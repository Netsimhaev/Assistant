/**
 * The signed webhook receiver (Stage D, Task 11): `POST|GET
 * /hooks/ext/<businessId>/<systemId>` on the dashboard server, with no
 * session and no CSRF token — the system's own secret is the credential.
 *
 * **Who it is for comes from the path, and only the path.** The business is
 * a path segment resolved by one named platform read
 * (`resolveBusinessForHook`, `{ active }` and nothing else); the system is a
 * path segment that must be signed, with a webhook, in that business's
 * ACTIVE charter. Nothing in the body or the headers ever chooses either.
 *
 * **Every failure looks the same:** a 401 with an empty body — an unknown or
 * suspended business, a system that is not signed (or is signed without a
 * webhook), a missing secret, a bad or malformed signature, a stale
 * timestamp, a refused handshake, a signed body that is not JSON. Secrets
 * and signatures are compared in constant time (`timingSafeEqual`, over
 * fixed-length digests where the lengths could differ). A failure is
 * counted (`recordRejectedHook`) only once a real business and a real
 * signed system were resolved — a request naming a business that does not
 * exist writes nothing anywhere.
 *
 * **The HMAC is over the raw bytes.** The body is read with a 256 KB cap
 * (413 past it) and inserted, as bytes, into the signed `signedPayload`
 * template; JSON is parsed only after the signature verified. A body that
 * was re-serialised, re-indented or re-encoded in transit does not verify.
 *
 * **Stored is only what was declared.** A known event type stores
 * `extractFields(body, event.fields)` under `source: 'webhook'`, deduplicated
 * on a hash of the event type and those fields — so a repeated delivery is
 * one row. An unknown event type is a 202 that stores nothing and is counted
 * on the system's reject counter (not the call counter: that one feeds the
 * daily cap on outbound calls, and a provider's chatter must not spend it).
 *
 * **A handshake stores nothing** and answers with exactly the challenge as
 * `text/plain`, only after its own check: a `query_challenge` GET when the
 * mode matches and the token equals `EXT_<ID>_VERIFY`; a `body_challenge`
 * POST only after the signature verified and the body's type is the
 * declared value. The challenge must be 1–200 characters of
 * `[A-Za-z0-9._-]`.
 *
 * Nothing a provider wrote reaches a response or a log: a log line carries
 * at most the system id and a fixed reason code. `X-Forwarded-*` is not read
 * for anything here — the endpoint sits behind the reverse proxy and needs
 * no client address.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadActiveCharter } from '../charter/store.js';
import { withBusiness, type BusinessDb } from '../db/pool.js';
import { EXTERNAL_SYSTEM_ID, externalSecretRefs, type ExternalSystem } from '../domain/external-system.js';
import type { CredentialSource } from '../orchestrator/credentials.js';
import { resolveBusinessForHook } from '../tenancy/platform.js';
import { canonicalHash } from '../util/canonical.js';
import { extractFields, readFieldPath } from './extract.js';
import { insertEvent, recordRejectedHook } from './store.js';

/** The one path this module serves. Anchored; each segment is validated separately. */
export const EXTERNAL_HOOK_PATH = /^\/hooks\/ext\/([^/]+)\/([^/]+)$/;

/** Largest body read before the request is refused with a 413. */
export const EXTERNAL_HOOK_MAX_BYTES = 256 * 1024;

/** How far a signed timestamp may be from the receiver's clock, either way. */
export const EXTERNAL_HOOK_TOLERANCE_SECONDS = 300;

/** Most values a kv signature header may carry under the signature key. */
const MAX_KV_SIGNATURES = 10;
/** Most `key=value` parts a kv header may carry at all. */
const MAX_KV_PARTS = 20;
/** A unix timestamp in seconds: digits only, no sign, no fraction. */
const UNIX_SECONDS = /^[0-9]{1,12}$/;
const CHALLENGE = /^[A-Za-z0-9._-]{1,200}$/;
const HEX = /^[0-9a-fA-F]+$/;

