# מדריך הרצה: החוט החי

מדריך שמריץ ידנית שרשרת אחת מקצה לקצה — יצירת משימה, אישור אנושי, ושליחת מייל
אמיתית (לתיבת בדיקה מקומית) — בלי מתכנן ובלי לקוח אמיתי. זה השלב הראשון שבו
המערכת שולחת דבר-מה אמיתי דרך רשת, ולא רק כותבת שורות בבסיס הנתונים.

אין עדיין מתכנן: `job:seed` כותב תוכנית של צעד אחד ביד. אין עדיין כלי ליצירת
תקנון אמיתי דרך CLI, ולכן שלב 3 למטה משתמש בתקנון-דוגמה מ-`src/test/fixtures.ts`
(`buildCharter`) — לא כי הוא "מבחן", אלא כי הוא הדרך היחידה כרגע לייצר תקנון
חתום שעובר את `installCharter`. שני המרכיבים האלה — מתכנן אמיתי וכלי לעריכת
תקנון — הם מה שנשאר לבנות אחרי החוט הזה, לא באג במדריך.

---

## 0. דרישות מוקדמות

- Postgres רץ, עם `assistant_dev` קיים ו-`.env` מוגדר (`DATABASE_URL`, `BUSINESS_ID`).
- `npm run migrate` רץ לפחות פעם אחת על בסיס הנתונים הזה.
- חשבון בעלים בדשבורד — בלעדיו אי אפשר להתחבר ולאשר. אם עוד אין:

  ```bash
  npm run owner:create
  ```

  שמור את קודי השחזור שמודפסים — הם מוצגים פעם אחת בלבד.

---

## 1. תיבת דואר מקומית לבדיקה

```bash
npx maildev
```

מאזין ל-SMTP בפורט `1025` ומציג ממשק web בכתובת `http://localhost:1080`. שום
מייל לא יוצא באמת מהמכונה — maildev תופס כל הודעה ומציג אותה בדפדפן. זה מה
שמאפשר להריץ את כל החוט בלי תיבת דואר אמיתית ובלי חשבון SMTP חיצוני.

---

## 2. משתני הסביבה

הרשימה הבאה היא **בדיוק** מה ש-`buildRuntime` (`src/orchestrator/runtime.ts`)
קורא בפועל — לא רשימה כללית. חסר אחד מששת משתני ה-SMTP הראשונים משבית את כל
מתאם הדואר, כולל הודעת בקשת האישור עצמה.

```bash
# מתאם הדואר (SMTP_KEYS ב-runtime.ts) — כל שישה נדרשים; חסר אחד משבית
# את המתאם כולו, כולל שליחת מיילים הודעת אישור:
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM=assistant@example.com
SMTP_USER=assistant
SMTP_PASS=anything   # maildev לא בודק אימות בכלל

# בלעדיו evaluateToolCall לא מקבל ApprovalNotifier ואף מייל בקשת-אישור
# לא נשלח — הבקשה עדיין נכתבת ומופיעה בדשבורד, רק בלי הודעה:
APPROVAL_NOTIFY_TO=owner@example.com

# הקישור שנכנס לתוך הודעת בקשת האישור. ברירת המחדל של buildRuntime היא
# http://127.0.0.1:8787 — ואילו הדשבורד עצמו (run-dashboard.ts) מאזין
# כברירת מחדל על 4173. אם לא מציבים כאן ערך שתואם לפורט שהדשבורד באמת
# מאזין עליו, הקישור בהודעה יצביע על פורט שאין בו כלום:
DASHBOARD_BASE_URL=http://127.0.0.1:4173

# credential_ref של החיבור ל-office-mail. envCredentials קורא
# ASSISTANT_CREDENTIAL_<ref>, לעולם לא <ref> עצמו — ראה .env.example:
ASSISTANT_CREDENTIAL_OFFICE_MAIL=anything
```

`MAIL_SYSTEM` הוא משתנה אופציונלי נוסף ש-`buildRuntime` קורא (ברירת המחדל
`office-mail`); אין צורך להגדיר אותו אלא אם רוצים שם מערכת אחר.

---

## 3. תקנון והחיבור

אין עדיין כלי CLI שמתקין תקנון או קובע חיבור למצב `live` — שניהם ייבנו עם
המתכנן. עד אז מריצים סקריפט חד-פעמי עם `tsx`. שמור את הקובץ הבא כ-
`scripts/seed-charter.ts` (או בכל נתיב זמני), הרץ אותו פעם אחת, ואפשר למחוק
אחר כך:

