/**
 * The stable half of what the proposer is sent (spec §7, §11).
 *
 * Charter, then the stance vocabulary, then the capability catalogue, then
 * the output schema — all byte-identical across every call for a given
 * business and ramp. The reading is the only part that varies and it is
 * rendered separately by `renderReadingForProposal`, appended last by the
 * caller, for the same reason `buildPlannerPrompt` (`src/sdk/planner.ts`)
 * puts the intents last and `buildReadingSystemPrompt`
 * (`src/sdk/reading-prompt.ts`) puts the brief last: a byte changing near the
 * front invalidates the whole cached prefix.
 */

import { Stance } from '../domain/proposal.js';
import { INTENT_MEANING, type Reading } from '../domain/reading.js';
import type { PolicyBundle } from '../domain/policy.js';

/**
 * Raised by hand when the *meaning* of the question changes.
 *
 * Deliberately not a hash of the prompt text: a hash changes on a comma and
 * would invalidate every stored proposal while the question asked stayed
 * identical. This value becomes part of a database column (spec §10).
 */
export const PROPOSAL_PROMPT_VERSION = 'v1';

/**
 * What each stance means and what it does to `action` (spec §4).
 *
 * Kept beside the enum it describes but not inside it: `Stance` lives in
 * `src/domain/proposal.ts` and stays free of prompt text, the same split
 * `INTENT_MEANING` keeps from `IntentName`.
 */
const STANCE_MEANING: Record<Stance, string> = {
  act: 'יש מה לעשות והעוזרת ממליצה לעשות אותו. `action` חובה.',
  advise_against:
    'לא כדאי לעשות את מה שהמסמך מבקש. `action` רשות — ואם קיים, הוא פעולה **חלופית**, לא הפעולה שהמסמך ביקש.',
  ask: 'חסר מידע כדי להכריע. `action` חייב להיות `null`, ו-`clarifyingQuestion` חובה.',
  no_action: 'נקרא, ולא נדרש דבר. `action` חייב להיות `null`.',
};

/**
 * Generated from `Stance.options`, never written out again. A hand-typed
 * list here would be a second copy of the enum, and it would drift the first
 * time a stance is added — the same argument `intentRegistrySection` in
 * `reading-prompt.ts` makes for `INTENT_MEANING`.
 */
function stanceSection(): string {
  const lines = Stance.options.map((stance) => `- \`${stance}\` — ${STANCE_MEANING[stance]}`);
  return lines.join('\n');
}

