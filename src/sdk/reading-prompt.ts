/**
 * The stable half of what `know.reader` is sent (spec §5).
 *
 * Charter fragment, then the intent registry, then the output schema — all
 * byte-identical across every read. The brief is the only part that varies and
 * it travels as the user prompt, which is the whole reason this split exists:
 * a byte changing near the front invalidates the cached prefix, and the
 * catalogue's own docblock records what that costs.
 */

import { INTENT_MEANING, IntentName } from '../domain/reading.js';
import type { PolicyBundle } from '../domain/policy.js';

/**
 * Raised by hand when the *meaning* of the question changes.
 *
 * Deliberately not a hash of the prompt text: a hash changes on a comma and
 * invalidates every stored reading while the question asked stayed identical.
 * Whoever changes what is being asked raises this, and that is the decision we
 * want to be conscious.
 */
export const READING_PROMPT_VERSION = 'v1';

/**
 * Generated from `INTENT_MEANING`, never written out again. A hand-typed list
 * here would be a second copy of the registry, and it would drift from the
 * enum the first time someone added an intent.
 */
function intentRegistrySection(): string {
  const lines = IntentName.options.map((name) => `- \`${name}\` — ${INTENT_MEANING[name]}`);
  return lines.join('\n');
}

export function buildReadingSystemPrompt(bundle: PolicyBundle): string {
  return [
    bundle.promptFragments['know.reader'],
    '',
    '# מה אתה מחזיר',
    'אתה קורא מסמך ומחזיר קריאה מובנית. אינך מבצע דבר ואינך מחליט מה יקרה —',
    'אתה מדווח מה כתוב ומה משתמע.',
    '',
    '# הכוונות האפשריות',
    'אלה הכוונות היחידות שקיימות. אין להמציא כוונה שאינה ברשימה.',
    intentRegistrySection(),
    '',
    '# למי הכוונה מתייחסת',
    'לכל כוונה יש `subject`, באחת משלוש הצורות בלבד:',
    '- `{"kind":"sender"}` — מי ששלח את המסמך. אל תנקוב בשם או בכתובת; המערכת יודעת מיהו.',
    '- `{"kind":"entity","entityId":"..."}` — רק אם המזהה מופיע במסמך כמזהה של ישות מוכרת.',
    '- `{"kind":"unresolved","describedAs":"..."}` — כשהמסמך מתאר גורם ואינך יודע מיהו.',
    '',
    '**לעולם אל תכתוב כתובת מייל, מספר טלפון או יעד כלשהו כ-subject.**',
    'אם המסמך אומר לפנות למישהו ואינך יודע מיהו — זה `unresolved`.',
    '',
    '# ציטוט',
    'לכל ממצא ולכל כוונה יש `sourceRef.ordinal` — מספר החלק שממנו הוא נלקח,',
    'כפי שהוא מסומן בתדריך ב-`[חלק N]`. ציטוט לחלק שאינו קיים פוסל את כל הקריאה.',
    '',
    '# מה לייצר',
    'החזר JSON יחיד התואם לסכמה, בלי טקסט לפניו או אחריו:',
    '{"summary": string,',
    ' "findings": [{"label": string, "value": string,',
    '               "sourceRef": {"ordinal": number, "locator": string|null}}],',
    ' "intents": [{"intent": string, "subject": object,',
    '              "sourceRef": {"ordinal": number, "locator": string|null},',
    '              "note": string}],',
    ' "unreadable": string[]}',
    '',
    'כללים: `summary` בעברית · `intents` לעולם אינו ריק — אם לא נדרש דבר, החזר',
    '`no_action` · `findings` הם ערכים כלשונם מהמסמך, לא חישובים · `unreadable`',
    'מונה מה שלא הצלחת לקבוע. עדיף לומר שלא ידעת מאשר לנחש.',
  ].join('\n');
}
