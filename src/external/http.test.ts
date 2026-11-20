import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createTlsServer, type TLSSocket as TLSSocketType } from 'node:tls';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
  EXTERNAL_DEADLINE_MS,
  EXTERNAL_MAX_BYTES,
  createGuardedHttps,
  type ExternalRequest,
  type GuardedHttpsTestOnly,
} from './http.js';

// A self-signed test certificate (CN=external-http-test, SAN localhost,
// api.example.test, 127.0.0.1, valid to 2126). Obvious test material; it
// protects nothing.
const TEST_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtiP0j1/JCc9P2Uv4\nP14J9gy/fC5TO+x59raCKSqJzmahRANCAAQGIHvfjCFfL+6z9M1hUkLyKrq6PZzQ\nTSsJe5z3l3fkAAtVbazmfJ4HZ4tiMDz0RUg3Lm0F7FgK0vhmsJJKyvrv\n-----END PRIVATE KEY-----\n';
const TEST_CERT =
  '-----BEGIN CERTIFICATE-----\nMIIBwDCCAWagAwIBAgIUChmNLkghQgQswzVnX6pUf6gBwQwwCgYIKoZIzj0EAwIw\nHTEbMBkGA1UEAwwSZXh0ZXJuYWwtaHR0cC10ZXN0MCAXDTI2MTExODIzMzQ0M1oY\nDzIxMjYxMDI1MjMzNDQzWjAdMRswGQYDVQQDDBJleHRlcm5hbC1odHRwLXRlc3Qw\nWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQGIHvfjCFfL+6z9M1hUkLyKrq6PZzQ\nTSsJe5z3l3fkAAtVbazmfJ4HZ4tiMDz0RUg3Lm0F7FgK0vhmsJJKyvrvo4GBMH8w\nHQYDVR0OBBYEFGekf466lnMNUOA6BYKaoYhWofV7MB8GA1UdIwQYMBaAFGekf466\nlnMNUOA6BYKaoYhWofV7MA8GA1UdEwEB/wQFMAMBAf8wLAYDVR0RBCUwI4IJbG9j\nYWxob3N0ghBhcGkuZXhhbXBsZS50ZXN0hwR/AAABMAoGCCqGSM49BAMCA0gAMEUC\nIQDwCP5w9Bi2+0SnR+Z+N70gg187L1Wnf9TUCty/H+63FQIgc+d0xSIQ3pVfuAQp\nicRga3JfS8iBNO83dnI+kGdPeHY=\n-----END CERTIFICATE-----\n';

