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

מדפיס שורה לכל דרישה מוקדמת: תקנון, חיבור, חשבון בדשבורד, מפתח האב, מתאם דואר,
שולח התראות, **כל הפניית סוד שהחוט הזה צריך ואם היא הוקצתה בפועל**, קצב
האוטונומיה, ומשימות פתוחות — ובסוף את **השעה הנוכחית בישראל** ואם היא בתוך חלון
שעות השקט. `MISS` בשורה כלשהי אומר בדיוק מה חסר ומה להריץ.

שורות הסוד נוספו אחרי שהתברר ש"מתאם דואר נבנה" אומר רק שחמשת משתני ה-SMTP
מוגדרים ואינו אומר דבר על כך שהסוד עצמו קיים — הפניה שלא הוקצתה נראתה מוכנה
כאן ואז הפילה כל `mail.send` ב-`credential_unavailable` בזמן ריצה.

> **מלכודת שנתקלנו בה בפועל, והיא לא נראית משום מקום אחר:** תקנון פעיל שאין
> בו `connections` כלל **אינו מספיק**. המרשם יכול רק לצמצם — שורה ב-
> `connection_bindings` אינה מעניקה ערוץ שהתקנון לא הזכיר — ולכן תקנון עם
> `connections: []` יחד עם binding במצב `live` עדיין נפסל ב-
> `no_channel_for_tool`, לפני שנשלח דבר. `scripts/seed-charter.ts` בודק את זה
> ומתקין גרסה חדשה שמצהירה על `office-mail` אם הפעילה אינה מצהירה.

> **⚠ `buildRuntime` קורא את התקנון וה-bindings פעם אחת, בעליית התהליך —
> לא ברציפות.** `run-scheduler.ts` בונה `Runtime` יחיד ומעביר אותו לכל
> פעימה; שינוי בטבלת `connection_bindings` — לרבות עמודת `provider`
> שמתאם ספק (כגון Google Calendar) נרשם לפיה — **אינו נכנס לתוקף** עד
> שהתהליך של ה-scheduler מופעל מחדש. זו מגבלה מוכרת ולא תקלה: הרצה מחדש
> של החיבור על כל פעימה הייתה אומרת קריאת התקנון ומפתח האב מחדש כל 30
> שניות, וזו החלטת ארכיטקטורה לשלב אחר. מי שמריץ `secret put` או משנה
> `connection_bindings` (ביד או דרך מסך הרשאות עתידי) בזמן שה-scheduler
> כבר רץ צריך להפעיל אותו מחדש כדי שהשינוי יורגש.

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
קורא בפועל עבור מסלול הדואר — לא רשימה כללית, וגם לא כל מה שהפונקציה קוראת
(היא קוראת גם `ANTHROPIC_API_KEY`, שאינו נחוץ לחוט הזה ושהיעדרו הוא אזהרה
בלבד: בלעדיו המשימות נסגרות כרגיל והעוזרת פשוט לא לומדת מהן דבר).
חסר אחד מחמשת משתני ה-SMTP משבית את כל מתאם הדואר, כולל הודעת בקשת האישור
עצמה. הסיסמה עצמה אינה כאן — היא מוקצית בשלב נפרד אחרי הבלוק הזה.

**המשתנה שבלעדיו כלום לא עולה הוא הראשון בבלוק, לא אחד מחמשת ה-SMTP.**
`buildRuntime` קורא את `CREDENTIAL_KEY_PATH` **לפני** כל השאר וזורק
`MasterKeyError` כשהוא חסר — לא אזהרה, סירוב: "או שלהתקנה הזו יש מפתח, או
שהיא לא עולה". בלעדיו שלב 6 (`npm run scheduler`) נופל בחריגה ולא באזהרת
"אין מתאם דואר" שהמדריך מכין אליה. הוא הופיע כאן בעבר רק כדרישה של
`secret put`, מה שנקרא כעניין של ה-CLI בלבד.

