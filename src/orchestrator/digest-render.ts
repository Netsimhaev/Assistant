import { formatMinor } from '../util/money.js';
import { stripBidiControls } from '../util/bidi.js';
import type { DigestException, DigestFacts } from './digest-facts.js';
import { MAX_NAMED_EXCEPTIONS } from './digest-facts.js';

export interface RenderedDigest {
  body: string;
  /** False when the window held nothing worth interrupting him for — spec §2 decision 3. */
  hadContent: boolean;
}

const KIND_LABEL: Readonly<Record<DigestFacts['window']['kind'], string>> = Object.freeze({
  daily: 'תדריך יומי',
  weekly: 'תדריך שבועי',
});

/**
 * **Always formatted in the CHARTER's zone — `timeZone` has no default.**
 * `window.start`/`end` were computed in that zone by `digest-window.ts`; a
 * caller that formats them in some other zone (the process's default, on a
 * container or VPS that is not the charter's own) prints a header that can
 * disagree with the stored row's own boundaries and with the period the
 * owner actually lived through. Measured: the same instant renders `07.10`
 * under `Asia/Jerusalem` and `06.10` under `UTC`.
 */
function day(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', timeZone }).format(at);
}

/**
 * Every value that reaches the owner's eyes passes through here, and nothing
 * else composes a subject line. A document name is chosen by whoever sent the
 * file; a direction override inside it rearranges what he READS while leaving
 * the bytes that were acted on untouched.
 */
function safe(value: string): string {
  return stripBidiControls(value);
}

/** Used for §3.4 (`permissionChanges`), which the database never caps — so
 * the hidden count really is "how many more than `MAX_NAMED_EXCEPTIONS`",
 * computed from what was fetched because what was fetched is everything. */
function namedList(items: readonly DigestException[]): string[] {
  const shown = items.slice(0, MAX_NAMED_EXCEPTIONS);
  const lines = shown.map((e) => `· ${safe(e.subject)} — ${safe(e.reason)}`);
  const hidden = items.length - shown.length;
  if (hidden > 0) lines.push(`· ועוד ${hidden} שלא נמנו כאן.`);
  return lines;
}

/**
 * §3.3's own list. Unlike `namedList` above, `items` arrives ALREADY capped
 * and fairly interleaved across sources by `interleaveFairly`
 * (`digest-facts.ts`) — so this never slices again, and `hiddenCount` is the
 * exact, pre-measured figure `collectDigestFacts` computed from each
 * source's real `count(*) OVER ()`, never `items.length` minus a constant.
 */
function namedExceptionsList(items: readonly DigestException[], hiddenCount: number): string[] {
  const lines = items.map((e) => `· ${safe(e.subject)} — ${safe(e.reason)}`);
  if (hiddenCount > 0) lines.push(`· ועוד ${hiddenCount} שלא נמנו כאן.`);
  return lines;
}

export function renderDigest(facts: DigestFacts): RenderedDigest {
  const { window: w, waiting, done, exceptions, permissionChanges, cost, timeZone } = facts;
  const lines: string[] = [];

  lines.push(`${KIND_LABEL[w.kind]} · ${day(w.start, timeZone)}–${day(w.end, timeZone)}`);

  // Spec §5: a merged window admits the gap instead of rewriting history.
  //
  // **`windowsCovered - 1`, not `windowsCovered`.** `windowsCovered`
  // (`digest-window.ts`) counts every scheduled window this digest absorbs,
  // INCLUDING the one now going out — so a single missed day reports
  // `windowsCovered === 2`, and the sentence must say "1 time missed", not
  // "2 times". `windowsCovered` is never less than 1 (`dueWindow`'s own
  // `Math.max(1, ...)`), so this is never negative.
  if (w.windowsCovered > 1) {
    lines.push(`(לא יצא תדריך ${w.windowsCovered - 1} פעמים, וזה מכסה את כל התקופה.)`);
  }

  // §3.1 — leads, because it is the only part that will not happen without him.
  const waitingTotal = waiting.approvals + waiting.openQuestions + waiting.deferred;
  if (waitingTotal > 0) {
    lines.push('', 'ממתין לך:');
    if (waiting.approvals > 0) lines.push(`· ${waiting.approvals} אישורים שלא הוכרעו.`);
    if (waiting.openQuestions > 0) lines.push(`· ${waiting.openQuestions} שאלות שלי שממתינות לתשובה.`);
    if (waiting.deferred > 0) lines.push(`· ${waiting.deferred} משימות שעוצרות עד שתכריע.`);
  }

  // §3.2 — numbers only, no names.
  const doneTotal = done.jobsCompleted + done.messagesSent + done.documentsRead + done.memoriesWritten;
  if (doneTotal > 0) {
    lines.push('', 'מה נעשה:');
    if (done.jobsCompleted > 0) lines.push(`· ${done.jobsCompleted} משימות הושלמו.`);
    if (done.messagesSent > 0) lines.push(`· ${done.messagesSent} הודעות יצאו.`);
    if (done.documentsRead > 0) lines.push(`· ${done.documentsRead} מסמכים נקראו.`);
    if (done.memoriesWritten > 0) lines.push(`· ${done.memoriesWritten} דברים נרשמו לזיכרון.`);
  }

  // §3.3 — named, with the reason.
  if (exceptions.length > 0) {
    lines.push('', 'מה לא עבר חלק:', ...namedExceptionsList(exceptions, facts.exceptionsHiddenCount));
  }

  // §3.4 — the block that stops a promotion being discovered from the result.
  if (permissionChanges.length > 0) {
    lines.push('', 'מה השתנה בהרשאות שלי:', ...namedList(permissionChanges));
  }

  // §3.5 — both measures: what it cost, and how much is left.
  //
  // **"ב-30 הימים האחרונים", never "החודש".** The ceiling beside it is
  // enforced over a rolling 30 days (`spentInWindows`, policy/budget.ts), so
  // calling the figure a calendar month would make the two numbers on this one
  // line incomparable while reading as though they were not.
  if (cost.windowMinor > 0 || cost.rolling30Minor > 0) {
    lines.push(
      '',
      `עלות: ${formatMinor(cost.windowMinor, cost.currency)} בתקופה · ` +
        `${formatMinor(cost.rolling30Minor, cost.currency)} מתוך ` +
        `${formatMinor(cost.ceilingMinor, cost.currency)} ב-30 הימים האחרונים.`,
    );
  }

  // `cost.windowMinor > 0` is included so a window whose only event cost
  // money is never reported as "nothing happened" while a non-zero cost line
  // renders directly above that sentence — the contradiction this fixes.
  // `cost.rolling30Minor` is deliberately NOT part of this: it is a 30-day
  // rolling figure that can be non-zero in an otherwise-empty window just
  // because spend from an earlier window is still inside the 30 days, which
  // says nothing about whether THIS window had content.
  const hadContent =
    waitingTotal > 0 ||
    doneTotal > 0 ||
    exceptions.length > 0 ||
    permissionChanges.length > 0 ||
    cost.windowMinor > 0;

  // Spec §2 decision 3: an empty day is SAID. The screen still gets it so the
  // record stays continuous; `hadContent` is what keeps it out of his inbox.
  if (!hadContent) lines.push('', 'לא קרה כלום בתקופה הזו.');

  return { body: lines.join('\n'), hadContent };
}
