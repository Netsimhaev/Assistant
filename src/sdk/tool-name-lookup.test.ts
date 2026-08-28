import { describe, expect, it } from 'vitest';
import { translateToolName } from './tool-names.js';
import { classifyAction, isKnownTool } from '../policy/classify.js';

/**
 * Three lookups state their security contract as "absent means denied", and all
 * three were plain object-literal indexes — which resolve through
 * `Object.prototype`. For about a dozen inherited names (`constructor`,
 * `toString`, `valueOf`, `hasOwnProperty`, `__proto__`, …) the absent test is
 * simply false, so the boundary that is documented as the control is not the
 * one doing the denying. Nothing is exploitable through it today; the agent
 * allowlist catches these one layer later. That is precisely why it needs a
 * test — a defect that is currently masked by a different layer is the kind
 * that becomes live the day that layer moves.
 */
const INHERITED = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
] as const;

describe('object-literal lookups that mean "absent is denied"', () => {
  it.each(INHERITED)('translateToolName denies %s', (name) => {
    expect(translateToolName(name)).toBeNull();
  });

  it.each(INHERITED)('isKnownTool rejects %s', (name) => {
    expect(isKnownTool(name)).toBe(false);
  });

  it.each(INHERITED)('classifyAction returns null for %s', (name) => {
    expect(classifyAction(name)).toBeNull();
  });

  it('still translates a tool that really is mapped', () => {
    expect(translateToolName('Read')).toEqual({
      internal: 'doc.fetch',
      via: 'builtin',
      pathScoped: true,
    });
  });

  it('still classifies a tool that really is classified', () => {
    expect(classifyAction('mail.send')).toBe('email.reply');
    expect(isKnownTool('mail.send')).toBe(true);
  });
});
