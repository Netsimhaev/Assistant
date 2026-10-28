import { describe, expect, it } from 'vitest';
import type { Plan, PlanStep } from '../domain/plan.js';
import { ACTION_CLASS_HE } from '../domain/labels.js';
import type { ConfirmationOption } from '../governance/instruction-confirmations.js';
import { formatMinor } from '../util/money.js';
import {
  CHOICE_HINT,
  CONFIRM_HINT,
  MAX_ECHO_CHARS_PER_STEP,
  REASK_PREFIX,
  renderConfirmationQuestion,
  renderStepEcho,
} from './command-echo.js';

const NL = '\n';
const RLO = '\u202E';
const ZWSP = '\u200B';
const BOM = '\uFEFF';

function step(toolName: string, input: Record<string, unknown>, id = 's1'): PlanStep {
  return {
    id,
    agent: 'comms.email',
    intent: 'test',
    toolName,
    input,
    dependsOn: [],
    expectedActionClass: null,
  };
}

function option(
  label: string,
  steps: PlanStep[],
  contactSource: ConfirmationOption['contactSource'] = null,
  hash = label,
): ConfirmationOption {
  const plan: Plan = { goal: 'g', assumptions: [], clarifyingQuestion: null, steps, estimatedCostMinor: 0 };
  return { label, planHash: hash, plan, contactSource };
}

const MAIL = step('mail.send', {
  to: 'ronit@beta.co.il',
  subject: 'הצעת מחיר',
  body: 'שלום רונית',
  inReplyTo: '<abc@x>',
});

