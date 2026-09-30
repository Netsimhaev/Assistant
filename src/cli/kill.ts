/**
 * `kill` — the owner's handle on the emergency stop.
 *
 * **Why this file exists at all, six weeks after the mechanism did.**
 * `trip()` and `release()` (`governance/killswitch.ts`) have been complete,
 * tested in both directions, and enforced at stage 1 of the gate
 * (`policy/engine.ts`) since the first migration. They had **no production
 * caller of any kind** — no CLI entry, no dashboard route, nothing outside
 * their own test file. So the stop was real and unreachable: the gate would
 * have honoured it, and no owner had any way to pull it. That is the same
 * "declared but nobody reads it" defect this project has now paid for seven
 * times, inverted — a writer with no caller rather than a field with no
 * reader — and it sat on the one control an owner reaches for when something
 * is actively going wrong.
 *
 * Stage 0's exit condition names three things that must be provable from the
 * audit trail: a policy denial, an approval, and the kill switch. The first
 * two had been provable for weeks. The third could not be, because pulling it
 * required writing a throwaway script first.
 *
 * **A CLI and deliberately not a dashboard button.** Two reasons, and the
 * second is the load-bearing one. The dashboard is the assistant's own
 * surface: it needs a database that answers, a session that validates, and a
 * charter that parses. The emergency stop is exactly the control you want
 * when some of that is already misbehaving, and putting it behind the same
 * stack means the one case it exists for is the case where it may not render.
 * And a stop must be reachable by whoever holds the machine, which for this
 * product is the platform operator, not the business owner in a browser. A
 * dashboard button is worth adding later **beside** this, never instead.
 *
 * **Why `status` prints, and why it prints even when nothing is stopped.**
 * `kill_switch` (the table) is the only authoritative answer to "is anything
 * stopped right now" — `audit_log` records what happened, and `trip()`'s
 * non-transactional write means audit rows can land out of order relative to
 * it (that function's own docblock). An operator under pressure needs one
 * command whose answer is the live state, and "nothing is stopped" is an
 * answer, not an empty result.
 */
import { closePool } from '../db/pool.js';
import { config } from '../config.js';
import {
  AGENT_DEPARTMENT,
  activeScopes,
  release,
  trip,
  type Department,
  type KillScope,
} from '../governance/killswitch.js';

/** Every legal scope, in the order the usage message should list them. */
const DEPARTMENTS: readonly Department[] = [
  'front_office',
  'knowledge',
  'operations',
  'production',
  'governance',
];
const SCOPES: readonly KillScope[] = ['all', 'outbound', ...DEPARTMENTS];

function isScope(value: string): value is KillScope {
  return (SCOPES as readonly string[]).includes(value);
}

export interface KillCliDeps {
  log: (line: string) => void;
  businessId?: string;
}

const USAGE =
  'שימוש:\n' +
  '  npm run kill -- stop <היקף> <מפעיל> "<נימוק>"\n' +
  '  npm run kill -- resume <היקף> <מפעיל> "<נימוק>"\n' +
  '  npm run kill -- status\n' +
  `היקפים: ${SCOPES.join(', ')}`;

/**
 * Parses argv and moves the switch, or reports the live state.
 *
 * Throws rather than calling `process.exit`, the same shape `set-ramp.ts` and
 * `seed-job.ts` use, so `main` prints a readable message and a test can
 * assert `.rejects.toThrow()` without spawning a process. Nothing is written
 * before every argument has been validated — a stop whose reason is missing
 * is a stop nobody can explain afterwards, and the reason is the only part of
 * the audit row a human wrote.
 */
