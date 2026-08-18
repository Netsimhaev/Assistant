# ה-Orchestrator

**ההחלטה המכוננת: ה-Orchestrator הוא שירות TypeScript דטרמיניסטי עם מכונת מצבים עמידה — לא סשן Claude שמנהל סוכנים.**

Claude נקרא **בנקודות החלטה** (תכנון, ניסוח, שיפוט), לא כלולאת הבקרה. הסיבה: העבודה נמשכת ימים, חייבת לשרוד קריסות תהליך, וחייבת להיות ניתנת לביקורת בדיעבד. שיחת LLM אינה אף אחד משלושת אלה.

---

## 1. הלולאה כמצב ממשי

`להבין → לחשוב → לתכנן → לבצע → לבדוק → לעקוב → לזכור → לעדכן` היא **enum מתמיד בשורת `Job`** — לא הוראה בפרומפט.

```ts
export type JobPhase =
  | 'intake'         // אירוע גולמי נשמר, דה-דופליקציה, חותמת מקור
  | 'understand'     // triage/reader הפיקו ExtractedIntent[]  (גבול ההסגר)
  | 'plan'           // המתכנן הפיק Plan (DAG של צעדים)
  | 'await_approval' // PendingAction אחת או יותר בתור; ה-job רדום
  | 'execute'        // צעדים נשלחים לביצוע
  | 'verify'         // קריטריוני הקבלה מוערכים
  | 'followup'       // רדום עם wakeAt; עשוי לחזור ל-execute
  | 'remember'       // ה-Curator מקבע זיכרון עמיד
  | 'update'         // הצעות לנורמות, העדפות ותיקוני תקנון
  | 'closed' | 'failed' | 'halted';
```

כל מעבר כותב שורת `job_step`:

```ts
export interface JobStepLog {
  jobId: string;
  from: JobPhase; to: JobPhase;
  at: string;
  actor: AgentId | 'orchestrator' | 'human' | 'system';
  envelopeId?: string;
  costMinor?: number;
  reason: string;
}
```

ההיסטוריה המלאה של job ניתנת לשחזור מה-DB. **שום שלב לא חי רק בחלון ההקשר של מודל.**

> `think` אינו שלב בכוונה. הוא החשיבה של המתכנן (Opus) בתוך `plan`, בתוספת הערכת `gov.risk`. להפוך "לחשוב" למצב מתמיד לא קונה כלום.

**תשתית:** PostgreSQL 17 · pg-boss לתורים · advisory locks · scheduler ל-wakeups.

---

## 2. פירוק: איך המתכנן מייצר תוכנית

המתכנן הוא קריאת `query()` אחת ל-**Opus 5** עם:

- ה-`ExtractedIntent[]` — מובנה, **לעולם לא טקסט גולמי**
- **קטלוג יכולות מקומפל** — מי יכול לעשות מה, עם רמות האוטונומיה האפקטיביות הנוכחיות, כך שהתוכנית ישימה מעצם הבנייה
- תמצית התקנון ומעטפת התקציב
- זיכרון רלוונטי (חבילת recall חסומה)
- **פלט מובנה** מוגבל לסכמת `Plan`

```ts
export interface Plan {
  jobId: string;
  goal: string;                       // מנוסח מחדש במשפט אחד
  assumptions: string[];              // מה שהמתכנן הסיק — כל אחת היא סיכון
  clarifyingQuestion?: string;        // לכל היותר אחת. ראה למטה
  steps: PlanStep[];
  successCriteria: AcceptanceCriterion[];
  estimatedCostMinor: number;
  estimatedTokens: number;
}

export interface PlanStep {
  id: string;
  agent: AgentId;
  intent: string;                     // 'draft_reply' | 'find_slots' | 'place_order'
  input: unknown;                     // מאומת ב-zod לכל intent
  dependsOn: string[];                // קשתות ה-DAG
  writeScopes: string[];              // 'calendar:primary', 'thread:abc', 'supplier:42'
  acceptance: AcceptanceCriterion[];
  verification: VerificationStrategy;
  expectedActionClass?: ActionClass;  // מאפשר סריקת סיכון מקדימה לפני הביצוע
  compensation?: CompensationPlan;    // איך מבטלים, אם בכלל אפשר
}
```

### כלל השאלה האחת

המתכנן רשאי לפלוט **לכל היותר `clarifyingQuestion` אחת**, ורק כשביטחון בהנחה נמוך מסף התקנון, או כששתי פרשנויות מועמדות נבדלות בדרך שמשנה כסף או התחייבויות חיצוניות. אחרת הוא ממשיך.

הנימוק: עמימות מוסלמת, לעולם לא מנוחשת — כאן בדיוק עוזרות אוטונומיות מזיקות לעסקים. אבל עוזרת ששואלת חמש שאלות לכל בקשה גרועה מחסרת תועלת. מכאן: בדיוק אחת.

**הנחות לעולם אינן שקטות.** כל `assumption` מופיעה מילה במילה בכרטיס האישור.

---

## 3. ניתוב: מונע-Orchestrator, לא מונע-מודל

ה-Agent SDK מאפשר לסוכן ראשי להאציל לתת-סוכנים דרך כלי `Task`. הניתוב הזה הוא **החלטת מודל** — לא דטרמיניסטי וקשה לביקורת.

**ההחלטה:** העברות בין מחלקות נשלחות על ידי ה-Orchestrator כריצות `query()` **נפרדות, אחת לכל `PlanStep`**. תת-סוכני SDK משמשים רק לפיזור *בתוך צעד* שבו הסיכון נמוך וההורה קריאה-בלבד (למשל `know.reader` שמפזר קוראים מקבילים על 12 קבצים מצורפים).

