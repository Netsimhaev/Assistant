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
    timeZone: 'Asia/Jerusalem',
    waiting: { approvals: 0, openQuestions: 0, deferred: 0 },
    done: { jobsCompleted: 0, messagesSent: 0, documentsRead: 0, memoriesWritten: 0 },
    exceptions: [],
    exceptionsHiddenCount: 0,
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
   * Fix round 3, item 1: the previous version of this test compared the
   * charter zone (`Asia/Jerusalem`) against a hardcoded expectation that
   * happened to match this repo's own process zone on every development
   * machine so far — so dropping `timeZone` from `day()`'s `Intl` options
   * entirely left this test green (13/13) unless the process was explicitly
   * launched with `TZ=UTC`, which `vitest.config.ts` never sets. A guard
   * that only fires under a flag nobody sets is not a guard.
   *
   * This version renders the SAME instant through two different SUPPLIED
   * zones and asserts they disagree with each other, each with the exact
   * date `Intl` actually produces for that zone — a mutation that ignores
   * the `timeZone` parameter and reads whatever the process zone happens to
   * be would make both renders IDENTICAL (same process, same instant, same
   * ignored parameter), so this cannot pass by accident regardless of what
   * zone the machine running it is in. `Pacific/Kiritimati` (UTC+14) is
   * chosen because no real server's default zone sits there, so there is no
   * plausible process zone under which the mutation would coincidentally
   * reproduce both assertions.
   *
   * `2026-10-06T12:00:00Z` is 02:00 on the 7th in `Pacific/Kiritimati`
   * (UTC+14) but still 15:00 on the 6th in `Asia/Jerusalem` (UTC+3, DST in
   * effect in early October) — a genuine calendar-date disagreement on the
   * SAME instant, driven only by which zone string is passed in.
   */
  it('renders different calendar dates for the same instant under two different supplied zones', () => {
    const window = {
      kind: 'daily' as const,
      start: new Date('2026-10-05T12:00:00Z'),
      end: new Date('2026-10-06T12:00:00Z'),
      windowsCovered: 1,
    };
    const kiritimatiHeader =
      renderDigest(facts({ window, timeZone: 'Pacific/Kiritimati' })).body.split('\n')[0] ?? '';
    const jerusalemHeader =
      renderDigest(facts({ window, timeZone: 'Asia/Jerusalem' })).body.split('\n')[0] ?? '';

    expect(kiritimatiHeader).toContain('07.10');
    expect(jerusalemHeader).toContain('06.10');
    expect(kiritimatiHeader).not.toBe(jerusalemHeader);
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
   * Fix round 2, item 4: `exceptions` arrives from `collectDigestFacts`
   * ALREADY capped and interleaved, so the renderer must list it verbatim
   * and print `exceptionsHiddenCount` exactly as given — never re-slice at
   * 20 and never derive "hidden" from `items.length`. Simulated here with
   * exactly `MAX_NAMED_EXCEPTIONS` (20) items (so a stray re-slice would be
   * invisible) and a hidden count that does NOT match `23 - 20`, which is
   * exactly the shape a capped-at-21-per-source fetch used to produce.
   */
  it('lists exactly what it is given and states the hidden count exactly as given', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      subject: `משימה ${i}`, reason: 'נכשלה.',
    }));
    const out = renderDigest(facts({ exceptions: twenty, exceptionsHiddenCount: 61 }));
    expect(out.body).toContain('משימה 0');
    expect(out.body).toContain('משימה 19');
    expect(out.body).not.toContain('משימה 20');
    expect(out.body).toContain('ועוד 61');
  });

  /** No "+N" line at all when nothing is hidden. */
  it('names every item with no "+N" line when nothing is hidden', () => {
    const out = renderDigest(facts({
      exceptions: [{ subject: 'משימה אחת', reason: 'נכשלה.' }],
      exceptionsHiddenCount: 0,
    }));
    expect(out.body).not.toContain('ועוד');
  });

  /** Spec §3.4 — the block that exists so a promotion is never discovered from the result. */
  it('reports a permission change', () => {
    const out = renderDigest(facts({
      permissionChanges: [{ subject: 'email.reply', reason: 'הורשתה לפעול בלי לשאול.' }],
    }));
    expect(out.body).toContain('email.reply');
    expect(out.hadContent).toBe(true);
  });

  /**
   * Fix round 2, item 3: `windowsCovered` counts every scheduled window this
   * digest absorbs INCLUDING the one now going out (`digest-window.ts`'s own
   * `dueWindow`) — so three covered means TWO missed, not three. The old
   * sentence printed `windowsCovered` itself and overstated every gap by
   * exactly one.
   */
  it('reports the number of windows MISSED, not the number this digest covers', () => {
    const out = renderDigest(facts({
      window: {
        kind: 'daily',
        start: new Date('2026-10-04T08:00:00+03:00'),
        end: new Date('2026-10-07T08:00:00+03:00'),
        windowsCovered: 3,
      },
    }));
    expect(out.body).toContain('לא יצא תדריך 2 פעמים');
    expect(out.body).not.toContain('תדריך 3 פעמים');
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
   * Found on the first run against real data: a job title is the owner's own
   * instruction text, which carries paragraph breaks, and a document name is
   * whatever the sender typed. A newline inside a subject split one bullet
   * into a bullet plus a stray line — and a sender who puts "\n· " in a file
   * name forges a bullet of his own in the one summary the owner trusts.
   * Each named item must stay exactly one line.
   */
  it('keeps a subject or reason that carries line breaks on its own single line', () => {
    const out = renderDigest(facts({
      exceptions: [
        { subject: 'תשיבי לרונית.\n\nרונית מבטא לוגיסטיקה', reason: 'נכשל.' },
        { subject: 'מכתב.txt\n· כל המשימות הושלמו בהצלחה', reason: 'נדחה.\r\nבאמת.' },
      ],
    }));
    const bullets = out.body.split('\n').filter((l) => l.startsWith('·'));
    expect(bullets).toContain('· תשיבי לרונית. רונית מבטא לוגיסטיקה — נכשל.');
    expect(bullets).toContain('· מכתב.txt · כל המשימות הושלמו בהצלחה — נדחה. באמת.');
    expect(bullets).toHaveLength(2);
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

  /**
   * Fix round 2, item 8: `hadContent` used to ignore cost entirely, so a
   * window whose only event cost money rendered the cost line immediately
   * above "לא קרה כלום בתקופה הזו" — and was withheld from email/WhatsApp
   * even though something plainly happened.
   */
  it('treats a window whose only event cost money as having content', () => {
    const out = renderDigest(facts({
      cost: { windowMinor: 500, rolling30Minor: 500, ceilingMinor: 50000, currency: 'ILS' },
    }));
    expect(out.hadContent).toBe(true);
    expect(out.body).not.toContain('לא קרה כלום');
  });

  /**
   * The flip side of the item 8 fix: a non-zero ROLLING 30-day figure alone
   * (spend from an earlier window still inside the 30-day lookback) says
   * nothing about whether THIS window had content, and must not flip
   * `hadContent` on its own.
   */
  it('does not treat a non-zero rolling 30-day figure alone as this window having content', () => {
    const out = renderDigest(facts({
      cost: { windowMinor: 0, rolling30Minor: 500, ceilingMinor: 50000, currency: 'ILS' },
    }));
    expect(out.hadContent).toBe(false);
  });
});
