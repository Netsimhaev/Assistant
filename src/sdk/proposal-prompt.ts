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
import { AgentId } from '../domain/audit.js';
import { INTENT_MEANING, IntentName, type Reading } from '../domain/reading.js';
import type { PolicyBundle } from '../domain/policy.js';
import { READ_ONLY_CLASS_LABEL } from '../orchestrator/catalogue.js';
import { REFINEMENT_RULES } from '../policy/classify.js';
import { renderLocalToolContracts } from '../orchestrator/local-tools.js';

/**
 * Raised by hand when the *meaning* of the question changes.
 *
 * Deliberately not a hash of the prompt text: a hash changes on a comma and
 * would invalidate every stored proposal while the question asked stayed
 * identical. This value becomes part of a database column (spec §10).
 */
// Raised to v2 (09/09): the read-only-sentinel rule for `expectedActionClass`
// (commit "The catalogue's class column no longer offers a token the schema
// rejects") is a new hard constraint on a valid answer, not prose — a
// proposal cached under v1 was generated without the model ever having been
// told that rule.
//
// Raised to v3 (11/09): a read-only tool may no longer be an `action` at all,
// and `proposalProblems` enforces it. Same test as v2 — this changes which
// answers are valid, not merely how the question is worded, and a proposal
// cached under v2 was produced by a model that had never been told it.
//
// Raised to v4 (11/09): `proposalProblems` now compares the declared class
// against the REFINED one, matching the executor, so the payload-refinement
// rules are stated here. A proposal cached under v3 was produced by a model
// that would have been rejected by the check as it now stands.
//
// Raised to v5 (12/09): the local tools have a real executor now, and the
// payload each one requires is stated. A proposal cached under v4 was produced
// by a model that had to guess the shape -- and the live run showed it guessed
// plausibly and wrongly.
export const PROPOSAL_PROMPT_VERSION = 'v5';

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

/**
 * Renders a zod enum's options as an inline literal union — `"a"|"b"|"c"` —
 * for the JSON-schema example below.
 *
 * Generated, never hand-typed, for the same reason `stanceSection` is: a
 * hand-typed copy of a closed enum drifts the first time a member is added.
 * The schema block sits closest to generation and wins over prose written
 * earlier in the prompt, so a field that says `string` where the enum is
 * closed is a standing invitation for the model to invent a value — which is
 * exactly what happened to `stance` before this function existed.
 */