export interface WebhookDeps {
  secrets: CredentialSource;
  now: () => Date;
}

type Webhook = NonNullable<ExternalSystem['webhook']>;
type HmacScheme = Extract<Webhook['scheme'], { kind: 'hmac-sha256' }>;

/** A refusal the caller sees as a bare 401; `reason` is a fixed code for our own log. */
class Refusal {
  constructor(
    readonly reason: string,
    /** True once a real business and a real signed system were resolved. */
    readonly counted: boolean,
  ) {}
}

function noStore(): Record<string, string> {
  return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
}

function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...noStore(), 'Content-Length': '0', ...extra });
  res.end();
}

function sendChallenge(res: ServerResponse, challenge: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...noStore(),
    'Content-Length': String(Buffer.byteLength(challenge)),
  });
  res.end(challenge);
}

/** The raw body, or `null` past `limit` bytes (declared or actual). */
async function readBoundedBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  const within = await new Promise<boolean>((resolveRead, rejectRead) => {
    let total = 0;
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > limit) {
        req.off('data', onData);
        req.off('end', onEnd);
        req.resume();
        resolveRead(false);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => resolveRead(true);
    req.on('data', onData);
    req.on('end', onEnd);
    req.once('error', rejectRead);
  });
  return within ? Buffer.concat(chunks) : null;
}

/** Constant-time equality of two strings of any length: compared as SHA-256 digests. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  // Equal-length digests, so `timingSafeEqual` never throws and its time
  // does not depend on how long either string is.
  return timingSafeEqual(a, b);
}

/** Constant-time equality of two strings; differing lengths are `false`, never a throw. */
function sameBytes(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One header's value, or `null` when absent (Node joins a repeated header into one value, which a kv parse then reads whole). */
function singleHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

/** A kv header (`t=…,v1=…`) as key → values, or `null` when malformed or oversized. */
function parseKv(header: string, separator: string): Map<string, string[]> | null {
  const parts = header.split(separator);
  if (parts.length > MAX_KV_PARTS) return null;
  const out = new Map<string, string[]>();
  for (const raw of parts) {
    const part = raw.trim();
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    const list = out.get(key);
    if (list === undefined) out.set(key, [value]);
    else list.push(value);
  }
  return out;
}

/** The signed timestamp as a string of digits, or a refusal. */
function readTimestamp(
  scheme: HmacScheme,
  req: IncomingMessage,
  kv: Map<string, string[]> | null,
  now: Date,
): string | null {
  const source = scheme.timestamp;
  if (source === null) return null;
  let value: string | null;
  if (source.from === 'header') {
    value = singleHeader(req, source.header);
  } else {
    const values = kv?.get(source.key);
    value = values !== undefined && values.length === 1 ? (values[0] ?? null) : null;
  }
  if (value === null || !UNIX_SECONDS.test(value)) throw new Refusal('bad_timestamp', true);
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(value));
  if (skew > EXTERNAL_HOOK_TOLERANCE_SECONDS) throw new Refusal('stale_timestamp', true);
  return value;
}

/** The template filled with the timestamp and the raw body bytes. */
function signedBytes(template: string, timestamp: string | null, body: Buffer): Buffer {
  const pieces: Buffer[] = [];
  let at = 0;
  for (const match of template.matchAll(/\{(timestamp|body)\}/g)) {
    pieces.push(Buffer.from(template.slice(at, match.index), 'utf8'));
    if (match[1] === 'body') pieces.push(body);
    else {
      // The schema refuses `{timestamp}` without a timestamp source.
      if (timestamp === null) throw new Refusal('bad_timestamp', true);
      pieces.push(Buffer.from(timestamp, 'utf8'));
    }
    at = match.index + match[0].length;
  }
  pieces.push(Buffer.from(template.slice(at), 'utf8'));
  return Buffer.concat(pieces);
}

