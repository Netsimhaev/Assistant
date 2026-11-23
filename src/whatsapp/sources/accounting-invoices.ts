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
import { loadBindings } from '../../orchestrator/bindings.js';
import type { CredentialSource } from '../../orchestrator/credentials.js';
import { stripBidiControls, toOneLine } from '../../util/bidi.js';
import { readFieldPath } from '../../external/extract.js';
import type { ExternalHttp } from '../../external/http.js';
import { carriesSecret, headerSafe, secretForms, sendExternal } from '../../external/perform.js';
import { buildExternalRequest } from '../../external/request.js';
import { countCallsToday, recordCall } from '../../external/store.js';
import { loadInvoiceSettings } from './invoice-settings.js';
import type { SourceItem, Tier2Source } from './types.js';

export const ACCOUNTING_INVOICE_LABEL = 'חשבונית ממערכת הנהלת החשבונות';
const MAX_ROWS = 10;
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

export function createAccountingInvoicesSource(deps: AccountingInvoicesDeps): Tier2Source {
  return async (db, ids, signal) => {
    const none = { items: [] as SourceItem[], ownershipViolation: false };
    try {
      if (signal.aborted) return none;
      const settings = await loadInvoiceSettings(db);
      if (settings === null) return none;
      const contactId = ids.externalIds?.[settings.systemId];
      if (contactId === undefined || contactId === '') return none;

      const active = await loadActiveCharter(db);
      if (active === null) return none;
      const system = active.bundle.externalSystems.find((s) => s.id === settings.systemId);
      const op = system?.operations.find((o) => o.name === settings.operation);
      // Re-checked at read time: the charter may have changed since the settings were saved.
      if (system === undefined || op === undefined || op.kind !== 'read') return none;
      if (!op.params.some((p) => p.name === settings.customerParam)) return none;
      if (!op.fields.some((f) => f.path === settings.customerField)) return none;

      const binding = (await loadBindings(db)).find((b) => b.system === `ext:${system.id}`);
      if (binding === undefined || binding.status !== 'live' || binding.credentialRef === null) return none;
      const credential = await deps.credentials.resolve(binding.credentialRef, db.businessId, db);
      const secret = credential?.value;
      if (typeof secret !== 'string' || !headerSafe(secret)) return none;

      const now = (deps.now ?? (() => new Date()))();
      // A fresh id per call: nothing about the contact (no phone digits) goes to the provider.
      const built = buildExternalRequest(
        system,
        op,
        { params: { [settings.customerParam]: contactId } },
        `wa-invoices:${ulid()}`,
      );
      if (!built.ok) return none;

      const timeZone = active.charter.identity.timezone;
      if (signal.aborted) return none;
      const sent = await sendExternal(system, built, secret, false, {
        http: deps.http,
        callsToday: (systemId) => countCallsToday(db, systemId, timeZone, now),
        recordCall: (call) => recordCall(db, call),
        capPerDay: config.externalCallsPerDay,
      });
      if (!sent.ok || sent.json === undefined) return none;

      const rows = rowsOf(sent.json);
      if (rows === null) return { items: [], ownershipViolation: true };

      const forms = secretForms(system, secret);
      const numberField = op.fields.find((f) => /invoice|number|מספר/i.test(`${f.path} ${f.label}`));
      const items: SourceItem[] = [];
      let violation = false;
      for (const row of rows) {
        if (rawId(readFieldPath(row, settings.customerField)) !== contactId) {
          violation = true;
          continue;
        }
        if (items.length >= MAX_ROWS) continue;
        const fields: { label: string; value: string }[] = [];
        for (const f of op.fields) {
          const raw = readFieldPath(row, f.path);
          if (raw === undefined || raw === null) continue;
          if (typeof raw === 'object') {
            violation = true;
            continue;
          }
          const value = String(raw);
          if (!carriesSecret(value, forms)) fields.push({ label: f.label, value });
        }
        const number = numberField === undefined ? undefined : fields.find((f) => f.label === numberField.label)?.value;
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
      return { items, ownershipViolation: violation };
    } catch {
      return none;
    }
  };
}