```bash
# מפתח האב שפותח כל סוד שמור. buildRuntime קורא אותו ראשון ומסרב לעלות
# בלעדיו — כל הפקודות במדריך שנוגעות בסודות תלויות בו (שלב 6 בכללן):
CREDENTIAL_KEY_PATH=./secrets/master.key

# מתאם הדואר (SMTP_KEYS ב-runtime.ts) — חמישה נדרשים יחד; חסר אחד משבית
# את המתאם כולו, כולל שליחת מייל הודעת האישור. אין כאן SMTP_PASS: מתאם
# הדואר מזדהה מהסוד שנפתר מהמאגר המוצפן, לא ממשתנה סביבה (ראה למטה):
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM=assistant@example.com
SMTP_USER=assistant

# **נדרש דווקא כאן, ורק כאן** — ולכן ב-`.env.example` הוא מושאר כשורת
# הערה ולא כערך, כדי שהעתקה לייצור לא תגרור אותו איתה. **SMTP_SECURE=false
# הופך את STARTTLS לחובה**,
# כך שסיסמה שנפתרה מהמאגר לא יכולה לצאת בטקסט גלוי. maildev אינו מדבר TLS
# כלל, ולכן בלי השורה הזו כל שליחה במדריך הזה תיכשל בחיבור. `1` בדיוק —
# כל ערך אחר נחשב כבוי — ובכל עלייה שבה הוא דלוק מודפסת אזהרה. **אל
# תעתיקו את השורה הזו ל-.env של ייצור.**
SMTP_ALLOW_CLEARTEXT=1

# בלעדיו evaluateToolCall לא מקבל ApprovalNotifier ואף מייל בקשת-אישור
# לא נשלח — הבקשה עדיין נכתבת ומופיעה בדשבורד, רק בלי הודעה:
APPROVAL_NOTIFY_TO=owner@example.com

# הפניית הסוד שהתראת בקשת-האישור מזדהה איתה (createEmailNotifier,
# src/governance/notify.ts). **חסר לעומת שגוי:** לא מוגדר = אזהרה, אין
# הודעת מייל, וכל השאר עובד; ערך שאינו ref חוקי (אותיות גדולות, ספרות וקו
# תחתון בלבד) = buildRuntime זורק וה-scheduler כולו לא עולה. שגיאת הקלדה
# כאן עוצרת הרבה יותר ממה שנראה.
#
# **קיצור דרך לפיתוח:** כאן מוצבת אותה הפניה כמו זו של החיבור עצמו (שלב 3),
# כך שסוד אחד משרת את שניהם ואין צורך להקצות פעמיים. זה מקצר את המדריך, לא
# מה שהעיצוב מתכוון אליו — מפרט §4 מבקש שתי הפניות כדי שאפשר יהיה לסבב אחת
# בלי לגעת בשנייה, וייצור אמור להקצות שתיים (למשל `NOTIFY_MAIL`, כפי
# ש-`.env.example` מציב). שתיהן נפתרות לסיסמה של אותו חשבון בכל מקרה: יש
# `SMTP_USER` אחד ו-transport אחד:
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
— אלה קיימים לבדיקות בלבד ואינם רצים כאן.

**קודם, אם עוד אין מפתח אב במכונה הזו.** `secret put` דורש `CREDENTIAL_KEY_PATH`
מוגדר וקובץ מפתח שכבר נוצר תחתיו — בלעדיו הפקודה למטה נכשלת. פעם אחת לכל
התקנה:

```bash
npm run secret:key create <המפעיל שלך>
```

**עכשיו הקצה את הסוד**, תחת ההפניה `OFFICE_MAIL` (אותה הפניה ששלב 3 קושר
ל-`credential_ref` של החיבור, ושהוגדרה למעלה גם כ-`NOTIFY_CREDENTIAL_REF`):

```bash
npm run secret put OFFICE_MAIL <המפעיל שלך>
```

הפקודה קוראת את הסוד מהקלט הסטנדרטי, לא מארגומנט. `maildev` לא בודק אימות
בכלל, כך שכל ערך עובד — מה שחשוב הוא שההפניה תיפתר בכלל, לא הערך שבה. בלי
הצעד הזה כל `mail.send` נדחה ב-`credential_unavailable` (ראה טבלת הכשלים
למטה), ואף הודעת בקשת-אישור לא יוצאת.

---

## 3. תקנון והחיבור

אין עדיין כלי CLI שמתקין תקנון או קובע חיבור למצב `live` — שניהם ייבנו עם
המתכנן. עד אז מריצים את הסקריפט שכבר נמצא במאגר:

```bash
npx tsx scripts/seed-charter.ts
```

**הסקריפט נמצא במאגר ואין לכתוב אותו מחדש ביד.** עד סבב הניקוי של 29/09 הפרק
הזה הדביק כאן את קוד המקור שלו וביקש לשמור אותו כקובץ חדש — ניסוח שקדם
לקיומו של הסקריפט ונשאר במקומו אחריו. ההעתקה ההיא כבר לא הייתה מתקמפלת:
`ConnectionBinding.provider` הוא שדה **חובה** מאז מיגרציה 033
(`z.string().min(1).nullable()` — כלומר מותר לו להיות `null` אבל אסור לו
להיעדר), והוא נעדר מהרשימה שהודבקה כאן; והיא גם הצהירה על `office-mail`
בלבד, כך שמי שהעתיק אותה איבד את ההצהרה על `office-calendar` שפרק 10 נשען
עליה.

**מה הסקריפט עושה:** מתקין תקנון שמצהיר על **שתי** מערכות — `office-mail`
(ערוץ `api`, `serves: ['mail.send']`) ו-`office-calendar`
(`serves: ['calendar.read']`) — וקובע את החיבור `office-mail` ל-`live` עם
`credentialRef: 'OFFICE_MAIL'`.

**ומה הוא במפורש אינו עושה:** הוא **אינו** כותב שורת binding ל-`office-calendar`.
זו לא שכחה — היומן מקבל את ה-binding שלו מטקס ההרשאה בפרק 10, ששם נקבעים
גם ה-`provider` וגם ה-`credentialRef` שלו; שורה שהייתה נכתבת כאן מראש הייתה
נדרסת שם בכל מקרה.

**הרצה חוזרת בטוחה, ולא תדרוס הצהרה קיימת.** הסקריפט קורא את התקנון הפעיל
דרך `probeActiveCharter` ולא דרך `loadActiveCharter` — כלומר גם תקנון שאי
אפשר לפרסר אינו עוצר אותו, וזה מה שהופך אותו לנתיב ההתאוששות בטבלת הכשלים
למטה — ומדלג על ההתקנה רק אם התקנון הפעיל מצהיר על **שתי** המערכות. תקנון
שמצהיר על אחת מהן בלבד מוחלף בגרסה חדשה שמצהירה על שתיהן, ולעולם לא בגרסה
שמצהירה רק על האחרת.

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

## 10. חוט חי שני: טקס ההרשאה (OAuth) ל-Google Calendar

חוט נפרד מהחוט שלמעלה — לא מייל, ולא צריך scheduler רץ כדי להוכיח שהוא
עובד. מה שהוא מוכיח: שלחיצה של הבעלים על "לחיבור" במסך `/connections`
מסתיימת בהרשאה אמיתית שמורה מוצפנת, ושדרכה `npm run connector:calendar`
קורא אירועים אמיתיים מהיומן של העסק — לא רק שהקוד מתקמפל.

### 10.0 דרישות מוקדמות

- מפתח אב קיים (`npm run secret:key create <מפעיל>`, פעם אחת להתקנה — ראה
  שלב 2 למעלה אם עוד לא נוצר).
- תקנון פעיל שמצהיר על מערכת בשם `office-calendar` עם
  `serves: ['calendar.read']`. **`scripts/seed-charter.ts` משלב 3 מצהיר עליה
  כבר**, כך שאם שלב 3 הורץ הדרישה הזו מסופקת ואין מה לכתוב ביד. (עד סבב
  הניקוי של 29/09 נאמר כאן להעתיק את התבנית של אותו סקריפט "רק עם
  `system: 'office-calendar'`" — בזמן שהסקריפט עצמו כבר כלל אותה, כלומר
  עבודה כפולה שגם מסתיימת באותו תקנון בדיוק.) **המרשם יכול רק לצמצם** (ראה
  `CLAUDE.md`): שורת `connection_bindings` בלבד, בלי הצהרה תואמת בתקנון,
  עדיין נדחית ב-`no_channel_for_tool`.
- שתי הפניות סוד — לא אחת — מוקצות במאגר **לפני** שמתחילים:

  ```bash
  npm run secret put GOOGLE_OAUTH_CLIENT_ID <המפעיל שלך>
  npm run secret put GOOGLE_OAUTH_CLIENT_SECRET <המפעיל שלך>
  ```

  אלה זהות ה-OAuth client של האפליקציה עצמה מול Google (Google Cloud
  Console — OAuth client ID מסוג "Web application"), **לא** הרשאה של עסק
  בודד: את ה-client יוצרים ב-Cloud Console **פעם אחת לכל המוצר**, ואותם שני
  ערכים בדיוק מוקצים בכל התקנה. בלעדיהן `handleOAuthStart` מסרב מיד
  ב"תצורה חסרה", לפני שהבעלים בכלל מגיע למסך ההסכמה של Google.

  **אבל השורה במאגר היא לכל עסק, ולא אחת לכולם — המשפט הזה טען את ההפוך עד
  30/09 וזה היה שגוי.** נאמר כאן ש"שורה אחת משרתת כל עסק שההתקנה הזו מריצה",
  ואין מנגנון שמאפשר זאת: `googleTokenHttp`
  ([src/orchestrator/adapters/google-token-http.ts](../src/orchestrator/adapters/google-token-http.ts))
  פותר את שתי ההפניות דרך `credentials.resolve(ref, input.businessId)`, ו-
  `storedCredentials` מסנן ב-`WHERE business_id = $1` **וגם** קושר את מזהה
  העסק כ-AAD להצפנה עצמה — כלומר שורה שנכתבה תחת עסק א' אינה נקראת על ידי
  עסק ב', לא בשאילתה ולא בצופן, וזו בקרה מכוונת (ראה `CLAUDE.md`, "שתי בקרות
  בלתי-תלויות עומדות על אותו גבול"). בפועל אין כאן סתירה תפעולית, כי הפרויקט
  מריץ **התקנה אחת לכל עסק** (`config.businessId` מ-`BUSINESS_ID` — כתוב
  בדוקבלוק של [src/cli/secret.ts](../src/cli/secret.ts)), ולכן "שורה לכל
  התקנה" ו"שורה לכל עסק" הם אותו דבר. מי שיארח שני עסקים בהתקנה אחת חייב
  להקצות את שתי ההפניות **תחת כל אחד מהם בנפרד**; אחרת העסק השני נדחה
  ב"תצורה חסרה" בלי שדבר יצביע על הסיבה.
- `DASHBOARD_BASE_URL` מוגדר ותואם לכתובת שבה הדשבורד באמת מאזין (ראה שלב 2
  למעלה) — Google מפנה חזרה בדיוק ל-`<DASHBOARD_BASE_URL>/oauth/callback`,
  ואי-התאמה כאן היא תקלת ההתקנה הנפוצה ביותר (spec 5.5).
- ב-Google Cloud Console: ה-redirect URI הרשום ל-client זהה בייט-לבייט
  לערך שהפקודה למעלה מחשבת.
- **Google Calendar API מופעל בפרויקט** (Cloud Console → APIs & Services →
  Library → Google Calendar API → Enable). זה **אינו** נגזר מההסכמה: חילופי
  האסימון מדברים עם `oauth2.googleapis.com`, שאינו תלוי בכך, בזמן שקריאת
  היומן עצמה מדברת עם `www.googleapis.com/calendar/v3`, שכן. לכן בלי ההפעלה
  הזו **הטקס מצליח במלואו** — הרשאה נכתבת, ה-binding עובר ל-`provider:
  'google'`, ומסך ההצלחה מוצג — ורק שלב 10.2 נכשל. שני תסמינים שנראים
  מנותקים זה מזה ושניהם נובעים מכאן: מסך ההצלחה מציג את החשבון **ריק**, כי
  `fetchGoogleAccount` ([src/dashboard/oauth-consent.ts](../src/dashboard/oauth-consent.ts))
  קורא לאותו API כדי להביא את התווית, מחזיר `null` על כל כשל, ובמפורש אינו
  מפיל את כתיבת ההרשאה בגללו; ו-`npm run connector:calendar` מחזיר
  `forbidden` — **כשל סופי, לא לניסיון חוזר** — עם הודעת Google עצמה
  מצורפת (`הגישה ליומן נדחתה (403) — Google Calendar API has not been used in
  project ...`). ההודעה הזו כן אומרת מה לעשות, כך שהמחיר הוא סבב מבולבל אחד
  ולא תעלומה; הבולט הזה נוסף ב-30/09 אחרי שהחסר הזה נמצא בתנאים המוקדמים
  בזמן הכנת ההרצה החיה.
- **מצב הפרסום (Publishing status) של מסך ההסכמה ב-Google Cloud Console.**
  `calendar.readonly` הוא scope רגיש, ו-client שנשאר במצב **"Testing"**
  (במקום "In production", אחרי אימות של Google או כמפיץ פנימי) מנפיק
  אסימוני רענון ש**פגים אחרי שבעה ימים** — ללא קשר לשום דבר בקוד הזה.
  הטקס עצמו **יצליח**: `handleOAuthCallback` יכתוב הרשאה, `connector-
  calendar.ts` ידפיס אירועים אמיתיים, וכל הבדיקות בשלב 10.2 יעברו בירוק —
  ורק כעבור שבוע כל קריאה תתחיל להיכשל ב-`invalid_grant`, ושורת הביקורת
  תגיד נכון "הספק דחה את ההרשאה" (זה `OAuthRefreshRejectedError`, לא
  `OAuthMisconfiguredError` — הספק אכן נדרש ואכן סירב, בגלל תפוגת האסימון
  שה-"Testing" קובעת). **אין כאן באג בקוד** — המפעיל צריך לדעת את זה
  *לפני* שהוא מסיק ש-10.2 שהצליח פירושו שהשער עבר לצמיתות. לבדוק/להעביר את
  המצב ל-"In production" (או, בזמן פיתוח, לוודא במפורש שהמצב אינו
  "Testing") לפני שסומכים על ריצה שנשארת עובדת מעבר לשבוע הראשון.

### 10.1 החיבור

1. `npm run dashboard`, היכנס עם חשבון הבעלים.
2. פתח `/connections`. המערכת `office-calendar` מופיעה עם קישור "לחיבור"
   (כך `views.ts` מרנדר אותו; הפרק הזה כתב "התחבר" עד 29/09).
3. לחיצה מפנה ל-`GET /oauth/office-calendar/start` — הדשבורד מנפיק PKCE
   ו-`state` חד-פעמי (`createState`, [src/governance/oauth-state.ts](../src/governance/oauth-state.ts))
   ומפנה לעמוד ההסכמה של Google.
4. אשר גישה **read-only** ליומן (ה-scope היחיד שהטקס הזה מבקש:
   `https://www.googleapis.com/auth/calendar.readonly`).
