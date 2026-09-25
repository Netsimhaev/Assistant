# מדריך הרצה: החוט החי

מדריך שמריץ ידנית שרשרת אחת מקצה לקצה — יצירת משימה, אישור אנושי, ושליחת מייל
אמיתית (לתיבת בדיקה מקומית) — בלי מתכנן ובלי לקוח אמיתי. זה השלב הראשון שבו
המערכת שולחת דבר-מה אמיתי דרך רשת, ולא רק כותבת שורות בבסיס הנתונים.

אין עדיין מתכנן: `job:seed` כותב תוכנית של צעד אחד ביד. אין עדיין כלי ליצירת
תקנון אמיתי דרך CLI, ולכן שלב 3 למטה משתמש בתקנון-דוגמה מ-`src/test/fixtures.ts`
(`buildCharter`) — לא כי הוא "מבחן", אלא כי הוא הדרך היחידה כרגע לייצר תקנון
חתום שעובר את `installCharter`. שני המרכיבים האלה — מתכנן אמיתי וכלי לעריכת
תקנון — הם מה שנשאר לבנות אחרי החוט הזה, לא באג במדריך.

> **⚠ החוט הזה עובד רק ביום.** התקנון-הדוגמה ששלב 3 מתקין (`buildCharter`,
> `src/test/fixtures.ts`) מגדיר `quietHours: { from: '20:00', to: '07:00' }`
> ב-`Asia/Jerusalem`. השער בודק שעות שקט (שלב 7) **לפני** אוטונומיה (שלב 8) —
> ראה `evaluateToolCall`, `src/policy/engine.ts` — ולכן בין 20:00 ל-07:00 שעון
> ישראל הפעימה הראשונה של ה-scheduler אינה מגיעה בכלל ל-`queue_approval`: היא
> נכשלת ב-`quiet_hours`, המשימה עוברת ל-`followup` עם `wakeAt` בסוף החלון,
> ואין שום שורת `approval_requests`, שום מייל, ו**שום פלט קונסולה** — לא
> חריגה, לא `logErrored`, כלום. מי שמריץ את המדריך בערב ורואה שקט מוחלט לא
> עשה שום דבר לא נכון; ראה את שורת "שעות שקט" בטבלת הכשלים למטה. שני
> מבחני ה-suite החדשים (`run-due.test.ts`, `notify-wiring.test.ts`) קובעים
> שעון קבוע ל-`NOON` בדיוק כדי להימנע מהחלון הזה.

---

## בדיקת מוכנות — הרץ את זה ראשון

```bash
npx tsx scripts/live-thread-status.ts
```

מדפיס שורה לכל דרישה מוקדמת: תקנון, חיבור, חשבון בדשבורד, מתאם דואר, שולח
התראות, קצב האוטונומיה, ומשימות פתוחות — ובסוף את **השעה הנוכחית בישראל**
ואם היא בתוך חלון שעות השקט. `MISS` בשורה כלשהי אומר בדיוק מה חסר ומה להריץ.

> **מלכודת שנתקלנו בה בפועל, והיא לא נראית משום מקום אחר:** תקנון פעיל שאין
> בו `connections` כלל **אינו מספיק**. המרשם יכול רק לצמצם — שורה ב-
> `connection_bindings` אינה מעניקה ערוץ שהתקנון לא הזכיר — ולכן תקנון עם
> `connections: []` יחד עם binding במצב `live` עדיין נפסל ב-
> `no_channel_for_tool`, לפני שנשלח דבר. `scripts/seed-charter.ts` בודק את זה
> ומתקין גרסה חדשה שמצהירה על `office-mail` אם הפעילה אינה מצהירה.

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
קורא בפועל — לא רשימה כללית. חסר אחד מחמשת משתני ה-SMTP הראשונים משבית את כל
מתאם הדואר, כולל הודעת בקשת האישור עצמה. הסיסמה עצמה אינה כאן — היא מוקצית
בשלב נפרד אחרי הבלוק הזה.

