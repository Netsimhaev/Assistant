import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalJson } from './canonical.js';

describe('canonicalJson', () => {
  it('is stable across key insertion order', () => {
    const a = { b: 1, a: 2, c: { z: 3, y: 4 } };
    const b = { c: { y: 4, z: 3 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('drops undefined properties but preserves array positions', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    // Position is meaningful in an array, so a hole becomes null rather than
    // shifting every later element left.
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('distinguishes values that JSON.stringify would flatten', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: '1' }));
    expect(canonicalHash([])).not.toBe(canonicalHash({}));
    expect(canonicalHash(null)).not.toBe(canonicalHash('null'));
  });

  it('renders bigint as a string rather than throwing', () => {
    expect(canonicalJson({ seq: 42n })).toBe('{"seq":"42"}');
  });

  it('refuses values that cannot round-trip', () => {
    // Silently turning NaN into null would make two different actions hash the
    // same, which is exactly the failure a TOCTOU guard must not have.
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/no JSON representation/);
    expect(() => canonicalJson({ x: Infinity })).toThrow(/no JSON representation/);
  });

  it('hashes a money amount distinctly from its string form', () => {
    expect(canonicalHash({ amountMinor: 210_000 })).not.toBe(
      canonicalHash({ amountMinor: '210000' }),
    );
  });
});
