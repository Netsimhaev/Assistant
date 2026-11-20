/**
 * Deleting a whole business — the tenancy half (spec
 * docs/superpowers/specs/2026-11-19-business-deletion-design.md).
 *
 * Four steps, in this order, each one its own call so a retry can re-run
 * only what did not finish:
 *
 * 0. `revokeBusinessGrants` — before the rows go: each live Google grant's
 *    token is revoked at the provider, so the customer's account does not
 *    keep a live grant to an application that no longer holds its row.
 * 1. `deleteBusinessRows` — in ONE platform transaction: lock the registry
 *    row, re-check every guard against what the database says now (the head
 *    admin, the suspension, the exact name, no scheduler pass in flight), run
 *    `delete_business_rows` (migration 081 — every table, found at call time),
 *    and set the status to `deleting`. A refusal changes nothing.
 * 2. `deleteBusinessFiles` — the document, produced and inbox folders. Never the save
 *    folder: those are the owner's own copies on her machine's share
 *    (`doc.save`), and a business re-created with the same id is refused
 *    while it still holds a file (`createBusiness`).
 * 3. `finishDeletion` — the registry row, last, and only once those folders
 *    are gone. Until then the status `deleting` keeps the id taken and lets
 *    the head admin retry the file step.
 *
 * Nothing here writes an activity-log row or an audit row: the caller records
 * the action, and the business's own audit chain is one of the things deleted.
 *
 * Cross-business by nature, so it runs on the platform pool and is one of the
 * named functions in the closed list (CLAUDE.md, "ריבוי עסקים"). It is the
 * only production file that names `delete_business_rows` (pinned by
 * `business-deletion.test.ts`).
 */