5. Google מפנה בחזרה ל-`/oauth/callback` עם `code`. `handleOAuthCallback`
   ([src/dashboard/oauth-routes.ts](../src/dashboard/oauth-routes.ts)) צורך
   את ה-`state` (סירוב זהה אם הוא לא קיים, כבר נוצל, או שייך לסשן אחר —
   ראה 10.2 למטה), מחליף את הקוד, וכותב **בטרנזקציה אחת**: הרשאת ה-OAuth
   (`oauth_grants`, מוצפנת), שורת ביקורת, ואת `connection_bindings.provider
   = 'google'`.
6. עמוד ההצלחה מציג את החשבון ואת ההיקפים שאושרו בפועל.

**אם ה-scheduler כבר רץ, הפעל אותו מחדש** — הוא קורא bindings ותקנון פעם
אחת בעלייה, בדיוק כמו האזהרה למעלה על `office-mail`.

### 10.2 ההוכחה: קריאה אמיתית

```bash
npx tsx scripts/connector-calendar.ts
```

(מוגדר גם כ-`npm run connector:calendar`.) פותר את ה-credential
(`oauthCredentials`), מרענן אסימון גישה מול Google בפועל דרך
`googleTokenHttp`, וקורא `calendar.read` על ה-adapter האמיתי. תוצאה
תקינה מדפיסה JSON עם אירועים אמיתיים מהיומן של העסק — לא נתון בדוי, לא
שורה שמדמה תשובה.