```ts
import { installCharter } from '../src/charter/store.js';
import { buildCharter } from '../src/test/fixtures.js';
import { upsertBinding } from '../src/orchestrator/bindings.js';
import { closePool } from '../src/db/pool.js';
import type { CharterConnection } from '../src/domain/connection.js';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }));
console.log(`charter installed: ${bundle.charterVersion}`);

await upsertBinding(
  {
    system: 'office-mail',
    status: 'live',
    endpoint: null,
    credentialRef: 'OFFICE_MAIL',
    lastOkAt: null,
    lastError: null,
  },
  { by: 'runbook' },
);
console.log('binding office-mail set to live');

await closePool();
```

```bash
npx tsx scripts/seed-charter.ts
```

`installCharter` בלי `{ businessId }` פועל על `config.businessId` (`BUSINESS_ID`
מה-`.env`) — אותו עסק שכל שאר הפקודות במדריך הזה פועלות עליו כברירת מחדל.
`credentialRef: 'OFFICE_MAIL'` הוא מה שהופך את `ASSISTANT_CREDENTIAL_OFFICE_MAIL`
משלב 2 לרלוונטי — שם שונה כאן דורש שינוי תואם שם.

---

## 4. הדשבורד

בחלון טרמינל נפרד:

```bash
npm run dashboard
```

מאזין על loopback בלבד (`127.0.0.1:4173` כברירת מחדל — ראה
[docs/dashboard-deployment.md](dashboard-deployment.md)). היכנס עם החשבון
שנוצר בשלב 0.

---

## 5. יצירת המשימה

בחלון טרמינל שני:

```bash
npm run job:seed -- --to dana@example.com
```

הפקודה (`src/cli/seed-job.ts`) יוצרת משימה, מקדמת אותה דרך
`intake → understand → plan → execute`, קושרת אליה תוכנית בת צעד אחד
(`mail.send`, מסווג `email.initiate`), ומעלה את הרמפה **רק** עבור
`email.initiate` ל-`approve_required` — כל שאר מחלקות הפעולה נשארות ב-
`draft_only`. הפלט מדפיס את מזהה המשימה ואת ה-hash של התוכנית.

---

## 6. הרצת ה-scheduler

בחלון טרמינל שלישי:

```bash
npm run scheduler
```

הפעימה הראשונה מוצאת את המשימה ב-`execute`, מריצה את הצעד היחיד, והשער
(`evaluateToolCall`) קובע `queue_approval` — כי `approve_required` דורש אדם,
לא כי משהו נכשל. המשימה עוברת ל-`await_approval`, ו-`runtime.notify` (מחובר
מאז ש-`run-due.ts` מעביר אותו ל-`runPlanForJob`) שולח הודעת בקשת-אישור דרך
SMTP.

---

## 7. אישור

פתח את `http://localhost:1080` (ממשק maildev) — הודעה בכותרת "בקשה לאישור:
..." אמורה להופיע. ההודעה עצמה **אינה** נושאת את תוכן המייל שיישלח —
`buildMessage` (`src/governance/notify.ts`) שולח רק תקציר, רמת סיכון ותפוגה,
בכוונה: הפרטים נשארים מאחורי כניסה מאובטחת. פתח את הקישור (`DASHBOARD_BASE_URL/a/<id>`),
היכנס אם עוד לא מחובר, ואשר.

אישור מריץ מיד `applyDecision` (`src/orchestrator/resume.ts`), שמחזיר את
המשימה ל-`execute` — לא מריץ אותה. שליחת המייל בפועל ממתינה לפעימה הבאה.

---

## 8. הפעימה השנייה

הפעימה הבאה של ה-scheduler (עד `SCHEDULER_INTERVAL_MS`, ברירת מחדל 30
שניות) מוצאת את המשימה שוב ב-`execute`, ו-`runDueJobs` ממשיך מהצעד שעצר —
לא מהתחלה. השער מריץ שוב, מוצא אישור לא-מנוצל תואם, וממש הפעם המייל השני
(המייל האמיתי, ל-`dana@example.com`) יוצא ומופיע ב-maildev. המשימה עוברת
ל-`verify`.

---

## 9. בדיקת מסלול הביקורת

```sql
SELECT seq, kind, actor, action_class, reason FROM audit_log
 WHERE business_id = 'dev-business'
 ORDER BY seq;
```