/** Whether `given` is the HMAC `expected`, in the scheme's encoding, in constant time. */
function signatureMatches(given: string, expected: Buffer, encoding: 'hex' | 'base64'): boolean {
  if (encoding === 'hex') {
    if (!HEX.test(given)) return false;
    return sameBytes(given.toLowerCase(), expected.toString('hex'));
  }
  return sameBytes(given, expected.toString('base64'));
}

function verifyHmac(scheme: HmacScheme, req: IncomingMessage, body: Buffer, secret: string, now: Date): void {
  const source = scheme.signature;
  const header = singleHeader(req, source.header);
  if (header === null || header.length === 0) throw new Refusal('missing_signature', true);

  let candidates: string[];
  let kv: Map<string, string[]> | null = null;
  if (source.from === 'header') {
    if (source.prefix !== null) {
      if (!header.startsWith(source.prefix)) throw new Refusal('bad_signature', true);
      candidates = [header.slice(source.prefix.length)];
    } else {
      candidates = [header];
    }
  } else {
    kv = parseKv(header, source.separator);
    if (kv === null) throw new Refusal('malformed_signature', true);
    candidates = kv.get(source.key) ?? [];
    if (candidates.length === 0 || candidates.length > MAX_KV_SIGNATURES) {
      throw new Refusal('malformed_signature', true);
    }
  }
  if (scheme.timestamp?.from === 'kv' && kv === null) throw new Refusal('bad_timestamp', true);

  const timestamp = readTimestamp(scheme, req, kv, now);
  const expected = createHmac('sha256', secret).update(signedBytes(scheme.signedPayload, timestamp, body)).digest();
  // Every candidate is compared, even after a match, so the work does not
  // depend on which position held the right one.
  let ok = false;
  for (const candidate of candidates) {
    if (signatureMatches(candidate, expected, scheme.encoding)) ok = true;
  }
  if (!ok) throw new Refusal('bad_signature', true);
}

async function resolveSecret(
  deps: WebhookDeps,
  db: BusinessDb,
  ref: string,
): Promise<string> {
  const handle = await deps.secrets.resolve(ref, db.businessId, db);
  if (handle === null) throw new Refusal('missing_secret', true);
  return handle.value;
}

/** The signed webhook of `systemId` in the active charter, or a refusal that is not counted. */
async function signedWebhook(db: BusinessDb, systemId: string): Promise<Webhook> {
  let active;
  try {
    active = await loadActiveCharter(db);
  } catch {
    throw new Refusal('charter_unreadable', false);
  }
  const system = active?.charter.externalSystems.find((s) => s.id === systemId);
  if (system === undefined || system.webhook === null) throw new Refusal('not_signed', false);
  return system.webhook;
}

/** The query parameter, when it appears exactly once. */
function onlyParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

async function handleQueryChallenge(
  deps: WebhookDeps,
  db: BusinessDb,
  systemId: string,
  webhook: Webhook,
  params: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const handshake = webhook.handshake;
  if (handshake?.kind !== 'query_challenge') throw new Refusal('no_query_handshake', true);
  const token = await resolveSecret(deps, db, externalSecretRefs(systemId).verify);
  const mode = onlyParam(params, handshake.modeParam);
  const given = onlyParam(params, handshake.tokenParam);
  const challenge = onlyParam(params, handshake.challengeParam);
  // All three checked before deciding, so a wrong mode costs what a wrong token does.
  const modeOk = mode !== null && sameSecret(mode, handshake.modeValue);
  const tokenOk = given !== null && sameSecret(given, token);
  const challengeOk = challenge !== null && CHALLENGE.test(challenge);
  if (!modeOk || !tokenOk || !challengeOk || challenge === null) throw new Refusal('bad_handshake', true);
  sendChallenge(res, challenge);
}

