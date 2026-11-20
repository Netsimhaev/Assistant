import type { ExternalSystem } from '../domain/external-system.js';
import { extractFields } from './extract.js';
import {
  EXTERNAL_DEADLINE_MS,
  EXTERNAL_MAX_BYTES,
  type ExternalHttp,
  type ExternalResult,
} from './http.js';

/**
 * The one way a request reaches an external system — shared by the adapter
 * (`orchestrator/adapters/external.ts`, an `ext.read`/`ext.call` step under a
 * boss command) and the daily scan (`external/scan.ts`, ruling 9 of the plan:
 * a documented gate bypass authorised by the owner's signature on the `scan`
 * block). Two callers, one path, so the scan cannot drift from the adapter on
 * any of the controls that matter: the daily cap checked against the same
 * count, the same auth header built from the same resolved credential, the
 * same guarded client, the same outcome table, the same call log, and the
 * same stripping of a secret a provider echoes back.
 *
 * The request itself is built by the caller with `buildExternalRequest`
 * (same builder for both); this module never builds a URL.
 */

/** The outcome codes this path can produce. Each has a Hebrew sentence in the adapter. */
export type ExternalSendCode =
  | 'external_daily_cap'
  | 'external_cap_unreadable'
  | 'external_disabled'
  | 'external_address_refused'
  | 'external_auth'
  | 'external_unavailable'
  | 'external_rejected'
  | 'external_network'
  | 'external_response_too_large'
  | 'external_request_failed'
  | 'external_bad_url'
  | 'adapter_timeout'
  | 'delivery_unknown';

export const RETRYABLE_SEND_CODES: ReadonlySet<ExternalSendCode> = new Set<ExternalSendCode>([
  'external_daily_cap',
  'external_cap_unreadable',
  'external_unavailable',
  'external_network',
  'adapter_timeout',
]);

export interface ExternalSendDeps {
  http: ExternalHttp;
  /** Calls already made today to this system, in the charter's time zone. */
  callsToday: (systemId: string) => Promise<number>;
  /** Counts one attempt that reached `http.send`. `outcome` is a fixed code. */
  recordCall: (call: { systemId: string; outcome: string }) => Promise<void>;
  /** 0 means external calls are switched off. */
  capPerDay: number;
}

export interface BuiltExternalRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | null;
}

export type ExternalSendOutcome =
  | { ok: true; json: unknown }
  | { ok: false; code: ExternalSendCode; retryable: boolean; outcomeUnknown?: true };

/**
 * A secret usable as a header value: printable ASCII, no spaces at the ends,
 * nothing that could end the header line. Anything else is refused before a
 * request exists, rather than left for the HTTP stack to throw on.
 */
export function headerSafe(secret: string): boolean {
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

/** The JSON body of a response, or `undefined` when it is not JSON. */
export function parseJson(body: string): unknown {
  if (body.trim() === '') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** The outcome of one send, for a read (`isWrite: false`) or a write. */
function classify(
  result: ExternalResult,
  isWrite: boolean,
): ExternalSendCode | 'ok' | 'timeout_unknown' | 'timeout' {
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

/**
 * The secret in every form this path sends it: raw, and for basic auth its
 * base64. A field value that contains any of them is dropped — a provider
 * echoing the Authorization header must never land the key in a field.
 */
export function secretForms(system: ExternalSystem, secret: string): string[] {
  const forms = [secret];
  if (system.auth.kind === 'basic') forms.push(Buffer.from(secret, 'utf8').toString('base64'));
  return forms;
}

export function carriesSecret(value: string, forms: readonly string[]): boolean {
  return forms.some((form) => value.includes(form));
}

/** `extractFields`, minus every value that carries the secret in any form it was sent. */
export function extractSafeFields(
  json: unknown,
  fields: Parameters<typeof extractFields>[1],
  forms: readonly string[],
): { label: string; value: string }[] {
  return extractFields(json, fields).filter((f) => !carriesSecret(f.value, forms));
}

/**
 * Cap check → auth header → one guarded send → classification → call log.
 * Never throws for a provider failure; returns a code. Every attempt that
 * reached `http.send` is counted with a fixed code, success or not.
 */
export async function sendExternal(
  system: ExternalSystem,
  built: BuiltExternalRequest,
  secret: string,
  isWrite: boolean,
  deps: ExternalSendDeps,
): Promise<ExternalSendOutcome> {
  const fail = (code: ExternalSendCode, extra: { outcomeUnknown?: true } = {}): ExternalSendOutcome => ({
    ok: false,
    code,
    retryable: RETRYABLE_SEND_CODES.has(code),
    ...extra,
  });
  async function count(outcome: string): Promise<void> {
    // Bookkeeping, not control: the call already happened, and a failed
    // INSERT must not turn its outcome into a different one.
    await deps.recordCall({ systemId: system.id, outcome }).catch(() => {
      console.error(`[external] could not record a call for ext:${system.id}`);
    });
  }

  if (deps.capPerDay <= 0) return { ok: false, code: 'external_disabled', retryable: false };
  let today: number;
  try {
    today = await deps.callsToday(system.id);
  } catch {
    return fail('external_cap_unreadable');
  }
  if (today >= deps.capPerDay) return fail('external_daily_cap');

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
  } catch (error) {
    // Nothing from the thrown error is kept — it may quote a header. The one
    // throw placed BEFORE any send is the client's refusal of a non-https
    // URL (a TypeError): a final refusal, never "maybe done". Any other
    // throw cannot be placed, so a write is `delivery_unknown`.
    const beforeSend = error instanceof TypeError && built.url.protocol !== 'https:';
    const code: ExternalSendCode = beforeSend
      ? 'external_bad_url'
      : isWrite
        ? 'delivery_unknown'
        : 'external_request_failed';
    await count(code);
    return { ok: false, code, retryable: false };
  }

  const outcome = classify(result, isWrite);
  if (outcome === 'ok' && result.kind === 'response') {
    await count('ok');
    return { ok: true, json: parseJson(result.body) };
  }
  if (outcome === 'timeout' || outcome === 'timeout_unknown') {
    await count('adapter_timeout');
    return fail('adapter_timeout', outcome === 'timeout_unknown' ? { outcomeUnknown: true } : {});
  }
  const code: ExternalSendCode = outcome === 'ok' ? 'external_request_failed' : outcome;
  await count(code);
  return fail(code);
}
