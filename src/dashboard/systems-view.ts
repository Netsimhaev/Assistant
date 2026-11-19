/**
 * `GET /systems` — what the signed external systems have sent and what the
 * daily scan found (Stage D, Task 12). Read-only, behind the owner's session
 * and the no-charter gate like every other screen.
 *
 * One card per system in the ACTIVE charter: its label and host, the last
 * scan (time and outcome, in Hebrew), event counts over 24 hours and 7 days,
 * the newest items' first declared field, and how many webhook calls were
 * refused. Every value that came from outside — and the technician-written
 * labels — goes through `escLabel`, so neither markup nor a direction
 * override reaches the page.
 */
import type { ServerResponse } from 'node:http';
import { loadActiveCharter } from '../charter/store.js';
import type { BusinessDb } from '../db/pool.js';
import { countEventsSince, loadSystemState, recentEvents } from '../external/store.js';
import { SCAN_OK } from '../external/scan.js';
import { EXTERNAL_MESSAGES_HE } from '../orchestrator/adapters/external.js';
import { errorPage, page, sendHtml } from './mailbox-connect.js';
import { escLabel, escapeHtml as esc } from './views.js';

export const SYSTEMS_TITLE = 'מה הגיע ממערכות חיצוניות';

/** How many of a system's newest items the card names. */
export const SYSTEMS_RECENT_ITEMS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

const SCAN_OUTCOME_HE: Readonly<Record<string, string>> = {
  [SCAN_OK]: 'הצליחה',
  not_connected: 'המערכת אינה מחוברת כרגע — לא נסרקה',
  scan_unreadable: 'התשובה מהמערכת לא הייתה במבנה שהוגדר — לא נשמר דבר',
  bad_params: 'לא ניתן היה לבנות את בקשת הסריקה מההגדרה',
};

/** The Hebrew sentence for a stored outcome code; an unknown code is said as unknown, never shown raw. */
export function scanOutcomeText(code: string): string {
  if (Object.hasOwn(SCAN_OUTCOME_HE, code)) return SCAN_OUTCOME_HE[code] ?? '';
  if (Object.hasOwn(EXTERNAL_MESSAGES_HE, code)) return EXTERNAL_MESSAGES_HE[code as keyof typeof EXTERNAL_MESSAGES_HE];
  return 'תוצאה לא מוכרת';
}

function when(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export async function handleSystems(res: ServerResponse, db: BusinessDb, now: Date = new Date()): Promise<void> {
  let active;
  try {
    active = await loadActiveCharter(db);
  } catch {
    return sendHtml(res, 200, errorPage(SYSTEMS_TITLE, 'התקנון החתום אינו קריא כרגע, ולכן אי אפשר להציג את המערכות.'));
  }
  const systems = active?.charter.externalSystems ?? [];
  const timeZone = active?.charter.identity.timezone ?? 'UTC';

  const cards: string[] = [];
  // One after the other: every query runs on this request's one connection.
  for (const system of systems) {
    const state = await loadSystemState(db, system.id);
    const day = await countEventsSince(db, system.id, new Date(now.getTime() - DAY_MS));
    const week = await countEventsSince(db, system.id, new Date(now.getTime() - 7 * DAY_MS));
    const recent = await recentEvents(db, system.id, SYSTEMS_RECENT_ITEMS);

    const scanLine =
      system.scan === null
        ? 'אין סריקה יומית למערכת הזו.'
        : state?.lastScanAttemptAt === null || state?.lastScanAttemptAt === undefined
          ? `סריקה כל ${system.scan.everyHours} שעות — עוד לא בוצעה.`
          : `סריקה אחרונה: ${when(state.lastScanAttemptAt, timeZone)} — ${scanOutcomeText(state.lastScanOutcome ?? '')}` +
            (state.lastScanAt !== null && state.lastScanAt.getTime() !== state.lastScanAttemptAt.getTime()
              ? ` (הצלחה אחרונה: ${when(state.lastScanAt, timeZone)})`
              : '');

    const eventLabel = (type: string): string =>
      system.webhook?.events.find((e) => e.type === type)?.label ??
      system.operations.find((o) => o.name === type)?.label ??
      type;
    const items = recent.map((event) => {
      const first = event.fields[0];
      const value = first === undefined ? '' : ` — ${escLabel(first.label)}: ${escLabel(first.value)}`;
      return `<li>${esc(when(event.createdAt, timeZone))} · ${escLabel(eventLabel(event.eventType))}${value}</li>`;
    });

    const rejected = state?.rejectedHooks ?? 0;
    cards.push(`<div class="card">
<h2>${escLabel(system.label)} <span class="muted">(${escLabel(hostOf(system.baseUrl))})</span></h2>
<p>${esc(scanLine)}</p>
<p>אירועים: ${day} ב-24 השעות האחרונות · ${week} ב-7 הימים האחרונים</p>
${items.length === 0 ? '<p class="muted">עוד לא הגיע דבר מהמערכת הזו.</p>' : `<p>האחרונים:</p><ul>${items.join('')}</ul>`}
<p class="muted">התראות שנדחו (חתימה או מפתח שגויים): ${rejected}</p>
</div>`);
  }

  sendHtml(
    res,
    200,
    page(
      SYSTEMS_TITLE,
      `<h1>${esc(SYSTEMS_TITLE)}</h1>
<p>מה שהמערכות החיצוניות החתומות שלחו (התראות) ומה שהסריקה היומית מצאה. זה מידע שנכתב מחוץ לעסק: העוזרת לומדת ממנו כטענה, ולעולם אינה פועלת לפיו בלי שתבקש.</p>
${cards.length === 0 ? '<p>אין מערכות חיצוניות חתומות בתקנון.</p>' : cards.join('\n')}
<p><a href="/connections">&rarr; חזרה לחיבורים</a></p>`,
    ),
  );
}