(`dev-business` הוא `BUSINESS_ID` שברירת המחדל ב-`.env.example` — החלף אם
הגדרת ערך אחר.) כל שלב — קריאת הכלי, ההחלטה, בקשת האישור, ה-`decision` שהאדם
נתן — אמור להופיע כשורה נפרדת.

---

## מה לא יעבוד ולמה

| מצב | מה קורה | איך רואים את זה |
|---|---|---|
| **לא הותקן תקנון** (דילגו על שלב 3) | `job:seed` נכשל מיד: `seedMailJob` קורא ל-`activeCharterVersion`, מקבל `null`, וזורק `no active charter for business ... — install one first`. שום משימה לא נוצרת. | ההודעה מודפסת ישירות לטרמינל של `job:seed`, לא בלוג של תהליך אחר. |
| **החיבור `office-mail` לא `live`** (נשכח `upsertBinding`, או שהסטטוס `disconnected`/`error`) | `resolveChannel` (`src/orchestrator/channels.ts`) מחזיר `unavailable`, ו-`performStep` (`run-plan.ts`) זורק `StepChannelError('channel_unavailable', ..., retryable: true)`. **ניתן לניסיון חוזר**: המשימה עוברת ל-`followup` עם `wakeAt` קרוב — לא ל-`failed` — כי חיבור שנפל עשוי לחזור. שום שורת `job_step_results` לא נכתבת, כי `channel_unavailable` אינו `outcomeUnknown` (שום קריאה יצאה בכלל). | `job_steps.reason` מציג `channel_unavailable — {"status":"unavailable",...}`; לוג ה-scheduler מציג את אותה משימה חוזרת בכל פעימה בלי שהיא מתקדמת ל-`verify`. |
| **`ASSISTANT_CREDENTIAL_OFFICE_MAIL` לא מוגדר** | `performStep` פותר את ה-credential *לפני* קריאה למתאם. `envCredentials.resolve('OFFICE_MAIL')` מחזיר `null`, ו-`performStep` זורק `StepChannelError('credential_unavailable', 'OFFICE_MAIL')` — **לא** ניתן לניסיון חוזר (ref שגוי או סוד שלא הוקצה לא מסתדרים בהמתנה). המשימה עוברת ישר ל-`failed`. | `job_steps.reason` מציג `credential_unavailable — OFFICE_MAIL`; אין שורת `job_step_results` כלל, כי שום קריאה חיצונית לא יצאה. |
| **הרמפה לא הועלתה** (למשל הריצו `setRampLevel` ידנית ל-`auto`, או שהעבירו `--to` בלי להריץ `job:seed` בכלל) | אם הרמפה עדיין ב-`draft_only` (ברירת המחדל): השער עוצר בטרם יציאה — `halted:draft_only:persist_as_draft` — ואף אישור לא נוצר ואף מייל לא נשלח. אם מישהו כבר העלה אותה ל-`auto` (לא `approve_required`): המייל השני יוצא **בלי** אישור אנושי, וזה מבטל את כל הנקודה של הדגמת השרשרת. | `halted:draft_only...` בפלט `runDueJobs`/הלוג של ה-scheduler עבור המקרה הראשון; היעדר שורת `approval_requests` כלשהי עבור המקרה השני — סימן שהצעד רץ ישר. |

---

## סיכום משתני סביבה

| משתנה | חובה? | ברירת מחדל | קורא |
|---|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASS` | כן, כל השישה יחד | אין | `buildRuntime` (`SMTP_KEYS`) |
| `MAIL_SYSTEM` | לא | `office-mail` | `buildRuntime` |
| `APPROVAL_NOTIFY_TO` | לא (בלעדיו אין הודעת מייל, אבל השרשרת עדיין עובדת דרך הדשבורד) | אין | `buildRuntime` |
| `DASHBOARD_BASE_URL` | לא, אבל ברירת המחדל כנראה שגויה אצלך | `http://127.0.0.1:8787` | `buildRuntime` |
| `ASSISTANT_CREDENTIAL_OFFICE_MAIL` | כן, לכל `credential_ref` בשם `OFFICE_MAIL` | אין | `envCredentials` (`DEFAULT_CREDENTIAL_ENV_PREFIX`) |
| `DASHBOARD_PORT`, `DASHBOARD_HOST`, `DASHBOARD_TRUST_PROXY`, `DASHBOARD_ALLOW_PUBLIC_BIND` | לא | `4173`, `127.0.0.1`, כבוי, כבוי | `run-dashboard.ts` |
| `SCHEDULER_INTERVAL_MS` | לא | `30000` | `run-scheduler.ts` |
