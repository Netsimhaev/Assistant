import type { ExternalField } from '../domain/external-system.js';
import { toOneLine } from '../util/bidi.js';

/**
 * Pulls the fields an operation DECLARED out of a provider's JSON response —
 * and nothing else. The response is written by whoever runs the far end, so
 * the assistant keeps only the values the owner signed for, each one a short
 * single line.
 *
 * Every rule is positive:
 *  - a path walks OWN keys only (`Object.hasOwn`), so `toString`,
 *    `constructor` or an inherited property never resolves;
 *  - a numeric segment indexes an array; any other segment on an array, or
 *    any segment on a non-object, is a missing path;
 *  - a missing path, or a `null`/`undefined` value, is omitted — never an
 *    empty string that would read as "the system said nothing";
 *  - a value is stringified (an object or array as JSON), passed through
 *    `toOneLine` (which strips bidi controls and line breaks), and cut at
 *    500 characters.
 */

export const EXTRACTED_VALUE_MAX_CHARS = 500;

/** Longest JSON text read before an object value is cut — bounds the stringify of a huge sub-tree. */
const OBJECT_JSON_MAX_CHARS = 4_000;

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/** The raw value at a dotted path, or `undefined` when any segment is missing. */
export function readFieldPath(json: unknown, path: string): unknown {
  let current: unknown = json;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A value as one capped display line, or `null` when there is nothing to show. */
export function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') text = String(value);
  else if (typeof value === 'object') {
    try {
      text = (JSON.stringify(value) ?? '').slice(0, OBJECT_JSON_MAX_CHARS);
    } catch {
      return null;
    }
  } else return null;
  return toOneLine(text).slice(0, EXTRACTED_VALUE_MAX_CHARS);
}

export function extractFields(
  json: unknown,
  fields: readonly ExternalField[],
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const field of fields) {
    const value = displayValue(readFieldPath(json, field.path));
    if (value === null) continue;
    out.push({ label: field.label, value });
  }
  return out;
}
