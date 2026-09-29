import { describe, expect, it } from 'vitest';
import { CONNECTION_GROUP_ORDER, GROUP_LABELS, groupForServes } from './connection-groups.js';
import type { ConnectionGroup } from './connection-groups.js';

describe('groupForServes', () => {
  it('names each group from the tools the connection serves', () => {
    expect(groupForServes(['mail.send', 'mail.draft'])).toBe('mail');
    expect(groupForServes(['calendar.read'])).toBe('calendar');
    expect(groupForServes(['crm.read', 'crm.write'])).toBe('crm');
    expect(groupForServes(['accounting.write'])).toBe('accounting');
    expect(groupForServes(['wa.send_message'])).toBe('whatsapp');
  });

  it('puts an unrecognised connection under "other" rather than hiding it', () => {
    expect(groupForServes(['something.new'])).toBe('other');
    expect(GROUP_LABELS.other).toBe('אחר');
  });

  it('does not require every served tool to agree — the first recognised prefix wins', () => {
    // A connection realistically serves one family of tools; one stray,
    // unrelated tool name in the list must not push it into "other".
    expect(groupForServes(['mail.send', 'something.new'])).toBe('mail');
  });

  it('is not fooled by a prototype-chain lookup on a tool named after an Object property', () => {
    // `Object.hasOwn`, not a bare index/truthiness check (see the module's
    // own docblock) — `{}['constructor']` and `{}['toString']` both resolve
    // to a function through the prototype chain on a bare object, which
    // would make a tool literally named "constructor.foo" or "toString.bar"
    // silently "match" whichever group PREFIX_TO_GROUP's own bracket lookup
    // happened to coerce that function into, instead of falling through to
    // "other" the way every other unrecognised prefix does.
    expect(groupForServes(['constructor.foo'])).toBe('other');
    expect(groupForServes(['toString.bar'])).toBe('other');
    expect(groupForServes(['__proto__.baz'])).toBe('other');
  });

  it('falls through to "other" for an empty serves list', () => {
    expect(groupForServes([])).toBe('other');
  });
});

describe('GROUP_LABELS', () => {
  it('gives every group a non-empty Hebrew heading', () => {
    for (const group of CONNECTION_GROUP_ORDER) {
      expect(GROUP_LABELS[group].length).toBeGreaterThan(0);
    }
  });

  it('names exactly the six groups the display order lists, in both directions', () => {
    const fromOrder = [...CONNECTION_GROUP_ORDER].sort();
    const fromLabels = (Object.keys(GROUP_LABELS) as ConnectionGroup[]).sort();
    expect(fromOrder).toEqual(fromLabels);
  });
});