async function handleSignedPost(
  deps: WebhookDeps,
  db: BusinessDb,
  systemId: string,
  webhook: Webhook,
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
): Promise<void> {
  const secret = await resolveSecret(deps, db, externalSecretRefs(systemId).hook);
  const scheme = webhook.scheme;
  if (scheme.kind === 'shared-secret') {
    const given = singleHeader(req, scheme.header);
    if (given === null || !sameSecret(given, secret)) throw new Refusal('bad_signature', true);
  } else {
    verifyHmac(scheme, req, body, secret, deps.now());
  }

  // Verified: only now is the body parsed. Not JSON → 401, nothing stored
  // (chosen over 400 so every refusal reads the same to the caller).
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Refusal('unparseable_body', true);
  }

  const type = webhook.typePath === null ? webhook.events[0]?.type : readFieldPath(json, webhook.typePath);

  const handshake = webhook.handshake;
  if (handshake?.kind === 'body_challenge' && typeof type === 'string' && type === handshake.typeValue) {
    const challenge = readFieldPath(json, handshake.challengePath);
    if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) throw new Refusal('bad_handshake', true);
    sendChallenge(res, challenge);
    return;
  }

  const event = typeof type === 'string' ? webhook.events.find((e) => e.type === type) : undefined;
  if (event === undefined) {
    // Authentic, but not something the owner signed for: counted, dropped.
    await recordRejectedHook(db, systemId, 'unknown_event_type');
    sendEmpty(res, 202);
    return;
  }
  const fields = extractFields(json, event.fields);
  await insertEvent(db, {
    systemId,
    source: 'webhook',
    eventType: event.type,
    // The type is part of the identity: two events whose declared fields
    // happen to coincide are two deliveries, not one.
    itemHash: canonicalHash({ eventType: event.type, fields }),
    fields,
  });
  sendEmpty(res, 202);
}

/**
 * Serve one request on `EXTERNAL_HOOK_PATH`. The caller has matched the path;
 * this re-matches it, so nothing else can be served by mistake.
 */
export async function handleExternalWebhook(req: IncomingMessage, res: ServerResponse, deps: WebhookDeps): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://hook.local');
  const match = EXTERNAL_HOOK_PATH.exec(url.pathname);
  if (match === null) return sendEmpty(res, 404);
  if (method !== 'GET' && method !== 'POST') {
    req.resume();
    return sendEmpty(res, 405, { Allow: 'GET, POST' });
  }

  // The body first, bounded, before anything is parsed or looked up.
  let body: Buffer = Buffer.alloc(0);
  if (method === 'POST') {
    const read = await readBoundedBody(req, EXTERNAL_HOOK_MAX_BYTES);
    if (read === null) return sendEmpty(res, 413, { Connection: 'close' });
    body = read;
  } else {
    req.resume();
  }

  const businessId = match[1] ?? '';
  const systemId = match[2] ?? '';
  try {
    if (!EXTERNAL_SYSTEM_ID.test(systemId)) throw new Refusal('bad_system_id', false);
    const business = await resolveBusinessForHook(businessId);
    if (business === null || !business.active) throw new Refusal('no_business', false);

    await withBusiness(businessId, async (db) => {
      const webhook = await signedWebhook(db, systemId);
      try {
        if (method === 'GET') await handleQueryChallenge(deps, db, systemId, webhook, url.searchParams, res);
        else await handleSignedPost(deps, db, systemId, webhook, req, body, res);
      } catch (err) {
        if (err instanceof Refusal && err.counted) await recordRejectedHook(db, systemId, err.reason);
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof Refusal) {
      if (err.counted) console.warn(`external webhook refused: system=${systemId} reason=${err.reason}`);
      if (!res.headersSent) sendEmpty(res, 401);
      return;
    }
    // A fault of ours (the database, the pool) — not the caller's. A 503 so a
    // provider retries; the error itself is never echoed or logged.
    console.error(`external webhook failed: system=${EXTERNAL_SYSTEM_ID.test(systemId) ? systemId : '-'} reason=internal`);
    if (!res.headersSent) sendEmpty(res, 503);
  }
}
