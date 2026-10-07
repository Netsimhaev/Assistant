import { describe, expect, it } from 'vitest';
import { DIGEST_DEFAULTS } from '../governance/digest-settings.js';
import { renderDigestScreen } from './digest-view.js';

const live = { body: 'תדריך יומי · היום עד כה', windowLabel: '07/10 08:00 – עכשיו' };

describe('renderDigestScreen', () => {
  /**
   * Spec §4: the live view exists so the owner can see what a digest looks
   * like without committing to a schedule — and it must never be mistaken
   * for a stored one. The stored digest is a record; the live one is a
   * preview. 'עד כה' comes straight from `live.body`; 'טרם נשלח' is the
   * screen's own distinguishing label, rendered independently of the body.
   */
  it('marks the live view as live and distinguishes it from a stored digest', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live,
      csrf: 'c',
    });
    expect(html).toContain('עד כה');
    expect(html).toContain('טרם נשלח');
  });

  it('says plainly when no digest has ever been sent', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live,
      csrf: 'c',
    });
    expect(html).toContain('לא נשלח עדיין');
  });

  /** Spec §6: an unreachable channel is shown, not hidden. */
  it('shows that a channel was wanted and could not be reached', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [
        {
          digestId: 'DG-1',
          kind: 'daily',
          windowStart: '2026-10-06 08:00:00+03',
          windowEnd: '2026-10-07 08:00:00+03',
          body: 'גוף',
          hadContent: true,
          createdAt: '2026-10-07 08:00:01+03',
          emailState: 'failed',
          whatsappState: 'skipped_not_connected',
        },
      ],
      live,
      csrf: 'c',
    });
    expect(html).toContain('לא נשלח');
    expect(html).toContain('לא היה מחובר');
  });

  /**
   * A channel the owner never enabled (`null`) must not render as though it
   * had been attempted — "nothing to send" and "not sent" must stay visibly
   * different (spec §6). Checked by absence: neither label the two
   * *attempted* states carry should appear when both states are `null`.
   */
  it('shows nothing for a channel the owner never enabled', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [
        {
          digestId: 'DG-2',
          kind: 'daily',
          windowStart: '2026-10-06 08:00:00+03',
          windowEnd: '2026-10-07 08:00:00+03',
          body: 'גוף אחר לגמרי',
          hadContent: true,
          createdAt: '2026-10-07 08:00:01+03',
          emailState: null,
          whatsappState: null,
        },
      ],
      live,
      csrf: 'c',
    });
    expect(html).not.toContain('נשלח בהצלחה');
    expect(html).not.toContain('לא היה מחובר');
  });

  /** A stored body can carry a document name a stranger chose. */
  it('escapes and bidi-strips a stored body', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [
        {
          digestId: 'DG-1',
          kind: 'daily',
          windowStart: '2026-10-06 08:00:00+03',
          windowEnd: '2026-10-07 08:00:00+03',
          body: '<script>alert(1)</script>‮גרר',
          hadContent: true,
          createdAt: '2026-10-07 08:00:01+03',
          emailState: null,
          whatsappState: null,
        },
      ],
      live,
      csrf: 'c',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('‮');
    expect(html).toContain('גרר');
  });

  /**
   * Fix round 1, item 1: `live === null` must still render the history and
   * the form — neither needs the charter the live preview needs — and the
   * two reasons a preview can be unavailable ("no charter yet" vs. "charter
   * cannot be read") must say different things, never collapse into one
   * generic sentence.
   */
  it('says plainly that no charter has been signed yet, and still renders the form', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live: null,
      liveUnavailable: 'טרם נחתם תקנון עסקי — תצוגה חיה תופיע לאחר החתימה.',
      csrf: 'c',
    });
    expect(html).toContain('טרם נחתם תקנון עסקי');
    expect(html).toContain('לא נשלח עדיין שום תדריך');
    expect(html).toContain('name="dailyHour"');
  });

  it('says plainly that the charter cannot be read, with text distinct from "none yet"', () => {
    const noneYet = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live: null,
      liveUnavailable: 'טרם נחתם תקנון עסקי — תצוגה חיה תופיע לאחר החתימה.',
      csrf: 'c',
    });
    const unreadable = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live: null,
      liveUnavailable: 'התקנון החתום אינו קריא כרגע, ולכן אי אפשר להציג תצוגה חיה.',
      csrf: 'c',
    });
    expect(unreadable).toContain('אינו קריא כרגע');
    expect(unreadable).not.toContain('טרם נחתם תקנון עסקי');
    expect(noneYet).not.toContain('אינו קריא כרגע');
  });

  it('carries a CSRF token on the settings form', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live,
      csrf: 'tok-123',
    });
    expect(html).toContain('tok-123');
  });
});