```bash
# מתאם הדואר (SMTP_KEYS ב-runtime.ts) — חמישה נדרשים יחד; חסר אחד משבית
# את המתאם כולו, כולל שליחת מייל הודעת האישור. אין כאן SMTP_PASS: מתאם
# הדואר מזדהה מהסוד שנפתר מהמאגר המוצפן, לא ממשתנה סביבה (ראה למטה):
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM=assistant@example.com
SMTP_USER=assistant

# בלעדיו evaluateToolCall לא מקבל ApprovalNotifier ואף מייל בקשת-אישור
# לא נשלח — הבקשה עדיין נכתבת ומופיעה בדשבורד, רק בלי הודעה:
APPROVAL_NOTIFY_TO=owner@example.com

# הפניית הסוד שהתראת בקשת-האישור מזדהה איתה (createEmailNotifier,
# src/governance/notify.ts) — בלעדיה, כמו בלעדי APPROVAL_NOTIFY_TO, אין
# הודעת מייל. כאן משתמשים באותה הפניה כמו זו של החיבור עצמו (שלב 3),
# כך שסוד אחד משרת את שניהם:
NOTIFY_CREDENTIAL_REF=OFFICE_MAIL

# הקישור שנכנס לתוך הודעת בקשת האישור. ברירת המחדל של buildRuntime היא
# http://127.0.0.1:8787 — ואילו הדשבורד עצמו (run-dashboard.ts) מאזין
# כברירת מחדל על 4173. אם לא מציבים כאן ערך שתואם לפורט שהדשבורד באמת
# מאזין עליו, הקישור בהודעה יצביע על פורט שאין בו כלום:
DASHBOARD_BASE_URL=http://127.0.0.1:4173
```

`MAIL_SYSTEM` הוא משתנה אופציונלי נוסף ש-`buildRuntime` קורא (ברירת המחדל
`office-mail`); אין צורך להגדיר אותו אלא אם רוצים שם מערכת אחר.

הסוד עצמו — הסיסמה ש-`SMTP_USER` מזדהה איתה בפועל — אינו משתנה סביבה בכלל.
`src/mail/transport.ts` מזדהה אך ורק מהסוד שנפתר מהמאגר המוצפן (`credentials`,
`src/governance/credential-store.ts`), לא מ-`envCredentials`/`ASSISTANT_CREDENTIAL_<ref>`
— אלה קיימים לבדיקות בלבד ואינם רצים כאן. הקצה את הסוד תחת ההפניה
`OFFICE_MAIL` (אותה הפניה ששלב 3 קושר ל-`credential_ref` של החיבור, ושהוגדרה
למעלה גם כ-`NOTIFY_CREDENTIAL_REF`):

```bash
npm run secret put OFFICE_MAIL <המפעיל שלך>
```

