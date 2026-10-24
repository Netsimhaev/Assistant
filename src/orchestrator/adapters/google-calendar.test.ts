import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { installCharter } from '../../charter/store.js';
import { closePool } from '../../db/pool.js';
import type { CharterConnection } from '../../domain/connection.js';
import { KEY_BYTES, writeKeyState } from '../../governance/master-key.js';
import { writeGrant } from '../../governance/oauth-grants.js';
import { resetDatabase } from '../../test/db.js';
import { buildCharter } from '../../test/fixtures.js';
import { loadBindings, upsertBinding } from '../bindings.js';
import { oauthCredentials } from '../oauth-token.js';
import { createGoogleCalendarAdapter } from './google-calendar.js';
import { createCredentialHandle } from './types.js';
import type { AdapterCall, CredentialHandle } from './types.js';

const BUSINESS = config.businessId;

const CALENDAR_CONNECTION: CharterConnection = {
  system: 'office-calendar',
  label: 'יומן המשרד',
  channel: 'api',
  serves: ['calendar.read'],
  target: null,
  subprocessor: null,
};

/** Local test helper: `AdapterCall` with sensible defaults for every field a test does not care about. */
function call(partial: {
  toolName: string;
  input?: unknown;
  credential?: CredentialHandle | null;
  endpoint?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): AdapterCall {
  return {
    toolName: partial.toolName,
    input: partial.input ?? {},
    credential: partial.credential === undefined ? null : partial.credential,
    endpoint: partial.endpoint ?? null,
    businessId: 'test-business',
    idempotencyKey: partial.idempotencyKey ?? 'test-idempotency-key',
    signal: partial.signal ?? new AbortController().signal,
  };
}

/** Local test helper: a `CredentialHandle` carrying `value` as its access token. */
function handle(value: string): CredentialHandle {
  return createCredentialHandle('TEST_REF', value);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('createGoogleCalendarAdapter', () => {
  it('reads events with the access token, and refuses any other tool', async () => {
    let seen: { accessToken: string } | undefined;
    const http = {
      listEvents: async (i: {
        accessToken: string;
        calendarId: string;
        timeMinIso: string;
        maxResults: number;
        signal: AbortSignal;
      }) => {
        seen = i;
        return { status: 200, body: { items: [{ id: 'e1', summary: 'פגישה' }] } };
      },
    };
    const adapter = createGoogleCalendarAdapter({ system: 'office-calendar', http });

    const result = await adapter.execute(call({ toolName: 'calendar.read', credential: handle('access-1') }));
    expect(result.ok).toBe(true);
    expect(seen?.accessToken).toBe('access-1');

    const wrong = await adapter.execute(call({ toolName: 'mail.send', credential: handle('access-1') }));
    expect(wrong).toMatchObject({ ok: false, retryable: false, code: 'unsupported_tool' });
  });

  it('refuses without a credential rather than calling the provider', async () => {
    let called = false;
    const adapter = createGoogleCalendarAdapter({
      system: 'office-calendar',
      http: {
        listEvents: async () => {
          called = true;
          throw new Error('unreachable');
        },
      },
    });
    const result = await adapter.execute(call({ toolName: 'calendar.read', credential: null }));
    expect(result).toMatchObject({ ok: false, retryable: false, code: 'credential_unavailable' });
    expect(called).toBe(false);
  });

  it('classifies 401 as retryable for this read-only tool, and 5xx as retryable, and 403 as terminal', async () => {
    for (const [status, expected] of [[401, true], [503, true], [403, false]] as const) {
      const adapter = createGoogleCalendarAdapter({
        system: 'office-calendar',
        http: { listEvents: async () => ({ status, body: {} }) },
      });
      const result = await adapter.execute(call({ toolName: 'calendar.read', credential: handle('a') }));
      expect(result).toMatchObject({ ok: false, retryable: expected });
    }
  });

  it('never puts the access token in the returned message', async () => {
    const adapter = createGoogleCalendarAdapter({
      system: 'office-calendar',
      http: { listEvents: async () => ({ status: 403, body: { error: { message: 'Forbidden' } } }) },
    });
    const result = await adapter.execute(
      call({ toolName: 'calendar.read', credential: handle('SENTINEL-TOKEN') }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).not.toContain('SENTINEL-TOKEN');
    expect(result.message.length).toBeGreaterThan(0); // positive half
  });

  it('refuses a payload the planner shaped wrong, without calling the provider', async () => {
    let called = false;
    const adapter = createGoogleCalendarAdapter({
      system: 'office-calendar',
      http: {
        listEvents: async () => {
          called = true;
          return { status: 200, body: { items: [] } };
        },
      },
    });
    const result = await adapter.execute(
      call({ toolName: 'calendar.read', input: { maxResults: 'lots' }, credential: handle('a') }),
    );
    expect(result).toMatchObject({ ok: false, retryable: false, code: 'invalid_input' });
    expect(called).toBe(false);
  });

  it('returns a narrowed event list, never the raw provider body', async () => {
    const adapter = createGoogleCalendarAdapter({
      system: 'office-calendar',
      http: {
        listEvents: async () => ({
          status: 200,
          body: {
            items: [
              {
                id: 'e1',
                summary: 'פגישה',
                start: { dateTime: '2026-01-01T10:00:00Z' },
                end: { dateTime: '2026-01-01T11:00:00Z' },
                // A field the real Google API sends and nobody asked for.
                htmlLink: 'https://calendar.google.com/should-not-leak',
              },
            ],
            // Real responses carry a pagination token too; not our business.
            nextPageToken: 'zzz',
          },
        }),
      },
    });
    const result = await adapter.execute(call({ toolName: 'calendar.read', credential: handle('a') }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.output).toEqual({
      events: [
        {
          id: 'e1',
          summary: 'פגישה',
          start: { dateTime: '2026-01-01T10:00:00Z' },
          end: { dateTime: '2026-01-01T11:00:00Z' },
        },
      ],
    });
  });

  it('the default http implementation calls the real calendar API with a bearer token', async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.['Authorization'];
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const adapter = createGoogleCalendarAdapter({ system: 'office-calendar' });
      const result = await adapter.execute(call({ toolName: 'calendar.read', credential: handle('tok-1') }));
      expect(result.ok).toBe(true);
      expect(capturedUrl).toContain('googleapis.com/calendar/v3');
      expect(capturedAuth).toBe('Bearer tok-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * **Read this before touching this test — see task-4-brief.md Step 7.**
   *
   * An earlier version of this test drove the call through
   * `runPlanForJob`. That cannot work: `calendar.read` sits in
   * `READ_ONLY_TOOLS` and not in `OUTBOUND_TOOLS`, so `needsChannel` is
   * false and `performStep` (`run-plan.ts`) routes the step as a LOCAL
   * step — no adapter is ever called and no credential is ever resolved.
   * Widening `needsChannel`, or adding this tool to the outbound list, is a
   * change to a shared policy predicate `crm.read` and `memory.recall`
   * depend on explicitly, and belongs to a different sub-project, not here.
   *
   * So the chain is driven directly, one layer below the orchestrator:
   * charter -> binding -> grant -> minted token -> adapter.
   */
  it('drives the real chain: declared connection, live binding, stored grant, minted token, events back', async () => {
    const KEY = randomBytes(KEY_BYTES);

    // The `installCharter` call below is NOT exercised by anything else in
    // this test (fix-round 1, finding M4): the adapter here is built
    // directly with `createGoogleCalendarAdapter`, not resolved out of a
    // `buildRuntime`-assembled registry, so nothing downstream reads the
    // charter at all. It stays for parity with the brief's own Step 7
    // snippet and as a readable stand-in for "a connection like this is
    // declared" — the charter -> registry link itself (does a declared
    // `serves: ['calendar.read']` connection actually cause registration)
    // is proven separately, by `runtime.test.ts`'s two registration tests.
    await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
    await writeKeyState(KEY, 'KEY-e2e', { businessId: BUSINESS });
    await upsertBinding(
      {
        system: 'office-calendar',
        status: 'live',
        endpoint: null,
        credentialRef: 'OFFICE_CALENDAR',
        provider: 'google',
        lastOkAt: null,
        lastError: null,
      },
      { by: 'test' },
    );
    await writeGrant(
      {
        businessId: BUSINESS,
        system: 'office-calendar',
        provider: 'google',
        credentialRef: 'OFFICE_CALENDAR',
        account: 'owner@example.com',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        refreshToken: 'refresh-e2e',
        grantedBy: 'owner',
      },
      KEY,
    );

    const seen: string[] = [];
    const credentials = oauthCredentials({
      key: KEY,
      fallback: { resolve: async () => null },
      http: {
        exchangeRefresh: async () => ({
          ok: true,
          accessToken: 'access-e2e',
          expiresInSeconds: 3600,
          rotatedRefreshToken: null,
        }),
      },
    });
    const adapter = createGoogleCalendarAdapter({
      system: 'office-calendar',
      http: {
        listEvents: async (i) => {
          seen.push(i.accessToken);
          return { status: 200, body: { items: [{ id: 'e1', summary: 'פגישה אמיתית' }] } };
        },
      },
    });

    // The two halves the spine exists to join: the binding names a ref, and
    // that ref resolves to a freshly minted access token. Asserted BEFORE
    // the call, so the assertions below cannot pass on a chain that never
    // started.
    const bindings = await loadBindings({ businessId: BUSINESS });
    const ref = bindings.find((b) => b.system === 'office-calendar')?.credentialRef;
    expect(ref).toBe('OFFICE_CALENDAR');
    const credential = await credentials.resolve(ref!, BUSINESS);
    expect(credential?.value).toBe('access-e2e');

    const result = await adapter.execute({
      toolName: 'calendar.read',
      input: {},
      credential,
      endpoint: null,
      businessId: BUSINESS,
      idempotencyKey: 'e2e-1',
      signal: AbortSignal.timeout(5_000),
    });

    expect(result.ok).toBe(true);
    expect(seen).toEqual(['access-e2e']);
    if (!result.ok) throw new Error('unreachable');
    expect(result.output).toMatchObject({ events: [{ id: 'e1' }] });
  });
});
