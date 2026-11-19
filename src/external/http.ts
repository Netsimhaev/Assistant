/**
 * The guarded HTTPS client (Stage D, Task 5). Every external call goes
 * through `send`, and nothing else in `src/external/` opens a socket.
 *
 * Four controls, each enforced here and not left to the caller:
 *
 * 1. **The address is checked on the socket that is actually used.** The
 *    guard runs inside the `lookup` option Node's `net.connect` calls, so the
 *    address that was checked IS the address that is dialled — a second
 *    resolution between "check" and "connect" (DNS rebinding) has nowhere to
 *    happen. Every address DNS returned must be allowed; one forbidden
 *    address refuses the call, and so does an empty answer. Node skips
 *    `lookup` for an IP-literal hostname, so that case is checked explicitly
 *    before the request is built.
 * 2. **Redirects are never followed.** `node:https` does not follow them; a
 *    3xx comes back as `kind: 'response'` with its status and body, and the
 *    caller decides (it treats it as a failure).
 * 3. **The deadline is a race, not a hint.** A timer races the request and,
 *    on expiry, destroys it. An `AbortSignal` alone would leave a promise
 *    hanging on a peer that ignores it.
 * 4. **The body is capped while it streams.** Bytes are counted per chunk;
 *    crossing `maxBytes` destroys the request at once. `accept-encoding:
 *    identity` is always sent and nothing is decompressed, so a compressed
 *    bomb cannot slip under the byte cap.
 *
 * `sent` on `network`/`timeout` answers "may the peer have acted on this
 * request?", and it errs toward yes. It is false only while no request byte
 * can have left the process: before the TLS handshake completed (Node queues
 * the request until then). From the moment the handshake completes — or
 * `finish` fires — it is true. `finish` alone does not mean "fully written":
 * it was measured firing with 16MB of body still buffered in the process,
 * and a server may act on the headers before it reads the body. A wrong
 * `false` is the dangerous direction (the caller would treat the call as not
 * made and could repeat it); a wrong `true` only costs a "may have happened"
 * re-ask — the same distinction `adapter_timeout` and `delivery_unknown`
 * carry elsewhere.
 *
 * Test seams live under `__testOnly` and nowhere else: production code calls
 * `createGuardedHttps()` with no argument.
 */
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { isForbiddenAddress } from './address-guard.js';

export const EXTERNAL_DEADLINE_MS = 30_000;
export const EXTERNAL_MAX_BYTES = 1_048_576;

export interface ExternalRequest {
  method: string;
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: string | null;
  deadlineMs: number;
  maxBytes: number;
}

export type ExternalResult =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'refused_address' }
  | { kind: 'too_large' }
  | { kind: 'network'; sent: boolean }
  | { kind: 'timeout'; sent: boolean };

export interface ExternalHttp {
  send(req: ExternalRequest): Promise<ExternalResult>;
}

/**
 * TEST ONLY. Never passed in production. `ca` trusts a local self-signed
 * server; `resolve` replaces `dns.lookup(host, { all: true })`; `isForbidden`
 * replaces the address guard (a permissive guard lets a test reach
 * 127.0.0.1). A test that must prove the real guard refuses passes `resolve`
 * and/or `ca` only.
 */
export interface GuardedHttpsTestOnly {
  ca?: string;
  resolve?: (host: string) => Promise<LookupAddress[]>;
  isForbidden?: (ip: string) => boolean;
}

export interface GuardedHttpsOptions {
  __testOnly?: GuardedHttpsTestOnly;
}

/** Marks a lookup failure that is the guard's refusal, not a DNS error. */
class AddressRefusedError extends Error {
  readonly code = 'EXTERNAL_ADDRESS_REFUSED';
  constructor() {
    super('external address refused by the guard');
    this.name = 'AddressRefusedError';
  }
}

function systemResolve(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(
  resolve: (host: string) => Promise<LookupAddress[]>,
  isForbidden: (ip: string) => boolean,
): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => isForbidden(a.address))) {
          callback(new AddressRefusedError(), '', 0);
          return;
        }
        // Every address here was checked. Honour a family Node asked for.
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
        const usable = wanted === 0 ? addresses : addresses.filter((a) => a.family === wanted);
        const first = usable[0];
        if (first === undefined) {
          const err: NodeJS.ErrnoException = new Error(`no address of family ${String(wanted)}`);
          err.code = 'ENOTFOUND';
          callback(err, '', 0);
          return;
        }
        if (options.all === true) callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}

function bareHost(url: URL): string {
  const h = url.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function outgoingHeaders(req: ExternalRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    // Set below, by this module only.
    if (lower === 'accept-encoding' || lower === 'content-length') continue;
    headers[name] = value;
  }
  headers['accept-encoding'] = 'identity';
  if (req.body !== null) headers['content-length'] = String(Buffer.byteLength(req.body, 'utf8'));
  return headers;
}

export function createGuardedHttps(options: GuardedHttpsOptions = {}): ExternalHttp {
  const seams = options.__testOnly ?? {};
  const isForbidden = seams.isForbidden ?? isForbiddenAddress;
  const lookup = guardedLookup(seams.resolve ?? systemResolve, isForbidden);

  return {
    send(req: ExternalRequest): Promise<ExternalResult> {
      if (req.url.protocol !== 'https:') {
        return Promise.reject(new TypeError('guarded client: only https URLs are allowed'));
      }
      const host = bareHost(req.url);
      if (isIP(host) !== 0 && isForbidden(host)) {
        return Promise.resolve({ kind: 'refused_address' });
      }

      return new Promise<ExternalResult>((resolve) => {
        let settled = false;
        let finished = false;
        let secured = false;
        let clientReq: ClientRequest | null = null;
        // Errs toward true on purpose — see the module doc.
        const sent = (): boolean => secured || finished;

        const settle = (result: ExternalResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clientReq?.destroy();
          resolve(result);
        };

        const timer = setTimeout(() => settle({ kind: 'timeout', sent: sent() }), Math.max(0, req.deadlineMs));

        const onResponse = (res: IncomingMessage): void => {
          // A response means the peer has read the request.
          secured = true;
          finished = true;
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > req.maxBytes) {
            settle({ kind: 'too_large' });
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            if (settled) return;
            total += chunk.length;
            if (total > req.maxBytes) {
              settle({ kind: 'too_large' });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            settle({ kind: 'response', status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('aborted', () => settle({ kind: 'network', sent: true }));
          res.on('error', () => settle({ kind: 'network', sent: true }));
        };

        try {
          clientReq = httpsRequest(
            req.url,
            {
              method: req.method,
              headers: outgoingHeaders(req),
              lookup,
              agent: false,
              ...(seams.ca !== undefined ? { ca: seams.ca } : {}),
            },
            onResponse,
          );
        } catch {
          settle({ kind: 'network', sent: false });
          return;
        }

        clientReq.on('socket', (socket) => {
          const tls = socket as TLSSocket;
          tls.once('secureConnect', () => {
            secured = true;
          });
        });
        clientReq.on('finish', () => {
          finished = true;
        });
        clientReq.on('error', (err: NodeJS.ErrnoException) => {
          if (err instanceof AddressRefusedError) settle({ kind: 'refused_address' });
          else settle({ kind: 'network', sent: sent() });
        });
        clientReq.end(req.body ?? undefined);
      });
    },
  };
}