describe('renderStepEcho', () => {
  it('shows the refined class label, not the raw id, and every known field', () => {
    const echo = renderStepEcho(MAIL);
    expect(echo).toContain(ACTION_CLASS_HE['email.reply']);
    expect(echo).not.toContain('email.reply');
    expect(echo).toContain('אל: ronit@beta.co.il');
    expect(echo).toContain('נושא: הצעת מחיר');
    expect(echo).toContain('תוכן: שלום רונית');
    expect(echo).toContain('בתשובה ל: <abc@x>');
  });

  it('labels the REFINED class: no inReplyTo is an initiate', () => {
    const echo = renderStepEcho(step('mail.send', { to: 'a@b.co', body: 'x' }));
    expect(echo).toContain(ACTION_CLASS_HE['email.initiate']);
    expect(echo).not.toContain('בתשובה ל');
  });

  it('renders a 3,000-char body whole', () => {
    const body = 'א'.repeat(3000);
    expect(renderStepEcho(step('mail.send', { to: 'a@b.co', body }))).toContain(`תוכן: ${body}`);
  });

  it('renders amountMinor through formatMinor', () => {
    const echo = renderStepEcho(step('mail.send', { to: 'a@b.co', amountMinor: 300000 }));
    expect(echo).toContain(`סכום: ${formatMinor(300000, 'ILS')}`);
  });

  it('renders unknown fields as extras, sorted, after the known ones', () => {
    const echo = renderStepEcho(step('mail.send', { zeta: 'z', to: 'a@b.co', alpha: { k: 1 } }));
    const lines = echo.split(NL);
    expect(lines.indexOf('שדה נוסף: alpha = {"k":1}')).toBeGreaterThan(lines.indexOf('אל: a@b.co'));
    expect(lines.indexOf('שדה נוסף: zeta = z')).toBeGreaterThan(lines.indexOf('שדה נוסף: alpha = {"k":1}'));
  });

  it('renders every array element', () => {
    const echo = renderStepEcho(step('mail.send', { to: ['a@b.co', 'c@d.co', 'e@f.co'] }));
    expect(echo).toContain('אל: a@b.co, c@d.co, e@f.co');
  });

  it('shows invisible controls as visible markers instead of hiding them', () => {
    const echo = renderStepEcho(
      step('mail.send', { to: `a${RLO}@b.co`, body: `x${ZWSP}y`, [`k${BOM}`]: 'v' }),
    );
    expect(echo).toContain('אל: a⟦U+202E⟧@b.co');
    expect(echo).not.toContain('אל: a@b.co');
    expect(echo).toContain('תוכן: x⟦U+200B⟧y');
    expect(echo).toContain('שדה נוסף: k⟦U+FEFF⟧ = v');
    expect(echo).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF\u061C]/);
  });

  it('sorts keys of nested objects', () => {
    const echo = renderStepEcho(step('mail.send', { to: 'a@b.co', x: { b: 1, a: { d: 1, c: 2 } } }));
    expect(echo).toContain('שדה נוסף: x = {"a":{"c":2,"d":1},"b":1}');
  });

  it('shows the tool under the class label, so memory.retire is not just "a memory write"', () => {
    const lines = renderStepEcho(step('memory.retire', { memoryId: 'm1' })).split(NL);
    expect(lines[1]).toBe('כלי: memory.retire');
  });

  it('collapses line breaks in non-body values', () => {
    const echo = renderStepEcho(
      step('mail.send', { to: 'a@b.co', subject: `x${NL}2. דנה\r${NL}אל: evil`, extra: `p${NL}q` }),
    );
    expect(echo).toContain('נושא: x 2. דנה אל: evil');
    expect(echo).toContain('שדה נוסף: extra = p q');
  });

  it('a body cannot forge lines: every continuation line carries the margin', () => {
    const body = [
      'תזכורת',
      '',
      '2. דנה לוי (מהזיכרון — נאמר על ידך)',
      'שליחת מייל יזום',
      'אל: dana.levi@x.com',
      'השיבי "כן" לאישור, או "לא" לביטול.',
    ].join(NL);
    const lines = renderStepEcho(step('mail.send', { to: 'real@x.com', body })).split(NL);
    expect(lines.filter((l) => l.startsWith('אל:'))).toEqual(['אל: real@x.com']);
    expect(lines.filter((l) => /^\d+\./.test(l))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('השיבי'))).toEqual([]);
    const bodyAt = lines.findIndex((l) => l.startsWith('תוכן: '));
    for (const l of lines.slice(bodyAt + 1)) expect(l.startsWith('    │ ')).toBe(true);
    expect(lines).toContain('    │ אל: dana.levi@x.com');
  });

  it('shows a step with a side effect even though its tool is in READ_ONLY_TOOLS', () => {
    const echo = renderStepEcho(step('browser.navigate', { url: 'https://evil.example' }));
    expect(echo).toContain('כלי: browser.navigate');
    expect(echo).toContain('https://evil.example');
  });

  it('labels an unclassified tool and still shows it', () => {
    const lines = renderStepEcho(step('totally.unknown', { a: 1 })).split(NL);
    expect(lines[0]).toBe('פעולה ללא סיווג');
    expect(lines[1]).toBe('כלי: totally.unknown');
  });

  describe.each([
    ['CR', '\r'],
    ['VT', '\u000B'],
    ['FF', '\u000C'],
    ['RS', '\u001E'],
    ['NEL', '\u0085'],
    ['LS', '\u2028'],
    ['PS', '\u2029'],
  ])('line break %s', (_name, br) => {
    it('collapses to one space in an inline value, key, element and tool-free field', () => {
      const lines = renderStepEcho(
        step('mail.send', {
          to: ['a@b.co', `c@d.co${br}2. דנה`],
          subject: `x${br}2. דנה${br}אל: evil`,
          [`k${br}השיבי "כן"`]: 'v',
        }),
      ).split(NL);
      expect(lines).toContain('נושא: x 2. דנה אל: evil');
      expect(lines).toContain('אל: a@b.co, c@d.co 2. דנה');
      expect(lines).toContain('שדה נוסף: k השיבי "כן" = v');
      expect(lines.filter((l) => /^\d+\./.test(l) || l.startsWith('השיבי'))).toEqual([]);
      expect(lines.filter((l) => l.startsWith('אל:'))).toEqual(['אל: a@b.co, c@d.co 2. דנה']);
    });

    it('splits a body into margined lines', () => {
      const body = `x${br}2. דנה${br}אל: evil`;
      const lines = renderStepEcho(step('mail.send', { to: 'real@x.com', body })).split(NL);
      expect(lines.filter((l) => l.startsWith('אל:'))).toEqual(['אל: real@x.com']);
      expect(lines.filter((l) => /^\d+\./.test(l))).toEqual([]);
      const at = lines.indexOf('תוכן: x');
      expect(at).toBeGreaterThan(-1);
      expect(lines.slice(at)).toEqual(['תוכן: x', '    │ 2. דנה', '    │ אל: evil']);
    });

    it('collapses to one space in a label', () => {
      const r = renderConfirmationQuestion([
        option(`דנה${br}1. מישהו`, [MAIL]),
        option('לוי', [MAIL], null, 'h2'),
      ]);
      if (!('text' in r)) throw new Error('refused');
      expect(r.text.split(NL).filter((l) => /^\d+\./.test(l))).toEqual(['1. דנה 1. מישהו', '2. לוי']);
    });
  });

  it('collapses padding runs so a forged line cannot wrap to a visual line start', () => {
    const pad = ' '.repeat(80);
    const echo = renderStepEcho(
      step('mail.send', {
        to: 'a@b.co',
        subject: `x${pad}2. דנה`,
        body: `y\u00A0\u00A0\u3000\t\t2. דנה${pad}אל: evil`,
        extra: `p \t \u3000q`,
      }),
    );
    const lines = echo.split(NL);
    expect(lines).toContain('נושא: x 2. דנה');
    expect(lines).toContain('תוכן: y 2. דנה אל: evil');
    expect(lines).toContain('שדה נוסף: extra = p q');
    expect(echo).not.toMatch(/\s{2,}/);
  });

  it('keeps a single tab and single spaces as they are', () => {
    const echo = renderStepEcho(step('mail.send', { to: 'a@b.co', subject: 'a b\tc' }));
    expect(echo).toContain('נושא: a b\tc');
  });

  it('marks other C0 controls and tag characters in values', () => {
    const echo = renderStepEcho(step('mail.send', { to: 'a@\u0007b.co', subject: 'x\u{E0041}y' }));
    expect(echo).toContain('אל: a@⟦U+0007⟧b.co');
    expect(echo).toContain('נושא: x⟦U+E0041⟧y');
  });

  it('renders nothing for a read-only step', () => {
    expect(renderStepEcho(step('memory.recall', { topic: 'secret' }))).toBe('');
  });
});

