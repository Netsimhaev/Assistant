# ביצוע פעולות במערכות חיצוניות — אפיון

**תת-מערכות 1+2 מתוך חמש.** מרשם היכולות והמתאם החיצוני הראשון.
נכתב 18/08/2026. סטטוס: אושר לתכנון מימוש.

---

## 1. הבעיה

היום המערכת יודעת לשפוט כל פעולה ולא יודעת לבצע אף אחת. `AGENT_ALLOWLISTS` מונה **48 שמות כלים**; `SDK_TO_INTERNAL` מכיל **שורה אחת** — `Read → doc.fetch`. הפער מכוון: שכבת ההרשאות נבנתה קודם כדי שכל כלי שיתחבר ימצא שער שכבר יודע לשפוט אותו. אבל התוצאה היא שהטבלאות נראות כמו יכולות, ואינן.

הדרישה: שהמערכת תבצע פעולות אמיתיות — מייל, יומן, וואטסאפ, CRM — ותשתמש בדפדפן כשאין למערכת חיבור אחר.

---

## 2. ההחלטות שנקבעו לפני העיצוב

| # | ההחלטה | הנימוק |
|---|---|---|
| 1 | **מרשם בקוד בוחר את הערוץ, לא המודל** | הבחירה בין API לדפדפן היא החלטת אבטחה. סשן דפדפן מחזיק את מלוא הסמכות של הבעלים באתר, והדף נכתב על ידי מי ששולט באתר. מודל שקרא תוכן מוזרק אפשר לשכנע לבחור בערוץ החזק יותר — *"ה-API של הספק לא זמין, פתח דפדפן"* הוא משפט שתוקף שותל בדף. המודל מצהיר **מה** הוא רוצה; הקוד קובע **איך**. |
| 2 | **הביצוע במריץ התוכנית, לא בלולאת הכלים של המודל** | `runPlan → executeStep → perform()` מבצע בקוד. המודל לא מחזיק את הסמכות בכלל, ולכן סשן שנחטף אינו בהקשר שלו. זה גם הנדבך היחיד שבו בקרה 4 מ-`docs/08-risks.md` — השוואת הסכום החי ב-DOM לסכום המאושר — ניתנת למימוש. |
| 3 | **מתאמים משלנו, Zapier כמתאם אחד מביניהם** | כל מתווך רואה את המטענים, כלומר את הודעות הלקוחות. מייל ויומן — מתאם ישיר שלנו. הזנב הארוך — Zapier, מוצהר ב-`data.subprocessorsAllowed`. |
| 4 | **התקנון קובע מה מותר; טבלה קובעת אם זה עובד** | חיבור מערכת חדשה נשאר פעולה חתומה. סיבוב credential לא דורש חתימה — אחרת אף אחד לא יסובב credentials. |

---

## 3. הארכיטקטורה

### שני חצאים

**החצי החתום — בתקנון.** אילו מערכות מחוברות, באיזה ערוץ, לאילו כלים הן משרתות, ומי מעבד את המטען בדרך החוצה.

**החצי התפעולי — טבלה.** האם החיבור חי כרגע, לאיזה endpoint, ומה ה-ref של ה-credential.

### האינווריאנט

> **הטבלה יכולה רק לצמצם, לעולם לא להרחיב.**

- מערכת שאינה בתקנון אין לה ערוץ, גם אם יש לה שורה בטבלה.
- לטבלה **אין עמודת `channel`**. היא לא יכולה לשנות ערוץ, בכוונה.
- `status: 'disconnected'` הופך חיבור מותר ללא-זמין. זו כל סמכותה.

זו הסיבה שזה אינו "שני מקורות אמת". התקנון הוא המקור היחיד ל**מה מותר**; הטבלה עונה רק על **האם זה עובד עכשיו**.

---

## 4. הסכמות

### התקנון — מפתח עליון חדש

```ts
connections: z.array(z.object({
  system: z.string().min(1),            // 'gmail' · 'supplier-a'
  label: z.string().min(1),             // מה שהבעלים קורא בעברית
  channel: z.enum(['api', 'browser']),
  serves: z.array(z.string()).min(1),   // ['mail.send']
  target: z.string().nullable(),        // ספק מסוים, או null = כל היעדים
  subprocessor: z.string().nullable(),  // null = ישיר
})).default([])
```

**`channel` חתום.** כאן חיה הדרישה "כשאין API — דפדפן": היא הופכת למשפט שהבעלים חתם עליו לכל מערכת בנפרד. מבחוץ ההתנהגות זהה לבחירה אוטומטית; ההבדל הוא שתוכן מוזרק אינו יכול לשנות אותה.

