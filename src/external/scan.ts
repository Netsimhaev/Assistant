/**
 * The daily scan of a signed external system (Stage D, Task 12).
 *
 * **A documented gate bypass — ruling 9 of the plan.** The scan reads, on a
 * timer, with no boss command behind it, so it cannot run under
 * `confirmedCommandCovers` and is not a job at all. It is authorised by the
 * owner's signature on the `scan` block itself: the sign page states it in
 * words ("העוזרת תקרא אוטומטית את … כל N שעות, בלי לשאול אותך בכל פעם",
 * `external/describe.ts`), and docs/10 says the same. It joins the short list
 * of documented bypasses (mail labelling, the curator, erasure, calendar holds).
 *
 * What keeps it narrow — every one a positive control:
 *  - **Only systems in the ACTIVE charter** (`bundle.externalSystems`, the
 *    list the gate resolves against). Never drafts, never bindings: a removed
 *    system is not in the charter and is never scanned. An unreadable charter
 *    scans nothing and says so.
 *  - **Only the signed scan operation**, which the schema already requires to
 *    be a `read` over `GET`. The one value filled in by code is `sinceParam`
 *    (the ISO time of the last SUCCESSFUL scan), a query param the schema
 *    requires the operation to declare.
 *  - **The adapter's own path**: the same request builder
 *    (`buildExternalRequest`), the same live binding and credential
 *    resolution a plan step uses, and `sendExternal` (`perform.ts`) — the same
 *    daily cap against the same count, the same guarded client, the same
 *    outcome table, the same call log, the same secret-echo stripping.
 *  - **It only learns.** Each item becomes an `external_events` row of the
 *    operation's DECLARED fields (`extractFields`), deduplicated by
 *    `canonicalHash({ eventType, fields })` — the same hash the webhook writes
 *    (ruling T11-a). No job, no step, no card: no `ext.*` step can come of it.
 *
 * A scan that fails BEFORE an item is stored (refused address, bad key, cap,
 * timeout, an answer not in the signed shape) inserts nothing and leaves
 * `last_scan_at` where it was; its outcome code is recorded
 * (`last_scan_outcome`) and it is not retried for an hour (`SCAN_RETRY_MS`),
 * so a broken system cannot eat the day's call cap — which the owner's own
 * commands share — in an afternoon. A throw WHILE items are being stored
 * (a database fault mid-loop) keeps the events already inserted, records the
 * attempt as `scan_failed` at best effort (so the same back-off applies) and
 * likewise leaves `last_scan_at` where it was; the next scan asks from the
 * same point and `itemHash` dedupe drops what was already stored.
 *
 * A list longer than `MAX_SCAN_ITEMS` is cut, and the cut is never silent:
 * only the first `MAX_SCAN_ITEMS` items are stored, the outcome is
 * `scan_truncated`, `last_scan_at` does NOT move (the next scan asks from the
 * same point; dedupe stops repeats), the pass result counts it and warns, and
 * `/systems` tells the owner. Items beyond the cut are not stored by this
 * scan, and a system whose answer stays above the cap keeps losing the tail
 * until the technician narrows the scan.
 */
import type { BusinessDb } from '../db/pool.js';
import { config } from '../config.js';
import { loadActiveCharter } from '../charter/store.js';
import { checkKillSwitch } from '../governance/killswitch.js';
import type { ExternalSystem } from '../domain/external-system.js';
import { loadBindings } from '../orchestrator/bindings.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import { canonicalHash } from '../util/canonical.js';
import { readFieldPath } from './extract.js';
import type { ExternalHttp } from './http.js';
import { extractSafeFields, headerSafe, secretForms, sendExternal } from './perform.js';
import { buildExternalRequest } from './request.js';
import { countCallsToday, insertEvent, loadSystemState, recordCall, recordScanAttempt } from './store.js';

/** After a failed attempt, the next one waits at least this long. */
export const SCAN_RETRY_MS = 60 * 60 * 1000;

/** Items stored from one scan response; a longer list is `scan_truncated` (see the docblock). */
export const MAX_SCAN_ITEMS = 200;

/** Outcome of a scan whose list was longer than `MAX_SCAN_ITEMS`. */
export const SCAN_TRUNCATED = 'scan_truncated';

/** Outcome of a scan that threw after its request was sent. */
export const SCAN_FAILED = 'scan_failed';

/** The success outcome code stored on the state row. */
export const SCAN_OK = 'ok';

export interface ScanOptions {
  http: ExternalHttp;
  credentials: CredentialSource;
  now?: Date;
  /** Defaults to `config.externalCallsPerDay` — the adapter's cap. Injected by tests. */
  capPerDay?: number;
}

export interface ScanResult {
  /** Due systems a scan was attempted for this pass (success or not). */
  scanned: number;
  /** Events this pass inserted (duplicates of stored items are not counted). */
  newItems: number;
  /** Systems with a signed scan that were not due, or not connected. */
  skipped: number;
  /** Scans whose list was longer than `MAX_SCAN_ITEMS` and was cut. */
  truncated: number;
  warnings: string[];
}

const HOUR_MS = 60 * 60 * 1000;

function isDue(
  system: ExternalSystem & { scan: NonNullable<ExternalSystem['scan']> },
  state: { lastScanAt: Date | null; lastScanAttemptAt: Date | null } | null,
  now: Date,
): boolean {
  const lastOk = state?.lastScanAt ?? null;
  if (lastOk !== null && now.getTime() - lastOk.getTime() < system.scan.everyHours * HOUR_MS) return false;
  const attempt = state?.lastScanAttemptAt ?? null;
  if (attempt !== null && now.getTime() - attempt.getTime() < SCAN_RETRY_MS) return false;
  return true;
}

