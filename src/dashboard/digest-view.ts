/**
 * "מה קרה" — the owner's digest screen: the stored history (a record, read
 * back verbatim), a live preview of what a digest would say right now, and
 * the schedule/channel settings form.
 *
 * **A stored digest and the live preview must never be confusable.** The
 * stored body is what the owner was actually told, at the time, and is
 * rendered exactly as `recentDigests` returns it. The live block is computed
 * fresh on every page load, was never sent anywhere, and is labelled as such
 * — explicitly, not by omission — so "what did you tell me on Tuesday" always
 * has one unambiguous answer in the history section below it.
 *
 * Self-contained rather than built on top of `views.ts`'s private `page`/
 * `logoutForm` helpers — the same choice `conversation-view.ts` already made,
 * and for the same reason: `views.ts` is well past 1,600 lines and this
 * screen does not need to grow it further. `escLabel` is the one import that
 * matters: a stored body can carry a document name a stranger chose, and
 * `esc` alone would leave a bidi override free to rearrange what the owner
 * reads while leaving the bytes that were acted on untouched.
 */
import { DigestSchedule } from '../governance/digest-settings.js';
import type { DigestSettings } from '../governance/digest-settings.js';
import type { ChannelState, StoredDigest } from '../orchestrator/digest-store.js';
import { escapeHtml, escLabel } from './views.js';

