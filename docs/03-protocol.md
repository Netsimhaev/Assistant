# פרוטוקול השיתוף בין הסוכנים

סוכן **לעולם אינו קורא לסוכן אחר ישירות**. כל תקשורת עוברת ב-envelopes דרך ה-Orchestrator, שמאמת אותם.

---

## 1. ה-Envelope

```ts
export type AgentId =
  | 'intake.triage' | 'comms.email' | 'comms.whatsapp' | 'sched.meetings'
  | 'know.reader' | 'know.memory' | 'know.digest'
  | 'ops.tasks' | 'ops.web' | 'ops.systems'
  | 'prod.docs' | 'prod.media'
  | 'gov.charter' | 'gov.risk' | 'gov.verify';

export type TrustLevel =
  | 'boss' | 'staff' | 'known_counterparty' | 'unknown_external' | 'open_web';

export type AutonomyLevel =
  | 'forbidden' | 'draft_only' | 'approve_required' | 'auto_notify' | 'auto';

export interface AgentEnvelope<TPayload = unknown> {
  v: 1;
  id: string;                    // ULID
  correlationId: string;         // ה-job השורשי
  causalChain: string[];         // מזהי envelopes, שורש ראשון — מעקב לולאות ומקור
  from: AgentId | 'orchestrator';
  to: AgentId;
  kind: 'assign' | 'result' | 'help_request' | 'verify_request' | 'verdict' | 'escalate';
  intent: string;                // פועל יציב, סכמת zod רשומה לכל intent
  payload: TPayload;             // מובנה. לעולם לא בלוק טקסט חיצוני גולמי.
  contextRefs: ContextRef[];     // מצביעים; המקבל פותר אותם בעצמו
  acceptance: AcceptanceCriterion[];
  constraints: {
    charterVersion: string;
    provenanceCeiling: TrustLevel;   // האמון הנמוך ביותר בשרשרת הסיבתית
    autonomyCeiling: AutonomyLevel;  // תקרה קשיחה ל-envelope הזה
    tokenBudget: number;
    moneyCeilingMinor?: number;
    deadlineAt: string;
  };
  hops: number;                  // ++ לכל האצלה. תקרה קשיחה: 6
  idempotencyKey: string;
  createdAt: string;
}
```

---

## 2. שיתוף הקשר בלי לפוצץ את תקציב הטוקנים

> **הכלל: envelopes נושאים מצביעים, לא תוכן.**

`ContextRef` הוא מצביע שהסוכן המקבל פותר דרך כלי `memory.recall` **חסום** משלו.

```ts
export type ContextRef =
  | { kind: 'entity';       id: string }
  | { kind: 'thread';       id: string; maxMessages?: number }
  | { kind: 'doc';          id: string; span?: [number, number] }
  | { kind: 'artifact';     uri: string; sha256: string; mime: string }
  | { kind: 'memory_query'; query: string; scopes: MemoryScope[]; maxTokens: number };
```

שלושה מנגנונים שומרים על ההקשר חסום:

### א. אחזור מתוקצב

`memory.recall` מקבל `maxTokens` קשיח ומחזיר תוצאה **ארוזה**: תמצית תקנון → כרטיס ישות → top-k chunks → אפיזודות אחרונות, עם קיצוץ מהקצה הפחות חשוב. הוא **לעולם לא מחזיר יותר ממה שביקשו**. סוכן שביקש 4k טוקנים מקבל ≤4k.

### ב. סיכום-של-רשומה

לכל שרשור ולכל מסמך יש `summary` מתוחזק (מיוצר פעם אחת על ידי `know.reader`, מתעדכן הדרגתית). סוכנים מקבלים את הסיכום כברירת מחדל; טקסט מלא רק כשה-envelope מבקש span במפורש וה-intent מצדיק זאת.

### ג. Prompt caching על התחילית היציבה

תמצית התקנון + פרופיל הקול + ה-system prompt של הסוכן יציבים ברמת הבייט לכל גרסת תקנון ולכל סוכן, ונשמרים במטמון עם `cache_control`. תוכן תנודתי (חותמות זמן, מזהי job, תקציבים) בא **אחרי** נקודת השבירה האחרונה של המטמון.

> **לעולם אין להזריק חותמת זמן ל-system prompt.** זה הורס את המטמון בשקט ומשלש בערך את עלות הקלט במצב יציב.

### מלכודת: סף המטמון המינימלי משתנה בין שכבות המודל

תחילית קצרה מהסף **לא נשמרת במטמון בשקט** — בלי שגיאה, פשוט `cache_creation_input_tokens: 0`.

| מודל | סף מינימלי |
|---|---|
| Opus 5 | 512 טוקנים |
| Sonnet 5 | 1,024 טוקנים |
| **Haiku 4.5** | **4,096 טוקנים** |