export async function runKillCli(argv: string[], deps: KillCliDeps): Promise<void> {
  const { log } = deps;
  const businessId = deps.businessId ?? config.businessId;

  const action = argv[0];
  if (action === undefined) throw new Error(USAGE);

  if (action === 'status') {
    if (argv.length > 1) throw new Error(`ל-status אין ארגומנטים.\n${USAGE}`);
    const active = await activeScopes(businessId);
    if (active.length === 0) {
      log(`אין שום עצירה פעילה עבור ${businessId} — כל ההיקפים פתוחים.`);
      return;
    }
    log(`עצירות פעילות עבור ${businessId}:`);
    for (const state of active) {
      log(`  ${state.scope.padEnd(14)} נעצר על ידי ${state.trippedBy ?? '—'} ב-${state.trippedAt ?? '—'}`);
      log(`  ${''.padEnd(14)} נימוק: ${state.reason ?? '—'}`);
    }
    log('');
    log('הטבלה `kill_switch` היא המקור הסמכותי היחיד למצב הנוכחי — לא `audit_log`.');
    return;
  }

  if (action !== 'stop' && action !== 'resume') {
    throw new Error(`פעולה לא מוכרת "${action}".\n${USAGE}`);
  }

  const rawScope = argv[1];
  const by = argv[2];
  const reason = argv[3];

  if (rawScope === undefined || by === undefined || reason === undefined) {
    throw new Error(USAGE);
  }
  if (argv.length > 4) {
    throw new Error(`ארגומנט עודף — עטוף את הנימוק במרכאות.\n${USAGE}`);
  }
  if (!isScope(rawScope)) {
    throw new Error(`היקף לא מוכר "${rawScope}".\nהיקפים: ${SCOPES.join(', ')}`);
  }
  if (by.trim().length === 0) throw new Error('שם המפעיל אינו יכול להיות ריק.');
  if (reason.trim().length === 0) throw new Error('הנימוק אינו יכול להיות ריק.');

  const scope: KillScope = rawScope;

  if (action === 'stop') {
    await trip(scope, by, reason, { businessId });
    log(`העצירה בהיקף "${scope}" פעילה מעכשיו עבור ${businessId}.`);
    log('');
    explainScope(scope, log);
    log('');
    log('שים לב: שלבים 1–4 של השער אינם כותבים שורת ביקורת, ולכן קריאה שנדחית');
    log('מהעצירה הזו נעצרת בשלב 1 ולא משאירה שורה משל עצמה ב-`audit_log`.');
    log('מה שכן נרשם הוא המעבר עצמו — השורה שנכתבה רגע לפני ההודעה הזו.');
    log('');
    log(`לשחרור: npm run kill -- resume ${scope} <מפעיל> "<נימוק>"`);
    return;
  }

  await release(scope, by, reason, { businessId });
  log(`העצירה בהיקף "${scope}" שוחררה עבור ${businessId}.`);
  const stillActive = await activeScopes(businessId);
  if (stillActive.length > 0) {
    log('');
    log('היקפים שעדיין עצורים:');
    for (const state of stillActive) log(`  ${state.scope}`);
    log('עצירה אחת שנשארת חוסמת בעצמה — שחרור של היקף אחד אינו פותח את השאר.');
  }
}

/**
 * What each scope actually stops, in the owner's terms.
 *
 * Derived from `AGENT_DEPARTMENT` rather than a hand-written list of agent
 * names: a sixteenth agent added to that table appears here on its own, and a
 * department whose membership changes cannot drift from what the gate reads.
 */
function explainScope(scope: KillScope, log: (line: string) => void): void {
  if (scope === 'all') {
    log('היקף "all" עוצר כל פעולה של כל סוכן — קריאה, ניתוח ושליחה כאחד.');
    return;
  }
  if (scope === 'outbound') {
    log('היקף "outbound" עוצר כל פעולה שיוצאת מהעסק, וממשיך להתיר קריאה,');
    log('ניתוח והכנת טיוטות. זו ההגדרה האמצעית השימושית: העוזרת ממשיכה לעבוד');
    log('ולא שולחת דבר. הפעולות שנחסמות הן אלה שמסומנות `OUTBOUND_TOOLS`.');
    return;
  }
  const members = Object.entries(AGENT_DEPARTMENT)
    .filter(([, department]) => department === scope)
    .map(([agent]) => agent);
  log(`היקף "${scope}" עוצר את הסוכנים של המחלקה הזו בלבד:`);
  for (const agent of members) log(`  ${agent}`);
  log('סוכנים במחלקות אחרות ממשיכים לעבוד כרגיל.');
}

async function main(): Promise<void> {
  await runKillCli(process.argv.slice(2), { log: (line) => console.log(line) });
}

// Only run when executed directly — never on import from the test. Same
// pattern as src/cli/set-ramp.ts and src/cli/seed-job.ts.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
  await closePool();
}
