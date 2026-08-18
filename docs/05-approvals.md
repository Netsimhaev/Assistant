# סיכון, אישורים ואוטונומיה

---

## 1. סיווג הסיכון

כל פעולה עם תופעת לוואי מנוקדת על **שבעה ממדים**. שישה מהם מחושבים בקוד טהור.

```ts
export interface RiskAssessment {
  actionId: string; actionClass: ActionClass;
  dimensions: {
    money:              { amountMinor: number; pctOfDailyCeiling: number; score: number };
    reversibility:      { class: 'trivial'|'reversible'|'costly'|'irreversible'; score: number };
    externalVisibility: { audience: 'internal'|'one_known'|'one_unknown'|'many'|'public'; score: number };
    dataSensitivity:    { classes: DataClass[]; leavesInstance: boolean; score: number };
    novelty:            { metric: NormMetric; z: number; precedentIds: string[]; score: number };
    provenance:         { level: TrustLevel; chainDepth: number; score: number };
    charterFit:         { verdict: 'within'|'ambiguous'|'violates'; citedRuleIds: string[]; score: number };
  };
  total: number;                                   // משוקלל, 0–100
  band: 'routine' | 'sensitive' | 'anomalous' | 'blocked';
  decidedBy: 'rules' | 'rules+haiku' | 'rules+opus';
  explanation: string;                             // משפט אחד לבוס
  suggestedApprovers: string[];
}
```

### רצועות

| רצועה | תנאי | ניתוב |
|---|---|---|
| `routine` | סה"כ < 25 **וגם** `charterFit=within` **וגם** אף ממד לא מוקסם | בצע; רישום בלוג בלבד |
| `sensitive` | 25–60, או כסף מעל תקרת המחלקה, או מגע ראשון עם גורם לא מוכר | אישור, timeout רגיל |
| `anomalous` | חריגות z > 3, או `charterFit=ambiguous`, או `provenance=open_web` עם כל הוצאה | אישור עם הדגשת החריגה, timeout קצר, הסלמה ב-timeout |
| `blocked` | פרדיקט `forbidden` קשיח, הפרת תקרת מקור, או תקציב מוצה | דחה; הודע; **לעולם לא להציע כפתור אישור** |

---

## 2. זיהוי חריגות מול ההיסטוריה של העסק

זו הדרישה "לקרוא את אופי העסק" בצורתה הנמדדת.

```ts
export type NormMetric =
  | 'order_qty_for_sku'          // 50 יחידות מול p50=20, p95=30 → z גבוה
  | 'order_value_for_supplier'
  | 'discount_pct_for_customer'
  | 'quote_value_for_segment'
  | 'outbound_volume_per_day'
  | 'reply_length_for_channel'
  | 'first_contact_hour'
  | 'new_counterparty_rate';
```

`NormsEngine` מתחזק התפלגויות מתגלגלות (חלונות 30/90/365 יום) ב-Postgres, מחושבות מדי לילה.

> **סטטיסטיקה עמידה: חציון + MAD, לא ממוצע + סטיית תקן.** נתוני עסק הם heavy-tailed, והממוצע נגרר אחרי חריגים בודדים.

**התחלה קרה:** ב-60 הימים הראשונים *הכל* חריג. זו **התנהגות נכונה, לא באג** — מנגנון הרמפה (סעיף 5) שומר על אוטונומיה נמוכה ממילא בתקופה הזו.

> **החוקים המוצהרים (התקנון) והנורמות הנצפות (הפרופיל) נפרדים בכוונה.**
> התקנון אומר מה **מותר**. הפרופיל אומר מה **רגיל**.
> פעולה יכולה להיות מותרת לחלוטין ועדיין לדרוש מבט שני.

---

## 3. תור האישורים

```ts
export interface ApprovalRequest {
  id: string; jobId: string; envelopeId: string;
  actionClass: ActionClass;
  summary: string;              // שורה אחת, בגודל התראת טלפון, בעברית
  detail: string;               // גוף הכרטיס
  diffVsNorm?: string;          // "כמות 50 — בדרך כלל 20"
  artifacts: EvidenceRef[];     // טיוטת הטקסט, צילום העגלה, PDF ההצעה
  risk: RiskAssessment;
  proposedCall: { tool: string; input: unknown; inputHash: string };
  requestedFrom: { personId: string; channel: Channel }[];
  createdAt: string; expiresAt: string;
  onTimeout: 'expire' | 'escalate_next' | 'notify_only';
  state: 'pending'|'approved'|'approved_with_edit'|'denied'|'expired'|'cancelled';
  decision?: {
    by: string; at: string; channel: Channel; note?: string;
    editedInput?: unknown;
    inputHashAtDecision: string;   // שומר TOCTOU
  };
}
```

### שלושת ערוצי המסירה — כרטיס החלטה זהה בכולם

| ערוץ | תפקיד | נימוק |
|---|---|---|
| **דשבורד PWA + Web Push** | ראשי | שליטה מלאה בכרטיס, ראיות מלאות לנגד העיניים, אישור מרוכז לפריטים מאותה מחלקה, והיסטוריית ביקורת. אפס תלות בצד שלישי ואפס עלות להודעה. **כל החלטה שכרוכה בכסף אמיתי מוכרעת כאן** |
| **WhatsApp דרך הגשר** | התראה דחופה בנייד | הבוס כבר שם. הגשר שולח חופשי בכל זמן. **מענה בטקסט או במילת מפתח, לא בכפתורים** — כפתורים אינטראקטיביים אינם אמינים בלקוחות לא-רשמיים. הכרטיס מציג "השב 1 לאישור / 2 לדחייה / 3 לפרטים" ובנוסף קישור עמוק לדשבורד |
| **מייל עם קישורי HMAC** | גיבוי | קישורי approve/deny חתומים, nonce, TTL קצר. עצמאי לחלוטין. **לעולם לא הערוץ היחיד** — אישור במייל איטי מדי |

