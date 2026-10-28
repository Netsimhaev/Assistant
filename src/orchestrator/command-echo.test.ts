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
    const lines = echo.split('\n');
    expect(lines.indexOf('שדה נוסף: alpha = {"k":1}')).toBeGreaterThan(lines.indexOf('אל: a@b.co'));
    expect(lines.indexOf('שדה נוסף: zeta = z')).toBeGreaterThan(lines.indexOf('שדה נוסף: alpha = {"k":1}'));
  });

  it('renders every array element', () => {
    const echo = renderStepEcho(step('mail.send', { to: ['a@b.co', 'c@d.co', 'e@f.co'] }));
    expect(echo).toContain('אל: a@b.co, c@d.co, e@f.co');
  });

  it('strips bidi controls from values, keys, and nested JSON', () => {
    const rlo = '‮';
    const echo = renderStepEcho(
      step('mail.send', { to: `a${rlo}@b.co`, body: `x${rlo}y`, [`k${rlo}`]: { n: `v${rlo}` } }),
    );
    expect(echo).not.toMatch(/[‪-‮⁦-⁩‎‏؜]/);
    expect(echo).toContain('אל: a@b.co');
    expect(echo).toContain('שדה נוסף: k = {"n":"v"}');
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
    expect(unverified.text.split('\n')[0]).toContain('נלמד ממסמך/מייל — לא אומת');
    expect(boss.text.split('\n')[0]).toContain('נאמר על ידך');
    expect(none.text).not.toContain('מהזיכרון');
  });

  it('reask prefixes the question', () => {
    const r = renderConfirmationQuestion([option('א', [MAIL])], { reask: true });
    if (!('text' in r)) throw new Error('refused');
    expect(r.text.startsWith(REASK_PREFIX)).toBe(true);
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
