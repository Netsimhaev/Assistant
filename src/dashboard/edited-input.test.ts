import { describe, expect, it } from 'vitest';
import { canonicalHash } from '../util/canonical.js';
import { parseEditedInput } from './server.js';

/**
 * The one place in the system where a tool payload is built from raw JSON with
 * no schema behind it.
 *
 * Every other route into `evaluateToolCall` goes through `Plan.safeParse`,
 * whose `z.record(z.string(), z.unknown())` quietly drops `__proto__`. This one
 * had `JSON.parse` and an `isPlainObject` check, so an own `__proto__` survived
 * into `edited_input`, through the JSONB round-trip, into `effectiveInput`, and
 * on to the gate — where redaction turned it into a prototype the adapter could
 * read and the gate could not. Sanitising here is what closes that path at its
 * source; `prototype-payload.test.ts` locks the layer behind it.
 */
describe('parseEditedInput', () => {
  const original = { to: 'dana@example.com', subject: 'נושא' };
  const originalHash = canonicalHash(original);

  it('drops a __proto__ key instead of carrying it into the payload that runs', () => {
    const result = parseEditedInput(
      '{"__proto__":{"to":"blocked@rival.co.il"},"to":"dana@example.com","subject":"אחר"}',
      originalHash,
    );

    expect(result.ok).toBe(true);
    const edited = (result as { ok: true; editedInput?: unknown }).editedInput as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(edited, '__proto__')).toBe(false);
    expect(edited['to']).toBe('dana@example.com');
  });

  it('still accepts an ordinary edit unchanged', () => {
    const result = parseEditedInput('{"to":"dana@example.com","subject":"אחר"}', originalHash);

    expect(result).toEqual({
      ok: true,
      editedInput: { to: 'dana@example.com', subject: 'אחר' },
    });
  });

  it('still reports an edit that only reformats as no edit at all', () => {
    const result = parseEditedInput('{"subject":"נושא","to":"dana@example.com"}', originalHash);

    expect(result).toEqual({ ok: true });
  });

  it('still rejects a payload that is not an object', () => {
    expect(parseEditedInput('"just a string"', originalHash)).toEqual({
      ok: false,
      raw: '"just a string"',
    });
  });

  it('still rejects unparseable JSON', () => {
    expect(parseEditedInput('{not json', originalHash)).toEqual({ ok: false, raw: '{not json' });
  });
});