const esc = escapeHtml;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 1rem; flex-wrap: wrap; }
  .card { border: 1px solid #8884; border-radius: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 1rem; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  .error { color: #c0392b; font-weight: bold; }
  pre { white-space: pre-wrap; word-break: break-word; background: #8881; padding: 0.75rem; border-radius: 0.4rem; }
  label { display: block; margin-top: 0.75rem; }
  select { margin-top: 0.2rem; }
  button { margin-top: 1rem; padding: 0.5rem 1.2rem; cursor: pointer; }
`;

const SCHEDULE_LABEL: Readonly<Record<DigestSchedule, string>> = Object.freeze({
  off: 'כבוי — אין תדריכים',
  daily: 'יומי',
  weekly: 'שבועי',
  both: 'יומי ושבועי',
});

/** 0 = Sunday, matching `digest-window.ts`'s own `weekday` convention. */
const WEEKDAY_LABELS: readonly string[] = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * A channel's state, by a positive label per value — never a negation. `null`
 * (the owner never enabled this channel) is handled by the caller: this
 * function is only ever reached for a channel that WAS wanted, so "not sent"
 * and "nothing to send" are never rendered as the same thing (spec §6).
 */
const CHANNEL_STATE_LABEL: Readonly<Record<ChannelState, string>> = Object.freeze({
  sent: 'נשלח בהצלחה',
  failed: 'לא נשלח — תקלה בשליחה',
  skipped_not_connected: 'לא נשלח — לא היה מחובר',
});

function hourOptions(selected: number): string {
  return Array.from({ length: 24 }, (_, hour) => {
    const chosen = hour === selected ? ' selected' : '';
    return `<option value="${hour}"${chosen}>${String(hour).padStart(2, '0')}:00</option>`;
  }).join('\n');
}

function weekdayOptions(selected: number): string {
  return WEEKDAY_LABELS.map((label, idx) => {
    const chosen = idx === selected ? ' selected' : '';
    return `<option value="${idx}"${chosen}>${esc(label)}</option>`;
  }).join('\n');
}

function scheduleOptions(selected: DigestSchedule): string {
  return DigestSchedule.options
    .map((option) => {
      const chosen = option === selected ? ' selected' : '';
      return `<option value="${esc(option)}"${chosen}>${esc(SCHEDULE_LABEL[option])}</option>`;
    })
    .join('\n');
}

/**
 * A Postgres `timestamptz::text` value (`YYYY-MM-DD HH:MM:SS+ZZ`), formatted
 * as `DD/MM HH:MM` in `timeZone` — the charter's own zone, passed in by the
 * caller.
 *
 * **Fix round 2, item 1.** This used to shorten the string by plain slicing,
 * on the claimed grounds that it "avoids needing a zone this view is not
 * given". That claim was false: Postgres renders `timestamptz::text` in the
 * DATABASE SESSION's zone, so slicing it silently inherited whatever zone
 * the server happened to be running under — on a default-UTC container, the
 * stored-digest card's window label and the digest body's own header
 * (`renderDigest`, now correctly formatted in the charter's zone — item 1,
 * first site) could show two different zones inside the SAME card. The text
 * already carries its own correct UTC offset (that is what
 * `timestamptz::text` means), so `new Date(...)` recovers the exact instant
 * regardless of which zone produced the string; only the FORMATTING step
 * needs `timeZone`, via `Intl` exactly like `digest-render.ts`'s `day`.
 *
 * If the shape does not parse as a date at all, the raw string is shown
 * rather than guessed at.
 */
function shortDate(pgTimestamp: string, timeZone: string): string {
  const at = new Date(pgTimestamp);
  if (Number.isNaN(at.getTime())) return pgTimestamp;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
}

/** One channel's row, or nothing at all when the owner never enabled it. */
function channelLine(label: string, state: ChannelState | null): string {
  if (state === null) return '';
  return `<div class="muted">${esc(label)}: ${esc(CHANNEL_STATE_LABEL[state])}</div>`;
}

/**
 * One stored digest — a record, never recomputed. `d.body` goes through
 * `escLabel`, never `esc` alone: it can carry a document name chosen by
 * whoever sent the file, and a bidi override inside it would change what the
 * owner reads without touching the bytes that were actually acted on.
 *
 * **Fix round 2, item 2: "נוצר ב-", never "נשלח ב-".** `createdAt` is the
 * moment the row was WRITTEN, not a delivery — and both channels are off by
 * default (spec §4), so in the default configuration every stored row used
 * to claim "sent at…" while nothing left the machine. Delivery is spoken
 * about only by the per-channel lines below this header, each labelled by
 * its own `ChannelState` — never by this header line, and never implied by
 * the header line's mere presence.
 */
function digestRow(d: StoredDigest, timeZone: string): string {
  const kindLabel = d.kind === 'daily' ? 'יומי' : 'שבועי';
  const channels = [channelLine('מייל', d.emailState), channelLine('וואטסאפ', d.whatsappState)]
    .filter((line) => line !== '')
    .join('\n');

  return `
    <article class="card">
      <div class="muted">
        ${esc(kindLabel)} · ${esc(shortDate(d.windowStart, timeZone))}–${esc(shortDate(d.windowEnd, timeZone))}
        · נוצר ב-${esc(shortDate(d.createdAt, timeZone))}
      </div>
      <pre>${escLabel(d.body)}</pre>
      ${channels}
    </article>`;
}

/**
 * The live-preview section, or — when the charter the preview needs cannot
 * be used at all — one Hebrew line saying so, in its place.
 *
 * `live === null` covers two different facts, and this project does not let
 * different facts look alike: "no charter has been signed yet" (an ordinary
 * state on a brand-new installation) and "the signed charter cannot be read"
 * (a schema mismatch — see `loadActiveCharter`'s own docblock) are distinct
 * messages, chosen by the caller via `liveUnavailable` and never collapsed
 * into one generic "unavailable" here. The fallback string below is only
 * reached if a caller forgets to supply one; it exists so this function
 * cannot throw or render a blank section, not as a message meant to be seen.
 *
 * The stored history and the settings form render regardless of this
 * section's state — `recentDigests` and `loadDigestSettings` never needed
 * the charter in the first place, and a missing/unreadable charter is no
 * reason to hide either of them.
 */
function renderLiveSection(
  live: { body: string; windowLabel: string } | null,
  liveUnavailable: string | undefined,
  schedule: DigestSchedule,
): string {
  if (live === null) {
    const message = liveUnavailable ?? 'תצוגה חיה אינה זמינה כרגע.';
    return `<section class="card">
  <h2>תצוגה חיה</h2>
  <p class="muted">${esc(message)}</p>
</section>`;
  }

  // Spec intent: under 'off' nothing is actually scheduled, so the preview
  // is illustrative rather than "what would have gone out a moment ago" —
  // said explicitly rather than left for the owner to infer from a switch
  // position elsewhere on the same page.
  const offNote =
    schedule === 'off'
      ? ' התדריכים כבויים כרגע — זו רק דוגמה למה שהיית מקבל אילו הפעלת אותם.'
      : '';

  return `<section class="card">
  <h2>תצוגה חיה — ${esc(live.windowLabel)}</h2>
  <p class="muted">
    תדריך כזה טרם נשלח לאף יעד — זו הדגמה בלבד של מה שהייתי אומרת לך עד כה,
    על בסיס הנתונים כרגע. השורה הזו לא נרשמת ולא נשמרת כתדריך.${offNote}
  </p>
  <pre>${escLabel(live.body)}</pre>
</section>`;
}

export function renderDigestScreen(options: {
  settings: DigestSettings;
  stored: readonly StoredDigest[];
  live: { body: string; windowLabel: string } | null;
  /**
   * The charter's own zone, for every date this screen shows — the stored
   * history's window/creation dates and the "last updated" note alike.
   * Required, with no default: a caller that has no charter to read (and so
   * no zone) must say so explicitly (`'UTC'`, documented at the call site),
   * never let this function fall back to one on its own.
   */
  timeZone: string;
  liveUnavailable?: string;
  csrf: string;
  error?: string;
}): string {
  const { settings, stored, live, csrf, timeZone } = options;
  const errorBlock = options.error === undefined ? '' : `<p class="error">${esc(options.error)}</p>`;

  const storedList =
    stored.length === 0
      ? '<p class="muted">לא נוצר עדיין שום תדריך.</p>'
      : stored.map((d) => digestRow(d, timeZone)).join('\n');

  const updatedNote =
    settings.updatedAt === ''
      ? ''
      : `<p class="muted">עודכן לאחרונה ב-${esc(shortDate(settings.updatedAt, timeZone))} על ידי ${esc(settings.updatedBy)}.</p>`;

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>מה קרה</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>מה קרה</h1>
</header>
${errorBlock}

${renderLiveSection(live, options.liveUnavailable, settings.schedule)}

<h2>היסטוריית תדריכים</h2>
${storedList}

<h2>הגדרות התדריך</h2>
${updatedNote}
<form method="post" action="/digest/settings">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <label>תדירות
    <select name="schedule">${scheduleOptions(settings.schedule)}</select>
  </label>
  <label>שעת התדריך היומי
    <select name="dailyHour">${hourOptions(settings.dailyHour)}</select>
  </label>
  <label>יום התדריך השבועי
    <select name="weeklyDay">${weekdayOptions(settings.weeklyDay)}</select>
  </label>
  <label>שעת התדריך השבועי
    <select name="weeklyHour">${hourOptions(settings.weeklyHour)}</select>
  </label>
  <label><input type="checkbox" name="toEmail"${settings.toEmail ? ' checked' : ''}> לשלוח במייל</label>
  <label><input type="checkbox" name="toWhatsApp"${settings.toWhatsApp ? ' checked' : ''}> לשלוח בוואטסאפ</label>
  <button type="submit">שמירה</button>
</form>

<p><a href="/">לכרטיסי האישור</a></p>
</body>
</html>`;
}