import { lstat, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { isValidBusinessId, withBusiness, withBusinessTransaction, type BusinessDb, type Queryable } from '../db/pool.js';
import { listGrants, readGrantBySystem } from '../governance/oauth-grants.js';
import { revokeAtProvider, revokeUrlForProvider } from '../governance/oauth-provider-revoke.js';
import { withPlatform } from '../db/platform-pool.js';
import { businessFolders, countFilesUnder } from './paths.js';
import { BUSINESS_DELETE_LOCK_PREFIX, BusinessDeletingError, getBusiness } from './businesses.js';

export type DeletionRefusal = 'not_head' | 'not_suspended' | 'name_mismatch' | 'pass_in_flight' | 'unknown_business';

/** What the head admin reads when a deletion is refused. Plain Hebrew. */
export const DELETION_REFUSAL_HE: Readonly<Record<DeletionRefusal, string>> = {
  not_head: 'רק מנהל ראשי יכול למחוק עסק.',
  not_suspended: 'אפשר למחוק רק עסק מושהה. יש להשהות את העסק קודם.',
  name_mismatch: 'השם שהוקלד אינו תואם בדיוק את שם העסק.',
  pass_in_flight: 'העוזרת עובדת על העסק הזה ברגע זה. כדאי לנסות שוב בעוד כמה דקות.',
  unknown_business: 'העסק לא נמצא.',
};

/**
 * The advisory-lock key shared by the deletion (exclusive), `createBusiness`
 * (exclusive) and every per-business panel write (shared):
 * `hashtext(BUSINESS_DELETE_LOCK_PREFIX || id)`. Defined in `businesses.ts`
 * (which this module imports) so `createBusiness` can take it without an
 * import cycle. Advisory locks are database-wide, so a write on the app pool
 * and the deletion on the platform pool serialise: either the write commits
 * before the deletion takes the lock (and its rows are deleted with the
 * rest), or the deletion has committed and the write sees `deleting` and
 * refuses.
 */
export { BUSINESS_DELETE_LOCK_PREFIX };

const LOCK_EXCLUSIVE_SQL = 'SELECT pg_advisory_xact_lock(hashtext($1 || $2))';
const LOCK_SHARED_SQL = 'SELECT pg_advisory_xact_lock_shared(hashtext($1 || $2))';

/**
 * Inside the caller's writing transaction: take the shared deletion lock,
 * then re-read the status and throw `BusinessDeletingError` when the business
 * is being deleted or no longer registered. Throws if `tx` is not inside a
 * transaction — a transaction-scoped lock taken outside one is released at
 * once and guards nothing.
 *
 * The status re-read runs on the PLATFORM pool while `tx` holds an APP-pool
 * connection: two different pools, so this is not hold-and-wait within one
 * pool (CLAUDE.md, "ריבוי עסקים"). The read is a plain SELECT and does not
 * wait on the deletion's row lock.
 */
export async function assertNotDeleting(tx: BusinessDb): Promise<void> {
  if (!tx.inTransaction) throw new Error('assertNotDeleting: must run inside a transaction');
  await tx.query(LOCK_SHARED_SQL, [BUSINESS_DELETE_LOCK_PREFIX, tx.businessId]);
  const biz = await getBusiness(tx.businessId);
  if (biz === null || biz.status === 'deleting') throw new BusinessDeletingError(tx.businessId);
}

/**
 * One business transaction that starts with `assertNotDeleting`: the form
 * every per-business panel write takes.
 */
export async function withBusinessWriteGuard<T>(businessId: string, fn: (tx: BusinessDb) => Promise<T>): Promise<T> {
  return withBusinessTransaction(businessId, async (tx) => {
    await assertNotDeleting(tx);
    return fn(tx);
  });
}

/**
 * Ruling 4: a pass is in flight when it started after the last one finished,
 * and started less than 30 minutes ago — a pass that crashed without ending
 * stops blocking after that. On the database clock, never the process's.
 */
const PASS_IN_FLIGHT_SQL = `(pass_started_at IS NOT NULL
   AND pass_started_at > coalesce(pass_finished_at, '-infinity'::timestamptz)
   AND pass_started_at > now() - interval '30 minutes')`;

/**
 * The scheduler's heartbeat at the start of one business's pass — written
 * only while the business is still `active`. Returns whether it was: `false`
 * means the business was suspended, or its deletion committed, after the
 * scheduler read its list, and the pass must not run (it would write rows
 * under an id the deletion has just emptied). Throws on a database error;
 * the scheduler then runs the pass anyway (fail-open, `tenants.ts`).
 */
export async function recordPassStart(businessId: string): Promise<boolean> {
  return withPlatform(async (db) => {
    const { rows } = await db.query(
      `UPDATE businesses SET pass_started_at = now() WHERE business_id = $1 AND status = 'active' RETURNING 1`,
      [businessId],
    );
    return rows.length > 0;
  });
}

/** The scheduler's heartbeat at the end of one business's pass. */
export async function recordPassEnd(businessId: string): Promise<void> {
  await withPlatform((db) =>
    db.query('UPDATE businesses SET pass_finished_at = now() WHERE business_id = $1', [businessId]),
  );
}

/** Is a scheduler pass of this business running now (Ruling 4)? `false` for an unknown business. */
export async function passInFlight(businessId: string): Promise<boolean> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<{ in_flight: boolean }>(
      `SELECT ${PASS_IN_FLIGHT_SQL} AS in_flight FROM businesses WHERE business_id = $1`,
      [businessId],
    );
    return rows[0]?.in_flight === true;
  });
}

/**
 * Trims ASCII whitespace (space, tab, CR, LF) from both ends — and nothing
 * else. `String.prototype.trim` also strips U+FEFF and other Unicode spaces,
 * which would let a name carrying an invisible mark match.
 */
