import { describe, expect, it } from 'vitest';
import { extractFields, readFieldPath, EXTRACTED_VALUE_MAX_CHARS } from './extract.js';

describe('extractFields', () => {
  it('reads nested paths and indexes arrays by numeric segments', () => {
    const json = { data: { customer: { name: 'דנה', id: 42 } }, items: [{ name: 'first' }, { name: 'second' }] };
    expect(
      extractFields(json, [
        { path: 'data.customer.name', label: 'שם' },
        { path: 'data.customer.id', label: 'מזהה' },
        { path: 'items.0.name', label: 'פריט ראשון' },
        { path: 'items.1.name', label: 'פריט שני' },
      ]),
    ).toEqual([
      { label: 'שם', value: 'דנה' },
      { label: 'מזהה', value: '42' },
      { label: 'פריט ראשון', value: 'first' },
      { label: 'פריט שני', value: 'second' },
    ]);
  });

  it('omits missing paths, out-of-range indexes and null values', () => {
    const json = { a: { b: null }, list: [1] };
    expect(
      extractFields(json, [
        { path: 'a.b', label: 'null' },
        { path: 'a.c', label: 'missing' },
        { path: 'list.5', label: 'oob' },
        { path: 'list.x', label: 'non-numeric on array' },
        { path: 'a.b.c', label: 'through null' },
      ]),
    ).toEqual([]);
  });

  it('walks own keys only — never the prototype chain', () => {
    const proto = { secret: 'inherited' };
    const json = Object.create(proto) as Record<string, unknown>;
    json['own'] = 'yes';
    expect(
      extractFields(json, [
        { path: 'secret', label: 'inherited' },
        { path: 'own', label: 'own' },
        { path: 'toString', label: 'proto fn' },
      ]),
    ).toEqual([{ label: 'own', value: 'yes' }]);
  });

  it('stringifies objects as JSON, booleans and numbers plainly', () => {
    expect(
      extractFields({ o: { x: 1 }, t: true, n: 3.5 }, [
        { path: 'o', label: 'o' },
        { path: 't', label: 't' },
        { path: 'n', label: 'n' },
      ]),
    ).toEqual([
      { label: 'o', value: '{"x":1}' },
      { label: 't', value: 'true' },
      { label: 'n', value: '3.5' },
    ]);
  });

  it('strips bidi controls and line breaks, and caps at 500 characters', () => {
    const long = 'א'.repeat(800);
    const out = extractFields({ s: 'a‮b\nc', l: long }, [
      { path: 's', label: 's' },
      { path: 'l', label: 'l' },
    ]);
    expect(out[0]).toEqual({ label: 's', value: 'ab c' });
    expect(out[1]?.value.length).toBe(EXTRACTED_VALUE_MAX_CHARS);
    expect(EXTRACTED_VALUE_MAX_CHARS).toBe(500);
  });

  it('returns nothing for a non-object root', () => {
    expect(extractFields('text', [{ path: 'a', label: 'a' }])).toEqual([]);
    expect(extractFields(null, [{ path: 'a', label: 'a' }])).toEqual([]);
  });
});

describe('readFieldPath', () => {
  it('returns undefined for a missing path and the raw value otherwise', () => {
    expect(readFieldPath({ a: [{ b: 'x' }] }, 'a.0.b')).toBe('x');
    expect(readFieldPath({ a: [] }, 'a.0')).toBeUndefined();
  });
});
