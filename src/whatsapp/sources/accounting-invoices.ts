/**
 * Invoices of ONE contact from the owner's accounting system (a signed
 * external system), read through the same request builder, credential
 * resolution, daily cap and guarded client the daily scan uses.
 *
 * Ownership (§9.2). The request carries the contact's id as ONE declared
 * parameter, but the provider is not trusted to filter: every returned row is
 * kept only when its declared customer-id field equals the contact's
 * `externalIds[systemId]` EXACTLY (string `===`, a number by `String(n)`, any
 * other type never matches; no trimming or normalising before the compare).
 * Any row dropped marks the whole result `ownershipViolation` — the caller
 * then does not answer from this source at all. A response that is not a list
 * is a violation too: a wrapper object is never treated as a row. Only scalar
 * field values are rendered; an object or array value is dropped and is a
 * violation (it could carry other customers' data).
 *
 * No settings, no id for this system on the contact, no live binding or any
 * failure yields no items — and with no settings, id or binding, no HTTP.
 * Nothing from message text, and no phone digits, reach the request.
 */
import { ulid } from 'ulid';
import { config } from '../../config.js';
import { loadActiveCharter } from '../../charter/store.js';
import type { BusinessDb } from '../../db/pool.js';
import { loadBindings } from '../../orchestrator/bindings.js';
import type { CredentialSource } from '../../orchestrator/credentials.js';
import { stripBidiControls, toOneLine } from '../../util/bidi.js';
import { readFieldPath } from '../../external/extract.js';
import type { ExternalHttp } from '../../external/http.js';
import { carriesSecret, headerSafe, secretForms, sendExternal } from '../../external/perform.js';
import { buildExternalRequest } from '../../external/request.js';
import { countCallsToday, recordCall } from '../../external/store.js';
import { loadInvoiceSettings, type ExternalSenderSource } from './invoice-settings.js';
import type { SenderIds, SourceItem, Tier2Result, Tier2Source } from './types.js';

export const ACCOUNTING_INVOICE_LABEL = 'חשבונית ממערכת הנהלת החשבונות';
export const MAX_OWNED_ROWS = 10;
const MAX_TEXT_CHARS = 2000;
/** Where a list response may keep its rows. */
const LIST_KEYS = ['data', 'items', 'results', 'invoices'] as const;

export interface AccountingInvoicesDeps {
  http: ExternalHttp;
  credentials: CredentialSource;
  now?: () => Date;
}