> **מסלול האישורים לעולם לא תלוי ב-WhatsApp.** הגשר הוא הערוץ השביר ביותר במערכת. הדשבורד והמייל חייבים להיות עצמאיים באמת, כך שאם הגשר יורד המערכת ממשיכה לתפקד במלואה ורק ההתראה בנייד נעלמת.

### שומר TOCTOU

האישור **נקשר ל-`inputHash`**. אם הקלט השתנה בין הבקשה להחלטה — למשל המחיר באתר הספק זז — ה-hash לא תואם וה-`PreToolUse` דוחה מחדש. אישור-עם-עריכה קושר את עצמו לקלט **הערוך**, וזה מה שמאפשר לבוס לשנות כמות בכרטיס ולראות את השינוי מבוצע נאמנה.

---

## 4. Kill switch

שלוש רמות. **כולן חייבות לשרוד restart של התהליך** — המצב יושב ב-Postgres ונבדק בראש כל `PreToolUse` וגם על ידי צרכן התור לפני כל dequeue.

| רמה | טריגר | אפקט |
|---|---|---|
| **עצירת מחלקה** | פקודת הבוס, או 3 אירועים בשעה באותה מחלקה | הצעדים של אותה מחלקה מפסיקים לצאת מהתור; ה-jobs נרדמים |
| **עצירת כל היוצא** | פקודת הבוס, או פרדיקט אירוע | כל הקריאה והניתוח ממשיכים; **שום דבר לא עוזב את הבניין** |
| **עצירה מלאה** | מילת פקודה של הבוס ("עצור הכל") בכל ערוץ, כפתור בדשבורד, או טריגר אירוע | כל התורים מתנקזים לרדומים; ריצות באוויר מקבלות `query.interrupt()`; באנר בכל מסך |

בנוסף: **ביטול הסשנים הפעילים של ה-CredentialBroker**, כדי שסשן דפדפן לא יוכל להשלים checkout אחרי עצירה.

חידוש דורש פעולה אנושית מפורשת ומייצר רשומת ביקורת עם סיבה.

---

## 5. אוטונומיה נרכשת — התשובה ל"כמה חבל לתת"

```ts
export interface AutonomyRamp {
  actionClass: ActionClass;
  level: AutonomyLevel;                  // התקרה האפקטיבית הנוכחית
  samples: number;                       // החלטות ב-30 הימים האחרונים
  approvedWithoutEdit: number;
  incidents: number;
  promotedAt?: string; demotedAt?: string;
}
```

### כללי קידום

| מעבר | תנאי |
|---|---|
| `draft_only` → `approve_required` | 20 דגימות עם ≥90% אישור או אישור-עם-עריכה-קלה |
| `approve_required` → `auto_notify` | 50 דגימות עם ≥95% אישור-ללא-עריכה **ואפס אירועים ב-30 יום** |
| `auto_notify` → `auto` | **רק בהחלטה מפורשת של הבוס.** לעולם לא אוטומטית, ולעולם לא למחלקה שכרוכה בכסף או באי-הפיכות |

### הורדה בדרגה

> **מיידית. אירוע אחד. בלי ויכוח.**
>
> כל תלונה, כל היפוך, כל הפרת תקנון → המחלקה יורדת דרגה אחת ודורשת 30 ימים נקיים כדי לטפס בחזרה.

---

## 6. מסלול הביקורת

טבלה אחת, append-only ומשורשרת-hash, שמשמשת גם כזיכרון האפיזודי (L2) וגם כרשומת התאימות.

```ts
export interface AuditEntry {
  seq: bigint;                    // מונוטוני
  at: string;
  jobId?: string; envelopeId?: string;
  actor: AgentId | 'orchestrator' | 'human' | 'system';
  onBehalfOf?: string;            // personId כשאדם החליט
  kind: 'intent_to_act' | 'tool_call' | 'tool_result' | 'decision' | 'approval'
      | 'policy_denial' | 'phase_change' | 'memory_write' | 'incident' | 'charter_change';
  actionClass?: ActionClass;
  charterVersion: string;
  provenance: TrustLevel;
  risk?: RiskAssessment;
  inputHash: string; outputHash?: string;
  artifacts: EvidenceRef[];
  costMinor?: number; tokens?: { in: number; out: number; cacheRead: number };
  prevHash: string; hash: string;  // sha256(prevHash || canonical(entry))
}
```

### התכונות שחשובות

- **הכוונה נרשמת לפני הקריאה**, כך שקריסה באמצע פעולה נראית לעין
- **שרשרת ה-hash** הופכת שיבוש לניתן לזיהוי
- כל רשומה נושאת את **גרסת התקנון**, כך שאפשר לענות "מה היו החוקים כשזה קרה?"
- הכל ניתן לתשאול **בשפה פשוטה** מהדשבורד — "הראה לי כל מה שהעוזרת עשתה עבור לקוח X"

שימור לפי `charter.data.retentionDays`, עם עקיפת legal-hold.
