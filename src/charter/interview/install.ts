import { ZodError } from 'zod';
import { appendAudit } from '../../audit/log.js';
import { transaction, type BusinessDb } from '../../db/pool.js';
import type { BusinessCharter } from '../../domain/charter.js';
import { setAutonomyMode } from '../../governance/autonomy-mode.js';
import type { MailProvider } from '../../mail/mailbox.js';
import { canonicalHash } from '../../util/canonical.js';
import { signCharter } from '../sign.js';
import { installCharter, loadCharterVersion } from '../store.js';
import { InterviewAnswers } from './answers.js';
import { buildCharterFromInterview } from './build.js';
import { deleteDraft, loadDraft, type InterviewDraft } from './draft-store.js';
import { mailboxAddedBy } from './summary.js';

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
 * screen offers `/autonomy`. `setAutonomyMode` runs its own transaction and
 * audit row on `db` after the install's has committed.
 *
 * **A mailbox the signature adds is preflighted first.** The same check the
 * connections screen's own mailbox sign runs (`oauthCeremonyPreflight`):
 * signing moves `mail.send` off every other connection, so a charter whose
 * OAuth ceremony cannot start would leave the business with no outgoing mail
 * at all. The caller supplies the check (`mailboxPreflight`, required — an
 * omission is a compile error, not a silent skip); it runs on the provider of
 * the very charter about to be signed, after the hash comparison, and a
 * refusal changes nothing.
 *
 * The audit reason names who signed and what was superseded — never answer
 * content: no names, domains or phone numbers reach `audit_log`, which is
 * append-only and survives erasure.
 */

export type InstallOutcome =
  | { outcome: 'installed'; charterVersion: string; modeApplied: boolean }
  | { outcome: 'incomplete' | 'not_frozen' | 'hash_mismatch' | 'stale' }
  | { outcome: 'preflight_failed'; reason: string };

/** The mailbox preflight: `null` when the provider's OAuth ceremony can start, else the Hebrew reason. */
export type MailboxPreflight = (provider: MailProvider) => Promise<string | null>;

/** The hash the summary carries: `canonicalHash` of the unsigned charter the frozen draft builds. */
export function shownHashFor(draft: InterviewDraft, businessId: string, previous: BusinessCharter | null): string {
  if (draft.frozenAt === null) throw new Error('shownHashFor needs a frozen draft');
  const answers = InterviewAnswers.parse(draft.answers);
  return canonicalHash(buildCharterFromInterview(answers, { businessId, frozenAt: draft.frozenAt, previous }));
}

/**
 * The charter a draft was started from, as the summary and the sign step both
 * read it — one function, so the hash the summary shows and the hash the sign
 * rebuilds can never disagree about `previous`.
 *
 *   - no base (a first install) → `previous: null`;
 *   - a base row that is GONE → `{ ok: false }`: a starting point the owner
 *     can no longer have been shown, so the sign is `stale`;
 *   - a base row that exists but does NOT PARSE under this code (a
 *     `ZodError` — a stale `schemaVersion` is a literal mismatch inside
 *     `BusinessCharter.parse`, so it lands here too) → `previous: null`. This is the "edit the rules" door for an unreadable
 *     charter (spec §6.1, §6.6): the interview reopens empty and the
 *     signature replaces the charter nobody can read. Refusing here (as this
 *     code did until Task 8) would leave that installation with no way out —
 *     the exact trap `probeActiveCharter` exists to avoid. Nothing of the
 *     unreadable charter can be preserved, because nothing of it can be read;
 *     the locked check still requires the active pointer to be that version.
 *
 * Only a parse failure means "unreadable". Anything else — the database gone,
 * a dropped connection — is rethrown: read as "unreadable", it would open the
 * interview EMPTY over a perfectly readable charter, and a sign from there
 * would drop everything the owner signed that the interview does not ask.
 */
export async function previousForDraft(
  db: BusinessDb,
  draft: Pick<InterviewDraft, 'baseCharterVersion'>,
): Promise<{ ok: true; previous: BusinessCharter | null } | { ok: false }> {
  if (draft.baseCharterVersion === null) return { ok: true, previous: null };
  let previous: BusinessCharter | null;
  try {
    previous = await loadCharterVersion(db, draft.baseCharterVersion);
  } catch (error) {
    if (error instanceof ZodError) return { ok: true, previous: null };
    throw error;
  }
  return previous === null ? { ok: false } : { ok: true, previous };
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

async function lockedChecks(tx: BusinessDb, draft: InterviewDraft): Promise<void> {
  const businessId = tx.businessId;
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

export async function signAndInstallInterview(
  db: BusinessDb,
  input: {
    username: string;
    shownHash: string;
    mailboxPreflight: MailboxPreflight;
  },
): Promise<InstallOutcome> {
  const { username } = input;
  const businessId = db.businessId;

  const draft = await loadDraft(db);
  if (draft === null) return { outcome: 'incomplete' };
  const parsed = InterviewAnswers.safeParse(draft.answers);
  if (!parsed.success) return { outcome: 'incomplete' };
  const answers = parsed.data;
  if (draft.frozenAt === null) return { outcome: 'not_frozen' };

  const base = await previousForDraft(db, draft);
  if (!base.ok) return { outcome: 'stale' };
  const { previous } = base;

  const unsigned = buildCharterFromInterview(answers, { businessId, frozenAt: draft.frozenAt, previous });
  if (canonicalHash(unsigned) !== input.shownHash) return { outcome: 'hash_mismatch' };

  const addedMailbox = mailboxAddedBy(unsigned, previous);
  if (addedMailbox !== null) {
    const reason = await input.mailboxPreflight(addedMailbox);
    if (reason !== null) return { outcome: 'preflight_failed', reason };
  }

  const signed = signCharter(unsigned, { signedByPersonId: username, method: 'dashboard_click' });
  const reason =
    `charter signed through the setup interview by ${username}` +
    (previous !== null ? `, superseding ${previous.charterVersion}` : '');

  try {
    await transaction(db, async (tx) => {
      await lockedChecks(tx, draft);
      await installCharter(tx, signed);
      await appendAudit(tx, {
        actor: 'human',
        onBehalfOf: username,
        kind: 'charter_change',
        charterVersion: signed.charterVersion,
        provenance: 'boss',
        inputHash: canonicalHash({ businessId, contentHash: signed.signature.contentHash }),
        reason,
      });
      await deleteDraft(tx);
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
    await setAutonomyMode(db, answers.autonomy.mode, username);
  } catch (error) {
    // The error only, never the answers: the charter is live, and this line
    // is what an operator finds when the owner reports the banner.
    console.error(
      'setup interview: the charter was installed but the autonomy dial could not be applied:',
      error instanceof Error ? error.message : error,
    );
    modeApplied = false;
  }
  return { outcome: 'installed', charterVersion: signed.charterVersion, modeApplied };
}
