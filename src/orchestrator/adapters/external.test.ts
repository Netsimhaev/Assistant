import { describe, expect, it } from 'vitest';
import { ExternalSystem } from '../../domain/external-system.js';
import type { ExternalHttp, ExternalRequest, ExternalResult } from '../../external/http.js';
import { canonicalJson } from '../../util/canonical.js';
import { EXTERNAL_MESSAGES_HE, createExternalAdapter } from './external.js';
import { REDACTED } from '../../policy/redact.js';
import { createCredentialHandle, type AdapterCall, type AdapterResult } from './types.js';

const SECRET = 'sk_live_TOPSECRET_9f8e7d';
const VERSION = 'charter-v7';

function system(auth: Record<string, unknown> = { kind: 'bearer' }): ExternalSystem {
  return ExternalSystem.parse({
    id: 'acme',
    label: 'Acme',
    baseUrl: 'https://api.acme.example/v1',
    auth,
    idempotencyHeader: 'Idempotency-Key',
    operations: [
      {
        name: 'get_customer', label: 'לקוח', kind: 'read', actionClass: 'external.read', method: 'GET',
        path: '/customers/{id}',
        params: [{ name: 'id', in: 'path', required: true }],
        fields: [
          { path: 'data.name', label: 'שם' },
          { path: 'items.0.name', label: 'פריט' },
        ],
        idPath: 'data.id',
      },
      {
        name: 'create_note', label: 'הערה', kind: 'change', actionClass: 'crm.write', method: 'POST',
        path: '/notes',
        params: [{ name: 'text', in: 'body', required: true }],
        idPath: 'id',
      },
      {
        name: 'pay', label: 'תשלום', kind: 'money', actionClass: 'payment.make', method: 'POST',
        path: '/pay',
        params: [],
        amount: { field: 'amount', unit: 'minor', currency: 'ILS' },
      },
    ],
  });
}

interface Recorded {
  sent: ExternalRequest[];
  calls: { systemId: string; outcome: string }[];
}

function harness(
  reply: ExternalResult | ((req: ExternalRequest) => Promise<ExternalResult>),
  opts: { callsToday?: number; cap?: number; auth?: Record<string, unknown> } = {},
) {
  const rec: Recorded = { sent: [], calls: [] };
  const http: ExternalHttp = {
    async send(req) {
      rec.sent.push(req);
      return typeof reply === 'function' ? reply(req) : reply;
    },
  };
  const adapter = createExternalAdapter(system(opts.auth), {
    http,
    callsToday: async () => opts.callsToday ?? 0,
    recordCall: async (call) => {
      rec.calls.push(call);
    },
    capPerDay: opts.cap ?? 200,
    charterVersion: VERSION,
  });
  return { adapter, rec };
}

const READ_INPUT = { system: 'acme', operation: 'get_customer', params: { id: 'c1' } };
const WRITE_INPUT = { system: 'acme', operation: 'create_note', params: { text: 'שלום' } };

function call(toolName: string, input: unknown, credential: AdapterCall['credential'] = createCredentialHandle('EXT_ACME_KEY', SECRET)): AdapterCall {
  return {
    toolName,
    input,
    credential,
    endpoint: null,
    businessId: 'test-business',
    idempotencyKey: 'idem-123',
    attachments: [],
    judgedCharterVersion: VERSION,
    signal: new AbortController().signal,
  };
}

const read = (h: ReturnType<typeof harness>, input: unknown = READ_INPUT) => h.adapter.execute(call('ext.read', input));
const write = (h: ReturnType<typeof harness>, input: unknown = WRITE_INPUT) => h.adapter.execute(call('ext.call', input));

function failure(r: AdapterResult): { retryable: boolean; code: string; message: string } {
  if (r.ok) throw new Error('expected failure');
  return r;
}

const resp = (status: number, body = '{}'): ExternalResult => ({ kind: 'response', status, body });

describe('createExternalAdapter — identity', () => {
  it('registers as ext:<id>, api, serving ext.call and ext.read', () => {
    const { adapter } = harness(resp(200));
    expect(adapter.system).toBe('ext:acme');
    expect(adapter.channel).toBe('api');
    expect([...adapter.serves].sort()).toEqual(['ext.call', 'ext.read']);
  });
});

