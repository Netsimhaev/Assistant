import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialisation.
 *
 * Every hash in the system — the charter's content hash, the audit chain, the
 * TOCTOU guard binding an approval to the exact input it approved — depends on
 * two different processes producing byte-identical output for equal values.
 * `JSON.stringify` does not guarantee that: object key order follows insertion
 * order, so the same logical value serialises differently depending on how it
 * was built.
 *
 * Rules:
 *   - object keys sorted lexicographically, recursively
 *   - `undefined` object properties dropped (they carry no value)
 *   - `undefined` inside arrays becomes `null` (position is meaningful)
 *   - bigint rendered as a decimal string (JSON has no bigint)
 *   - no insignificant whitespace
 */
export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `canonicalJson: ${String(value)} has no JSON representation; refusing to hash a value that cannot round-trip`,
        );
      }
      return JSON.stringify(value);
    case 'undefined':
      // Only reachable at the top level — object/array cases handle their own.
      throw new TypeError('canonicalJson: cannot serialise a bare undefined');
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined ? 'null' : serialise(item),
    );
    return `[${items.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serialise(entry)}`);
  }
  return `{${parts.join(',')}}`;
}

/** sha256 of the canonical serialisation, lowercase hex. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** sha256 of two hex digests concatenated — the audit chain's link function. */
export function chainHash(prevHash: string, payload: unknown): string {
  return createHash('sha256')
    .update(prevHash, 'utf8')
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}
