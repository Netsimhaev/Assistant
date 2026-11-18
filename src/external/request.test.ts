import { describe, expect, it } from 'vitest';
import { ExternalSystem } from '../domain/external-system.js';
import { buildExternalRequest, pathShapeProblem } from './request.js';

function good(r: ReturnType<typeof buildExternalRequest>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r;
}

function sys(over: Record<string, unknown> = {}, ops?: unknown[]): ExternalSystem {
  return ExternalSystem.parse({
    id: 'acme',
    label: 'Acme',
    baseUrl: 'https://api.acme.example/v1/',
    auth: { kind: 'bearer' },
    idempotencyHeader: 'Idempotency-Key',
    operations: ops ?? [
      {
        name: 'get_customer', label: 'לקוח', kind: 'read', actionClass: 'external.read', method: 'GET',
        path: '/customers/{id}',
        params: [
          { name: 'id', in: 'path', required: true },
          { name: 'q', in: 'query', required: false },
        ],
      },
      {
        name: 'create_note', label: 'הערה', kind: 'change', actionClass: 'crm.write', method: 'POST',
        path: '/notes',
        params: [{ name: 'text', in: 'body', required: true }],
      },
      {
        name: 'pay', label: 'תשלום', kind: 'money', actionClass: 'payment.make', method: 'POST',
        path: '/pay',
        params: [{ name: 'ref', in: 'body', required: false }],
        amount: { field: 'amount', unit: 'major', currency: 'ILS' },
      },
    ],
    ...over,
  });
}
const op = (s: ExternalSystem, name: string) => s.operations.find((o) => o.name === name)!;