הפקודה קוראת את הסוד מהקלט הסטנדרטי, לא מארגומנט. `maildev` לא בודק אימות
בכלל, כך שכל ערך עובד — מה שחשוב הוא שההפניה תיפתר בכלל, לא הערך שבה. בלי
הצעד הזה כל `mail.send` נדחה ב-`credential_unavailable` (ראה טבלת הכשלים
למטה), ואף הודעת בקשת-אישור לא יוצאת. הפקודה דורשת `CREDENTIAL_KEY_PATH`
מוגדר ומפתח שכבר נוצר (`npm run secret:key create <מפעיל>`) — אם עוד אין
כזה במכונה הזו, זהו הזמן ליצור אחד.

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
`credentialRef: 'OFFICE_MAIL'` הוא מה שהופך את הסוד שהוקצה בשלב 2
(`npm run secret put OFFICE_MAIL`) לרלוונטי — שם שונה כאן דורש הקצאה תחת אותו
שם, ושינוי תואם ב-`NOTIFY_CREDENTIAL_REF` אם רוצים שההתראה תמשיך להשתמש
באותו סוד.

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
| **מריצים בין 20:00 ל-07:00 שעון ישראל** (ראה האזהרה בראש המדריך) | `evaluateToolCall` (שלב 7, `src/policy/engine.ts`) נתקל ב-`inQuietHours` לפני שהוא בכלל מגיע לשלב האוטונומיה, ומחזיר `deny(DENY_CODES.quietHours, ...)`. `executeStep` מרדים את המשימה ל-`followup` עם `wakeAt` בסוף החלון (07:00). אין שורת `approval_requests`, אין מייל, ואין `queue_approval` — הריצה הראשונה של ה-scheduler "לא עושה כלום" באופן שנראה זהה לכשל שקט אחר. | **אין שום פלט קונסולה** בשני התהליכים — לא ב-`job:seed` (כבר סיים בהצלחה) ולא ב-`scheduler` (זה `deny` רגיל, לא `errored`). האות היחיד הוא ה-DB: <br>`SELECT phase, wake_at FROM jobs WHERE job_id = '<job-id>';` <br>מחזיר `phase = 'followup'` ו-`wake_at` מוגדר לזמן שאחרי 07:00 שעון ישראל. ה-scheduler יריץ את המשימה שוב לבד ברגע שמגיע `wake_at` — אין צורך לעשות דבר מלבד לחכות, או להריץ שוב בשעות היום. |
| **לא הותקן תקנון** (דילגו על שלב 3) | `job:seed` נכשל מיד: `seedMailJob` קורא ל-`activeCharterVersion`, מקבל `null`, וזורק `no active charter for business ... — install one first`. שום משימה לא נוצרת. | ההודעה מודפסת ישירות לטרמינל של `job:seed`, לא בלוג של תהליך אחר. |
| **החיבור `office-mail` לא `live`** (נשכח `upsertBinding`, או שהסטטוס `disconnected`/`error`) | `resolveChannel` (`src/orchestrator/channels.ts`) מחזיר `unavailable`, ו-`performStep` (`src/orchestrator/run-plan.ts`) זורק `StepChannelError('channel_unavailable', JSON.stringify(resolution), true)`. **ניתן לניסיון חוזר**: `execute.ts`'s retryable branch כותב `reason: \`${code} — retry:${stepId} at ${wakeAt}\`` — היא **אינה** משתמשת ב-`message` שנשא את ה-JSON; הצורה `${code} — ${message}` שכן הייתה מכילה אותו קיימת רק בענף ה-`failed`, ומחזור-חוזר לעולם לא מגיע אליו. המשימה עוברת ל-`followup` עם `wakeAt` בעוד 5 דקות (`RETRY_DELAY_MS`). שום שורת `job_step_results` לא נכתבת, כי `channel_unavailable` אינו `outcomeUnknown`. | **אין שום פלט קונסולה** — לא ב-`npm run job:seed` ולא ב-`npm run scheduler`: ל-`run-due.ts` אין קריאות `console.*` בכלל, ו-`logErrored` ב-`run-scheduler.ts` מדפיס רק את `due.errored` (עבודות שזרקו) — לא `due.ran` (שאליו שייך המחזור הזה). האות היחיד הוא ה-DB עצמו: `jobs.phase` מתנדנד בין `followup` ל-`execute` בכל פעימה בלי להגיע ל-`verify`. שאילתה: <br>`SELECT phase, wake_at FROM jobs WHERE job_id = '<job-id>';` <br>`SELECT reason, at FROM job_steps WHERE job_id = '<job-id>' ORDER BY at DESC LIMIT 3;` — השורה האחרונה מציגה `channel_unavailable — retry:s1 at 2026-...`. |
| **הסוד `OFFICE_MAIL` לא הוקצה במאגר** (לא הרצת `npm run secret put OFFICE_MAIL <מפעיל>`, או שהוקצה תחת שם אחר) | `performStep` פותר את ה-credential *לפני* קריאה למתאם. `storedCredentials(...).resolve('OFFICE_MAIL', businessId)` לא מוצא שורה במאגר ומחזיר `null`, ו-`performStep` זורק `StepChannelError('credential_unavailable', 'OFFICE_MAIL')` — **לא** ניתן לניסיון חוזר (ref שגוי או סוד שלא הוקצה לא מסתדרים בהמתנה). המשימה עוברת ישר ל-`failed`. | `job_steps.reason` מציג `credential_unavailable — OFFICE_MAIL`; אין שורת `job_step_results` כלל, כי שום קריאה חיצונית לא יצאה. |
| **הרמפה לא הועלתה** (למשל הריצו `setRampLevel` ידנית ל-`auto`, או שהעבירו `--to` בלי להריץ `job:seed` בכלל) | אם הרמפה עדיין ב-`draft_only` (ברירת המחדל): `effectiveAutonomy` (`src/policy/engine.ts`) מחזיר `draft_only`, השער קורא `deny(DENY_CODES.draftOnly, ...)` כאשר `DENY_CODES.draftOnly = 'draft_only:persist_as_draft'` (`src/domain/policy.ts`), וענף ה-deny הרגיל (לא `quiet_hours`) ב-`execute.ts` כותב `reason: \`${decision.code} — ${decision.reason}\`` ומעביר את המשימה ישר ל-`failed`. אף אישור לא נוצר ואף מייל לא נשלח. אם מישהו כבר העלה אותה ל-`auto` (לא `approve_required`): **אין הבדל בהדגמה הזו** — `seedMailJob` (`src/cli/seed-job.ts`) כותב `input: { to, subject, body }` בלי `counterpartyId`, ו-`runDueJobs` מעביר `counterpartyTags: []`; `scoreVisibility` (`src/policy/risk.ts`) לא מוצא שום התאמה ב-`knownCounterparties` ומחזיר `one_unknown`, `bandFor` מסלים ל-`sensitive` בלי קשר לאוטונומיה, ו-`evaluateToolCall`'s `risk.band !== 'routine'` check (`src/policy/engine.ts`) מבקש אישור **גם ב-`auto`**. `dana@example.com` פשוט אינו counterparty מוכר לתקנון-הדוגמה — כדי לראות `auto` באמת מדלג על אישור צריך תקנון עם `knownCounterparties` שכולל אותו, וזה מחוץ למה שהמדריך הזה מקים. | **גם כאן אין פלט קונסולה**: זה `RanJob` רגיל בתוך `due.ran`, לא חריגה ב-`due.errored`, ו-`logErrored` (`src/orchestrator/run-scheduler.ts`) לא הבדיל בעבר בין `done` ל-`rejected` בתוך `due.ran`; מאז התיקון הוא כן מדפיס כל `ran` שסטטוסו `rejected` — אך `done`/`halted` עדיין לא נדפסים, וזה `RanJob` תקין (`halted` על `queue_approval`) ולא כשל. למקרה `draft_only`: <br>`SELECT phase FROM jobs WHERE job_id = '<job-id>';` מחזיר `failed`, ו-`job_steps.reason` מתחיל ב-`draft_only:persist_as_draft — `. למקרה `auto`: <br>`SELECT count(*) FROM approval_requests WHERE job_id = '<job-id>';` מחזיר `1`, לא `0` — האישור עדיין נוצר, מהסיבה שבעמודה הקודמת. |