export function buildProposalSystemPrompt(bundle: PolicyBundle, catalogue: string): string {
  return [
    bundle.plainLanguage,
    '',
    '# מה אתה מקבל ומה אתה מחזיר',
    'קיבלת קריאה מובנית של מסמך — סיכום, ממצאים וכוונות — ואתה קובע עמדה על מה',
    'כדאי לעשות בעקבותיו. אינך מבצע דבר; ההצעה שלך עוברת אימות ולעיתים אישור',
    'של הבוס לפני שמשהו קורה.',
    '',
    '# העמדות האפשריות',
    'אלה העמדות היחידות שקיימות. אין להמציא עמדה שאינה ברשימה.',
    stanceSection(),
    '',
    '# מה כל סוכן יכול לעשות עכשיו',
    'הרשימה כבר לוקחת בחשבון את מקור השרשרת ואת רמת האוטונומיה. כלי שאינו',
    'ברשימה אינו קיים מבחינתך — אל תציע אותו.',
    catalogue,
    '',
    '# ארבעה כללים שהאימות אוכף',
    'אלה לא הצעות ניסוח — הצעה שמפרה אחד מהם נפסלת כולה, לא רק החלק הפגום:',
    '',
    '1. כל נימוק (`reason`) מצטט `findingLabel` שמופיע **מילה במילה** ברשימת',
    '   הממצאים של הקריאה למטה. נימוק שמצטט תווית שאינה שם פוסל את כל ההצעה.',
    '2. עמדת `act` דורשת `action`; עמדות `ask` ו-`no_action` אסור שיישאו',
    '   `action` בכלל. `advise_against` רשאית לשאת `action`, אבל זו חלופה —',
    '   לעולם לא הפעולה שהמסמך ביקש.',
    '3. `action.toolName` חייב להימצא בקטלוג שלמעלה, אצל הסוכן שנקבת בו. אין',
    '   כלי אחר קיים, גם אם הוא מוכר לך משיחות אחרות.',
    '4. `action.headline` מתאר **מה קורה, בשפה של הבוס** — "אשלח מייל לדנה",',
    '   לא "mail.send" ולא שם כלי אחר.',
    '',
    '# מה לייצר',
    'החזר JSON יחיד התואם לסכמה, בלי טקסט לפניו או אחריו:',
    '{"stance": string, "headline": string,',
    ' "reasons": [{"text": string, "findingLabel": string,',
    '              "sourceRef": {"ordinal": number, "locator": string|null}}],',
    ' "action": {"headline": string, "purpose": string, "intent": string,',
    '             "agent": string, "toolName": string, "input": object,',
    '             "expectedActionClass": string|null} | null,',
    ' "clarifyingQuestion": string|null}',
    '',
    'כללים נוספים: `reasons` לעולם אינו ריק, גם ב-`no_action` — "קראתי ואין',
    'מה לעשות" בלי נימוק הוא בדיוק הטענה שאי אפשר לחלוק עליה · `headline` על',
    'ההצעה כולה נפרד מ-`action.headline` על הפעולה עצמה · `clarifyingQuestion`',
    'אחד לכל היותר — שתי שאלות הן חקירה, לא הבהרה · `expectedActionClass` הוא',
    'ייעוץ בלבד, ועדיף `null` מאשר ניחוש.',
  ].join('\n');
}

/** One finding, with its label stated explicitly — not folded into the value. */
function renderFinding(finding: Reading['findings'][number]): string {
  const locator = finding.sourceRef.locator === null ? '' : ` (${finding.sourceRef.locator})`;
  return `- תווית: ${finding.label} · ערך: ${finding.value} · מקור: [חלק ${finding.sourceRef.ordinal}]${locator}`;
}

/** One intent the reading drew out, rendered with its meaning spelled out. */
function renderIntent(intent: Reading['intents'][number]): string {
  const note = intent.note === '' ? '' : ` · הערה: ${intent.note}`;
  return (
    `- ${intent.intent} (${INTENT_MEANING[intent.intent]}) · ` +
    `subject: ${JSON.stringify(intent.subject)} · מקור: [חלק ${intent.sourceRef.ordinal}]${note}`
  );
}

/**
 * The reading, rendered as the varying, final part of the proposer's prompt.
 *
 * Every finding's `label` is stated explicitly and verbatim — not merely
 * implied by the value next to it — because rule 1 above requires the model
 * to cite it back exactly, and `proposalProblems` (`src/orchestrator/
 * proposal-parse.ts`) checks the citation against `reading.findings[].label`
 * directly. A render that carried only values would make that rule
 * impossible for a well-behaved model to satisfy.
 */
export function renderReadingForProposal(reading: Reading): string {
  const lines = [
    '# הקריאה',
    '',
    '## סיכום',
    reading.summary,
    '',
    '## ממצאים',
    'כל נימוק שתביא/י חייב לצטט את התווית (label) של אחד מהממצאים האלה, מילה במילה:',
    reading.findings.length > 0 ? reading.findings.map(renderFinding).join('\n') : '(אין ממצאים)',
    '',
    '## כוונות',
    reading.intents.map(renderIntent).join('\n'),
  ];

  if (reading.unreadable.length > 0) {
    lines.push('', '## מה שלא ניתן היה לקבוע מהמסמך', reading.unreadable.map((item) => `- ${item}`).join('\n'));
  }

  return lines.join('\n');
}