describe('buildExternalRequest', () => {
  it('encodes path values and keeps the origin', () => {
    const s = sys();
    const r = buildExternalRequest(s, op(s, 'get_customer'), { params: { id: '../admin?x=1#y' } }, 'k1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url.pathname).toBe('/v1/customers/..%2Fadmin%3Fx%3D1%23y');
    expect(r.url.origin).toBe('https://api.acme.example');
    expect(r.headers['Idempotency-Key']).toBe('k1');
    expect(r.body).toBeNull();
  });

  it('never yields a double slash and keeps the host for a hostile value', () => {
    const s = sys();
    const r = buildExternalRequest(s, op(s, 'get_customer'), { params: { id: '//evil.example' } }, 'k');
    expect(good(r).url.host).toBe('api.acme.example');
    expect(good(r).url.pathname.includes('//')).toBe(false);
  });

  it('builds the query', () => {
    const s = sys();
    const r = buildExternalRequest(s, op(s, 'get_customer'), { params: { id: '1', q: 'a b&c' } }, 'k');
    expect(good(r).url.search).toBe('?q=a+b%26c');
  });

  it('refuses missing, unknown and non-scalar params', () => {
    const s = sys();
    const o = op(s, 'get_customer');
    expect(buildExternalRequest(s, o, { params: {} }, 'k').ok).toBe(false);
    expect(buildExternalRequest(s, o, { params: { id: '1', zzz: 'x' } }, 'k').ok).toBe(false);
    expect(buildExternalRequest(s, o, { params: { id: { a: 1 } } }, 'k').ok).toBe(false);
    expect(buildExternalRequest(s, o, { params: { id: Number.NaN } }, 'k').ok).toBe(false);
    const bad = buildExternalRequest(s, o, { params: { id: '1', q: ['x'] } }, 'k');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.code).toBe('bad_params');
  });

  it('ignores inherited keys', () => {
    const s = sys();
    const params = Object.create({ id: 'inherited' }) as Record<string, unknown>;
    expect(buildExternalRequest(s, op(s, 'get_customer'), { params }, 'k').ok).toBe(false);
  });

  it('treats __proto__ as an undeclared param', () => {
    const s = sys();
    const params = JSON.parse('{"__proto__":{"text":"x"}}') as Record<string, unknown>;
    expect(buildExternalRequest(s, op(s, 'create_note'), { params }, 'k').ok).toBe(false);
  });

  it('sends a json body', () => {
    const s = sys();
    const r = buildExternalRequest(s, op(s, 'create_note'), { params: { text: { deep: [1] } } }, 'k');
    expect(good(r).body).toBe('{"text":{"deep":[1]}}');
    expect(good(r).headers['Content-Type']).toBe('application/json');
  });

  it('money: major divides by 100, minor keeps', () => {
    const s = sys();
    const r = buildExternalRequest(s, op(s, 'pay'), { params: {}, amountMinor: 12345 }, 'k');
    expect(JSON.parse(good(r).body ?? "{}")).toEqual({ amount: 123.45 });
    const s2 = sys({}, [
      { name: 'pay', label: 'x', kind: 'money', actionClass: 'payment.make', method: 'POST', path: '/pay',
        amount: { field: 'amount', unit: 'minor', currency: 'ILS' } },
    ]);
    const r2 = buildExternalRequest(s2, op(s2, 'pay'), { amountMinor: 12345 }, 'k');
    expect(JSON.parse(good(r2).body ?? "{}")).toEqual({ amount: 12345 });
  });

  it('money: requires amountMinor, refuses the amount field in params, bad amounts', () => {
    const s = sys();
    const o = op(s, 'pay');
    expect(buildExternalRequest(s, o, { params: {} }, 'k').ok).toBe(false);
    expect(buildExternalRequest(s, o, { params: { amount: 5 }, amountMinor: 100 }, 'k').ok).toBe(false);
    expect(buildExternalRequest(s, o, { amountMinor: -1 }, 'k').ok).toBe(false);
    expect(buildExternalRequest(s, o, { amountMinor: 1.5 }, 'k').ok).toBe(false);
  });

  it('a non-money op carrying amountMinor is refused', () => {
    const s = sys();
    expect(buildExternalRequest(s, op(s, 'create_note'), { params: { text: 'x' }, amountMinor: 5 }, 'k').ok).toBe(false);
  });

  it('form encoding: string amount, scalars only', () => {
    const s = sys({}, [
      { name: 'pay', label: 'x', kind: 'money', actionClass: 'payment.make', method: 'POST', path: '/pay',
        bodyEncoding: 'form', params: [{ name: 'ref', in: 'body', required: false }],
        amount: { field: 'amount', unit: 'major', currency: 'ILS' } },
    ]);
    const o = op(s, 'pay');
    const r = buildExternalRequest(s, o, { params: { ref: 'a b' }, amountMinor: 12345 }, 'k');
    expect(good(r).body).toBe('ref=a+b&amount=123.45');
    expect(good(r).headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(buildExternalRequest(s, o, { params: { ref: { a: 1 } }, amountMinor: 1 }, 'k').ok).toBe(false);
    expect(buildExternalRequest(s, o, { params: { ref: [1] }, amountMinor: 1 }, 'k').ok).toBe(false);
  });

  it('GET refuses body params and sends no body', () => {
    const s = sys({}, [
      { name: 'list', label: 'x', kind: 'read', actionClass: 'external.read', method: 'GET', path: '/l',
        params: [{ name: 'b', in: 'body', required: false }] },
    ]);
    expect(buildExternalRequest(s, op(s, 'list'), { params: { b: 1 } }, 'k').ok).toBe(false);
    const r2 = buildExternalRequest(s, op(s, 'list'), { params: {} }, 'k');
    expect(good(r2).body).toBeNull();
  });

  it('omits the idempotency header when null', () => {
    const s = sys({ idempotencyHeader: null });
    const r = buildExternalRequest(s, op(s, 'get_customer'), { params: { id: '1' } }, 'k');
    expect(r.ok).toBe(true);
    expect(Object.keys(good(r).headers)).not.toContain('Idempotency-Key');
  });

  it('messages are Hebrew, one line and short', () => {
    const s = sys();
    const r = buildExternalRequest(s, op(s, 'get_customer'), { params: { id: '1', zzz: 'a'.repeat(500) + '\n' } }, 'k');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(/[א-ת]/.test(r.message)).toBe(true);
    expect(r.message).not.toContain('\n');
    expect(r.message.length).toBeLessThan(200);
  });

  it('keeps ? and # in query values encoded', () => {
    const s = sys();
    const r = good(buildExternalRequest(s, op(s, 'get_customer'), { params: { id: '1', q: 'a?b#c' } }, 'k'));
    expect(r.url.search).toBe('?q=a%3Fb%23c');
    expect(r.url.hash).toBe('');
  });

  it('sends no body and no Content-Type when a non-money POST has no body params', () => {
    const s = sys({}, [
      { name: 'ping', label: 'x', kind: 'change', actionClass: 'crm.write', method: 'POST', path: '/ping',
        params: [{ name: 'a', in: 'body', required: false }] },
    ]);
    const r = good(buildExternalRequest(s, op(s, 'ping'), { params: {} }, 'k'));
    expect(r.body).toBeNull();
    expect(Object.keys(r.headers)).not.toContain('Content-Type');
  });

  it('refuses a missing path param even if the (unsigned-shape) definition made it optional', () => {
    const s = sys();
    const o = { ...op(s, 'get_customer'), params: [{ name: 'id', in: 'path' as const, required: false }] };
    const r = buildExternalRequest(s, o, { params: {} }, 'k');
    expect(r.ok).toBe(false);
  });

  describe('dot-segment and empty path values', () => {
    const two = () => sys({ baseUrl: 'https://api.x.com/v1' }, [
      { name: 'refund', label: 'x', kind: 'change', actionClass: 'crm.write', method: 'DELETE',
        path: '/customers/{cid}/orders/{oid}/refund',
        params: [{ name: 'cid', in: 'path', required: true }, { name: 'oid', in: 'path', required: true }] },
    ]);
    for (const bad of ['..', '.', '', '%2e%2e', '.%2E', '%2E', '%2e.']) {
      it('refuses ' + JSON.stringify(bad), () => {
        const s = two();
        for (const params of [{ cid: 'x', oid: bad }, { cid: bad, oid: 'y' }]) {
          const r = buildExternalRequest(s, op(s, 'refund'), { params }, 'k');
          expect(r.ok).toBe(false);
          expect(!r.ok && r.code).toBe('bad_params');
        }
      });
    }
    it('accepts an ordinary value', () => {
      const s = two();
      const r = good(buildExternalRequest(s, op(s, 'refund'), { params: { cid: 'a.b', oid: '...' } }, 'k'));
      expect(r.url.pathname).toBe('/v1/customers/a.b/orders/.../refund');
    });
  });

  describe('pathShapeProblem (second layer, on its own)', () => {
    const values = new Map([['cid', '..'], ['oid', 'y']]);
    it('catches a normalised-away segment', () => {
      // What new URL() does to /v1/customers/../orders/y/refund
      const url = new URL('https://api.x.com/v1/customers/../orders/y/refund');
      expect(pathShapeProblem(url.pathname, '/v1', '/customers/{cid}/orders/{oid}/refund', values)).not.toBeNull();
    });
    it('catches a replaced literal and accepts the exact shape', () => {
      const v = new Map([['cid', 'x'], ['oid', 'y']]);
      expect(pathShapeProblem('/v1/customers/x/orders/y/other', '/v1', '/customers/{cid}/orders/{oid}/refund', v)).not.toBeNull();
      expect(pathShapeProblem('/v1/customers/x/orders/y/refund', '/v1', '/customers/{cid}/orders/{oid}/refund', v)).toBeNull();
    });
  });

  describe('the amount field', () => {
    it('schema refuses a dotted amount field', () => {
      expect(() => sys({}, [
        { name: 'pay', label: 'x', kind: 'money', actionClass: 'payment.make', method: 'POST', path: '/pay',
          amount: { field: 'data.amount', unit: 'minor', currency: 'ILS' } },
      ])).toThrow(/ללא נקודות/);
    });
    it('schema refuses an optional path param', () => {
      expect(() => sys({}, [
        { name: 'get_x', label: 'x', kind: 'read', actionClass: 'external.read', method: 'GET', path: '/c/{id}',
          params: [{ name: 'id', in: 'path', required: false }] },
      ])).toThrow(/חייב להיות חובה/);
    });
    it('refuses a body param that carries the amount key nested, at any depth', () => {
      const s = sys();
      const o = op(s, 'pay');
      for (const ref of [{ amount: 99999 }, [{ x: { amount: 1 } }], { a: [{ b: { amount: 2 } }] }]) {
        const r = buildExternalRequest(s, o, { params: { ref }, amountMinor: 100 }, 'k');
        expect(r.ok).toBe(false);
        expect(!r.ok && r.code).toBe('bad_params');
      }
    });
    it('still writes exactly one amount, the gated one', () => {
      const s = sys();
      const r = good(buildExternalRequest(s, op(s, 'pay'), { params: { ref: { note: 'x' } }, amountMinor: 100 }, 'k'));
      expect(JSON.parse(r.body ?? '{}')).toEqual({ ref: { note: 'x' }, amount: 1 });
    });
  });

  describe('round 2 hardening', () => {
    it('refuses mixed placeholder segments at signing, accepts a whole segment', () => {
      for (const path of ['/files/{id}.json', '/x/{a}-{b}']) {
        expect(() => sys({}, [
          { name: 'get_x', label: 'x', kind: 'read', actionClass: 'external.read', method: 'GET', path,
            params: [{ name: 'id', in: 'path', required: true }, { name: 'a', in: 'path', required: true }, { name: 'b', in: 'path', required: true }] },
        ])).toThrow(/מקטע שלם/);
      }
      expect(() => sys({}, [
        { name: 'get_x', label: 'x', kind: 'read', actionClass: 'external.read', method: 'GET', path: '/files/{id}',
          params: [{ name: 'id', in: 'path', required: true }] },
      ])).not.toThrow();
    });
    it('refuses a param named like the amount field in another case', () => {
      expect(() => sys({}, [
        { name: 'pay', label: 'x', kind: 'money', actionClass: 'payment.make', method: 'POST', path: '/pay',
          params: [{ name: 'Amount_Cents', in: 'body', required: false }],
          amount: { field: 'amount_cents', unit: 'minor', currency: 'ILS' } },
      ])).toThrow(/must not also be a parameter/);
    });
    it('refuses a nested key that differs from the amount field only by case', () => {
      const s = sys();
      const r = buildExternalRequest(s, op(s, 'pay'), { params: { ref: { AMOUNT: 5 } }, amountMinor: 100 }, 'k');
      expect(r.ok).toBe(false);
    });
    it('returns bad_params instead of throwing on a lone surrogate', () => {
      const s = sys();
      let r: ReturnType<typeof buildExternalRequest> | undefined;
      expect(() => { r = buildExternalRequest(s, op(s, 'get_customer'), { params: { id: String.fromCharCode(0xd800) } }, 'k'); }).not.toThrow();
      expect(r?.ok).toBe(false);
      expect(!r?.ok && r?.code).toBe('bad_params');
    });
    it('refuses an amount above 10^15 and accepts the limit', () => {
      const s = sys();
      expect(buildExternalRequest(s, op(s, 'pay'), { amountMinor: 1_000_000_000_000_001 }, 'k').ok).toBe(false);
      expect(buildExternalRequest(s, op(s, 'pay'), { amountMinor: 1_000_000_000_000_000 }, 'k').ok).toBe(true);
    });
  });
});
