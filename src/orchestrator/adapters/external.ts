import type { ExternalSystem } from '../../domain/external-system.js';
import { readFieldPath, displayValue } from '../../external/extract.js';
import type { ExternalHttp } from '../../external/http.js';
import {
  carriesSecret,
  extractSafeFields,
  headerSafe,
  secretForms,
  sendExternal,
} from '../../external/perform.js';
import { buildExternalRequestFromPayload } from '../../external/request.js';
import { REDACTED } from '../../policy/redact.js';
import { resolveExternalCall } from '../../policy/external-class.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

/**
 * The adapter for one external system the owner signed (Stage D): turns an
 * `ext.read` / `ext.call` step into one guarded HTTPS request and its answer
 * into a result the orchestrator records.
 *
 * What it trusts, and from where:
 *  - **The operation** is resolved with `resolveExternalCall` — the same
 *    function the gate ran at stage 3 — against the SIGNED definition this
 *    adapter was built from (the active charter's bundle, `runtime.ts`). It
 *    never looks an operation up on its own terms, so the gate and the
 *    adapter cannot disagree about which operation a payload names.
 *  - **The payload** is `call.input`, the gate's REDACTED payload, never the
 *    proposal. The request is built by `buildExternalRequest`, which accepts
 *    declared params only and writes the amount — `input.amountMinor`, the
 *    one value the gate judged — into the declared amount field. No amount is
 *    read from anywhere else.
 *  - **The secret** is `call.credential.value` only, never config. It goes
 *    into exactly one header and nowhere else: no message, no output and no
 *    error carries it.
 *
 * What it returns: a result, never a throw (the `ExternalAdapter` contract).
 * Every message is a fixed Hebrew sentence; text the provider sent never
 * reaches `message`. A success's `output` is `{ fields }` — the operation's
 * DECLARED fields only, each one line (`extractFields`) — and `externalId`
 * comes from the declared `idPath`.
 *
 * Write versus read is the operation's kind: `read` is a read, everything
 * else (change, delete, money) is a write. The difference matters only where
 * the far end may have acted without saying so: a read is safe to repeat, a
 * write is not, so an ambiguous write is `delivery_unknown` (final) — or, on
 * a timeout, retryable with `outcomeUnknown`, which makes `executeStep` write
 * the `unknown` completion row exactly as `callWithDeadline` does.
 *
 * Every attempt that reached `http.send` is counted (`recordCall`), success
 * or not, with a fixed short code — never content. The daily cap is checked
 * against that count before sending.
 */

export const EXTERNAL_SERVES = ['ext.call', 'ext.read'] as const;

/** Fixed Hebrew messages. Mirrored in `FAILURE_REASON_HE` (`whatsapp-report.ts`). */
export const EXTERNAL_MESSAGES_HE = {
  credential_unavailable: 'חסר מפתח תקין למערכת החיצונית — לא נשלח דבר',
  external_unresolved: 'הפעולה אינה מוגדרת במערכת שנחתמה — לא נשלח דבר',
  external_daily_cap: 'הגענו לתקרת הפניות היומית למערכת החיצונית — ננסה שוב מאוחר יותר',
  external_cap_unreadable: 'לא ניתן היה לבדוק את תקרת הפניות היומית — ננסה שוב מאוחר יותר',
  external_address_refused: 'כתובת המערכת החיצונית מפנה לכתובת פנימית או חסומה — לא נשלח דבר',
  external_auth: 'המערכת החיצונית דחתה את המפתח — צריך לעדכן אותו',
  external_unavailable: 'המערכת החיצונית לא הייתה זמינה — ננסה שוב',
  external_rejected: 'המערכת החיצונית דחתה את הבקשה',
  external_network: 'לא ניתן היה להגיע למערכת החיצונית — ננסה שוב',
  external_response_too_large: 'התשובה מהמערכת החיצונית גדולה מדי — לא נקראה',
  external_request_failed: 'אירעה תקלה בשליחת הבקשה למערכת החיצונית',
  adapter_timeout: 'המערכת החיצונית לא הגיבה בזמן',
  delivery_unknown: 'לא ניתן לדעת אם הפעולה בוצעה במערכת החיצונית — כדאי לבדוק שם',
  external_definition_stale: 'הגדרת המערכת החיצונית התעדכנה בזמן הביצוע — ננסה שוב בסבב הבא',
  external_bad_url: 'כתובת המערכת החיצונית אינה כתובת מאובטחת — לא נשלח דבר',
  external_disabled: 'החיבור למערכות חיצוניות כבוי',
  external_redacted_value: 'הבקשה למערכת החיצונית כוללת ערך שהתקנון מסתיר — לא נשלח דבר',
} as const;

