import { describe, expect, it } from 'vitest';
import { ExternalSystem } from '../domain/external-system.js';
import { buildExternalRequest } from './request.js';

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
    expect(r.ok && r.url.host).toBe('api.acme.example');
    expect(r.ok && r.url.pathname.includes('//')).toBe(false);
  });

  it('builds the query', () => {
    const s = sys();
    const r = buildExternalRequest(s, op(s, 'get_customer'), { params: { id: '1', q: 'a b&c' } }, 'k');
    expect(r.ok && r.url.search).toBe('?q=a+b%26c');
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
    expect(r.ok && r.body).toBe('{"text":{"deep":[1]}}');
    expect(r.ok && r.headers['Content-Type']).toBe('application/json');
  });

  it('money: major divides by 100, minor keeps', () => {
    const s = sys();
    const r = buildExternalRequest(s, op(s, 'pay'), { params: {}, amountMinor: 12345 }, 'k');
    expect(r.ok && JSON.parse(r.body ?? '{}')).toEqual({ amount: 123.45 });
    const s2 = sys({}, [
      { name: 'pay', label: 'x', kind: 'money', actionClass: 'payment.make', method: 'POST', path: '/pay',
        amount: { field: 'amount', unit: 'minor', currency: 'ILS' } },
    ]);
    const r2 = buildExternalRequest(s2, op(s2, 'pay'), { amountMinor: 12345 }, 'k');
    expect(r2.ok && JSON.parse(r2.body ?? '{}')).toEqual({ amount: 12345 });
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
    expect(r.ok && r.body).toBe('ref=a+b&amount=123.45');
    expect(r.ok && r.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
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
    expect(r2.ok && r2.body).toBeNull();
  });

  it('omits the idempotency header when null', () => {
    const s = sys({ idempotencyHeader: null });
    const r = buildExternalRequest(s, op(s, 'get_customer'), { params: { id: '1' } }, 'k');
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r.headers)).not.toContain('Idempotency-Key');
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
});