הנימוקים:

1. כל העברה הופכת ל**שורה עמידה** במקום לתור נסתר
2. כל צעד מקבל allowlist, שכבת מודל וסט hooks משלו
3. קריסה באמצע job מאבדת **צעד אחד**, לא את הסשן כולו
4. אפשר לעצור בין צעדים לאישור בלי להחזיק תהליך פתוח

---

## 4. מקביליות

**במקביל** כשלצעדים יש `writeScopes` זרים ואין קשת DAG ביניהם. נאכף באמצעות Postgres advisory locks על מחרוזת ה-scope.

### כללי סריאליזציה שאינם נתונים למשא ומתן

| # | הכלל | הנימוק |
|---|---|---|
| 1 | **הודעה יוצאת אחת לכל שרשור צד-שני בכל רגע.** `lock('thread:<id>')` | בלי זה שני סוכנים עונים לאותו מייל לקוח, והעסק נראה שבור. **זהו מצב הכשל הנפוץ ביותר של עיצובים רב-סוכניים נאיביים** |
| 2 | **כותב אחד לכל יומן.** הצעת משבצות מקבילה; הקביעה מסוריאלת | מניעת קביעות כפולות |
| 3 | **כל פעולות ההוצאה ב-job מסוריאלות** וחולקות מונה תקציב אחד | הוצאה מקבילה עוקפת תקרות במרוץ |
| 4 | **כתיבות זיכרון לישות אחת** מסוריאלות דרך נעילת ה-Curator לכל ישות | מניעת סתירות |

**מקבילי באופן טבעי:** קריאת 12 קבצים מצורפים · תשאול CRM + יומן + תיבה עבור התדריך · ניקוד סיכון ל-N פעולות מוצעות · ניסוח וריאציות להשוואה.

---

## 5. עבודה שנמשכת ימים

**Jobs רדומים כברירת מחדל.** שלב `followup` קובע `wakeAt` וה-job עוזב את הזיכרון לחלוטין. scheduler סורק `wakeAt <= now()` ומכניס לתור מחדש.

```ts
export interface FollowUp {
  id: string; jobId: string;
  what: string;                        // 'הספק מאשר אספקה של PO-4471'
  owner: 'assistant' | 'boss' | 'counterparty';
  dueAt: string;
  checkStrategy: VerificationStrategy; // איך מזהים סיפוק בלי לשאול
  nudgePolicy: { max: number; sent: number; intervalHours: number; channel: Channel };
  escalateAfter?: string;
  state: 'open' | 'nudging' | 'satisfied' | 'escalated' | 'abandoned';
  evidence: EvidenceRef[];
}
```

> **נקודת העיצוב הקריטית: פולואפים מסופקים על ידי ראיה, לא על ידי שאילה.**
>
> `checkStrategy` מסוג `{kind:'external_ack', matcher:{channel:'email', pattern:'PO-4471', withinHours:72}}` אומר שצופה התיבה **סוגר את הפולואפ אוטומטית** כשהאישור מגיע.
>
> רק פולואפים **לא** מסופקים צורכים טוקנים. זה מה שהופך את "מעקב אחרי משימות" לבר-קיימא בקנה מידה.

---

## 6. טיפול בכשלים ו-retries

| מחלקת שגיאה | זיהוי | תגובה |
|---|---|---|
| חולף (5xx, 429, רשת, `overloaded_error`) | סטטוס HTTP / שגיאה מוטפסת מה-SDK | backoff מעריכי + jitter, תקרה 5 ניסיונות, כיבוד `retry-after` |
| סירוב מודל (`stop_reason: 'refusal'`) | בדיקת התגובה | **לא לנסות שוב** את אותו פרומפט. לרשום ולהסלים לאדם עם הקטגוריה |
| דחיית מדיניות | ה-hook החזיר deny | סופי לאותו צעד. תכנון מחדש **פעם אחת** עם סיבת הדחייה בהקשר; אם גם התכנון החדש נדחה — הסלמה |
| עמימות (הסוכן שואל) | שדה בפלט המובנה | הסלמה לבוס. **לעולם לא לפתור לבד** |
| כשל אימות | פסק דין המאמת | תכנון מחדש עם הפסק כקלט. **מקסימום 2 תכנונים מחדש**, אחר כך הסלמה |
| תופעת לוואי לא-אידמפוטנטית בספק | timeout אחרי כתיבה חיצונית | **לעולם לא retry עיוור.** קודם קריאת יישוב ("האם כבר קיימת הזמנה ל-X היום?"). אם לא ידוע — הסלמה |
| תקציב מוצה | BudgetGovernor | עצירת ה-job והודעה. **לא להידרדר בשקט** |

### אידמפוטנטיות

כל פעולה הנראית כלפי חוץ נושאת `idempotencyKey` הנגזר מ-`(jobId, stepId, canonicalInputHash)`, ונרשמת בטבלת `executed_actions` **לפני** הקריאה עם סטטוס `in_flight`. שחזור אחרי restart מיישב שורות `in_flight`.

### פיצוי, לא rollback

לכל פעולה ברת-ביצוע התוכנית רושמת `CompensationPlan` כשקיים כזה — `cancel_calendar_event`, `send_correction_email`, `void_crm_record`.

כשלא קיים — הודעת וואטסאפ שנשלחה, הזמנה שהונחה אצל ספק בלי API — הפעולה מסווגת `irreversible` וציון הסיכון שלה עולה בהתאם. **זה בדיוק מה שדוחף אותה לרצועת האישור.**