> **ההשלכה על `intake.triage`:** הוא רץ על Haiku 4.5 והוא בעל נפח הקריאות הגבוה במערכת — בדיוק הסוכן שהמטמון הכי חשוב לו. אבל הסף שלו הוא **פי שמונה** מזה של Opus. תמצית תקנון של 1,500 טוקנים תיחסך במטמון אצל שאר הסוכנים ו**לא תיחסך אצלו כלל**.
>
> לכן התחילית של `intake.triage` צריכה להיות מתוכננת במפורש לחצות 4,096 טוקנים, או שיש לוותר על המטמון עבורו במודע ולתמחר בהתאם. **יש לאמת עם `usage.cache_read_input_tokens` — אם הוא אפס על פני ריצות חוזרות, זה מה שקורה.**

---

## 3. בקשת עזרה ממחלקה אחרת

סוכן פולט envelope מסוג `help_request` דרך כלי MCP בתוך התהליך — `agent.request_help({ to, intent, payload, why })` — שמחזיר מיד כרטיס. ה-Orchestrator מאמת:

```
help_request התקבל
  → hops < 6 ?                                 אחרת deny 'hop_limit'
  → to ∈ allowedCollaborators[from] ?          אחרת deny 'not_permitted'
  → intent רשום עבור `to` ?                    אחרת deny 'unknown_intent'
  → contextRefsHash לא נראה קודם על הזוג הזה עבור ה-intent הזה ?
                                               אחרת deny 'no_new_information'
  → נותר תקציב ?                               אחרת deny 'budget'
  → הכנסה לתור כ-PlanStep חדש, בירושת האילוצים (תקרות רק מתהדקות)
```

`allowedCollaborators` הוא **גרף מכוון סטטי** במדיניות המקומפלת. למשל `sched.meetings → comms.email` מותר; `ops.web → comms.whatsapp` אינו.

> **האילוצים מתהדקים מונוטונית במורד השרשרת.** ה-`provenanceCeiling` של envelope-בן הוא `min(הורה, המקור שלו)`, וה-`autonomyCeiling` שלו לעולם לא יכול לעלות על זה של ההורה. **אי אפשר להלבין הרשאות דרך האצלה.**

הריצה של הסוכן המבקש **נגמרת** אחרי `help_request`. הוא לא ממתין. ה-Orchestrator מחדש אותו עם התוצאה כשהיא מוכנה. כך הריצות נשארות קצרות, זולות ועמידות לקריסה.

---

## 4. אימות — איך תוצאה מתקבלת

תוצאה **לעולם אינה מתקבלת על סמך דבריו של הסוכן שביצע**. כל `PlanStep` נושא `VerificationStrategy` שהמתכנן בוחר מסט קבוע, מסודר מהזול ליקר:

```ts
export type VerificationStrategy =
  | { kind: 'assert';       check: PolicyPredicate }        // דטרמיניסטי, חינם
  | { kind: 'artifact';     validator: ArtifactValidator }  // נפתח? הנוסחאות מחשבות?
  | { kind: 'schema';       schemaId: string }              // הפלט תואם סכמה
  | { kind: 'cross_check';  source: 'crm' | 'calendar' | 'mailbox'; check: PolicyPredicate }
  | { kind: 'external_ack'; matcher: AckMatcher }           // הצד השני אישר
  | { kind: 'judge';        rubric: string; model: 'haiku' | 'sonnet' }
  | { kind: 'human';        personId: string };

export interface AcceptanceCriterion {
  id: string;
  statement: string;             // קריא לאדם, מוצג גם לשופט
  check?: PolicyPredicate;       // אם קיים — מוערך מכנית והוא הקובע
  severity: 'must' | 'should';
}
```

### הנחיות שהמתכנן מקיים

- **כל מה שניתן לבדיקה בקוד — חייב להיבדק בקוד.** "אירוע היומן קיים ב-14:00 עם משתתף X" הוא `assert`, לא קריאה לשופט.
- **`judge` רק לאיכות פרוזה ולשלמות** ("האם התשובה מתייחסת לשתי השאלות של הלקוח?"), תמיד עם הקשר `gov.verify` טרי שמעולם לא ראה את שיקולי הניסוח.
- **בדיקת עיגון מספרי** על כל מסמך ותדריך שנוצר: לחלץ כל מספר מהפלט ולוודא שכל אחד מתחקה למזהה עובדה בקלט.

> מספרים ללא מקור הם **גלאי ההזיות הזול ביותר שתבנו אי פעם**, והוא עולה אפס טוקנים.

- קריטריון `must` שנכשל → הצעד נכשל → תכנון מחדש (מקסימום 2) → הסלמה.

---

## 5. מניעת לולאות ופינג-פונג

חמישה שומרים בלתי תלויים, כי כל אחד מהם ייעקף בסופו של דבר.