/** The rows of a list response, or `null` when the answer is not a list (never a wrapper-as-row). */
function rowsOf(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (json !== null && typeof json === 'object') {
    for (const key of LIST_KEYS) {
      const value = (json as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/** The raw id for an exact compare: a string as is, a number by String(n); any other type is `null`. */
function rawId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

const clean = (v: string): string => toOneLine(stripBidiControls(v));

export interface OwnedRows extends Tier2Result {
  /** Kept rows: declared field path to its scalar value (secret-bearing values left out). */
  rows: Record<string, string>[];
  /** The operation's declared response fields, in declaration order. */
  fields: { path: string; label: string }[];
  /** The signed operation's label (empty when nothing ran). */
  opLabel: string;
}

/**
 * The shared read-and-own-check: one signed `read` operation of a signed
 * system, keyed by the sender's id in that system. Re-checks the active
 * charter, live binding, credential, daily cap (inside `sendExternal`) and
 * the guarded client; keeps a row only when its declared id field equals the
 * sender's id exactly. Any dropped row, nested value or non-list answer is an
 * ownership violation. Any other failure yields no rows (`failed` when the
 * provider call itself failed). The kill switch is the caller's (draftFor).
 */
export async function readOwnedRows(
  db: BusinessDb,
  deps: AccountingInvoicesDeps,
  ids: SenderIds,
  signal: AbortSignal,
  s: ExternalSenderSource,
): Promise<OwnedRows> {
  const none: OwnedRows = { items: [], ownershipViolation: false, rows: [], fields: [], opLabel: '' };
  try {
    if (signal.aborted) return none;
    const contactId = ids.externalIds?.[s.systemId];
    if (contactId === undefined || contactId === '') return none;

    const active = await loadActiveCharter(db);
    if (active === null) return none;
    const system = active.bundle.externalSystems.find((x) => x.id === s.systemId);
    const op = system?.operations.find((o) => o.name === s.operation);
    // Re-checked at read time: the charter may have changed since the settings were saved.
    if (system === undefined || op === undefined || op.kind !== 'read') return none;
    if (!op.params.some((p) => p.name === s.param)) return none;
    if (!op.fields.some((f) => f.path === s.field)) return none;

    const binding = (await loadBindings(db)).find((b) => b.system === `ext:${system.id}`);
    if (binding === undefined || binding.status !== 'live' || binding.credentialRef === null) return none;
    const credential = await deps.credentials.resolve(binding.credentialRef, db.businessId, db);
    const secret = credential?.value;
    if (typeof secret !== 'string' || !headerSafe(secret)) return none;

    const now = (deps.now ?? (() => new Date()))();
    // A fresh id per call: nothing about the contact (no phone digits) goes to the provider.
    const built = buildExternalRequest(system, op, { params: { [s.param]: contactId } }, `wa-invoices:${ulid()}`);
    if (!built.ok) return none;

    const timeZone = active.charter.identity.timezone;
    if (signal.aborted) return none;
    const sent = await sendExternal(system, built, secret, false, {
      http: deps.http,
      callsToday: (systemId) => countCallsToday(db, systemId, timeZone, now),
      recordCall: (call) => recordCall(db, call),
      capPerDay: config.externalCallsPerDay,
    });
    if (!sent.ok || sent.json === undefined) return { ...none, failed: true };

    const rows = rowsOf(sent.json);
    if (rows === null) return { ...none, ownershipViolation: true };

    const forms = secretForms(system, secret);
    const kept: Record<string, string>[] = [];
    let violation = false;
    for (const row of rows) {
      if (rawId(readFieldPath(row, s.field)) !== contactId) {
        violation = true;
        continue;
      }
      if (kept.length >= MAX_OWNED_ROWS) continue;
      const values: Record<string, string> = {};
      for (const f of op.fields) {
        const raw = readFieldPath(row, f.path);
        if (raw === undefined || raw === null) continue;
        if (typeof raw === 'object') {
          violation = true;
          continue;
        }
        const value = String(raw);
        if (!carriesSecret(value, forms)) values[f.path] = value;
      }
      kept.push(values);
    }
    return {
      items: [],
      ownershipViolation: violation,
      rows: kept,
      fields: op.fields.map((f) => ({ path: f.path, label: f.label })),
      opLabel: op.label,
    };
  } catch {
    return none;
  }
}

export function createAccountingInvoicesSource(deps: AccountingInvoicesDeps): Tier2Source {
  return async (db, ids, signal) => {
    const none = { items: [] as SourceItem[], ownershipViolation: false };
    try {
      if (signal.aborted) return none;
      const settings = await loadInvoiceSettings(db);
      if (settings === null) return none;
      const r = await readOwnedRows(db, deps, ids, signal, {
        systemId: settings.systemId,
        operation: settings.operation,
        param: settings.customerParam,
        field: settings.customerField,
      });
      const numberField = r.fields.find((f) => /invoice|number|מספר/i.test(`${f.path} ${f.label}`));
      const items: SourceItem[] = [];
      for (const row of r.rows) {
        const fields = r.fields
          .filter((f) => row[f.path] !== undefined)
          .map((f) => ({ label: f.label, value: row[f.path] as string }));
        const number = numberField === undefined ? undefined : row[numberField.path];
        items.push({
          source: 'accounting_invoices',
          label: number === undefined ? ACCOUNTING_INVOICE_LABEL : `${ACCOUNTING_INVOICE_LABEL}: ${clean(number)}`,
          text: fields
            .map((f) => `${clean(f.label)}: ${clean(f.value)}`)
            .join('\n')
            .slice(0, MAX_TEXT_CHARS),
          documentId: null,
          at: null,
        });
      }
      return { items, ownershipViolation: r.ownershipViolation };
    } catch {
      return none;
    }
  };
}
