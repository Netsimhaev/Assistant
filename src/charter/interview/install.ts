import { appendAudit } from '../../audit/log.js';
import { withTransaction, type Queryable } from '../../db/pool.js';
import type { BusinessCharter } from '../../domain/charter.js';
import { setAutonomyMode } from '../../governance/autonomy-mode.js';
import { canonicalHash } from '../../util/canonical.js';
import { signCharter } from '../sign.js';
import { installCharter, loadCharterVersion } from '../store.js';
import { InterviewAnswers } from './answers.js';
import { buildCharterFromInterview } from './build.js';
import { deleteDraft, loadDraft, type InterviewDraft } from './draft-store.js';

/**
 * Signing the charter the setup interview built (spec §6.2, §6.4).
 *
 * **What the summary showed is what gets signed.** The summary page renders
 * the output of `buildCharterFromInterview` on the frozen draft and carries
 * `shownHashFor` of that UNSIGNED charter in the form. Here the charter is
 * rebuilt server-side from the same draft — `frozenAt` pins `effectiveFrom`
 * and `charterVersion`, so an unchanged draft rebuilds byte-for-byte — and the
 * hash is compared before anything is signed. A mismatch refuses: the owner
 * is shown the summary again, never a charter they did not read. The same
 * "rebuild, compare a handle" shape `POST /erase/confirm` keeps with
 * `planFingerprint`.
 *
 * **One transaction: install, audit row, draft delete.** A failure in any of
 * them rolls back all three. Inside it, under a per-business advisory lock:
 *   - the active pointer must still be the version the draft started from
 *     (`null` on a first install). A first install has no `charter_active`
 *     row for `FOR UPDATE` to lock, which is why the advisory lock exists —
 *     two concurrent signs of one draft serialise on it, and the second sees
 *     the pointer already moved (`stale`);
 *   - the draft is re-read `FOR UPDATE` and must be the very draft that was
 *     hashed (same `frozen_at` and `updated_at`). An edit that landed between
 *     the hash check and the lock would otherwise be deleted unseen by the
 *     install of the older answers. Gone → `incomplete`; changed → `stale`.
 *
 * **The autonomy dial is applied after commit, and its failure is reported,
 * not thrown.** The charter is live either way; a failed apply leaves the
 * dial where it was (`off` on a fresh business), the safe direction, and the
 * screen offers `/autonomy`. `setAutonomyMode` opens its own transaction and
 * audit row, so folding it in would mean threading a connection it does not
 * take.
 *
 * The audit reason names who signed and what was superseded — never answer
 * content: no names, domains or phone numbers reach `audit_log`, which is
 * append-only and survives erasure.
 */

export type InstallOutcome =
  | { outcome: 'installed'; charterVersion: string; modeApplied: boolean }
  | { outcome: 'incomplete' | 'not_frozen' | 'hash_mismatch' | 'stale' };

/** The hash the summary carries: `canonicalHash` of the unsigned charter the frozen draft builds. */
export function shownHashFor(draft: InterviewDraft, businessId: string, previous: BusinessCharter | null): string {
  if (draft.frozenAt === null) throw new Error('shownHashFor needs a frozen draft');
  const answers = InterviewAnswers.parse(draft.answers);
  return canonicalHash(buildCharterFromInterview(answers, { businessId, frozenAt: draft.frozenAt, previous }));
}

class Refused extends Error {
  constructor(readonly outcome: 'incomplete' | 'stale') {
    super(outcome);
  }
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

async function lockedChecks(tx: Queryable, businessId: string, draft: InterviewDraft): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('charter-install:' || $1))", [businessId]);

  const active = await tx.query<{ charter_version: string }>(
    'SELECT charter_version FROM charter_active WHERE business_id = $1 FOR UPDATE',
    [businessId],
  );
  if ((active.rows[0]?.charter_version ?? null) !== draft.baseCharterVersion) throw new Refused('stale');

  const current = await tx.query<{ frozen_at: Date | null; updated_at: Date }>(
    'SELECT frozen_at, updated_at FROM charter_interview_drafts WHERE business_id = $1 FOR UPDATE',
    [businessId],
  );
  const row = current.rows[0];
  if (row === undefined) throw new Refused('incomplete');
  if (row.frozen_at?.getTime() !== draft.frozenAt?.getTime() || row.updated_at.getTime() !== draft.updatedAt.getTime()) {
    throw new Refused('stale');
  }
}

export async function signAndInstallInterview(input: {
  businessId: string;
  username: string;
  shownHash: string;
}): Promise<InstallOutcome> {
  const { businessId, username } = input;

  const draft = await loadDraft(businessId);
  if (draft === null) return { outcome: 'incomplete' };
  const parsed = InterviewAnswers.safeParse(draft.answers);
  if (!parsed.success) return { outcome: 'incomplete' };
  const answers = parsed.data;
  if (draft.frozenAt === null) return { outcome: 'not_frozen' };

  // A base that no longer loads (gone, or unparseable under this code) is a
  // starting point the owner can no longer have been shown: stale.
  let previous: BusinessCharter | null = null;
  if (draft.baseCharterVersion !== null) {
    try {
      previous = await loadCharterVersion(draft.baseCharterVersion, businessId);
    } catch {
      return { outcome: 'stale' };
    }
    if (previous === null) return { outcome: 'stale' };
  }

  const unsigned = buildCharterFromInterview(answers, { businessId, frozenAt: draft.frozenAt, previous });
  if (canonicalHash(unsigned) !== input.shownHash) return { outcome: 'hash_mismatch' };

  const signed = signCharter(unsigned, { signedByPersonId: username, method: 'dashboard_click' });
  const reason =
    `charter signed through the setup interview by ${username}` +
    (previous !== null ? `, superseding ${previous.charterVersion}` : '');

  try {
    await withTransaction(async (tx) => {
      await lockedChecks(tx, businessId, draft);
      await installCharter(signed, { businessId, tx });
      await appendAudit(
        {
          actor: 'human',
          onBehalfOf: username,
          kind: 'charter_change',
          charterVersion: signed.charterVersion,
          provenance: 'boss',
          inputHash: canonicalHash({ businessId, contentHash: signed.signature.contentHash }),
          reason,
        },
        { businessId, tx },
      );
      await deleteDraft(businessId, tx);
    });
  } catch (error) {
    if (error instanceof Refused) return { outcome: error.outcome };
    // `charter_version` is a global key and the version is deterministic per
    // draft: a duplicate means this very charter is already installed — the
    // locked checks above make that unreachable for one business, so this is
    // a backstop that keeps a double sign from surfacing as a 500.
    if (isUniqueViolation(error)) return { outcome: 'stale' };
    throw error;
  }

  let modeApplied = true;
  try {
    await setAutonomyMode(answers.autonomy.mode, username, { businessId });
  } catch {
    modeApplied = false;
  }
  return { outcome: 'installed', charterVersion: signed.charterVersion, modeApplied };
}
