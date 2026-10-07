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

function day(at: Date): string {
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit' }).format(at);
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

function namedList(items: readonly DigestException[]): string[] {
  const shown = items.slice(0, MAX_NAMED_EXCEPTIONS);
  const lines = shown.map((e) => `· ${safe(e.subject)} — ${safe(e.reason)}`);
  const hidden = items.length - shown.length;
  if (hidden > 0) lines.push(`· ועוד ${hidden} שלא נמנו כאן.`);
  return lines;
}

export function renderDigest(facts: DigestFacts): RenderedDigest {
  const { window: w, waiting, done, exceptions, permissionChanges, cost } = facts;
  const lines: string[] = [];

  lines.push(`${KIND_LABEL[w.kind]} · ${day(w.start)}–${day(w.end)}`);

  // Spec §5: a merged window admits the gap instead of rewriting history.
  if (w.windowsCovered > 1) {
    lines.push(`(לא יצא תדריך ${w.windowsCovered} פעמים, וזה מכסה את כל התקופה.)`);
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
    lines.push('', 'מה לא עבר חלק:', ...namedList(exceptions));
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

  const hadContent =
    waitingTotal > 0 || doneTotal > 0 || exceptions.length > 0 || permissionChanges.length > 0;

  // Spec §2 decision 3: an empty day is SAID. The screen still gets it so the
  // record stays continuous; `hadContent` is what keeps it out of his inbox.
  if (!hadContent) lines.push('', 'לא קרה כלום בתקופה הזו.');

  return { body: lines.join('\n'), hadContent };
}