**`subprocessor` נאכף בקומפילציה** מול `data.subprocessorsAllowed`. מתאם שמעביר מטענים דרך צד שלישי שהבעלים לא חתם עליו — התקנון **נדחה בחתימה**, לא בזמן ריצה. זה עקבי עם ההכרעה הקיימת: אזור זמן שלא נפתר ודפוס רדקציה שלא מתקמפל נדחים באותה נקודה.

**`serves` נאכף מול מרשם הכלים** — שם כלי שאינו ב-`TOOL_ACTION_CLASS` ואינו ב-`READ_ONLY_TOOLS` פוסל את התקנון. אחרת חיבור יכול להצהיר על כלי שאינו קיים, וזה חוק מת.

### הטבלה

```sql
CREATE TABLE connection_bindings (
    business_id     TEXT        NOT NULL,
    system          TEXT        NOT NULL,
    status          TEXT        NOT NULL,   -- 'live' | 'disconnected' | 'error'
    endpoint        TEXT,
    credential_ref  TEXT,                   -- מצביע לסוד. לעולם לא הסוד
    last_ok_at      TIMESTAMPTZ,
    last_error      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, system),
    CONSTRAINT connection_status_known
        CHECK (status IN ('live', 'disconnected', 'error'))
);
```

אין מפתח זר ל-`charter_versions`: החיבור שורד החלפת תקנון, והתאמתו למערכת מוצהרת נבדקת בזמן פתרון ולא בזמן כתיבה.

---

## 5. הפותר

```ts
export type ChannelResolution =
  | { status: 'resolved'; system: string; channel: 'api' | 'browser' }
  | { status: 'no_channel'; reason: string }
  | { status: 'ambiguous'; systems: string[] }
  | { status: 'unavailable'; system: string; reason: string };

export function resolveChannel(
  bundle: PolicyBundle,
  bindings: ConnectionBinding[],
  toolName: string,
  targetId: string | null,
): ChannelResolution;
```

**כלל ההתאמה, בחיוב:**

1. אוספים כל חיבור ש-`serves` שלו מכיל את `toolName`.
2. מביניהם — קודם התאמה מדויקת ל-`target`, ורק אחר כך `target: null`.
3. **שתי התאמות באותה רמת ספציפיות → `ambiguous`, כלומר דחייה.** לא הראשונה במערך.

סעיף 3 אינו קפדנות יתר. סדר מערך שמכריע בין שתי מדיניויות נראה כמו החלטה ומתנהג כמו מקריות, וזו בדיוק מחלקת הבאגים ש-`positive-controls.test.ts` נועל.

**`targetId`** נגזר מהמטען באותה לוגיקה שבונה עובדות: `supplierId ?? counterpartyId`, ו-`null` כשאין אף אחד מהם. בלעדיו אי אפשר לבטא "ספק A דרך API, ספק B דרך דפדפן", שהיא כל הדרישה.

הגזירה חייבת להיות **פונקציה אחת** ששני אתרי הקריאה מייבאים — אימות התוכנית ו-`executeStep`. שתי גזירות שנכתבות בנפרד הן שתי גזירות שיתפצלו, וכשהן יתפצלו תוכנית תאושר מול ערוץ אחד ותתבצע מול אחר.

**חיבור מוצהר בלי מתאם מאחוריו נפסל באימות התוכנית** — `no_adapter_for_system`. התקנון יכול להצהיר על מערכת שהקוד עדיין לא מממש, וזה מצב תקין; מה שאינו תקין הוא לגלות אותו באמצע ביצוע.

**מערכת שהתקנון לא הזכיר → `no_channel`, כלומר דחייה.** לא נפילה-אחורה לדפדפן. נפילה אוטומטית למערכת לא מוכרת היא בדיוק המסלול שתוקף היה בוחר: להזכיר ספק חדש בתוכן ולקבל דפדפן פתוח מולו.

---

## 6. ממשק המתאם

```ts
export interface ExternalAdapter {
  readonly system: string;
  readonly channel: 'api' | 'browser';
  readonly serves: readonly string[];
  execute(call: AdapterCall): Promise<AdapterResult>;
}

export interface AdapterCall {
  toolName: string;
  /** המטען המצונזר. המתאם לעולם אינו רואה את מה שהסוכן הציע. */
  input: unknown;
  credential: CredentialHandle | null;
  signal: AbortSignal;
}

export type AdapterResult =
  | { ok: true; output: unknown; externalId: string | null }
  | { ok: false; retryable: boolean; code: string; message: string };
```

**שלוש הכרעות:**

**המתאם מקבל את המטען המצונזר בלבד.** `executeStep` כבר מוסר ל-`perform` את `decision.redactedInput` ולא את הקלט המקורי — המתאם יורש את התכונה ואינו יכול לשלוח את המקור בטעות.