type ExternalCode = keyof typeof EXTERNAL_MESSAGES_HE;

export interface ExternalAdapterDeps {
  http: ExternalHttp;
  /**
   * The charter version `system` was read from. A call judged under any other
   * version (`AdapterCall.judgedCharterVersion`) is refused, retryable: the
   * next pass rebuilds the runtime from the charter the gate now reads.
   */
  charterVersion: string;
  /** Calls already made today to this system, in the charter's time zone. */
  callsToday: (systemId: string) => Promise<number>;
  /** Counts one attempt that reached `http.send`. `outcome` is a fixed code. */
  recordCall: (call: { systemId: string; outcome: string }) => Promise<void>;
  /** 0 means external calls are switched off: a final `external_disabled`. */
  capPerDay: number;
}

function fail(code: ExternalCode, retryable: boolean, extra: { outcomeUnknown?: true } = {}): AdapterResult {
  return { ok: false, retryable, code, message: EXTERNAL_MESSAGES_HE[code], ...extra };
}

/** Deep enough for any real payload; a guard against a cyclic structure. */
const MARKER_SCAN_DEPTH = 12;

/**
 * Does any string anywhere in `value` carry the redaction marker? A value too
 * deep to scan counts as carrying it — what we could not read is never the
 * permissive answer.
 */
function carriesRedactionMarker(value: unknown, depth = 0): boolean {
  if (depth > MARKER_SCAN_DEPTH) return true;
  if (typeof value === 'string') return value.includes(REDACTED);
  if (Array.isArray(value)) return value.some((v) => carriesRedactionMarker(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => carriesRedactionMarker(v, depth + 1));
  }
  return false;
}

/** The URL as text, percent-decoded where it decodes (a path param reaches it only encoded). */
function decodedUrl(url: URL): string {
  try {
    return decodeURIComponent(url.href);
  } catch {
    return url.href;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createExternalAdapter(system: ExternalSystem, deps: ExternalAdapterDeps): ExternalAdapter {
  const systemName = `ext:${system.id}`;

  async function execute(call: AdapterCall): Promise<AdapterResult> {
    // Same definition as the gate, or nothing: see `ExternalAdapterDeps.charterVersion`.
    if (call.judgedCharterVersion !== deps.charterVersion) return fail('external_definition_stale', true);
    if (call.credential === null) return fail('credential_unavailable', false);
    const secret = call.credential.value;
    if (typeof secret !== 'string' || !headerSafe(secret)) return fail('credential_unavailable', false);

    if (!isPlainObject(call.input)) return fail('external_unresolved', false);
    const input = call.input;
    const resolved = resolveExternalCall([system], call.toolName, input);
    if (!resolved.ok || resolved.system.id !== system.id) return fail('external_unresolved', false);
    const op = resolved.op;
    const isWrite = op.kind !== 'read';

    // The same payload reading the confirmation echo and the instruction door
    // use (`buildExternalRequestFromPayload`): the request the owner was shown
    // is the request built here.
    const built = buildExternalRequestFromPayload(system, op, input, call.idempotencyKey);
    if (!built.ok) {
      // `built.message` is our own Hebrew sentence (it may quote a param name
      // the plan wrote), never provider text and never the secret.
      return { ok: false, retryable: false, code: 'bad_params', message: built.message };
    }

    // Ruling T7-b, the backstop: the gate hands this adapter the REDACTED
    // payload, and a write must never carry the marker in place of a value the
    // owner approved. The instruction door refuses such a step first; this
    // catches one that arrives anyway. Final, nothing sent, not counted.
    if (carriesRedactionMarker(input['params']) || decodedUrl(built.url).includes(REDACTED)) {
      return fail('external_redacted_value', false);
    }

    // The shared path (`external/perform.ts`): cap, auth, guarded send,
    // outcome table and call log — the same one the daily scan takes.
    const sent = await sendExternal(system, built, secret, isWrite, deps);
    if (!sent.ok) {
      return fail(sent.code, sent.retryable, sent.outcomeUnknown === true ? { outcomeUnknown: true } : {});
    }
    const json = sent.json;
    const forms = secretForms(system, secret);
    const fields = extractSafeFields(json, op.fields, forms);
    const rawId = op.idPath === null ? null : displayValue(readFieldPath(json, op.idPath));
    const externalId = rawId !== null && carriesSecret(rawId, forms) ? null : rawId;
    return { ok: true, output: { fields }, externalId };
  }

  return { system: systemName, channel: 'api', serves: EXTERNAL_SERVES, execute };
}