function literalUnion(options: readonly string[]): string {
  return options.map((option) => `"${option}"`).join('|');
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
    '   `action` בכלל.',
    '3. `action.toolName` חייב להימצא בקטלוג שלמעלה, אצל הסוכן שנקבת בו. אין',
    '   כלי אחר קיים, גם אם הוא מוכר לך משיחות אחרות.',
    '4. `action.headline` מתאר **מה קורה, בשפה של הבוס** — "אשלח מייל לדנה",',
    '   לא "mail.send" ולא שם כלי אחר. כותרת שהיא שם כלי מוכר (בדיוק) נפסלת.',
    '',
    '# הערה על `advise_against`',
    'כש-`advise_against` נושאת `action`, זו צריכה להיות פעולה **חלופית** —',
    'למשל הודעה שמסבירה מדוע לא — ולעולם לא הפעולה שהמסמך עצמו ביקש. זו הנחיה',
    'ולא בדיקה: האימות אינו יודע מה המסמך ביקש, ולכן אינו יכול לאכוף אותה.',
    '',
    '# מה לייצר',
    'החזר JSON יחיד התואם לסכמה, בלי טקסט לפניו או אחריו:',
    `{"stance": ${literalUnion(Stance.options)}, "headline": string,`,
    ' "reasons": [{"text": string, "findingLabel": string,',
    '              "sourceRef": {"ordinal": number, "locator": string|null}}],',
    ' "action": {"headline": string, "purpose": string,',
    `             "intent": ${literalUnion(IntentName.options)},`,
    `             "agent": ${literalUnion(AgentId.options)},`,
    '             "toolName": string, "input": object,',
    // expectedActionClass stays a general string, not an inlined literal
    // union: ActionClass has two dozen members and the rendered union runs
    // to roughly 400 characters — past what any other line in this file's
    // prompts runs to, and long enough that it stops being readable as a
    // schema field rather than serving as one. The field is advisory only
    // (see the note below) and null is explicitly preferred to a guess, so
    // the cost of leaving it unenumerated here is lower than for the three
    // fields above.
    '             "expectedActionClass": string|null} | null,',
    ' "clarifyingQuestion": string|null}',
    '',
    'כללים נוספים: `reasons` לעולם אינו ריק, גם ב-`no_action` — "קראתי ואין',
    'מה לעשות" בלי נימוק הוא בדיוק הטענה שאי אפשר לחלוק עליה · `headline` על',
    'ההצעה כולה נפרד מ-`action.headline` על הפעולה עצמה · `clarifyingQuestion`',
    'אחד לכל היותר — שתי שאלות הן חקירה, לא הבהרה · `expectedActionClass` הוא',
    'ייעוץ בלבד, ועדיף `null` מאשר ניחוש.',
    '',
    // The same rule `buildPlannerPrompt` carries, and for the same reason:
    // this prompt renders the very same catalogue, so the label the model
    // might copy is identical (L1). Built from the constant rather than
    // retyped, so the two cannot drift apart.
    `כלי שהקטלוג מסמן «${READ_ONLY_CLASS_LABEL}» חייב לקבל \`null\` ב-\`expectedActionClass\`. ` +
      'הסימון הזה אינו מחלקת פעולה ואין להעתיק אותו כמחרוזת — הצעה שתעשה זאת תיפסל.',
    '',
    // The live run of 11/09. The model judged, correctly, that a ₪11,988 quote
    // exceeded its own authority, and proposed to act with
    // `agent.request_help` — at the time a tool the catalogue offered at
    // `auto` with no action class of its own. Nothing rejected it,
    // `raiseProposalApproval` declined to card a classless tool, and the
    // owner was told nothing at all. `proposalProblems` refused that shape,
    // and this said why.
    //
    // `agent.request_help` is classified now (`agent.delegate`,
    // `policy/classify.ts`) — delegating to another agent is a legitimate
    // `action` a proposal may name, and `proposalProblems` cards it. The line
    // below no longer names it: naming a now-classified tool here would steer
    // the model away from a shape the gate accepts. What is still true, and
    // still worth saying explicitly, is `escalate_to_human` — genuinely
    // read-only, and bringing something to the owner's attention is what
    // raising the card already does, so it is never the `action` itself.
    'פעולה מוצעת חייבת להיות כלי שיש לו מחלקת פעולה — זה מה שמאפשר להעלות עליה',
    'כרטיס שהבעלים יאשר. כלי שהקטלוג מסמן כקריאה-בלבד אינו יכול להיות `action`,',
    'וגם לא כלי שמסלים לאדם (`escalate_to_human`): **הבאת העניין לידיעת הבעלים היא מה',
    'שקורה ממילא כשההצעה נרשמת** — אינה פעולה שאתה מציע. אם אין פעולה שהבעלים',
    'יכול לאשר, אמור זאת בעמדה: `ask` עם שאלה, או `no_action` / `advise_against`',
    'עם הנימוק. הצעה שתנקוב בכלי קריאה-בלבד כ-`action` תיפסל.',
    '',
    // The same block `buildPlannerPrompt` carries, and now load-bearing here
    // too: `proposalProblems` compares the declared class against the REFINED
    // one, so a proposal that trusts the catalogue's base column is rejected.
    // Rendered from the same constant, beside the function that enforces it.
    '# איך לקרוא לכלים המקומיים שממומשים',
    'לכלים האלה יש מימוש אמיתי, והמטען חייב להיות בדיוק בצורה הזו — צורה אחרת תיפסל:',
    renderLocalToolContracts(),
    '',
    '# מחלקות שהמטען קובע',
    'עמודת המחלקה בקטלוג מציגה את מחלקת הבסיס. לארבעה כלים המטען שכתבת הוא שקובע בפועל,',
    'ולכן קבע את `expectedActionClass` לפי המטען שכתבת ולא לפי העמודה:',
    ...REFINEMENT_RULES.map((r) => `- ${r.rule}`),
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