**מתאם מחזיר תוצאה, לא זורק.** חריגה שבורחת ממתאם עוקפת את רישום התוצאה ומשאירה שורת כוונה בלי סוף. `executeStep` יעטוף בכל זאת — אבל הממשק מצהיר על החוזה.

**`retryable` מפריד** בין "השרת היה למטה" ל"הכתובת שגויה". הראשון חוזר ל-`followup` עם `wakeAt`, המסלול שה-scheduler כבר מפעיל. השני נכשל.

---

## 7. זרימת הנתונים

```
runPlan
  ├─ אימות התוכנית (לפני שצעד אחד רץ)
  │    ├─ planStepIsFeasible  — הסוכן מחזיק את הכלי
  │    └─ resolveChannel      — היתכנות: יש ערוץ לכלי הזה
  │         └─ no_channel | ambiguous → התוכנית נפסלת כולה
  │
  └─ לכל צעד, בסדר תלות:
       executeStep
         ├─ evaluateToolCall — עשרת שלבי השער
         │    └─ הכוונה נרשמת בביקורת לפני כל היתר
         ├─ allow → resolveChannel שוב (זמינות)
         │    └─ unavailable → refused, אחרי שהכוונה כבר נרשמה
         ├─ credential.resolve(ref)
         └─ perform = adapter.execute({ input: redactedInput, ... })
```

**שתי בדיקות ולא אחת.** בזמן תכנון — היתכנות, שפוסלת את התוכנית שלמה; זה מה ש-`runPlan` כבר עושה עם `planStepIsFeasible`, והוא הזול מבין הכשלים. בזמן ביצוע — זמינות, **אחרי** שהשער אישר, כדי שחיבור שנפל בין התכנון לביצוע ישאיר עקבות.

---

## 8. כשלים

| מצב | תוצאה | קוד |
|---|---|---|
| התקנון לא מכיר את המערכת | התוכנית נפסלת | `no_channel_for_tool` |
| שני חיבורים תואמים באותה רמה | התוכנית נפסלת | `ambiguous_channel` |
| אין binding, או `disconnected` | הצעד נדחה אחרי השער | `channel_unavailable` |
| אין credential ל-ref | הצעד נדחה אחרי השער | `credential_unavailable` |
| `retryable: true` | job ל-`followup` עם `wakeAt` | קוד המתאם |
| `retryable: false` | job ל-`failed` | קוד המתאם |
| המתאם זרק חריגה | הצעד נדחה | `adapter_threw` |
| התקנון מצהיר על מערכת שאין לה מתאם | התוכנית נפסלת | `no_adapter_for_system` |
| `channel: 'browser'` | הצעד נדחה, מסודר | `browser_not_implemented` |

**מונה הניסיונות נגזר ולא נשמר.** סופרים שורות `job_steps` שסיבתן מתחילה ב-`retry:<stepId>`, במקום להוסיף עמודת מונה. אותה החלטה בדיוק כמו בתקציב: מונה שקריסה משאירה שגוי הוא תקרה שמפסיקה להחזיק בשקט. תקרה: 3 ניסיונות, המתנה 5 → 25 → 125 דקות.

**הדפדפן במרשם מהיום הראשון.** `BrowserAdapter` נרשם עכשיו ומחזיר `browser_not_implemented`. כך `channel: 'browser'` בתקנון הוא הצהרה תקפה שנפתרת, נבדקת ומדווחת — ובניית המנוע האמיתי לא תיגע בשום קובץ אחר.

---

## 9. סודות

```ts
export interface CredentialSource {
  resolve(ref: string): Promise<CredentialHandle | null>;
}
```

`credential_ref` הוא **מצביע**. באפיון הזה מימוש יחיד שקורא ממשתני סביבה; `CredentialBroker` המלא — תת-מערכת 3 — יחליף אותו בלי לגעת במתאמים.

**הסוד לא נכנס להקשר של המודל ולא נכנס לביקורת** — רק ה-ref. זו התכונה שהופכת את תת-מערכת 3 להחלפה ולא לשכתוב, והיא נדרשת לפני מנוע הדפדפן: לפי בקרה 1 ב-`docs/08-risks.md`, הברוקר מזריק מצב סשן ברמת CDP והמודל לעולם לא רואה credentials.

---

## 10. בדיקות

**הפותר — טהור, בלי DB.** טבלת מקרים: ספציפי גובר על כללי · דו-משמעות נדחית · כלי לא מוכר נדחה · binding חסר מניב `unavailable` ולא `resolved`.