function trimAscii(value: string): string {
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

/**
 * Does the typed name match the business's name? The one comparison every
 * caller uses: ASCII whitespace trimmed at both ends, then exact equality.
 * The panel calls it before anything is revoked (a typo must not revoke the
 * customer's Google access); `deleteBusinessRows` calls it again under lock.
 */
export function namesMatch(typedName: string, displayName: string): boolean {
  return trimAscii(typedName) === trimAscii(displayName);
}

export interface DeleteBusinessRowsInput {
  businessId: string;
  /** The staff member asking — re-checked here as a live head admin. */
  staffId: string;
  /** The business's name as the head admin typed it. Only ASCII whitespace at its ends is trimmed. */
  typedName: string;
}

export type DeleteBusinessRowsResult =
  | { ok: true; tables: { table: string; deleted: number }[] }
  | { ok: false; refusal: DeletionRefusal };

/**
 * The row step. Every guard is read inside the transaction, after the
 * registry row is locked, so what the panel showed when the page loaded
 * decides nothing: a head role removed since, a business resumed since, a
 * pass that started since — each refuses.
 *
 * The name must match exactly after trimming ASCII whitespace at both ends: no case folding, no
 * collapsing of inner spaces, no stripping of invisible marks. A name typed
 * with a doubled space or a hidden direction mark is not the name.
 *
 * A business already `deleting` is refused (`not_suspended`): its rows are
 * gone, and a retry re-runs only the file step (`deleteBusinessFiles`, then
 * `finishDeletion`).
 */
export async function deleteBusinessRows(input: DeleteBusinessRowsInput): Promise<DeleteBusinessRowsResult> {
  const { businessId, staffId, typedName } = input;
  // A malformed id cannot be a registered business; the function would refuse it too.
  if (!isValidBusinessId(businessId)) return { ok: false, refusal: 'unknown_business' };
  return withPlatform(async (db) => {
    await db.query('BEGIN');
    try {
      const refuse = async (refusal: DeletionRefusal): Promise<DeleteBusinessRowsResult> => {
        await db.query('ROLLBACK');
        return { ok: false, refusal };
      };
      // Exclusive: waits for every panel write that holds the shared lock to
      // commit, and holds new ones off until this transaction ends.
      await db.query(LOCK_EXCLUSIVE_SQL, [BUSINESS_DELETE_LOCK_PREFIX, businessId]);
      const { rows: bizRows } = await db.query<{ display_name: string; status: string; in_flight: boolean }>(
        `SELECT display_name, status, ${PASS_IN_FLIGHT_SQL} AS in_flight
           FROM businesses WHERE business_id = $1 FOR UPDATE`,
        [businessId],
      );
      const biz = bizRows[0];
      if (biz === undefined) return await refuse('unknown_business');

      // FOR SHARE: a concurrent removal of the head role waits for this
      // transaction rather than slipping in between the check and the delete.
      const { rows: staffRows } = await db.query(
        'SELECT 1 FROM platform_staff WHERE staff_id = $1 AND removed_at IS NULL AND is_head FOR SHARE',
        [staffId],
      );
      if (staffRows.length === 0) return await refuse('not_head');
      if (biz.status !== 'suspended') return await refuse('not_suspended');
      if (!namesMatch(typedName, biz.display_name)) return await refuse('name_mismatch');
      if (biz.in_flight) return await refuse('pass_in_flight');

      const { rows: deleted } = await db.query<{ table_name: string; deleted: string }>(
        'SELECT table_name, deleted FROM delete_business_rows($1)',
        [businessId],
      );
      await db.query(`UPDATE businesses SET status = 'deleting' WHERE business_id = $1`, [businessId]);
      await db.query('COMMIT');
      return {
        ok: true,
        tables: deleted.map((r) => ({ table: r.table_name, deleted: Number(r.deleted) })),
      };
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

type RmFn = (path: string, options: { recursive: true; force: true }) => Promise<void>;

/** Test seam only; ignored outside tests. */
export interface DeleteFilesTestSeam {
  rm?: RmFn;
}

export type FileDeletionRefusal = 'not_deleting';

/** What the head admin reads when the file step is refused. Plain Hebrew. */
export const FILE_DELETION_REFUSAL_HE: Readonly<Record<FileDeletionRefusal, string>> = {
  not_deleting: 'אפשר למחוק את הקבצים רק של עסק שמחיקת הנתונים שלו כבר בוצעה.',
};

export type DeleteBusinessFilesResult =
  | { ok: true; removed: number; failed: string[] }
  | { ok: false; refusal: FileDeletionRefusal };

/**
 * The folders the deletion removes, each with a label for its root: the
 * document folder, the produced-files folder (`<DOCUMENT_ROOT>/produced/<id>`
 * — the production loop's tree, `produced/<businessId>/<productionId>/…`,
 * which sits beside the business folders and not inside its own), and the
 * inbox folder. Only for an id that already passed `isValidBusinessId`.
 */
function deletableFolders(businessId: string): Array<{ label: string; root: string; folder: string }> {
  const folders = businessFolders(businessId);
  const out = [
    { label: 'DOCUMENT_ROOT', root: config.documentRoot, folder: folders.document },
    { label: 'DOCUMENT_ROOT/produced', root: join(config.documentRoot, 'produced'), folder: folders.produced },
  ];
  if (folders.inbox !== null && config.documentInboxRoot !== null) {
    out.push({ label: 'DOCUMENT_INBOX_ROOT', root: config.documentInboxRoot, folder: folders.inbox });
  }
  return out;
}

/**
 * Is `folder` exactly `<root>/<businessId>` — the root its direct parent, the
 * id its last segment? Checked again right before each `rm`, as a second wall
 * behind `businessFolders`: a recursive removal that ever reached the root
 * itself, or a sibling, would delete other businesses' files.
 */
function isBusinessFolderUnder(folder: string, root: string, businessId: string): boolean {
  const resolved = resolve(folder);
  return dirname(resolved) === resolve(root) && basename(resolved) === businessId;
}

/**
 * The file step: removes `<DOCUMENT_ROOT>/<id>`, `<DOCUMENT_ROOT>/produced/<id>`
 * and `<DOCUMENT_INBOX_ROOT>/<id>` whole. Never the save folder.
 *
 * Gated on the database: only a business whose registry row says `deleting`
 * — its rows already gone (`deleteBusinessRows`) — loses its files. Any other
 * status, a missing row or a malformed id is refused and nothing is touched.
 * The row is held `FOR SHARE` until the folders are removed, so it cannot be
 * finished and the id re-created in between.
 *
 * `removed` counts the files under each folder that was removed (counted
 * before removing); `failed` names each folder that could not be removed by
 * its root's name and the path under it — never an absolute server path,
 * since it reaches a screen.
 */
export async function deleteBusinessFiles(
  businessId: string,
  testSeam?: DeleteFilesTestSeam,
): Promise<DeleteBusinessFilesResult> {
  if (!isValidBusinessId(businessId)) return { ok: false, refusal: 'not_deleting' };
  const remove: RmFn = (config.isTest ? testSeam?.rm : undefined) ?? rm;
  return withPlatform(async (db) => {
    await db.query('BEGIN');
    try {
      const { rows } = await db.query<{ status: string }>(
        'SELECT status FROM businesses WHERE business_id = $1 FOR SHARE',
        [businessId],
      );
      if (rows[0]?.status !== 'deleting') {
        await db.query('ROLLBACK');
        return { ok: false, refusal: 'not_deleting' };
      }
      let removed = 0;
      const failed: string[] = [];
      for (const { label, root, folder } of deletableFolders(businessId)) {
        const under = relative(root, folder).split(sep).join('/');
        try {
          if (!isBusinessFolderUnder(folder, root, businessId)) throw new Error('folder is not <root>/<id>');
          const count = await countFilesUnder(folder);
          await remove(folder, { recursive: true, force: true });
          removed += count;
        } catch {
          failed.push(`${label}/${under}`);
        }
      }
      await db.query('COMMIT');
      return { ok: true, removed, failed };
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

async function folderExists(folder: string): Promise<boolean> {
  try {
    await lstat(folder);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * The last step: deletes the registry row — only while its status is
 * `deleting` and only once the document, produced and inbox folders no longer exist.
 * The save folder is not checked (it is never removed). Returns whether it
 * removed the row.
 */
export async function finishDeletion(businessId: string): Promise<boolean> {
  if (!isValidBusinessId(businessId)) return false;
  for (const { folder } of deletableFolders(businessId)) {
    if (await folderExists(folder)) return false;
  }
  return withPlatform(async (db) => {
    await db.query('BEGIN');
    try {
      // Belt and braces: under the exclusive lock, any row that slipped in
      // since the row step is removed before the id is freed for reuse.
      await db.query(LOCK_EXCLUSIVE_SQL, [BUSINESS_DELETE_LOCK_PREFIX, businessId]);
      const { rows } = await db.query<{ status: string }>(
        'SELECT status FROM businesses WHERE business_id = $1 FOR UPDATE',
        [businessId],
      );
      if (rows[0]?.status !== 'deleting') {
        await db.query('ROLLBACK');
        return false;
      }
      await db.query('SELECT table_name, deleted FROM delete_business_rows($1)', [businessId]);
      const { rowCount } = await db.query(
        `DELETE FROM businesses WHERE business_id = $1 AND status = 'deleting'`,
        [businessId],
      );
      await db.query('COMMIT');
      return (rowCount ?? 0) > 0;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

async function headOnPlatform(db: Queryable, staffId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM platform_staff WHERE staff_id = $1 AND removed_at IS NULL AND is_head',
    [staffId],
  );
  return rows.length > 0;
}

/**
 * Is `staffId` a live head admin, as the database says NOW — not as the
 * session said when the request began? The deletion routes call it before a
 * step that is not gated on head by itself (the file retry); the row step and
 * the revocation re-check it on their own.
 */
export async function isActiveHead(staffId: string): Promise<boolean> {
  return withPlatform((db) => headOnPlatform(db, staffId));
}

/** How long one provider revocation may take before it counts as failed. */
export const PROVIDER_REVOKE_DEADLINE_MS = 10_000;

export interface RevokeBusinessGrantsInput {
  businessId: string;
  /** The staff member asking — re-checked here as a live head admin. */
  staffId: string;
  /** The server's master key: the grants' refresh tokens are sealed under it. */
  key: Buffer;
}

export interface RevokeBusinessGrantsDeps {
  fetchImpl?: typeof fetch;
  /** Defaults to `PROVIDER_REVOKE_DEADLINE_MS`. */
  deadlineMs?: number;
}

export type RevokeBusinessGrantsResult =
  | {
      ok: true;
      attempted: number;
      failed: number;
      /** The grants could not be read at all — how many there were, and so whether any stays live at a provider, is unknown. */
      grantsUnreadable: boolean;
    }
  | { ok: false; refusal: Extract<DeletionRefusal, 'not_head' | 'not_suspended' | 'unknown_business'> };

/**
 * The step before the rows go: revoke each live OAuth grant of the business
 * at its provider.
 *
 * **Gated on the database, like the file step.** This revokes the customer's
 * Google access, so it refuses — touching nothing and calling no provider —
 * unless the registry says the business is `suspended` and `staffId` is a
 * live head admin, both read here on the platform pool. A route that forgets
 * to check cannot reach an active business through this function. A
 * malformed id is refused as `unknown_business`, without throwing.
 *
 * **It does not mark anything revoked locally.** The grant rows are deleted
 * by `deleteBusinessRows` right after; a local mark would only be one more
 * write to undo if the deletion is abandoned.
 *
 * Per live grant (`listGrants`, `revokedAt === null`): a provider with no
 * revocation endpoint (Microsoft, `revokeUrlForProvider` → `null`) is skipped
 * and not counted; otherwise the refresh token is opened (the same
 * `readGrantBySystem` the owner's disconnect uses — a grant stores only a
 * refresh token) and POSTed to the provider within `deadlineMs`. A grant that
 * will not open counts as attempted and failed. `failed` is how many of the
 * attempted did not come back 2xx.
 *
 * Never throws once the gate has passed, and never logs: a token or a
 * provider's error text must not reach a log line.
 */
export async function revokeBusinessGrants(
  input: RevokeBusinessGrantsInput,
  deps: RevokeBusinessGrantsDeps = {},
): Promise<RevokeBusinessGrantsResult> {
  const { businessId, staffId, key } = input;
  if (!isValidBusinessId(businessId)) return { ok: false, refusal: 'unknown_business' };

  const gate = await withPlatform(async (db) => {
    const { rows: bizRows } = await db.query<{ status: string }>(
      'SELECT status FROM businesses WHERE business_id = $1',
      [businessId],
    );
    const biz = bizRows[0];
    if (biz === undefined) return 'unknown_business' as const;
    if (!(await headOnPlatform(db, staffId))) return 'not_head' as const;
    if (biz.status !== 'suspended') return 'not_suspended' as const;
    return null;
  });
  if (gate !== null) return { ok: false, refusal: gate };

  const deadlineMs = deps.deadlineMs ?? PROVIDER_REVOKE_DEADLINE_MS;
  let attempted = 0;
  let failed = 0;
  let grantsUnreadable = false;
  try {
    // The tokens are opened inside the business's own wall, and held only
    // here; the network calls happen after the connection is released.
    const tokens = await withBusiness(businessId, async (db) => {
      const out: Array<{ revokeUrl: string; token: string | null }> = [];
      for (const summary of await listGrants(db)) {
        if (summary.revokedAt !== null) continue;
        const revokeUrl = revokeUrlForProvider(summary.provider);
        if (revokeUrl === null) continue;
        let token: string | null = null;
        try {
          token = (await readGrantBySystem(db, summary.system, key))?.refreshToken ?? null;
        } catch {
          token = null;
        }
        out.push({ revokeUrl, token });
      }
      return out;
    });
    for (const { revokeUrl, token } of tokens) {
      attempted += 1;
      if (token === null) {
        failed += 1;
        continue;
      }
      const outcome = await revokeAtProvider({
        revokeUrl,
        token,
        deadlineMs,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });
      if (outcome !== 'revoked') failed += 1;
    }
  } catch {
    // Reading the grants failed outright: say so, rather than a zero that
    // reads as "nothing to revoke". The caller decides whether to go on.
    grantsUnreadable = true;
  }
  return { ok: true, attempted, failed, grantsUnreadable };
}