describe('createExternalAdapter — outcome table', () => {
  it('no credential → credential_unavailable, final, nothing sent', async () => {
    const h = harness(resp(200));
    const r = failure(await h.adapter.execute(call('ext.read', READ_INPUT, null)));
    expect(r).toMatchObject({ code: 'credential_unavailable', retryable: false });
    expect(h.rec.sent).toHaveLength(0);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('cap reached → external_daily_cap, retryable, nothing sent', async () => {
    const h = harness(resp(200), { callsToday: 5, cap: 5 });
    const r = failure(await read(h));
    expect(r).toMatchObject({ code: 'external_daily_cap', retryable: true });
    expect(h.rec.sent).toHaveLength(0);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('one call below the cap still goes out', async () => {
    const h = harness(resp(200), { callsToday: 4, cap: 5 });
    expect((await read(h)).ok).toBe(true);
  });

  it('bad params → bad_params, final, nothing sent', async () => {
    const h = harness(resp(200));
    const r = failure(await read(h, { system: 'acme', operation: 'get_customer', params: { nope: 1 } }));
    expect(r).toMatchObject({ code: 'bad_params', retryable: false });
    expect(h.rec.sent).toHaveLength(0);
  });

  it('an operation the signed definition does not hold → external_unresolved, final', async () => {
    const h = harness(resp(200));
    expect(failure(await read(h, { system: 'acme', operation: 'missing' }))).toMatchObject({
      code: 'external_unresolved',
      retryable: false,
    });
    // ext.read may not perform a change operation — same resolver as the gate.
    expect(failure(await read(h, WRITE_INPUT)).code).toBe('external_unresolved');
    expect(h.rec.sent).toHaveLength(0);
  });

  it('refused address → external_address_refused, final, counted', async () => {
    const h = harness({ kind: 'refused_address' });
    expect(failure(await read(h))).toMatchObject({ code: 'external_address_refused', retryable: false });
    expect(h.rec.calls).toEqual([{ systemId: 'acme', outcome: 'external_address_refused' }]);
  });

  it('2xx read → ok with declared fields and externalId from idPath', async () => {
    const body = JSON.stringify({ data: { name: 'דנה', id: 77, hidden: 'x' }, items: [{ name: 'כיסא' }] });
    const h = harness(resp(200, body));
    const r = await read(h);
    expect(r).toEqual({
      ok: true,
      output: { fields: [{ label: 'שם', value: 'דנה' }, { label: 'פריט', value: 'כיסא' }] },
      externalId: '77',
    });
    expect(h.rec.calls).toEqual([{ systemId: 'acme', outcome: 'ok' }]);
  });

  it('2xx write → ok, externalId from idPath; a non-JSON body yields no fields', async () => {
    const h = harness(resp(201, '{"id":"n-1"}'));
    expect(await write(h)).toEqual({ ok: true, output: { fields: [] }, externalId: 'n-1' });
    const h2 = harness(resp(204, ''));
    expect(await write(h2)).toEqual({ ok: true, output: { fields: [] }, externalId: null });
  });

  it.each([401, 403])('%i → external_auth, final', async (status) => {
    expect(failure(await read(harness(resp(status))))).toMatchObject({ code: 'external_auth', retryable: false });
    expect(failure(await write(harness(resp(status))))).toMatchObject({ code: 'external_auth', retryable: false });
  });

  it.each([429, 500, 502, 503, 504])('read with %i → retryable', async (status) => {
    expect(failure(await read(harness(resp(status))))).toMatchObject({ code: 'external_unavailable', retryable: true });
  });

  it.each([429, 503])('write with %i → retryable', async (status) => {
    expect(failure(await write(harness(resp(status))))).toMatchObject({ code: 'external_unavailable', retryable: true });
  });

  it.each([500, 502, 504])('write with %i → delivery_unknown, final', async (status) => {
    expect(failure(await write(harness(resp(status))))).toMatchObject({ code: 'delivery_unknown', retryable: false });
  });

  it.each([400, 404, 409, 422])('other 4xx (%i) → external_rejected, final', async (status) => {
    expect(failure(await read(harness(resp(status))))).toMatchObject({ code: 'external_rejected', retryable: false });
    expect(failure(await write(harness(resp(status))))).toMatchObject({ code: 'external_rejected', retryable: false });
  });

  it('timeout → adapter_timeout; on a write that may have gone out the outcome is marked unknown', async () => {
    const r1 = await read(harness({ kind: 'timeout', sent: true }));
    expect(r1).toMatchObject({ ok: false, code: 'adapter_timeout', retryable: true });
    expect((r1 as { outcomeUnknown?: boolean }).outcomeUnknown).toBeUndefined();
    const r2 = await write(harness({ kind: 'timeout', sent: true }));
    expect(r2).toMatchObject({ ok: false, code: 'adapter_timeout', retryable: true, outcomeUnknown: true });
    const r3 = await write(harness({ kind: 'timeout', sent: false }));
    expect(r3).toMatchObject({ ok: false, code: 'adapter_timeout', retryable: true });
    expect((r3 as { outcomeUnknown?: boolean }).outcomeUnknown).toBeUndefined();
  });

  it('network error not sent → retryable, read or write', async () => {
    expect(failure(await read(harness({ kind: 'network', sent: false })))).toMatchObject({
      code: 'external_network',
      retryable: true,
    });
    expect(failure(await write(harness({ kind: 'network', sent: false })))).toMatchObject({
      code: 'external_network',
      retryable: true,
    });
  });

  it('network error after sending → delivery_unknown on a write, retryable on a read', async () => {
    expect(failure(await write(harness({ kind: 'network', sent: true })))).toMatchObject({
      code: 'delivery_unknown',
      retryable: false,
    });
    expect(failure(await read(harness({ kind: 'network', sent: true })))).toMatchObject({
      code: 'external_network',
      retryable: true,
    });
  });

  it('a response over the size cap → final (delivery_unknown on a write)', async () => {
    expect(failure(await read(harness({ kind: 'too_large' })))).toMatchObject({
      code: 'external_response_too_large',
      retryable: false,
    });
    expect(failure(await write(harness({ kind: 'too_large' })))).toMatchObject({
      code: 'delivery_unknown',
      retryable: false,
    });
  });

  it('a throwing http client never escapes the adapter', async () => {
    const throwing = async (): Promise<ExternalResult> => {
      throw new TypeError(`refusing non-https ${SECRET}`);
    };
    const r = failure(await read(harness(throwing)));
    expect(r).toMatchObject({ code: 'external_request_failed', retryable: false });
    expect(r.message).not.toContain(SECRET);
    expect(failure(await write(harness(throwing)))).toMatchObject({ code: 'delivery_unknown', retryable: false });
  });

  it('counts every attempt that reached send, with a fixed code', async () => {
    const h = harness(resp(500, 'provider says: boom'));
    await read(h);
    expect(h.rec.calls).toEqual([{ systemId: 'acme', outcome: 'external_unavailable' }]);
  });

  it('never puts provider text in the message', async () => {
    const r = failure(await write(harness(resp(422, '{"error":"PROVIDER-TEXT"}'))));
    expect(r.message).not.toContain('PROVIDER-TEXT');
  });
});

describe('createExternalAdapter — request', () => {
  it('sends Authorization: Bearer <secret> and the idempotency key', async () => {
    const h = harness(resp(200));
    await read(h);
    const req = h.rec.sent[0]!;
    expect(req.headers['Authorization']).toBe(`Bearer ${SECRET}`);
    expect(req.headers['Idempotency-Key']).toBe('idem-123');
    expect(req.url.href).toBe('https://api.acme.example/v1/customers/c1');
    expect(req.method).toBe('GET');
  });

  it('sends Authorization: Basic base64(secret) for basic auth', async () => {
    const h = harness(resp(200), { auth: { kind: 'basic' } });
    await h.adapter.execute(call('ext.read', READ_INPUT, createCredentialHandle('EXT_ACME_KEY', 'user:pass')));
    expect(h.rec.sent[0]!.headers['Authorization']).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('sends the secret under the declared header for header auth', async () => {
    const h = harness(resp(200), { auth: { kind: 'header', header: 'X-Api-Key' } });
    await read(h);
    expect(h.rec.sent[0]!.headers['X-Api-Key']).toBe(SECRET);
    expect(h.rec.sent[0]!.headers['Authorization']).toBeUndefined();
  });

  it('refuses a secret that would break a header line, without sending', async () => {
    const h = harness(resp(200));
    const r = failure(await h.adapter.execute(call('ext.read', READ_INPUT, createCredentialHandle('EXT_ACME_KEY', 'a\r\nX-Evil: 1'))));
    expect(r).toMatchObject({ code: 'credential_unavailable', retryable: false });
    expect(h.rec.sent).toHaveLength(0);
  });

  it('sends only the approved amountMinor, into the declared field', async () => {
    const h = harness(resp(200));
    await write(h, { system: 'acme', operation: 'pay', params: {}, amountMinor: 1234 });
    expect(JSON.parse(h.rec.sent[0]!.body!)).toEqual({ amount: 1234 });
  });
});

describe('createExternalAdapter — the secret never leaks', () => {
  const cases: [string, ExternalResult][] = [
    ['ok', resp(200, JSON.stringify({ data: { name: SECRET, id: SECRET } }))],
    ['auth', resp(401, SECRET)],
    ['rejected', resp(400, SECRET)],
    ['5xx', resp(500, SECRET)],
    ['timeout', { kind: 'timeout', sent: true }],
    ['network', { kind: 'network', sent: true }],
    ['refused', { kind: 'refused_address' }],
  ];
  it.each(cases)('%s: not in message, output, a thrown error, or canonicalJson', async (_name, reply) => {
    // Echo-safe check: the provider echoing the secret back is provider content,
    // and only declared fields reach output — but this test proves the ADAPTER
    // never adds it. The ok case asserts separately below.
    for (const tool of ['ext.read', 'ext.call'] as const) {
      const h = harness(reply);
      const input = tool === 'ext.read' ? READ_INPUT : WRITE_INPUT;
      let result: AdapterResult;
      try {
        result = await h.adapter.execute(call(tool, input));
      } catch (e) {
        throw new Error(`adapter threw: ${String(e).includes(SECRET) ? 'WITH SECRET' : 'no secret'}`);
      }
      if (!result.ok) expect(result.message).not.toContain(SECRET);
      if (_name !== 'ok') {
        expect(canonicalJson(result)).not.toContain(SECRET);
        expect(JSON.stringify(result)).not.toContain(SECRET);
      }
    }
  });

  it('ok: the output carries only declared fields — the secret appears only if the provider put it in one', async () => {
    const h = harness(resp(200, JSON.stringify({ data: { name: 'דנה', other: SECRET } })));
    const r = await read(h);
    expect(canonicalJson(r)).not.toContain(SECRET);
    if (r.ok) expect(JSON.stringify(r.output)).not.toContain(SECRET);
  });
});

describe('every external code has a Hebrew failure sentence', () => {
  it('maps each code the adapter can return in FAILURE_REASON_HE', async () => {
    const { failedText, FAILED_GENERIC_TEXT } = await import('../whatsapp-report.js');
    const { EXTERNAL_MESSAGES_HE } = await import('./external.js');
    for (const code of [...Object.keys(EXTERNAL_MESSAGES_HE), 'bad_params']) {
      expect(failedText(`${code} — x`), code).not.toBe(FAILED_GENERIC_TEXT);
    }
  });
});

describe('fix round 1 hardenings', () => {
  it('refuses a step judged under another charter version — nothing sent, nothing counted', async () => {
    const h = harness(resp(200));
    for (const judged of ['charter-v8', undefined]) {
      const c = call('ext.read', READ_INPUT);
      const r = failure(await h.adapter.execute(
        judged === undefined ? (({ judgedCharterVersion: _v, ...rest }) => rest)(c) : { ...c, judgedCharterVersion: judged },
      ));
      expect(r).toMatchObject({ code: 'external_definition_stale', retryable: true });
    }
    expect(h.rec.sent).toHaveLength(0);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('drops a declared field or id that echoes the secret', async () => {
    const body = JSON.stringify({ data: { name: `Bearer ${SECRET}`, id: SECRET }, items: [{ name: 'כיסא' }] });
    const r = await read(harness(resp(200, body)));
    expect(r).toEqual({ ok: true, output: { fields: [{ label: 'פריט', value: 'כיסא' }] }, externalId: null });
    expect(canonicalJson(r)).not.toContain(SECRET);
  });

  it('drops a field that echoes the base64 form of a basic secret', async () => {
    const b64 = Buffer.from('user:pass').toString('base64');
    const h = harness(resp(200, JSON.stringify({ data: { name: `Basic ${b64}`, id: 'x' } })), { auth: { kind: 'basic' } });
    const r = await h.adapter.execute(call('ext.read', READ_INPUT, createCredentialHandle('EXT_ACME_KEY', 'user:pass')));
    expect(r).toEqual({ ok: true, output: { fields: [] }, externalId: 'x' });
  });

  it('a non-https TypeError on a write is a final external_bad_url, not delivery_unknown', async () => {
    const http: ExternalHttp = {
      async send(req) {
        // The guarded client's own refusal, reproduced: it throws before any socket.
        if (req.url.protocol !== 'https:') throw new TypeError('external requests must use https:');
        return resp(200);
      },
    };
    const plain = ExternalSystem.parse({ ...system(), id: 'acme' });
    // Simulate a definition whose URL is not https by mutating the parsed copy
    // (the schema refuses it at signing; this is the adapter's own backstop).
    (plain as { baseUrl: string }).baseUrl = 'http://api.acme.example/v1';
    const adapter = createExternalAdapter(plain, {
      http, callsToday: async () => 0, recordCall: async () => {}, capPerDay: 200, charterVersion: VERSION,
    });
    const r = failure(await adapter.execute(call('ext.call', WRITE_INPUT)));
    expect(r).toMatchObject({ code: 'external_bad_url', retryable: false });
  });

  it('a cap of 0 means switched off — final external_disabled, nothing sent', async () => {
    const h = harness(resp(200), { cap: 0 });
    const r = failure(await read(h));
    expect(r).toEqual({ ok: false, code: 'external_disabled', retryable: false, message: 'החיבור למערכות חיצוניות כבוי' });
    expect(h.rec.sent).toHaveLength(0);
  });
});

/**
 * Ruling T7-b, layer (b): a write must never carry the redaction marker in
 * place of a value the owner approved. The plan-time refusal is layer (a);
 * this is the backstop if a redacted payload reaches the adapter anyway.
 */
describe('createExternalAdapter — redacted values', () => {
  it('refuses a body param carrying the redaction marker: final, nothing sent, not counted', async () => {
    const h = harness(resp(200));
    const r = failure(await write(h, { system: 'acme', operation: 'create_note', params: { text: `טלפון ${REDACTED}` } }));
    expect(r).toMatchObject({ code: 'external_redacted_value', retryable: false });
    expect(r.message).toBe(EXTERNAL_MESSAGES_HE.external_redacted_value);
    expect(h.rec.sent).toHaveLength(0);
    expect(h.rec.calls).toHaveLength(0);
  });

  it('refuses the marker nested at depth inside a param', async () => {
    const h = harness(resp(200));
    const r = failure(await write(h, { system: 'acme', operation: 'create_note', params: { text: { a: [{ b: REDACTED }] } } }));
    expect(r.code).toBe('external_redacted_value');
    expect(h.rec.sent).toHaveLength(0);
  });

  it('refuses the marker in a path param, where it reaches the URL only encoded', async () => {
    const h = harness(resp(200));
    const r = failure(await read(h, { system: 'acme', operation: 'get_customer', params: { id: REDACTED } }));
    expect(r.code).toBe('external_redacted_value');
    expect(h.rec.sent).toHaveLength(0);
  });

  it('sends a param that carries no marker', async () => {
    const h = harness(resp(200));
    expect((await write(h, { system: 'acme', operation: 'create_note', params: { text: 'טלפון 050-1234567' } })).ok).toBe(true);
    expect(h.rec.sent).toHaveLength(1);
  });
});
