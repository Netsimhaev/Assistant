import { describe, expect, it } from 'vitest';
import { DIGEST_DEFAULTS } from '../governance/digest-settings.js';
import { renderDigestScreen } from './digest-view.js';

const live = { body: 'תדריך יומי · היום עד כה', windowLabel: '07/10 08:00 – עכשיו' };

/** Chosen because it disagrees with UTC on the calendar date for an early
 * morning instant — see the dedicated zone test below. */
const TZ = 'Asia/Jerusalem';

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
      timeZone: TZ,
      csrf: 'c',
    });
    expect(html).toContain('עד כה');
    expect(html).toContain('טרם נשלח');
  });

  it('says plainly when no digest has ever been created', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live,
      timeZone: TZ,
      csrf: 'c',
    });
    expect(html).toContain('לא נוצר עדיין');
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
      timeZone: TZ,
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
      timeZone: TZ,
      csrf: 'c',
    });
    expect(html).not.toContain('נשלח בהצלחה');
    expect(html).not.toContain('לא היה מחובר');
  });

  /**
   * Fix round 2, item 2: a stored row must be labelled by when it was
   * CREATED, never by whether it was sent — `createdAt` is the write
   * moment, not a delivery, and both channels are off by default, so the
   * default configuration used to claim "sent at…" on a digest that went
   * nowhere. Delivery is spoken about only by the per-channel lines
   * (asserted separately above); the header line itself must never imply
   * it. `'נשלח ב-'` (with the trailing hyphen, matching the header's exact
   * shape) is distinctive from `'לא נשלח'` on the channel-state line two
   * tests up, which never has that trailing `'ב-'`.
   */
  it('labels a stored card by when it was created, never by whether it was sent', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [
        {
          digestId: 'DG-created',
          kind: 'daily',
          windowStart: '2026-10-06 08:00:00+03',
          windowEnd: '2026-10-07 08:00:00+03',
          body: 'גוף',
          hadContent: true,
          createdAt: '2026-10-07 08:00:01+03',
          emailState: null,
          whatsappState: null,
        },
      ],
      live,
      timeZone: TZ,
      csrf: 'c',
    });
    expect(html).toContain('נוצר ב-');
    expect(html).not.toContain('נשלח ב-');
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
      timeZone: TZ,
      csrf: 'c',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('‮');
    expect(html).toContain('גרר');
  });

  /**
   * Fix round 2, item 1 (second site): `shortDate` used to shorten a
   * Postgres `timestamptz::text` by plain string slicing, which the old
   * docblock claimed "avoids needing a zone this view is not given" — false,
   * because slicing shows whatever zone the DATABASE SESSION happens to
   * render in, silently. This reproduces exactly that server configuration:
   * the row's text carries a `+00` offset, as a UTC-session server would
   * print `timestamptz::text` — and `2026-10-06 22:00:00+00` is
   * `2026-10-06T22:00:00Z`, which is 01:00 on the 7th in `Asia/Jerusalem`
   * (UTC+3, no DST in October) — a different CALENDAR DATE, not just a
   * different hour.
   *
   * Old slicing reads the digits straight off the string regardless of
   * `timeZone` and would show '06/10 22:00'; formatted correctly through the
   * zone this test supplies, it must show '07/10 01:00'. A reverted fix
   * fails this assertion specifically, which a same-offset fixture (where
   * slicing and formatting coincidentally agree) cannot do.
   */
  it('formats a stored date in the charter zone it is given, not the one embedded in the text', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [
        {
          digestId: 'DG-tz',
          kind: 'daily',
          windowStart: '2026-10-05 22:00:00+00',
          windowEnd: '2026-10-06 22:00:00+00',
          body: 'גוף',
          hadContent: true,
          createdAt: '2026-10-06 22:00:00+00',
          emailState: null,
          whatsappState: null,
        },
      ],
      live,
      timeZone: TZ,
      csrf: 'c',
    });
    expect(html).toContain('07/10 01:00');
    expect(html).not.toContain('06/10 22:00');
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
      timeZone: 'UTC',
      csrf: 'c',
    });
    expect(html).toContain('טרם נחתם תקנון עסקי');
    expect(html).toContain('לא נוצר עדיין שום תדריך');
    expect(html).toContain('name="dailyHour"');
  });

  it('says plainly that the charter cannot be read, with text distinct from "none yet"', () => {
    const noneYet = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live: null,
      liveUnavailable: 'טרם נחתם תקנון עסקי — תצוגה חיה תופיע לאחר החתימה.',
      timeZone: 'UTC',
      csrf: 'c',
    });
    const unreadable = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live: null,
      liveUnavailable: 'התקנון החתום אינו קריא כרגע, ולכן אי אפשר להציג תצוגה חיה.',
      timeZone: 'UTC',
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
      timeZone: TZ,
      csrf: 'tok-123',
    });
    expect(html).toContain('tok-123');
  });
});
