import { describe, expect, it } from 'vitest';
import type { DigestFacts } from './digest-facts.js';
import { renderDigest } from './digest-render.js';

function facts(over: Partial<DigestFacts> = {}): DigestFacts {
  return {
    window: {
      kind: 'daily',
      start: new Date('2026-10-06T08:00:00+03:00'),
      end: new Date('2026-10-07T08:00:00+03:00'),
      windowsCovered: 1,
    },
    waiting: { approvals: 0, openQuestions: 0, deferred: 0 },
    done: { jobsCompleted: 0, messagesSent: 0, documentsRead: 0, memoriesWritten: 0 },
    exceptions: [],
    permissionChanges: [],
    cost: { windowMinor: 0, rolling30Minor: 0, ceilingMinor: 50000, currency: 'ILS' },
    ...over,
  };
}

describe('renderDigest', () => {
  /**
   * Spec §2 decision 3: an empty day is said, not hidden and not padded. The
   * screen still receives it so the record stays continuous; `hadContent`
   * false is what keeps it out of his inbox.
   */
  it('says plainly that nothing happened, and marks the window as empty', () => {
    const out = renderDigest(facts());
    expect(out.hadContent).toBe(false);
    expect(out.body).toContain('לא קרה');
  });

  /** Spec §5: the digest states its own window, so the claim is checkable. */
  it('states the period it covers', () => {
    const out = renderDigest(facts());
    expect(out.body).toContain('06');
    expect(out.body).toContain('07');
  });

  /**
   * Spec §3: "what is waiting" leads, because it is the only part that will not
   * happen without him. A digest that opens with how much she managed buries
   * the one thing he has to act on.
   */
  it('puts what is waiting before what was done', () => {
    // NOTE: window overridden to Oct 1–2 (not the default Oct 6–7) because the
    // default end date's "07" contains the digit '7' in the header line,
    // which precedes the whole body — colliding with the '7' this assertion
    // is looking for in `jobsCompleted` and failing the test for a reason
    // that has nothing to do with section ordering. The brief's test used the
    // default window here; this is the one deviation documented in the task
    // report.
    const out = renderDigest(facts({
      window: {
        kind: 'daily',
        start: new Date('2026-10-01T08:00:00+03:00'),
        end: new Date('2026-10-02T08:00:00+03:00'),
        windowsCovered: 1,
      },
      waiting: { approvals: 2, openQuestions: 1, deferred: 0 },
      done: { jobsCompleted: 7, messagesSent: 3, documentsRead: 1, memoriesWritten: 2 },
    }));
    expect(out.body.indexOf('ממתין')).toBeLessThan(out.body.indexOf('7'));
    expect(out.hadContent).toBe(true);
  });

  /**
   * Spec §1.1: successes are a number, exceptions are a name and a reason.
   *
   * NOTE: asserts `'7 משימות'` rather than the lone digit `'7'`. This test
   * uses the default window ending 2026-10-07, so the header renders "07.10"
   * and contains the digit '7' regardless of whether `jobsCompleted` renders
   * at all — fix round 1, item 1.
   */
  it('counts successes and names each exception with its reason', () => {
    const out = renderDigest(facts({
      done: { jobsCompleted: 7, messagesSent: 3, documentsRead: 0, memoriesWritten: 0 },
      exceptions: [{ subject: 'עדכון המערכת', reason: 'החיבור לא נענה בזמן.' }],
    }));
    expect(out.body).toContain('7 משימות');
    expect(out.body).toContain('עדכון המערכת');
    expect(out.body).toContain('החיבור לא נענה בזמן.');
  });

  /**
   * Spec §9: capped at 20 with "+N", never truncated silently.
   *
   * NOTE: asserts `'ועוד 3'` rather than the lone digit `'3'`. With 23 items
   * capped at 20, the hidden count is 3 — but item index 3 is itself shown
   * as `משימה 3`, so a bare `toContain('3')` is satisfied by that shown item
   * regardless of whether the "+N" line exists at all. Verified: with the
   * `hidden > 0` branch deleted from the implementation, the brief's original
   * `toContain('3')` assertion still passed. This is the one other deviation
   * from the brief documented in the task report.
   */
  it('caps the named list and says how many it did not list', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      subject: `משימה ${i}`, reason: 'נכשלה.',
    }));
    const out = renderDigest(facts({ exceptions: many }));
    expect(out.body).toContain('משימה 0');
    expect(out.body).not.toContain('משימה 22');
    expect(out.body).toContain('ועוד 3');
  });

  /** Spec §3.4 — the block that exists so a promotion is never discovered from the result. */
  it('reports a permission change', () => {
    const out = renderDigest(facts({
      permissionChanges: [{ subject: 'email.reply', reason: 'הורשתה לפעול בלי לשאול.' }],
    }));
    expect(out.body).toContain('email.reply');
    expect(out.hadContent).toBe(true);
  });

  /** Spec §5: a merged window admits the gap rather than rewriting history. */
  it('admits the gap when it covers more than one scheduled window', () => {
    const out = renderDigest(facts({
      window: {
        kind: 'daily',
        start: new Date('2026-10-04T08:00:00+03:00'),
        end: new Date('2026-10-07T08:00:00+03:00'),
        windowsCovered: 3,
      },
    }));
    expect(out.body).toContain('3');
  });

  /**
   * A document name is chosen by whoever sent the file, and a direction
   * override inside it rearranges what the owner READS while leaving the bytes
   * untouched — and the digest is what he acts on. Same hazard `escLabel`
   * exists for, same single owner (`util/bidi.ts`).
   *
   * The positive half is load-bearing: a strip that ate the whole subject would
   * satisfy the absence check alone, and the test would then be asserting that
   * the owner is told nothing.
   */
  it('strips direction overrides from a subject a stranger chose', () => {
    const out = renderDigest(facts({
      exceptions: [{ subject: 'חשבונית‮gpj.exe', reason: 'נדחה.' }],
    }));
    expect(out.body).not.toContain('‮');
    expect(out.body).toContain('חשבונית');
  });

  /**
   * NOTE — fix round 1, item 2, two bugs in one assertion:
   *
   * (a) `/[a-z_.]+/g` strips lowercase only, while the check `/[A-Za-z]/`
   * looks for both cases — so a genuine lowercase English leak (e.g.
   * "debug trace leaked here") was deleted by the strip before the check
   * ever saw it, and the test stayed green.
   *
   * (b) the fixture carried no `permissionChanges`, so the test never
   * exercised the half of its own premise that identifiers like
   * `email.reply` are *allowed* through — tightening the regex alone, with
   * no identifier present to exempt, would prove nothing about the exemption.
   *
   * Fixed by requiring an internal `.`/`_` separator to count as an
   * "identifier" (so bare prose words are never stripped), and by adding a
   * real `email.reply` permission change so the exemption is genuinely
   * exercised alongside the prose check.
   */
  it('writes nothing in Latin letters to the owner', () => {
    const out = renderDigest(facts({
      done: { jobsCompleted: 2, messagesSent: 1, documentsRead: 0, memoriesWritten: 0 },
      permissionChanges: [{ subject: 'email.reply', reason: 'הורשתה לפעול בלי לשאול.' }],
    }));
    // Action-class names are identifiers (internal '.'/'_' separator) and may
    // appear; bare prose words may not.
    expect(out.body.replace(/[a-z]+(?:[._][a-z]+)+/g, '')).not.toMatch(/[A-Za-z]/);
  });
});