export async function scanExternalSystems(db: BusinessDb, options: ScanOptions): Promise<ScanResult> {
  const result: ScanResult = { scanned: 0, newItems: 0, skipped: 0, truncated: 0, warnings: [] };
  const now = options.now ?? new Date();

  let active;
  try {
    active = await loadActiveCharter(db);
  } catch (error) {
    result.warnings.push(
      `charter unreadable — no external scan this pass: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }
  if (active === null) return result;

  // The scan is the same request an ext.read step would send, and that
  // step stops at stage 1 of the gate under an `all`, `outbound` or
  // `operations` stop (`ops.systems` owns `ext.*`). A bypass of the gate's
  // later stages is not a bypass of the kill switch.
  const kill = await checkKillSwitch(db, 'ops.systems', true);
  if (kill.blocked) {
    result.skipped = active.bundle.externalSystems.filter((s) => s.scan !== null).length;
    return result;
  }

  const timeZone = active.charter.identity.timezone;
  const bindings = new Map((await loadBindings(db)).map((b) => [b.system, b] as const));
  const capPerDay = options.capPerDay ?? config.externalCallsPerDay;

  for (const system of active.bundle.externalSystems) {
    const scan = system.scan;
    if (scan === null) continue;
    let sentRequest = false;
    try {
      const state = await loadSystemState(db, system.id);
      if (!isDue({ ...system, scan }, state, now)) {
        result.skipped += 1;
        continue;
      }
      const record = (outcome: string, succeeded: boolean): Promise<void> =>
        recordScanAttempt(db, system.id, { at: now, outcome, succeeded });

      const binding = bindings.get(`ext:${system.id}`);
      if (binding === undefined || binding.status !== 'live' || binding.credentialRef === null) {
        await record('not_connected', false);
        result.skipped += 1;
        continue;
      }
      result.scanned += 1;

      // The schema guarantees this, and the check is repeated rather than
      // trusted: only a signed GET read is ever scanned.
      const op = system.operations.find((o) => o.name === scan.operation);
      if (op === undefined || op.kind !== 'read' || op.method !== 'GET') {
        await record('external_unresolved', false);
        continue;
      }

      const credential = await options.credentials.resolve(binding.credentialRef, db.businessId, db);
      const secret = credential?.value;
      if (typeof secret !== 'string' || !headerSafe(secret)) {
        await record('credential_unavailable', false);
        continue;
      }

      const params: Record<string, unknown> = {};
      if (scan.sinceParam !== null) {
        const since = state?.lastScanAt ?? null;
        if (since !== null) params[scan.sinceParam] = since.toISOString();
        else if (op.params.some((p) => p.name === scan.sinceParam && p.required)) {
          // First scan of an operation that will not answer without the param:
          // one interval back, rather than a scan that can never succeed.
          params[scan.sinceParam] = new Date(now.getTime() - scan.everyHours * HOUR_MS).toISOString();
        }
      }
      const built = buildExternalRequest(system, op, { params }, `scan:${system.id}:${now.toISOString()}`);
      if (!built.ok) {
        await record('bad_params', false);
        continue;
      }

      const sent = await sendExternal(system, built, secret, false, {
        http: options.http,
        callsToday: (systemId) => countCallsToday(db, systemId, timeZone, now),
        recordCall: (call) => recordCall(db, call),
        capPerDay,
      });
      sentRequest = true;
      if (!sent.ok) {
        await record(sent.code, false);
        continue;
      }

      let items: unknown[];
      let cut = false;
      if (sent.json === undefined) {
        await record('scan_unreadable', false);
        continue;
      }
      if (scan.itemsPath === null) items = [sent.json];
      else {
        const list = readFieldPath(sent.json, scan.itemsPath);
        if (list === undefined || list === null) items = [];
        else if (Array.isArray(list)) {
          cut = list.length > MAX_SCAN_ITEMS;
          items = list.slice(0, MAX_SCAN_ITEMS);
        }
        else {
          await record('scan_unreadable', false);
          continue;
        }
      }

      const forms = secretForms(system, secret);
      for (const item of items) {
        const fields = extractSafeFields(item, op.fields, forms);
        if (fields.length === 0) continue;
        const eventType = op.name;
        const inserted = await insertEvent(db, {
          systemId: system.id,
          source: 'scan',
          eventType,
          itemHash: canonicalHash({ eventType, fields }),
          fields,
        });
        if (inserted) result.newItems += 1;
      }
      if (cut) {
        result.truncated += 1;
        result.warnings.push(`external scan of ext:${system.id} returned more than ${MAX_SCAN_ITEMS} items — the rest were not stored`);
        await record(SCAN_TRUNCATED, false);
      } else {
        await record(SCAN_OK, true);
      }
    } catch (error) {
      result.warnings.push(
        `external scan of ext:${system.id} failed: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
      );
      if (sentRequest) {
        // Best effort, so the back-off applies; a second failure here is only noted.
        await recordScanAttempt(db, system.id, { at: now, outcome: SCAN_FAILED, succeeded: false }).catch(() => {
          result.warnings.push(`external scan of ext:${system.id}: the failed attempt could not be recorded`);
        });
      }
    }
  }
  return result;
}