| # | שומר | מנגנון |
|---|---|---|
| 1 | **תקרת hops** | `hops > 6` הוא deny קשיח |
| 2 | **תקציב** | טוקנים, זמן שעון וכסף — כולם יורדים ממעטפת ה-job. מיצוי עוצר |
| 3 | **אידמפוטנטיות** | `idempotencyKey` כפול נזרק עם רישום, לא מבוצע שוב |
| 4 | **גלאי אין-מידע-חדש** | `help_request` שה-`(from, to, intent, hash(contextRefs))` שלו תואם קודם באותו job — נדחה. **זה מה שבאמת הורג פינג-פונג:** A→B→A ממשיך רק אם ל-A יש הקשר חדש באמת |
| 5 | **גלאי תנודה בין זוג** | יותר מ-2 חילופים בין אותו זוג סוכנים על אותו intent בתוך job → ה-Orchestrator עוצר את תת-ה-DAG ומסלים לבוס עם התמליל |

> **שני סוכנים שחלוקים ביניהם הם סימן שאדם צריך להסתכל — לא שסוכן שלישי צריך להכריע.**

בנוסף: `maxTurns` על כל `query()` (מסופק על ידי ה-SDK) כרשת ביטחון לכל ריצה.

---

## 6. מרשם כוונות הקריאה — לא מרשם ה-intents של ה-envelope

> **אזהרה חשובה:** זה מרשם **אחר** מזה שסעיף 3 מתאר. שם `intent` הוא שדה על ה-envelope עם סכמת zod רשומה **לכל סוכן-נמען**, וזיהוי לולאות נשען על `(from, to, intent, contextRefsHash)` (סעיף 5, שומר #4). שום דבר מזה — ה-envelope עצמו, `hops`, `help_request` — עדיין לא נבנה. הסעיף הזה מתעד רק את המרשם השני, שכן נבנה.

תת-פרויקט ב' (קריאת מסמכים) בנה `IntentName` — מה שקורא מסמך יכול להסיק שנובע ממנו — ב-`src/domain/reading.ts`. עשר תוצאות עסקיות סגורות:

```ts
export const IntentName = z.enum([
  'reply_to_sender', 'contact_counterparty', 'schedule_meeting',
  'file_document', 'record_entity', 'record_preference',
  'pay_or_purchase', 'flag_for_owner', 'request_clarification', 'no_action',
]);
```

**כוונה שמה תוצאה, לעולם לא כלי.** `reply_to_sender`, לא `mail.send`. קורא שנוקב בכלי הוא קורא שבוחר סמכות, ו-`know.reader` הוא סוכן הסגר שהקלט שלו עוין בהגדרה — מיפוי כוונה לצעדים הוא עבודת המתכנן, שרואה את הקטלוג ואת התקנון. מבחן ב-`src/documents/reading-invariants.test.ts` דוחה כל שם שמכיל נקודה, הצורה של מזהה כלי.

**`EntityRef` — שלושה ענפים, ואין רביעי.** מי שהכוונה נוגעת בו הוא ישות מוכרת (`{ kind: 'entity', entityId }`), שולח ה-job עצמו (`{ kind: 'sender' }`, נפתר מרשומת ה-job ולעולם לא מהתוכן), או תיאור מילולי לא-פתור (`{ kind: 'unresolved', describedAs }`). **אין ענף שנושא כתובת.** מסמך יכול לומר שצריך לפנות למישהו; הוא אינו יכול לומר לאן ההודעה תלך. `entityId` מוקלד `SafeLookupKey` — אותו שומר שדוחה `__proto__`/`constructor`/`prototype` כמזהה ישות בתקנון.

**`sourceRef`** מצביע על החלק שממנו נגזרה הכוונה (`ordinal` — אחד מארטיפקטי המסמך שבאמת נשלחו לתדריך — ו-`locator` חופשי, מתוייג). כל כוונה, כמו כל ממצא, נבדקת שהיא מתייחסת לחלק שקיים; ציטוט למקור שלא קיים בתדריך הוא קריאה שנדחית, לא קריאה שמתקבלת. **"שנשלחו לתדריך" ולא "שקיימים במסמך"** — וזו ההבחנה שהבקרה חיה או מתה עליה: תקרת התדריך הכוללת (24,000 תווים) מפילה חלקים מאוחרים לגמרי, ולכן `renderReadingBrief` מחזיר גם את `includedOrdinals` — רשימת החלקים ששרדו את הקיצוץ — ו-`readingProblems` נבדק מולה, לא מול מערך הארטיפקטים. אחרת טענה שמיוחסת לטקסט שהמודל מעולם לא ראה עוברת את הבדיקה שנועדה בדיוק לה.

**מה שהמרשם הזה לא נותן.** אין לו קורא: `PlanRequest.intents` (`src/sdk/planner.ts`) עדיין מוקלד `unknown`, וכוונת קריאה לא הופכת לצעד בתוכנית עד שתת-פרויקט ג' יחווט `Intent[]` לתוכו. ועד אז, **פרוטוקול ה-envelope עצמו — שסעיפים 1–5 בקובץ הזה מתארים — נשאר בלתי בנוי**: אין `AgentEnvelope` שרץ בקוד, אין `help_request`, ואין את חמשת שומרי הלולאה. הסעיף הזה סוגר רק את חצי הכוונות; הפרוטוקול הוא עבודה נפרדת ועתידית.