### 10.3 הביטול

במסך `/connections`, "בטל" ליד `office-calendar` — `POST
/oauth/office-calendar/revoke`, מוגן CSRF. `handleOAuthRevoke` מסמן
`revoked_at` **מקומית קודם** (ראה `CLAUDE.md`, "הביטול המקומי הוא
הסמכותי"), ורק אז מנסה גם לבטל אצל הספק. הרץ שוב את שלב 10.2 מיד אחרי —
הקריאה הבאה **חייבת** להיכשל: `readGrantByRef` מסנן `revoked_at IS NOT
NULL`, `grantStatusByRef` מחזיר `'revoked'`, ו-`oauthCredentials` זורק
`OAuthGrantRevokedError` **לפני** שהיא נופלת לאחור לשום סוד סטטי אחר תחת
אותה הפניה. `connector-calendar.ts` תופס את זה ומדפיס `MISS` — לא stack
trace — עם ההודעה בעברית של החריגה.

### כשלי ה-OAuth, אחד לכל מחלקה ש-`oauthCredentials` באמת זורקת

חמש המחלקות ב-[src/orchestrator/oauth-token.ts](../src/orchestrator/oauth-token.ts),
כולן מעל מה שהפולבק (`CredentialSource`) עצמו יכול לזרוק:

| מחלקה | מה קרה | סופי או ניתן לניסיון חוזר | מה רואים |
|---|---|---|---|
| `OAuthGrantRevokedError` | הבעלים ביטל את ההרשאה (10.3), או שהיא לא הייתה קיימת מעולם וה-ref *כן* קיים כרשומה מבוטלת — `readGrantByRef` מחזיר `null` בשני המקרים, ו-`grantStatusByRef` הוא מה שמבחין ביניהם. **לעולם לא נופל אחורה** לסוד סטטי תחת אותו ref, גם אם אחד קיים — זו בדיוק העמימות ש-`AmbiguousCredentialRefError` מסרבת לה משורה למטה. | סופי — נדרשת הרשאה מחדש דרך 10.1 | `connector-calendar.ts` מדפיס `MISS` עם הודעת "ההרשאה ... בוטלה על ידי הבעלים". אין שורת ביקורת נוספת מעבר לזו ש-`handleOAuthRevoke` כבר כתב בשלב 10.3. |
| `OAuthRefreshRejectedError` | הספק עצמו הסתכל על אסימון הרענון וסירב (`invalid_grant` וכדומה) — לרוב כי הבעלים ביטל **אצל Google** ישירות, לא דרך הדשבורד. | סופי — נדרשת הרשאה מחדש | נכתבת שורת `audit_log` מסוג `credential_change` בשם הספק (`auditRefreshRejection`), ו-`markNeedsReauth` מסמן את ההרשאה. |
| `OAuthMisconfiguredError` | ההתקנה עצמה לא סיפקה מה שנדרש — `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` לא הוקצו (ראה 10.0), או ש-`provider` הרשום ב-binding אינו `google`. הספק **מעולם לא נענה** — זו עובדת תצורה, לא תשובה שלו. | סופי, אבל **לא** אותה משמעות כמו למעלה: אינה כותבת שורת `credential_change` (זו לא הייתה תגובה של הספק) ואינה מסמנת `needsReauth` (הרשאה מחדש לא מתקנת סוד מקומי חסר). | הודעה מפורשת שנוקבת בשם ה-ref החסר. |
| `OAuthRefreshTransientError` | כשל רשת, 5xx/429 מהספק, או שהקריאה חרגה מ-`TOKEN_EXCHANGE_TIMEOUT_MS` (15 שניות) — כולל תשובת 2xx עם גוף שלא ניתן לפענח. | **ניתן לניסיון חוזר** — הריצה הבאה (או קריאת `connector:calendar` נוספת) עשויה להצליח בלי שום פעולה מהבעלים. | הודעה בעברית שמתארת את הכשל הזמני; אין שורת ביקורת (אין מה לרשום על משהו שעשוי להסתדר לבד). |
| `AmbiguousCredentialRefError` | ההפניה קיימת גם כהרשאת OAuth שמורה **וגם** כסוד סטטי תחת אותו שם (`credentials`) — תצורה שגויה, לא כשל ריצה. | סופי עד שמישהו מסיר את אחת השתיים | הודעה מפורשת שקוראת לזה בשם ומבקשת "להסיר אחת מהן". נבדק רק במקרה של פספוס-מטמון (מינוי/רענון אמיתי) — פגיעת מטמון לא בודקת את זה מחדש, ראה `CLAUDE.md`. |

---

## מה לא יעבוד ולמה

| מצב | מה קורה | איך רואים את זה |
|---|---|---|
| **מריצים בין 20:00 ל-07:00 שעון ישראל** (ראה האזהרה בראש המדריך) | `evaluateToolCall` (שלב 7, `src/policy/engine.ts`) נתקל ב-`inQuietHours` לפני שהוא בכלל מגיע לשלב האוטונומיה, ומחזיר `deny(DENY_CODES.quietHours, ...)`. `executeStep` מרדים את המשימה ל-`followup` עם `wakeAt` בסוף החלון (07:00). אין שורת `approval_requests`, אין מייל, ואין `queue_approval` — הריצה הראשונה של ה-scheduler "לא עושה כלום" באופן שנראה זהה לכשל שקט אחר. | **אין שום פלט קונסולה** בשני התהליכים — לא ב-`job:seed` (כבר סיים בהצלחה) ולא ב-`scheduler` (זה `deny` רגיל, לא `errored`). האות היחיד הוא ה-DB: <br>`SELECT phase, wake_at FROM jobs WHERE job_id = '<job-id>';` <br>מחזיר `phase = 'followup'` ו-`wake_at` מוגדר לזמן שאחרי 07:00 שעון ישראל. ה-scheduler יריץ את המשימה שוב לבד ברגע שמגיע `wake_at` — אין צורך לעשות דבר מלבד לחכות, או להריץ שוב בשעות היום. |
| **התקנון נחתם לפני שינוי סכמה** (למשל מחלקת פעולה שנוספה מאז) | `loadActiveCharter` משווה את `schemaVersion` **לפני** הפירוק וזורק שגיאה שאומרת לאן לזוז: תקנון ישן יותר מהקוד — לחתום מחדש; תקנון חדש יותר (גלגול קוד לאחור) — לגלגל את הקוד קדימה, **לא** לחתום מחדש. כל משימה נכשלת בכל פעימה, כי `runDueJobs` קורא את התקנון לכל job. | הודעת החריגה מודפסת בלוג של `npm run scheduler` לכל משימה. `npx tsx scripts/live-thread-status.ts` מציג `MISS charter installed … STORED BUT UNREADABLE` עם אותה תרופה. **התיקון:** `npx tsx scripts/seed-charter.ts` — הוא מזהה תקנון שאי אפשר לקרוא (`probeActiveCharter`), אומר זאת, ומתקין גרסה חדשה מעליו. עד 27/09 הסקריפט הזה נפל בעצמו על אותה שגיאה ולא הייתה שום דרך להתאושש. |
| **לא הותקן תקנון** (דילגו על שלב 3) | `job:seed` נכשל מיד: `seedMailJob` קורא ל-`activeCharterVersion`, מקבל `null`, וזורק `no active charter for business ... — install one first`. שום משימה לא נוצרת. | ההודעה מודפסת ישירות לטרמינל של `job:seed`, לא בלוג של תהליך אחר. |
| **החיבור `office-mail` לא `live`** (נשכח `upsertBinding`, או שהסטטוס `disconnected`/`error`) | `resolveChannel` (`src/orchestrator/channels.ts`) מחזיר `unavailable`, ו-`performStep` (`src/orchestrator/run-plan.ts`) זורק `StepChannelError('channel_unavailable', JSON.stringify(resolution), true)`. **ניתן לניסיון חוזר**: `execute.ts`'s retryable branch כותב `reason: \`${code} — retry:${stepId} at ${wakeAt}\`` — היא **אינה** משתמשת ב-`message` שנשא את ה-JSON; הצורה `${code} — ${message}` שכן הייתה מכילה אותו קיימת רק בענף ה-`failed`, ומחזור-חוזר לעולם לא מגיע אליו. המשימה עוברת ל-`followup` עם `wakeAt` בעוד 5 דקות (`RETRY_DELAY_MS`). שום שורת `job_step_results` לא נכתבת, כי `channel_unavailable` אינו `outcomeUnknown`. | **אין שום פלט קונסולה** — לא ב-`npm run job:seed` ולא ב-`npm run scheduler`: ל-`run-due.ts` אין קריאות `console.*` בכלל, ו-`logErrored` ב-`run-scheduler.ts` מדפיס רק את `due.errored` (עבודות שזרקו) — לא `due.ran` (שאליו שייך המחזור הזה). האות היחיד הוא ה-DB עצמו: `jobs.phase` מתנדנד בין `followup` ל-`execute` בכל פעימה בלי להגיע ל-`verify`. שאילתה: <br>`SELECT phase, wake_at FROM jobs WHERE job_id = '<job-id>';` <br>`SELECT reason, at FROM job_steps WHERE job_id = '<job-id>' ORDER BY at DESC LIMIT 3;` — השורה האחרונה מציגה `channel_unavailable — retry:s1 at 2026-...`. |
| **הסוד `OFFICE_MAIL` לא הוקצה במאגר** (לא הרצת `npm run secret put OFFICE_MAIL <מפעיל>`, או שהוקצה תחת שם אחר) | `performStep` פותר את ה-credential *לפני* קריאה למתאם. `storedCredentials(...).resolve('OFFICE_MAIL', businessId)` לא מוצא שורה במאגר ומחזיר `null`, ו-`performStep` זורק `StepChannelError('credential_unavailable', 'OFFICE_MAIL')` — **לא** ניתן לניסיון חוזר (ref שגוי או סוד שלא הוקצה לא מסתדרים בהמתנה). המשימה עוברת ישר ל-`failed`. | `job_steps.reason` מציג `credential_unavailable — OFFICE_MAIL`; אין שורת `job_step_results` כלל, כי שום קריאה חיצונית לא יצאה. |
| **הרמפה לא הועלתה** (למשל הריצו `setRampLevel` ידנית ל-`auto`, או שהעבירו `--to` בלי להריץ `job:seed` בכלל) | אם הרמפה עדיין ב-`draft_only` (ברירת המחדל): `effectiveAutonomy` (`src/policy/engine.ts`) מחזיר `draft_only`, השער קורא `deny(DENY_CODES.draftOnly, ...)` כאשר `DENY_CODES.draftOnly = 'draft_only:persist_as_draft'` (`src/domain/policy.ts`), וענף ה-deny הרגיל (לא `quiet_hours`) ב-`execute.ts` כותב `reason: \`${decision.code} — ${decision.reason}\`` ומעביר את המשימה ישר ל-`failed`. אף אישור לא נוצר ואף מייל לא נשלח. אם מישהו כבר העלה אותה ל-`auto` (לא `approve_required`): **אין הבדל בהדגמה הזו** — `seedMailJob` (`src/cli/seed-job.ts`) כותב `input: { to, subject, body }` בלי `counterpartyId`, ו-`runDueJobs` מעביר `counterpartyTags: []`; `scoreVisibility` (`src/policy/risk.ts`) לא מוצא שום התאמה ב-`knownCounterparties` ומחזיר `one_unknown`, `bandFor` מסלים ל-`sensitive` בלי קשר לאוטונומיה, ו-`evaluateToolCall`'s `risk.band !== 'routine'` check (`src/policy/engine.ts`) מבקש אישור **גם ב-`auto`**. `dana@example.com` פשוט אינו counterparty מוכר לתקנון-הדוגמה — כדי לראות `auto` באמת מדלג על אישור צריך תקנון עם `knownCounterparties` שכולל אותו, וזה מחוץ למה שהמדריך הזה מקים. | **גם כאן אין פלט קונסולה**: זה `RanJob` רגיל בתוך `due.ran`, לא חריגה ב-`due.errored`, ו-`logErrored` (`src/orchestrator/run-scheduler.ts`) לא הבדיל בעבר בין `done` ל-`rejected` בתוך `due.ran`; מאז התיקון הוא כן מדפיס כל `ran` שסטטוסו `rejected` — אך `done`/`halted` עדיין לא נדפסים, וזה `RanJob` תקין (`halted` על `queue_approval`) ולא כשל. למקרה `draft_only`: <br>`SELECT phase FROM jobs WHERE job_id = '<job-id>';` מחזיר `failed`, ו-`job_steps.reason` מתחיל ב-`draft_only:persist_as_draft — `. למקרה `auto`: <br>`SELECT count(*) FROM approval_requests WHERE job_id = '<job-id>';` מחזיר `1`, לא `0` — האישור עדיין נוצר, מהסיבה שבעמודה הקודמת. |

---

## סיכום משתני סביבה

| משתנה | חובה? | ברירת מחדל | קורא |
|---|---|---|---|
| `CREDENTIAL_KEY_PATH` | **כן — בלעדיו `buildRuntime` זורק `MasterKeyError` וה-scheduler לא עולה בכלל** | אין (בכוונה: אין נתיב ברירת מחדל) | `buildRuntime`, `secret`/`secret-key` CLI |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER` | כן, כל החמישה יחד | אין | `buildRuntime` (`SMTP_KEYS`) |
| `SMTP_ALLOW_CLEARTEXT` | כן **במדריך הזה** (maildev אינו מדבר TLS); לא בייצור, ושם אל תגדירו אותו | כבוי — `SMTP_SECURE=false` מחייב STARTTLS | `buildRuntime` → `createSmtpTransport` (`requireTLS`) |
| `MAIL_SYSTEM` | לא | `office-mail` | `buildRuntime` |
| `APPROVAL_NOTIFY_TO` | לא (בלעדיו אין הודעת מייל, אבל השרשרת עדיין עובדת דרך הדשבורד) | אין | `buildRuntime` |
| `NOTIFY_CREDENTIAL_REF` | לא כשהוא **חסר** (אזהרה, אין הודעת מייל, השאר עובד); כן כשהוא **שגוי** — ref לא חוקי מפיל את עליית ה-scheduler כולה | אין | `buildRuntime`, נפתר מחדש בכל הודעה על ידי `createEmailNotifier` |
| `ANTHROPIC_API_KEY` | לא לחוט הזה (בלעדיו אזהרה: משימות נסגרות כרגיל, בלי אצירת זיכרון) | אין | `buildRuntime`, `curateJob` |
| `DASHBOARD_BASE_URL` | לא, אבל ברירת המחדל כנראה שגויה אצלך | `http://127.0.0.1:8787` | `buildRuntime` |
| הסוד `OFFICE_MAIL` (במאגר, לא משתנה סביבה) | כן, לכל `credential_ref` בשם `OFFICE_MAIL` | אין | `storedCredentials` — מוקצה עם `npm run secret put OFFICE_MAIL <מפעיל>` |
| `DASHBOARD_PORT`, `DASHBOARD_HOST`, `DASHBOARD_TRUST_PROXY`, `DASHBOARD_ALLOW_PUBLIC_BIND` | לא | `4173`, `127.0.0.1`, כבוי, כבוי | `run-dashboard.ts` |
| `SCHEDULER_INTERVAL_MS` | לא | `30000` | `run-scheduler.ts` |