**חוזה משותף לכל מתאם.** חבילת מבחנים אחת שכל מתאם חייב לעבור: מקבל מטען מצונזר בלבד · לעולם לא זורק · מסווג `retryable` נכון · `serves` שלו תת-קבוצה של מה שהתקנון הצהיר. מתאם חדש מריץ אותה ולא ממציא בדיקות משלו.

**אינווריאנטים מבניים**, בסגנון `capabilities.test.ts`:

- כל ערך ב-`serves` הוא שם כלי מוכר
- כל `subprocessor` מופיע ב-`subprocessorsAllowed`
- כל מתאם רשום מכוסה על ידי חיבור בתקנון, או מוצהר במפורש כלא-מחובר
- לטבלה אין עמודת `channel` — נאכף על הסכמה, לא בהערה

**קצה-לקצה עם `RecordingAdapter`.** תוכנית → שער → מתאם. הטענה המרכזית: המתאם ראה את המטען **המצונזר**, לא את זה שהצעד הציע. שום מבחן לא שולח מייל אמיתי — המרשם מוזרק.

**מבחן נשיכה לכל מעקה חדש.** כל מבחן חייב להיכשל מול הקוד שלפני התיקון. מבחן שעובר בשני המצבים אינו שומר על כלום — זה נתפס שלוש פעמים בסשן שקדם לאפיון הזה.

---

## 11. מחוץ להיקף, וסדר התלות

| # | תת-מערכת | תלוי ב |
|---|---|---|
| 3 | `CredentialBroker` מלא | 2 |
| 4 | מנוע הדפדפן — נהיגה, recipes, קשירת הסכום ב-DOM | 2, 3 |
| 5 | מתאם Zapier | 2, 3 |

התלות אמיתית ולא מנהלתית: אי אפשר לבנות דפדפן בטוח בלי ברוקר סודות, ו-Zapier הוא **מתאם אחד בממשק** ולא ארכיטקטורה נפרדת.

**גם מחוץ להיקף:** בדיקות בריאות אוטומטיות · חיבור-מחדש · ממשק onboarding לניהול `connection_bindings` · יותר ממתאם אמיתי אחד.

---

## 12. הקבצים

**חדשים**

| קובץ | תוכן |
|---|---|
| `src/domain/connection.ts` | `CharterConnection`, `ConnectionBinding`, `ChannelResolution` |
| `src/orchestrator/channels.ts` | `resolveChannel` |
| `src/orchestrator/adapters/registry.ts` | רישום מתאמים, הזרקה למבחנים |
| `src/orchestrator/adapters/types.ts` | `ExternalAdapter`, `AdapterCall`, `AdapterResult` |
| `src/orchestrator/adapters/mail.ts` | המתאם האמיתי הראשון |
| `src/orchestrator/adapters/browser.ts` | מציין מקום שמחזיר `browser_not_implemented` |
| `src/orchestrator/credentials.ts` | `CredentialSource` + מימוש env |
| `src/db/migrations/003_connection_bindings.sql` | הטבלה |

**נערכים**

| קובץ | שינוי |
|---|---|
| `src/domain/charter.ts` | `connections` + אכיפת `subprocessor` ו-`serves` בחתימה |
| `src/domain/policy.ts` | `connections` ב-`PolicyBundle` |
| `src/charter/compile.ts` | קומפילציה של `connections` |
| `src/orchestrator/run-plan.ts` | היתכנות ערוץ באימות התוכנית; בניית `perform` מהמתאם |
| `src/orchestrator/execute.ts` | עטיפת חריגת מתאם; מיפוי `retryable` ל-`followup` |
| `CLAUDE.md` | האינווריאנט של הצמצום, ושלוש ההכרעות בממשק |

**המתאם הראשון הוא מייל** — הכלי היחיד שהשער כבר מסווג במלואו: `email.reply`/`email.initiate`, שעות שקט, רדקציה ו-doNotContact. כלומר המתאם הראשון בודק את כל השכבה שכבר נבנתה, במקום לבנות שכבה חדשה במקביל לה.

### מה בדיוק המתאם הזה מדבר איתו

**SMTP, ו-`mail.send` בלבד.**

נבחר במפורש ולא נשאר פתוח. SMTP עובד מול Gmail, Outlook וכל שרת עצמאי בלי OAuth, כך שה-credential הוא זוג משתמש-סיסמה מאחורי `credential_ref` ולא זרימת הרשאות שהיא פרויקט בפני עצמו. המטרה כאן היא לאמת את **השכבה**, לא לבחור ספק.

**קריאת מייל מחוץ להיקף.** IMAP או Gmail API הם כיוון נכנס — הם מזינים את `intake.triage`, שאינו קיים, ומביאים תוכן לא אמין שדורש את שרשרת ההסגר. אפיון נפרד.