const HOST = 'api.example.test';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface Running {
  port: number;
  connections: number;
  requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function startHttps(handler: Handler): Promise<Running> {
  const state: Running = { port: 0, connections: 0, requests: [] };
  const sockets = new Set<Socket>();
  const server: HttpsServer = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on('connection', (s: Socket) => {
    state.connections += 1;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return state;
}

/** A TCP server that accepts and then says nothing — the TLS handshake never completes. */
async function startSilentTcp(): Promise<{ port: number; connections: () => number }> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((s) => {
    count += 1;
    sockets.add(s);
    s.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return { port, connections: () => count };
}

/** Resolves every name to 127.0.0.1, and records each call. */
function loopbackResolver(calls: string[]): NonNullable<GuardedHttpsTestOnly['resolve']> {
  return async (host) => {
    calls.push(host);
    return [{ address: '127.0.0.1', family: 4 }];
  };
}

function permissive(calls: string[] = []): GuardedHttpsTestOnly {
  return { ca: TEST_CERT, resolve: loopbackResolver(calls), isForbidden: () => false };
}

function request(port: number, overrides: Partial<ExternalRequest> = {}): ExternalRequest {
  return {
    method: 'GET',
    url: new URL(`https://${HOST}:${port}/v1/things?x=1`),
    headers: { accept: 'application/json' },
    body: null,
    deadlineMs: 5_000,
    maxBytes: 64 * 1024,
    ...overrides,
  };
}

describe('constants', () => {
  it('match the brief', () => {
    expect(EXTERNAL_DEADLINE_MS).toBe(30_000);
    expect(EXTERNAL_MAX_BYTES).toBe(1_048_576);
  });
});

describe('createGuardedHttps — the address guard runs inside lookup', () => {
  it('refuses a hostname that resolves to 127.0.0.1, with the REAL guard, before any connection', async () => {
    const server = await startHttps((_q, res) => res.end('should never be reached'));
    const calls: string[] = [];
    // Only the resolver and the CA are injected; the guard is the real one.
    const http = createGuardedHttps({ __testOnly: { ca: TEST_CERT, resolve: loopbackResolver(calls) } });
    const result = await http.send(request(server.port));
    expect(result).toEqual({ kind: 'refused_address' });
    // The refusal came from inside lookup: it ran for our host, and the socket never connected.
    expect(calls).toEqual([HOST]);
    expect(server.connections).toBe(0);
  });

  it('refuses when ANY returned address is forbidden, even if another is public', async () => {
    const server = await startHttps((_q, res) => res.end('no'));
    const http = createGuardedHttps({
      __testOnly: {
        ca: TEST_CERT,
        resolve: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      },
    });
    expect(await http.send(request(server.port))).toEqual({ kind: 'refused_address' });
    expect(server.connections).toBe(0);
  });

  it('refuses an empty DNS answer', async () => {
    const server = await startHttps((_q, res) => res.end('no'));
    const http = createGuardedHttps({ __testOnly: { ca: TEST_CERT, resolve: async () => [] } });
    expect(await http.send(request(server.port))).toEqual({ kind: 'refused_address' });
    expect(server.connections).toBe(0);
  });

  it('refuses localhost through the real system resolver', async () => {
    const server = await startHttps((_q, res) => res.end('no'));
    const http = createGuardedHttps({ __testOnly: { ca: TEST_CERT } });
    const result = await http.send({ ...request(server.port), url: new URL(`https://localhost:${server.port}/`) });
    expect(result).toEqual({ kind: 'refused_address' });
    expect(server.connections).toBe(0);
  });

  it('refuses an IP-literal hostname (Node never calls lookup for one)', async () => {
    const server = await startHttps((_q, res) => res.end('no'));
    const calls: string[] = [];
    const http = createGuardedHttps({ __testOnly: { ca: TEST_CERT, resolve: loopbackResolver(calls) } });
    for (const url of [`https://127.0.0.1:${server.port}/`, `https://[::1]:${server.port}/`, `https://[::ffff:7f00:1]:${server.port}/`]) {
      expect(await http.send({ ...request(server.port), url: new URL(url) })).toEqual({ kind: 'refused_address' });
    }
    expect(calls).toEqual([]);
    expect(server.connections).toBe(0);
  });

  it('connects when the guard is made permissive (test seam), and returns the response', async () => {
    const server = await startHttps((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"name":"שלום"}');
    });
    const calls: string[] = [];
    const http = createGuardedHttps({ __testOnly: permissive(calls) });
    const result = await http.send(request(server.port));
    expect(result).toEqual({ kind: 'response', status: 200, body: '{"ok":true,"name":"שלום"}' });
    expect(calls).toEqual([HOST]);
    expect(server.requests[0]?.url).toBe('/v1/things?x=1');
  });
});

describe('createGuardedHttps — request and response', () => {
  it('sends the body, the caller headers, and accept-encoding: identity over whatever the caller set', async () => {
    const server = await startHttps((_q, res) => res.end('done'));
    const http = createGuardedHttps({ __testOnly: permissive() });
    const result = await http.send(
      request(server.port, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Accept-Encoding': 'gzip, br', authorization: 'Bearer test' },
        body: '{"a":"ב"}',
      }),
    );
    expect(result).toEqual({ kind: 'response', status: 200, body: 'done' });
    const seen = server.requests[0];
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('{"a":"ב"}');
    expect(seen?.headers['accept-encoding']).toBe('identity');
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(seen?.headers['authorization']).toBe('Bearer test');
    expect(seen?.headers['content-length']).toBe(String(Buffer.byteLength('{"a":"ב"}')));
  });

  it('returns a 302 as a response and does not follow it', async () => {
    const server = await startHttps((req, res) => {
      if (req.url === '/elsewhere') {
        res.end('followed');
        return;
      }
      res.writeHead(302, { location: `https://${HOST}:${(req.socket.localPort ?? 0).toString()}/elsewhere` });
      res.end('moved');
    });
    const http = createGuardedHttps({ __testOnly: permissive() });
    const result = await http.send(request(server.port));
    expect(result).toEqual({ kind: 'response', status: 302, body: 'moved' });
    expect(server.requests.map((r) => r.url)).toEqual(['/v1/things?x=1']);
  });

  it('returns error statuses as responses', async () => {
    const server = await startHttps((_q, res) => {
      res.writeHead(503);
      res.end('busy');
    });
    const http = createGuardedHttps({ __testOnly: permissive() });
    expect(await http.send(request(server.port))).toEqual({ kind: 'response', status: 503, body: 'busy' });
  });

  it('returns too_large for a streamed body over maxBytes (no content-length)', async () => {
    const server = await startHttps((_q, res) => {
      res.writeHead(200); // chunked: the client cannot know the size up front
      const chunk = 'x'.repeat(1024);
      let sent = 0;
      const pump = (): void => {
        while (sent < 200) {
          sent += 1;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      res.on('error', () => undefined);
      pump();
    });
    const http = createGuardedHttps({ __testOnly: permissive() });
    expect(await http.send(request(server.port, { maxBytes: 10 * 1024 }))).toEqual({ kind: 'too_large' });
  });

  it('returns too_large when the declared content-length is over maxBytes', async () => {
    const server = await startHttps((_q, res) => {
      res.writeHead(200, { 'content-length': '5000' });
      res.end('y'.repeat(5000));
    });
    const http = createGuardedHttps({ __testOnly: permissive() });
    expect(await http.send(request(server.port, { maxBytes: 100 }))).toEqual({ kind: 'too_large' });
  });

  it('accepts a body of exactly maxBytes', async () => {
    const server = await startHttps((_q, res) => res.end('z'.repeat(100)));
    const http = createGuardedHttps({ __testOnly: permissive() });
    expect(await http.send(request(server.port, { maxBytes: 100 }))).toEqual({
      kind: 'response',
      status: 200,
      body: 'z'.repeat(100),
    });
  });

  it('returns timeout with sent: true when the server got the request and never answers', async () => {
    const server = await startHttps(() => undefined); // never responds
    const http = createGuardedHttps({ __testOnly: permissive() });
    const started = Date.now();
    const result = await http.send(request(server.port, { method: 'POST', body: '{}', deadlineMs: 400 }));
    expect(result).toEqual({ kind: 'timeout', sent: true });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(server.requests).toHaveLength(1); // the request really arrived
  });

  it('returns timeout with sent: false when the TLS handshake never completes', async () => {
    const silent = await startSilentTcp();
    const http = createGuardedHttps({ __testOnly: permissive() });
    const result = await http.send(request(silent.port, { method: 'POST', body: '{"a":1}', deadlineMs: 400 }));
    expect(result).toEqual({ kind: 'timeout', sent: false });
    expect(silent.connections()).toBe(1);
  });

  it('returns timeout with sent: TRUE once the handshake completed, even when the body is stuck in a buffer', async () => {
    // A TLS server that completes the handshake and then never reads. The
    // headers may have reached it and a server may act on them, so the client
    // must not claim "not sent" — a false "not sent" invites a repeat.
    const sockets = new Set<TLSSocketType>();
    const server = createTlsServer({ key: TEST_KEY, cert: TEST_CERT }, (s) => {
      sockets.add(s);
      s.pause();
      s.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        }),
    );
    const http = createGuardedHttps({ __testOnly: permissive() });
    const result = await http.send(
      request(port, { method: 'POST', body: 'b'.repeat(16 * 1024 * 1024), deadlineMs: 800 }),
    );
    expect(result).toEqual({ kind: 'timeout', sent: true });
    expect(sockets.size).toBe(1); // the handshake did complete
  });

  it('returns network with sent: true when the socket is closed after the request was written', async () => {
    const server = await startHttps((req) => req.socket.destroy());
    const http = createGuardedHttps({ __testOnly: permissive() });
    expect(await http.send(request(server.port, { method: 'POST', body: '{}' }))).toEqual({
      kind: 'network',
      sent: true,
    });
  });

  it('returns network with sent: false when nothing listens on the port', async () => {
    const silent = await startSilentTcp();
    const port = silent.port;
    await closers.pop()?.(); // close it: the port is now unused
    const http = createGuardedHttps({ __testOnly: permissive() });
    expect(await http.send(request(port))).toEqual({ kind: 'network', sent: false });
  });

  it('returns network with sent: false when the certificate is not trusted (no CA seam)', async () => {
    const server = await startHttps((_q, res) => res.end('no'));
    const http = createGuardedHttps({
      __testOnly: { resolve: loopbackResolver([]), isForbidden: () => false },
    });
    expect(await http.send(request(server.port))).toEqual({ kind: 'network', sent: false });
    expect(server.requests).toHaveLength(0);
  });

  it('throws on a non-https URL — the builder never produces one', async () => {
    const http = createGuardedHttps({ __testOnly: permissive() });
    await expect(http.send({ ...request(1), url: new URL('http://api.example.test/') })).rejects.toThrow(/https/);
  });
});

describe('createGuardedHttps — hardening', () => {
  it('ignores __testOnly entirely outside NODE_ENV=test (the seam is inert in production)', async () => {
    const server = await startHttps((_q, res) => res.end('reached'));
    const url = new URL(`https://127.0.0.1:${server.port}/`);
    const mutable = config as { isTest: boolean };
    const original = mutable.isTest;
    let prodLike: ReturnType<typeof createGuardedHttps>;
    try {
      mutable.isTest = false;
      prodLike = createGuardedHttps({ __testOnly: permissive() });
    } finally {
      mutable.isTest = original;
    }
    // Same seam, built under test: the permissive guard is honoured.
    const underTest = createGuardedHttps({ __testOnly: permissive() });
    expect(await underTest.send({ ...request(server.port), url })).toEqual({
      kind: 'response',
      status: 200,
      body: 'reached',
    });
    // Built outside test: the real guard refuses the loopback literal.
    expect(await prodLike.send({ ...request(server.port), url })).toEqual({ kind: 'refused_address' });
    expect(server.connections).toBe(1); // only the under-test call connected
  });

  it('classifies a lookup error by code, not only by class', async () => {
    const server = await startHttps((_q, res) => res.end('no'));
    const byCode = createGuardedHttps({
      __testOnly: {
        ca: TEST_CERT,
        resolve: async () => {
          throw Object.assign(new Error('wrapped refusal'), { code: 'EXTERNAL_ADDRESS_REFUSED' });
        },
      },
    });
    expect(await byCode.send(request(server.port))).toEqual({ kind: 'refused_address' });
    const byCause = createGuardedHttps({
      __testOnly: {
        ca: TEST_CERT,
        resolve: async () => {
          throw new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'EXTERNAL_ADDRESS_REFUSED' }) });
        },
      },
    });
    expect(await byCause.send(request(server.port))).toEqual({ kind: 'refused_address' });
    const plainDnsError = createGuardedHttps({
      __testOnly: {
        ca: TEST_CERT,
        resolve: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        },
      },
    });
    expect(await plainDnsError.send(request(server.port))).toEqual({ kind: 'network', sent: false });
    expect(server.connections).toBe(0);
  });

  it.each(['https://user@api.example.test/', 'https://user:pass@api.example.test/', 'https://:pass@api.example.test/'])(
    'refuses a URL carrying userinfo (%s) before resolving or connecting',
    async (raw) => {
      const server = await startHttps((_q, res) => res.end('no'));
      const calls: string[] = [];
      const http = createGuardedHttps({ __testOnly: permissive(calls) });
      const url = new URL(raw);
      url.port = String(server.port);
      expect(await http.send({ ...request(server.port), url })).toEqual({ kind: 'refused_address' });
      expect(calls).toEqual([]);
      expect(server.connections).toBe(0);
    },
  );
});

describe('the __testOnly seam is named only in tests', () => {
  it('appears in no production file under src/ except its defining module', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          scanned += 1;
          const rel = relative(root, full).split(sep).join('/');
          if (rel === 'external/http.ts') continue;
          if (readFileSync(full, 'utf8').includes('__testOnly')) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(scanned).toBeGreaterThan(100); // the walk really covered src/
    expect(readFileSync(join(root, 'external', 'http.ts'), 'utf8')).toContain('__testOnly');
    expect(offenders).toEqual([]);
  });
});