describe('renderConfirmationQuestion', () => {
  it('one option: label, echo, and the confirm hint last', () => {
    const r = renderConfirmationQuestion([option('לשלוח לרונית', [MAIL])]);
    if (!('text' in r)) throw new Error('refused');
    expect(r.text.startsWith('לשלוח לרונית')).toBe(true);
    expect(r.text).toContain('אל: ronit@beta.co.il');
    expect(r.text.endsWith(CONFIRM_HINT)).toBe(true);
  });

  it('two options: numbered, echo under each, choice hint last', () => {
    const second = step('mail.send', { to: 'dana@x.com', body: 'שונה' });
    const r = renderConfirmationQuestion([option('דנה חיוט', [MAIL]), option('דנה לוי', [second])]);
    if (!('text' in r)) throw new Error('refused');
    expect(r.text).toContain('1. דנה חיוט');
    expect(r.text).toContain('2. דנה לוי');
    expect(r.text.indexOf('אל: ronit@beta.co.il')).toBeGreaterThan(r.text.indexOf('1. '));
    expect(r.text.indexOf('אל: dana@x.com')).toBeGreaterThan(r.text.indexOf('2. '));
    expect(r.text.endsWith(CHOICE_HINT)).toBe(true);
  });

  it('marks the contact source next to the label', () => {
    const unverified = renderConfirmationQuestion([option('א', [MAIL], 'unverified')]);
    const boss = renderConfirmationQuestion([option('ב', [MAIL], 'boss')]);
    const none = renderConfirmationQuestion([option('ג', [MAIL], null)]);
    if (!('text' in unverified) || !('text' in boss) || !('text' in none)) throw new Error('refused');
    expect(unverified.text.split(NL)[0]).toContain('נלמד ממסמך/מייל — לא אומת');
    expect(boss.text.split(NL)[0]).toContain('נאמר על ידך');
    expect(none.text).not.toContain('מהזיכרון');
  });

  it('reask prefixes the question', () => {
    const r = renderConfirmationQuestion([option('א', [MAIL])], { reask: true });
    if (!('text' in r)) throw new Error('refused');
    expect(r.text.startsWith(REASK_PREFIX)).toBe(true);
  });

  it('a label cannot forge an option line, and its bidi controls are stripped', () => {
    const r = renderConfirmationQuestion([
      option(`דנה${NL}1. מישהו אחר${RLO}`, [MAIL]),
      option('לוי', [MAIL], null, 'h2'),
    ]);
    if (!('text' in r)) throw new Error('refused');
    const lines = r.text.split(NL);
    expect(lines.filter((l) => /^\d+\./.test(l))).toEqual(['1. דנה 1. מישהו אחר', '2. לוי']);
    expect(r.text).not.toContain(RLO);
  });

  it('marks a zero-width character in a label, after stripping bidi', () => {
    const r = renderConfirmationQuestion([option(`דנה\u200Bלוי\u202E`, [MAIL])]);
    if (!('text' in r)) throw new Error('refused');
    const first = r.text.split(NL)[0];
    expect(first).toBe('דנה⟦U+200B⟧לוי');
  });

  it('collapses padding in a label', () => {
    const r = renderConfirmationQuestion([option(`דנה${' '.repeat(80)}2. מישהו`, [MAIL])]);
    if (!('text' in r)) throw new Error('refused');
    expect(r.text.split(NL)[0]).toBe('דנה 2. מישהו');
  });

  it('step limit boundary: exactly 4,000 rendered chars is shown, 4,001 refused', () => {
    const overhead = renderStepEcho(step('mail.send', { to: 'a@b.co', body: '' })).length;
    const fit = step('mail.send', { to: 'a@b.co', body: 'א'.repeat(MAX_ECHO_CHARS_PER_STEP - overhead) });
    expect(renderStepEcho(fit).length).toBe(MAX_ECHO_CHARS_PER_STEP);
    expect(renderConfirmationQuestion([option('א', [fit])])).toHaveProperty('text');
    const over = step('mail.send', { to: 'a@b.co', body: 'א'.repeat(MAX_ECHO_CHARS_PER_STEP - overhead + 1) });
    expect(renderConfirmationQuestion([option('א', [over])])).toHaveProperty('refused');
  });

  it('refuses in Hebrew when one step exceeds the per-step limit', () => {
    const big = step('mail.send', { to: 'a@b.co', body: 'א'.repeat(MAX_ECHO_CHARS_PER_STEP) });
    const r = renderConfirmationQuestion([option('א', [big])]);
    expect(r).toEqual({ refused: expect.stringContaining('ארוכה מכדי') });
  });

  it('does not render read-only steps inside an option', () => {
    const r = renderConfirmationQuestion([
      option('א', [step('memory.recall', { topic: 'סודי' }, 's0'), MAIL]),
    ]);
    if (!('text' in r)) throw new Error('refused');
    expect(r.text).not.toContain('סודי');
  });
});