---

## סיכום משתני סביבה

| משתנה | חובה? | ברירת מחדל | קורא |
|---|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER` | כן, כל החמישה יחד | אין | `buildRuntime` (`SMTP_KEYS`) |
| `MAIL_SYSTEM` | לא | `office-mail` | `buildRuntime` |
| `APPROVAL_NOTIFY_TO` | לא (בלעדיו אין הודעת מייל, אבל השרשרת עדיין עובדת דרך הדשבורד) | אין | `buildRuntime` |
| `NOTIFY_CREDENTIAL_REF` | לא (בלעדיו, כמו בלעדי `APPROVAL_NOTIFY_TO`, אין הודעת מייל) | אין | `buildRuntime`, נפתר מחדש בכל הודעה על ידי `createEmailNotifier` |
| `DASHBOARD_BASE_URL` | לא, אבל ברירת המחדל כנראה שגויה אצלך | `http://127.0.0.1:8787` | `buildRuntime` |
| הסוד `OFFICE_MAIL` (במאגר, לא משתנה סביבה) | כן, לכל `credential_ref` בשם `OFFICE_MAIL` | אין | `storedCredentials` — מוקצה עם `npm run secret put OFFICE_MAIL <מפעיל>` |
| `DASHBOARD_PORT`, `DASHBOARD_HOST`, `DASHBOARD_TRUST_PROXY`, `DASHBOARD_ALLOW_PUBLIC_BIND` | לא | `4173`, `127.0.0.1`, כבוי, כבוי | `run-dashboard.ts` |
| `SCHEDULER_INTERVAL_MS` | לא | `30000` | `run-scheduler.ts` |
