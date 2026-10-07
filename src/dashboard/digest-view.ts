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
 * A Postgres `timestamptz::text` value (`YYYY-MM-DD HH:MM:SS+ZZ`), shortened
 * to `DD/MM HH:MM` by plain string slicing — never by parsing into a `Date`
 * and reformatting, which would need a time zone this view is not given and
 * was never meant to resolve on its own. If the shape does not match, the raw
 * string is shown rather than guessed at.
 */
function shortDate(pgTimestamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(pgTimestamp);
  if (!m) return pgTimestamp;
  const [, , month, day, hour, minute] = m;
  return `${day}/${month} ${hour}:${minute}`;
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
 */
function digestRow(d: StoredDigest): string {
  const kindLabel = d.kind === 'daily' ? 'יומי' : 'שבועי';
  const channels = [channelLine('מייל', d.emailState), channelLine('וואטסאפ', d.whatsappState)]
    .filter((line) => line !== '')
    .join('\n');

  return `
    <article class="card">
      <div class="muted">
        ${esc(kindLabel)} · ${esc(shortDate(d.windowStart))}–${esc(shortDate(d.windowEnd))}
        · נשלח ב-${esc(shortDate(d.createdAt))}
      </div>
      <pre>${escLabel(d.body)}</pre>
      ${channels}
    </article>`;
}

export function renderDigestScreen(options: {
  settings: DigestSettings;
  stored: readonly StoredDigest[];
  live: { body: string; windowLabel: string };
  csrf: string;
  error?: string;
}): string {
  const { settings, stored, live, csrf } = options;
  const errorBlock = options.error === undefined ? '' : `<p class="error">${esc(options.error)}</p>`;

  const storedList =
    stored.length === 0
      ? '<p class="muted">לא נשלח עדיין שום תדריך.</p>'
      : stored.map(digestRow).join('\n');

  const updatedNote =
    settings.updatedAt === ''
      ? ''
      : `<p class="muted">עודכן לאחרונה ב-${esc(shortDate(settings.updatedAt))} על ידי ${esc(settings.updatedBy)}.</p>`;

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

<section class="card">
  <h2>תצוגה חיה — ${esc(live.windowLabel)}</h2>
  <p class="muted">
    תדריך כזה טרם נשלח לאף יעד — זו הדגמה בלבד של מה שהייתי אומרת לך עד כה,
    על בסיס הנתונים כרגע. השורה הזו לא נרשמת ולא נשמרת כתדריך.
  </p>
  <pre>${escLabel(live.body)}</pre>
</section>

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
