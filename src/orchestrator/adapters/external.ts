import type { ExternalSystem } from '../../domain/external-system.js';
import { extractFields, readFieldPath, displayValue } from '../../external/extract.js';
import {
  EXTERNAL_DEADLINE_MS,
  EXTERNAL_MAX_BYTES,
  type ExternalHttp,
  type ExternalResult,
} from '../../external/http.js';
import { buildExternalRequest } from '../../external/request.js';
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
} as const;

type ExternalCode = keyof typeof EXTERNAL_MESSAGES_HE;

export interface ExternalAdapterDeps {
  http: ExternalHttp;
  /** Calls already made today to this system, in the charter's time zone. */
  callsToday: (systemId: string) => Promise<number>;
  /** Counts one attempt that reached `http.send`. `outcome` is a fixed code. */
  recordCall: (call: { systemId: string; outcome: string }) => Promise<void>;
  capPerDay: number;
}

function fail(code: ExternalCode, retryable: boolean, extra: { outcomeUnknown?: true } = {}): AdapterResult {
  return { ok: false, retryable, code, message: EXTERNAL_MESSAGES_HE[code], ...extra };
}

/**
 * A secret usable as a header value: printable ASCII, no spaces at the ends,
 * nothing that could end the header line. Anything else is refused before a
 * request exists, rather than left for the HTTP stack to throw on.
 */
function headerSafe(secret: string): boolean {
  return /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(secret);
}

function authHeader(system: ExternalSystem, secret: string): [string, string] {
  switch (system.auth.kind) {
    case 'bearer':
      return ['Authorization', `Bearer ${secret}`];
    case 'basic':
      return ['Authorization', `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`];
    case 'header':
      return [system.auth.header, secret];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The JSON body of a response, or `undefined` when it is not JSON. */
function parseJson(body: string): unknown {
  if (body.trim() === '') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** The outcome of one send, for a read (`isWrite: false`) or a write. */
function classify(result: ExternalResult, isWrite: boolean): ExternalCode | 'ok' | 'timeout_unknown' | 'timeout' {
  switch (result.kind) {
    case 'refused_address':
      return 'external_address_refused';
    case 'too_large':
      // The far end answered, so a write may well have landed; the status is
      // not known to us. A read just cannot be used.
      return isWrite ? 'delivery_unknown' : 'external_response_too_large';
    case 'timeout':
      return isWrite && result.sent ? 'timeout_unknown' : 'timeout';
    case 'network':
      if (!result.sent) return 'external_network';
      return isWrite ? 'delivery_unknown' : 'external_network';
    case 'response': {
      const s = result.status;
      if (s >= 200 && s <= 299) return 'ok';
      if (s === 401 || s === 403) return 'external_auth';
      if (!isWrite && (s === 429 || (s >= 500 && s <= 599))) return 'external_unavailable';
      if (isWrite && (s === 429 || s === 503)) return 'external_unavailable';
      if (isWrite && s >= 500 && s <= 599) return 'delivery_unknown';
      if (s >= 400 && s <= 499) return 'external_rejected';
      // 1xx / 3xx (redirects are never followed). A write answered with a
      // redirect may have been performed (POST-then-redirect), so it is
      // ambiguous; a read simply did not get its answer.
      return isWrite ? 'delivery_unknown' : 'external_rejected';
    }
  }
}

const RETRYABLE: ReadonlySet<ExternalCode> = new Set<ExternalCode>([
  'external_daily_cap',
  'external_cap_unreadable',
  'external_unavailable',
  'external_network',
  'adapter_timeout',
]);

export function createExternalAdapter(system: ExternalSystem, deps: ExternalAdapterDeps): ExternalAdapter {
  const systemName = `ext:${system.id}`;

  async function count(outcome: string): Promise<void> {
    // Bookkeeping, not control: the call already happened, and a failed
    // INSERT must not turn its outcome into a different one.
    await deps.recordCall({ systemId: system.id, outcome }).catch(() => {
      console.error(`[external] could not record a call for ${systemName}`);
    });
  }

  async function execute(call: AdapterCall): Promise<AdapterResult> {
    if (call.credential === null) return fail('credential_unavailable', false);
    const secret = call.credential.value;
    if (typeof secret !== 'string' || !headerSafe(secret)) return fail('credential_unavailable', false);

    if (!isPlainObject(call.input)) return fail('external_unresolved', false);
    const input = call.input;
    const resolved = resolveExternalCall([system], call.toolName, input);
    if (!resolved.ok || resolved.system.id !== system.id) return fail('external_unresolved', false);
    const op = resolved.op;
    const isWrite = op.kind !== 'read';

    // Own keys only. `params` must be an object; the amount is passed through
    // untouched for `buildExternalRequest` to validate against the operation.
    let params: Record<string, unknown> | undefined;
    if (Object.hasOwn(input, 'params')) {
      const p = input['params'];
      if (!isPlainObject(p)) {
        return { ok: false, retryable: false, code: 'bad_params', message: 'הפרמטרים לפעולה אינם תקינים — לא נשלח דבר' };
      }
      params = p;
    }
    const requestInput: { params?: Record<string, unknown>; amountMinor?: number } = {
      ...(params !== undefined ? { params } : {}),
      ...(Object.hasOwn(input, 'amountMinor') ? { amountMinor: input['amountMinor'] as number } : {}),
    };
    const built = buildExternalRequest(system, op, requestInput, call.idempotencyKey);
    if (!built.ok) {
      // `built.message` is our own Hebrew sentence (it may quote a param name
      // the plan wrote), never provider text and never the secret.
      return { ok: false, retryable: false, code: 'bad_params', message: built.message };
    }

    let today: number;
    try {
      today = await deps.callsToday(system.id);
    } catch {
      return fail('external_cap_unreadable', true);
    }
    if (today >= deps.capPerDay) return fail('external_daily_cap', true);

    const [authName, authValue] = authHeader(system, secret);
    const headers: Record<string, string> = { ...built.headers, [authName]: authValue };

    let result: ExternalResult;
    try {
      result = await deps.http.send({
        method: built.method,
        url: built.url,
        headers,
        body: built.body,
        deadlineMs: EXTERNAL_DEADLINE_MS,
        maxBytes: EXTERNAL_MAX_BYTES,
      });
    } catch {
      // Nothing from the thrown error is kept — it may quote a header.
      const code: ExternalCode = isWrite ? 'delivery_unknown' : 'external_request_failed';
      await count(code);
      return fail(code, false);
    }

    const outcome = classify(result, isWrite);
    if (outcome === 'ok' && result.kind === 'response') {
      await count('ok');
      const json = parseJson(result.body);
      const fields = extractFields(json, op.fields);
      const externalId = op.idPath === null ? null : displayValue(readFieldPath(json, op.idPath));
      return { ok: true, output: { fields }, externalId };
    }
    if (outcome === 'timeout' || outcome === 'timeout_unknown') {
      await count('adapter_timeout');
      return fail('adapter_timeout', true, outcome === 'timeout_unknown' ? { outcomeUnknown: true } : {});
    }
    const code: ExternalCode = outcome === 'ok' ? 'external_request_failed' : outcome;
    await count(code);
    return fail(code, RETRYABLE.has(code));
  }

  return { system: systemName, channel: 'api', serves: EXTERNAL_SERVES, execute };
}
