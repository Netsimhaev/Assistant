# שלב ד' — מערכות חיצוניות: תוכנית בנייה

> תרגום עברי של [2026-11-18-external-systems.md](2026-11-18-external-systems.md). שמות בקוד, נתיבים ופקודות נשארו באנגלית. אם יש סתירה בין השניים, הקובץ האנגלי הוא שהבונים עובדים לפיו.

**המטרה:** איש הצוות הטכני מגדיר בפאנל המנהל חיבור כללי ל-API מוצפן (HTTPS) של עסק, ובעל העסק חותם עליו בתקנון. מאותו רגע העוזרת:
- **פועלת במערכת:** קוראת ממנה ופועלת בה **רק על ציווי בוס שאושר**.
- **לומדת ממנה:** מההתראות שהמערכת שולחת ומהסריקה היומית.
- **מדווחת:** על מה שקראה ומה שעשתה.

כל זה בלי שום פטור חדש בשער ההרשאות.

**הארכיטקטורה:**
- **מבנה בתקנון:** מערכת חיצונית היא אובייקט חתום בתקנון (`externalSystems[]`), ולצידה חיבור רגיל אחד (`CharterConnection`) לכל מערכת. ה-`target` של החיבור הוא מזהה המערכת, כך שבחירת הערוץ וה-bindings עובדים בלי שינוי.
- **שני כלים חדשים:** `ext.read` ו-`ext.call`, בבעלות `ops.systems`. שניהם מסווגים ושניהם יוצאים החוצה.
- **מחלקת הפעולה של קריאה:** נקראת **מהפעולה החתומה**, ולעולם לא מהמטען או מהמודל.
- **מידע נכנס (התראות, סריקות, קריאות):**
  - הוא מצומצם בקוד, בלי מודל, רק לשדות שההגדרה מצהירה עליהם.
  - הוא נשמר כ-`unknown_external`.
  - הסיכום שלו נכתב בלי מודל.
  - מה שנשמר ממנו לזיכרון הוא `chunk` בלבד.

**טכנולוגיות:**
- TypeScript (NodeNext, ESM) ו-zod 4.
- pg עם RLS.
- vitest על Postgres אמיתי.
- `node:https`, בלי תלות חדשה.

**המפרט:** [docs/superpowers/specs/2026-11-13-external-systems-design.md](../specs/2026-11-13-external-systems-design.md). זה כולל את תשובות הבעלים מ-13/11, שגוברות על כל מה שכתוב מעליהן באותו קובץ.

## אילוצים גלובליים

- **השער לא מקבל פטור חדש.** ב-`src/policy/engine.ts` השינוי היחיד הוא הפתרון בשלב 3 (משימה 3), והוא עובר `/security-review`.
- **פעולה חיצונית רצה רק תחת `confirmedCommandCovers`:** ציווי בוס ועוד "כן" אחד. שום מסלול של המנצח, סריקה או התראה לא יוצר משימה עם צעד `ext.*`.
- **פעולות כסף:** סוג `money` ממופה רק למחלקה `payment.make` או `refund.issue`. פעולה כזו לעולם אינה רצה בלי "כן" מפורש של הבוס, בכל מצב.
- **מה המודל יכול לקבוע:** הכתובת, השיטה, הנתיב והמחלקה באים מההגדרה החתומה. המודל ממלא רק את `params`, ובפעולת כסף גם את `amountMinor`. כולם מוצגים במלואם בשאלת האישור.
- **רשת:**
  - HTTPS בלבד.
  - מסרבים לכתובות פרטיות, loopback, link-local, CGNAT, ULA, multicast, unspecified ו-metadata של ענן.
  - הבדיקה נעשית **אחרי פתרון DNS**, על ה-socket שבאמת נמצא בשימוש.
  - לעולם לא עוקבים אחרי הפניה (redirect).
- **סודות:**
  - נשמרים רק במאגר של העסק (`putSecret`), תחת `EXT_<ID>_KEY` ו-`EXT_<ID>_HOOK`, כש-`<ID>` הוא מזהה המערכת באותיות גדולות.
  - לעולם לא מופיעים בהגדרה, בתקנון, בפרומפט, בלוג, בשורת ביקורת, בפאנל או בדשבורד.
- **מידע מבחוץ:** כל מה שנקרא מבחוץ הוא `unknown_external`. מה שנכתב ממנו לזיכרון הוא `chunk` בלבד, ולעולם לא גורע עובדה קיימת.
- **בידוד המדיניות:** אף שורה ב-`src/policy/` לא קוראת דבר מתוך תשובה חיצונית, כולל סכומים. זה אותו כלל שחל על `findings`.
- **גרסת התקנון:** `CURRENT_SCHEMA_VERSION` עולה ל-`'1.4'`, וכל תקנון חתום חייב להיחתם מחדש. זה צפוי, לא באג.
- **שפה:** עברית לבעלים ולאיש הצוות, אנגלית בקוד. שמות מחלקות מוצגים לבעלים רק דרך `src/domain/labels.ts`.
- **טבלאות חדשות:** לכל אחת `business_id`, RLS עם `FORCE` והמדיניות הרגילה של `app_business_id()`, ושלושתם נוצרים במיגרציה של הטבלה.
- **בדיקות שלא הורצו:** כל בדיקה חיה שנבנתה ולא הורצה נכנסת ל-`docs/11-pre-launch-checks.md`.

## הכרעות שקיבלתי בזמן התכנון (⚙ — שלי, לא של הבעלים)

1. **ההגדרה נכתבת כ-JSON:** איש הצוות מדביק את ההגדרה **כ-JSON בתיבת טקסט**. zod מאמת אותה, השגיאות מוצגות בעברית, ואיש הצוות רואה תצוגה מקדימה בעברית. טופס דינמי ל-N פעולות הוא הרבה ממשק בלי תוספת בטיחות, ו-JSON נותן את הגמישות שהבעלים ביקש. *המחיר אם טעיתי:* לבנות טופס בהמשך; הסכמה נשארת כמו שהיא.
2. **גם קריאה שואלת "כן" אחד.** במתג ברירת המחדל, `off`, הרמפה מחזיקה את `external.read` ב-`draft_only`, ולכן ציווי מאושר הוא המסלול היחיד שבכלל יכול להריץ קריאה. *המחיר:* מילה אחת נוספת לכל שאילתה.
3. **התשובות מצומצמות בקוד:** לכל פעולה ולכל סוג התראה מוצהרים עד 20 שדות (`fields`), כל אחד עם נתיב JSON ותווית בעברית. רק הם נשמרים, מוצגים ונלמדים; שום דבר אחר מהתשובה לא נשמר. *המחיר:* איש הצוות צריך לנקוב בשדות, ושדה שלא נקב בו לא ייראה בכלל.
4. **הסיכום לבוס** על ההתראות והסריקות הוא פרק בתדריך היומי/השבועי, ועוד מסך `/systems`. אין ערוץ הודעות חדש. *המחיר:* בעלים שמשאיר את התדריך כבוי רואה את הסיכום רק במסך. זה נאמר במסך וב-docs/10.
5. **ניסיון חוזר:**
   - **כתיבה** שקיבלה 429 או 503 אפשר לנסות שוב.
   - **כתיבה במצב לא ברור:** 5xx אחר, תקלת רשת אחרי שהבקשה נשלחה, או פקיעת זמן, היא `delivery_unknown` או `adapter_timeout`. היא סופית ולא נשלחת שוב בעיוורון.
   - **קריאה** מנסים שוב על כל 429 או 5xx.
6. **יחידות כסף:**
   - רק שקל, דולר, אירו ולירה שטרלינג (שתי ספרות אחרי הנקודה).
   - המטבע חייב להיות זהה לזה של התקנון.
   - ב-`unit: 'major'` נשלח `amountMinor / 100` כמספר JSON.
7. **מותר לחתום לפני שהסוד נשמר.** הסטטוס מציג "חסר סוד", וכל קריאה נכשלת ב-`credential_unavailable` עד שהסוד יישמר.
8. **נקודת קבלת ההתראות** יושבת על שרת הדשבורד (מאחורי ה-proxy), בכתובת `POST /hooks/ext/<businessId>/<systemId>`. אין בה סשן, והאימות נעשה בסוד. סוגי אירועים לא מוכרים נספרים ונזרקים.
9. **הסריקה היומית היא עקיפת שער מתועדת.** היא מצטרפת לרשימה הקצרה: תיוג המייל, האוצר, המחיקה ושמירות המקום ביומן. המפרט דורש סריקה, ודרך השער במצב `off` היא לא הייתה קוראת דבר.
   - **מה מחזיק אותה במקום השער:**
     - היא יכולה להריץ רק את פעולת ה-`read` האחת שבעל העסק חתם עליה כ-`scan`.
     - היא רצה רק במרווח החתום.
     - היא עוברת דרך אותו בונה בקשות, אותו שומר כתובות ואותה תקרה יומית.
     - מה שהיא קוראת רק מלמד.
   - *המחיר אם טעיתי:* סריקה חתומה שקוראת מידע שבעל העסק לא ציפה לו.
   - *ההקלה:* עמוד החתימה אומר את זה במילים.

10. **שלוש תוספות כדי שיותר מערכות אמיתיות ייכנסו (הבעלים, 18/11):**
    - **חתימת התראה עם תחילית ו/או חותמת זמן:** פותחת את Stripe, ‏GitHub ו-Slack.
    - **גוף בקשה כטופס** (form-encoded).
    - **לחיצת היד באימות הראשון של התראות:** פותחת את Meta ו-Slack.

    אף אחת מהן לא מרפה דבר:
    - החתימה עדיין מחושבת על הבייטים הגולמיים עם סוד מהמאגר.
    - חותמת הזמן מוסיפה הגנה מפני שידור חוזר (±300 שניות).
    - תשובה ללחיצת יד מוחזרת רק אחרי בדיקת האסימון או החתימה, כטקסט רגיל, עד 200 תווים מתוך `[A-Za-z0-9._-]`.

    *מה עדיין בחוץ:* OAuth, ‏XML/SOAP, סריקה של כמה עמודים, וחתימת בקשות בסגנון AWS.

## מוקדי סקירה

1. **ערך פרמטר שמכיל `../`, `?`, `#` או `%2F`** לא משנה את הנתיב. כל ערך מקודד כמקטע נתיב יחיד. ממלא-מקום בתבנית בלי פרמטר תואם הוא סירוב, לא מקטע ריק.
2. **שם DNS שנפתר ל-`127.0.0.1`, `169.254.169.254`, `::ffff:10.0.0.1` או `fd00::1`**, או שמשנה כתובת בין הבדיקה לחיבור, מסורב. הבדיקה רצה בתוך ה-`lookup` של ה-socket עצמו.
3. **צעד בתוכנית שנוקב בפעולה מהסוג הלא נכון לכלי שלו** מסורב בשלב 3, ולעולם לא מסווג כמשהו מקל יותר. זה חל על:
   - פעולת `money` תחת `ext.read`.
   - פעולת `read` תחת `ext.call`.
   - מערכת לא מוכרת או פעולה לא מוכרת.
4. **התראה שהגוף שלה JSON תקין, אבל החתימה חושבה על בייטים אחרים** (סודר מחדש, רווחים שונו), מסורבת. ה-HMAC מחושב על הבייטים הגולמיים.
5. **קריאת כסף שגם ה-`params` שלה נושאים את שדה הסכום** מסורבת. אחרת היו בה שני סכומים, אחד שמוצג ואחד שנשלח. כך הסכום שבעל העסק ראה הוא היחיד שיכול להגיע לספק.

---

### משימה 1: סכמת תקנון 1.4 — מערכות חיצוניות ושתי מחלקות חדשות

**קבצים:**
- **ליצור:** `src/domain/external-system.ts`, `src/domain/external-system.test.ts`
- **לשנות:**
  - `src/domain/action.ts`: ה-enum, `NEVER_FULLY_AUTONOMOUS_TABLE` וטבלת הנמענים
  - `src/domain/charter.ts`: השדה, בדיקת הצימוד, וגרסה `'1.4'` עם שורת docblock
  - `src/domain/labels.ts`
  - `src/charter/schema-version.test.ts`
  - `src/charter/interview/build.ts`: בסיס האוטונומיה לשתי המחלקות
  - `src/test/fixtures.ts`
  - `src/charter/compile.ts` ו-`src/domain/policy.ts`: העברת `externalSystems` לבאנדל

**ממשקים — מה המשימה מייצרת:**
- `ExternalSystem` (zod + טיפוס), `ExternalOperation`, `ExternalField`, ו-`OperationKind = 'read'|'change'|'delete'|'money'`.
- `EXTERNAL_SYSTEM_ID = /^[a-z][a-z0-9_]{1,30}$/`.
- `externalSecretRefs(id) → { key: string; hook: string; verify: string }`, שמחזיר `EXT_<ID>_KEY`, ‏`EXT_<ID>_HOOK` ו-`EXT_<ID>_VERIFY`. האחרון נחוץ רק ללחיצת יד מסוג `query_challenge`, שאסימון האימות שלה אינו סוד החתימה.
- `CHANGE_CLASSES = ['crm.write','accounting.write','quote.issue','commitment.make','data.export'] as const`.
- `MONEY_CLASSES = ['payment.make','refund.issue'] as const`.
- `PolicyBundle.externalSystems: ExternalSystem[]`.

**מבנה `ExternalSystem`:**
- **שדות בסיס:** `{ id, label (בעברית), baseUrl, auth, idempotencyHeader, operations, webhook, scan }`.
- **`baseUrl`:** `https:` בלבד, בלי פרטי משתמש, בלי query ובלי fragment.
- **`auth`:** אחד מ-`{ kind: 'header', header }`, `{ kind: 'bearer' }` או `{ kind: 'basic' }`.
- **`idempotencyHeader`:** שם כותרת או null.
- **`operations`:** 1–50 פעולות, כל אחת `{ name, label, kind, actionClass, method, path, params, fields, idPath, amount }`:
  - `name`: `/^[a-z][a-z0-9_]{1,40}$/`.
  - `path`: מתחיל ב-`/`, וממלאי-המקום כתובים `{param}`.
  - `params`: רשימת `{ name, in: 'path'|'query'|'body', required }`.
  - `bodyEncoding`: `'json'` (ברירת מחדל) או `'form'`.
  - `fields`: עד 20 רשומות `{ path: dotted, label }`.
  - `idPath`: נתיב שדה או null.
  - `amount`: `{ field, unit: 'minor'|'major', currency }` או null.
- **`webhook`:** `{ scheme, typePath, events: [{ type, label, fields }], handshake }` או null.
  - **`scheme`:** `{ kind: 'shared-secret', header }`, או `{ kind: 'hmac-sha256', encoding: 'hex'|'base64', signature, signedPayload, timestamp }`:
    - **`signature`:** אחת משתי צורות:
      - `{ from: 'header', header, prefix: string|null }`. ב-GitHub: `X-Hub-Signature-256` עם התחילית `sha256=`.
      - `{ from: 'kv', header, key, separator }`. ב-Stripe: `Stripe-Signature`, המפתח `v1` והמפריד `,`. מספיק ערך אחד תואם.
    - **`signedPayload`:** תבנית שיש בה רק `{timestamp}` ו-`{body}`, עם `{body}` פעם אחת בדיוק. דוגמאות: `'{body}'` (ברירת מחדל), `'{timestamp}.{body}'` (Stripe), `'v0:{timestamp}:{body}'` (Slack).
    - **`timestamp`:** null, `{ from: 'header', header }` (Slack) או `{ from: 'kv', key }` (ב-Stripe המפתח `t`).
      - חובה כשהתבנית משתמשת ב-`{timestamp}`.
      - בשניות unix, ועד ±300 שניות מעכשיו.
  - **`handshake`:** אחד משלושה:
    - null.
    - `{ kind: 'query_challenge', modeParam, modeValue, tokenParam, challengeParam }`: ב-Meta אלה `hub.mode` עם הערך `subscribe`, ‏`hub.verify_token` ו-`hub.challenge`. בקשת GET; האסימון מושווה ל-`EXT_<ID>_VERIFY`.
    - `{ kind: 'body_challenge', typeValue, challengePath }`: ב-Slack זה `url_verification`. בקשת POST, אחרי בדיקת החתימה.
- **`scan`:** `{ operation, sinceParam: string|null, itemsPath: string|null, everyHours: 1..168 }` או null.

**צעדים:**
- [ ] **צעד 1: לכתוב מבחנים שנכשלים** ב-`external-system.test.ts`.
  - **שילובי סוג ומחלקה שמסורבים:**
    - `kind:'read'` עם מחלקה שאינה `external.read`.
    - `kind:'delete'` עם מחלקה שאינה `external.delete`.
    - `kind:'change'` עם מחלקה מחוץ ל-`CHANGE_CLASSES`.
    - `kind:'money'` עם `purchase.place`.
  - **כסף, מה שמסורב:**
    - פעולת `money` בלי `amount`.
    - `amount.currency` שאינו ב-`['ILS','USD','EUR','GBP']`.
    - `field` של סכום שמופיע גם ב-`params`.
  - **כתובות בסיס שמסורבות:** `http://…`, `https://u:p@h`, `https://h/?q=1`.
  - **נתיבים ופרמטרים שמסורבים:**
    - ממלא-מקום בנתיב בלי פרמטר `in:'path'`.
    - פרמטר `in:'path'` בלי ממלא-מקום.
    - שמות פעולה כפולים.
    - `scan.operation` שאינה פעולת `read`.
    - סוג אירוע שמופיע פעמיים ב-`webhook.events`.
  - **מקובל:** ה-fixture `crmFixture()`, שמיוצא מ-`src/test/external-fixtures.ts`.
  - **התראות, מה שמסורב:**
    - `signedPayload` בלי `{body}`, עם `{body}` פעמיים, או עם ממלא-מקום אחר מלבד `{timestamp}` ו-`{body}`.
    - תבנית עם `{timestamp}` כש-`timestamp: null`.
    - `body_challenge` בלי `typePath`.
    - `bodyEncoding: 'form'` על פעולת `GET`.
  - **צימוד לתקנון** (ב-`charter.test.ts`, מבחן נפרד לכל חצי):
    - לכל `externalSystems[i]` יש בדיוק חיבור אחד עם `system === 'ext:'+id`, `serves` שהוא בדיוק `['ext.call','ext.read']`, `target === id` ו-`channel: 'api'`.
    - לכל חיבור שהמערכת שלו מתחילה ב-`ext:` יש הגדרה.
  - **מטבע:** פעולת כסף שהמטבע שלה שונה מ-`money.currency` מסורבת כבר בפריסה, עם הודעה בעברית.
- [ ] **צעד 2: להריץ** `npx vitest run src/domain/external-system.test.ts src/domain/charter.test.ts src/charter/schema-version.test.ts`. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.**
  - להוסיף את `external.read` (נמען `internal`, לא אוטונומית לעולם: `false`) ואת `external.delete` (`internal`, `true`).
  - תוויות: "קריאה ממערכת חיצונית" ו"מחיקה במערכת חיצונית".
  - ברירות מחדל בראיון: `external.read` ב-`auto`, `external.delete` ב-`approve_required`.
  - לעדכן את הרשימה הקפואה ב-`schema-version.test.ts`, להעלות ל-`'1.4'` עם פסקה ב-docblock, ולהעביר את `externalSystems` (ברירת מחדל `[]`) דרך `compileCharter`.
- [ ] **צעד 4: להריץ** את אותם מבחנים ועוד `npm run typecheck`. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(charter): schema 1.4 — external systems and external.read/external.delete`.

### משימה 2: מיגרציה 077 ופונקציות האחסון

**קבצים:**
- **ליצור:** `src/db/migrations/077_external_systems.sql`, `src/external/store.ts`, `src/external/store.test.ts`
- **לשנות:** `src/tenancy/rls.test.ts`, רק אם ספירת הטבלאות הצפויה בו נעוצה

**ממשקים — מה המשימה מייצרת (ב-`src/external/store.ts`):**
- `saveDraft(db, {systemId, definition, staffId}) → void` (upsert), `loadDrafts(db) → DraftRow[]`, `deleteDraft(db, systemId)`.
- `recordExternalRead(db, {jobId, stepId, systemId, operation, fields}) → void`, `loadReadsForJob(db, jobId) → ReadRow[]`.
- `insertEvent(db, {systemId, source:'webhook'|'scan', eventType, itemHash, fields}) → boolean` (false על כפילות), `newEventsSince(db, cursor) → EventRow[]`, `markEventsCurated(db, ids)`.
- `countCallsToday(db, systemId, timeZone) → number`, `recordCall(db, {systemId, outcome})`.
- `recordRejectedHook(db, systemId, reason)`, `lastScanAt(db, systemId)` / `setLastScanAt(db, systemId, at)`.
- בכולן `fields: {label: string; value: string}[]`.

**טבלאות:**
- `external_system_drafts (business_id, system_id, definition jsonb, updated_at, updated_by_staff text)`, מפתח ראשי `(business_id, system_id)`.
- `external_reads (business_id, read_id, job_id, step_id, system_id, operation, fields jsonb, created_at)`.
- `external_events (business_id, event_id, system_id, source, event_type, item_hash, fields jsonb, created_at, curated_at)`, ייחוד על `(business_id, system_id, item_hash)`.
- `external_calls (business_id, system_id, at, outcome)`, בלי תוכן.
- `external_system_state (business_id, system_id, last_scan_at, rejected_hooks int, last_rejected_at)`.
- עמודה חדשה `business_runtime_settings.external_curation_per_day int NULL`.
- על כל הטבלאות: RLS עם `FORCE` והמדיניות הרגילה.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים** ב-`store.test.ts`, דרך `withBusiness(TEST_BUSINESS, …)`:
  - `insertEvent` עם `item_hash` חוזר מחזיר false ומשאיר שורה אחת.
  - `countCallsToday` סופר מחצות מקומית באזור הזמן שנמסר, לא מחצות UTC.
  - שורה שנכתבה לעסק א' אינה נראית לעסק ב'.
- [ ] **צעד 2:** להריץ `npm run migrate:test` על הבסיס הייעודי, ואז את המבחן. **צפוי:** נכשל.
- [ ] **צעד 3:** לכתוב את המיגרציה ואת פונקציות האחסון, במוסכמת `interface XRow` ו-`toX`.
- [ ] **צעד 4:** להריץ את `store.test.ts` ואת `src/tenancy/rls.test.ts`. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): migration 077 — drafts, reads, events, call log`.

### משימה 3: סיווג — `ext.read`/`ext.call` והמחלקה החתומה

**קבצים:**
- **ליצור:** `src/policy/external-class.ts`, `src/policy/external-class.test.ts`
- **לשנות:**
  - `src/policy/classify.ts`:
    - ב-`TOOL_ACTION_CLASS`: `ext.read: 'external.read'`, ו-`ext.call: 'external.delete'` כממלא-מקום, כי זו המחמירה ביותר.
    - שני הכלים נכנסים ל-`OUTBOUND_TOOLS`.
    - ב-`ingestsExternalContent`: `ext.read: true` ו-`ext.call: false`.
  - `src/domain/charter.ts` (`KNOWN_TOOL_NAMES`)
  - `src/charter/capabilities.ts` (רשימת ההרשאות של `ops.systems`)
  - `src/policy/engine.ts` (שלב 3)
  - `src/orchestrator/run-plan.ts` (`classifyStep`, `targetIdOf`)
  - `src/orchestrator/channels.ts` (היעד של `ext.*` הוא `input.system`)
  - `src/policy/positive-controls.test.ts`

**ממשקים — מה המשימה מייצרת:**
- `resolveExternalCall(systems: readonly ExternalSystem[], toolName: string, input: Record<string, unknown>) → { ok: true; system: ExternalSystem; op: ExternalOperation; actionClass: ActionClass } | { ok: false; reason: string }`.
  - קורא רק מפתחות משלו: `system` ו-`operation`.
  - `ext.read` מקבל רק `kind:'read'`; `ext.call` מקבל רק `change`, `delete` או `money`.
- קוד דחייה חדש: `DENY_CODES.externalOperationUnknown = 'external_operation_unknown'`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - `resolveExternalCall` מחזיר את המחלקה החתומה לכל סוג.
  - מחזירים `ok:false`: מערכת לא מוכרת, פעולה לא מוכרת, שם פעולה `constructor` או `__proto__`, ואי-התאמה בין סוג לכלי.
  - **מבחני שער** (עם באנדל שמחזיק את `crmFixture()`):
    - `ext.call` שנוקב בפעולה לא מוכרת נדחה ב-`external_operation_unknown`, ולא נכתבת שורת `audit_log`.
    - `ext.call` על פעולת `change`, תחת מתג `off` ובלי ציווי מאושר, נדחה בשלב 8. נכתבת שורת `intent_to_act`, ו-`facts.actionClass === 'crm.write'`.
    - אותה קריאה תחת ציווי בוס מאושר מותרת, עם הסמן `confirmed_command_exemption`.
  - `classifyStep` והשער מסכימים על כל פעולה ב-fixture: לולאה אחת שבודקת שוויון.
  - **בקרות חיוביות:** `ext.read` ו-`ext.call` נמצאים ב-`OUTBOUND_TOOLS` וב-`KNOWN_TOOL_NAMES`, ואינם ב-`READ_ONLY_TOOLS`.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.**
  - **במנוע:** מיד אחרי בדיקות ההרשאה של שלב 3 ולפני `buildFacts`, לכל `ext.*` לקרוא ל-`resolveExternalCall(ctx.bundle.externalSystems, …)`.
    - על `ok:false` לדחות.
    - אחרת, מיד אחרי `buildFacts`, לדרוס את `facts.actionClass` במחלקה החתומה.
    - הערה בסגנון של בדיקת ההאצלה.
  - **בתוכנית:** `classifyStep` משתמש באותה פונקציה, עם הבאנדל של הריצה.
- [ ] **צעד 4:** להריץ את המבחנים שלמעלה ועוד את `src/policy`, `src/charter` ו-`src/orchestrator/run-plan.test.ts`. **צפוי:** עובר.
- [ ] **צעד 5:** להריץ `/security-review` על השינוי, ולתקן ממצאים בביטחון 8 ומעלה.
- [ ] **צעד 6: שמירה (commit):** `feat(policy): ext.read/ext.call classified from the signed operation`.

### משימה 4: בונה הבקשות

**קבצים:**
- **ליצור:** `src/external/request.ts`, `src/external/request.test.ts`

**ממשקים — מה המשימה מייצרת:**
- `buildExternalRequest(system, op, input: { params?: Record<string, unknown>; amountMinor?: number }, idempotencyKey: string) → { ok: true; method; url: URL; headers: Record<string,string>; body: string | null } | { ok: false; code: 'bad_params'; message: string }`.
  - הכותרות לא כוללות את ההזדהות; משימה 6 מוסיפה אותה.
- `MAJOR_DIVISOR = 100`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **קידוד נתיב:**
    - `{id}` עם `'../admin?x=1#y'` נותן את הנתיב `/customers/..%2Fadmin%3Fx%3D1%23y`.
    - המקור (origin) של הכתובת תמיד שווה לזה של `baseUrl`.
  - **פרמטרים שמחזירים `bad_params`:** פרמטר חובה חסר, פרמטר שהפעולה לא הצהירה עליו, וערך שאינו סקלרי בנתיב או ב-query.
  - **כסף:**
    - `amountMinor: 12345` עם יחידה `major` נותן בגוף JSON את `amount: 123.45`.
    - עם יחידה `minor` נשלח `12345`.
    - פעולת כסף בלי `amountMinor`, או עם `params.amount`, מחזירה `bad_params`.
  - **שונות:**
    - `GET` לא שם פרמטרים מסוג `in:'body'` בשום מקום, ומסרב להם.
    - כותרת ה-idempotency נקבעת רק כש-`idempotencyHeader` אינו null.
    - עם `bodyEncoding: 'form'` נשלח `application/x-www-form-urlencoded`, והסכום נשלח כמחרוזת (`123.45`). ערך שהוא אובייקט או מערך מסורב.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.**
  - כל ערך נתיב עובר `encodeURIComponent`.
  - ערכי query נבנים ב-`URLSearchParams`.
  - הגוף הוא `JSON.stringify` של פרמטרי הגוף ועוד שדה הסכום, או `URLSearchParams` שלהם כש-`bodyEncoding` הוא `'form'`, עם `Content-Type` מתאים.
- [ ] **צעד 4:** להריץ. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): request builder — encoded segments, declared params, one amount`.

### משימה 5: לקוח HTTPS מוגן

**קבצים:**
- **ליצור:** `src/external/http.ts`, `src/external/address-guard.ts`, `src/external/address-guard.test.ts`, `src/external/http.test.ts`

**ממשקים — מה המשימה מייצרת:**
- `isForbiddenAddress(ip: string) → boolean`.
- הממשק `ExternalHttp`: `send(req: { method; url: URL; headers; body: string|null; deadlineMs: number; maxBytes: number }) → Promise<{ kind: 'response'; status: number; body: string } | { kind: 'refused_address' } | { kind: 'too_large' } | { kind: 'network'; sent: boolean } | { kind: 'timeout'; sent: boolean }>`.
- `createGuardedHttps(): ExternalHttp`.
- קבועים: `EXTERNAL_DEADLINE_MS = 30_000`, `EXTERNAL_MAX_BYTES = 1_048_576`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **כתובות אסורות** (`isForbiddenAddress` מחזיר true):
    - `127.0.0.1`, `10.1.2.3`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`
    - `::1`, `fe80::1`, `fd00::1`, `::ffff:10.0.0.1`, `ff02::1`
  - **כתובות מותרות** (`isForbiddenAddress` מחזיר false): `8.8.8.8` ו-`2001:4860:4860::8888`.
  - **מבחני רשת:** מול שרת מקומי של `https.createServer`, עם תעודה בחתימה עצמית שמוזרקת דרך אפשרות `tls` למבחנים בלבד:
    - חיבור דרך שם שנפתר ל-127.0.0.1 מחזיר `refused_address`. זה מוכיח שהשומר רץ בתוך `lookup`.
    - כשהשומר מוזרק כמתירני (נקודת הזרקה למבחנים), חוזר `response`.
    - 302 חוזר כ-`response` עם סטטוס 302, ולא עוקבים אחריו.
    - גוף גדול מ-`maxBytes` מחזיר `too_large`.
    - שרת שלא עונה מחזיר `timeout` עם `sent: true`.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש** עם `https.request(url, { lookup: guardedLookup, … })`.
  - `guardedLookup` קורא ל-`dns.lookup(host, { all: true })` ומסרב אם **אחת** הכתובות אסורה.
  - הדדליין נאכף במירוץ ועם `req.destroy()`, לא ב-`AbortSignal` בלבד.
  - `sent` נדלק כשכתיבת הבקשה הסתיימה.
- [ ] **צעד 4:** להריץ. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): guarded https — post-DNS address check, no redirects, caps`.

### משימה 6: המתאם למערכת חיצונית ורישומו

**קבצים:**
- **ליצור:** `src/orchestrator/adapters/external.ts`, `src/orchestrator/adapters/external.test.ts`, `src/external/extract.ts`, `src/external/extract.test.ts`
- **לשנות:**
  - `src/orchestrator/runtime.ts`: ב-`businessRuntime`, לרשום מתאם אחד לכל מערכת חתומה מהתקנון הפעיל, בלי לכתוב שום binding.
  - `src/orchestrator/execute.ts`: על `ext.read` מוצלח, לקרוא ל-`recordExternalRead` באותה טרנזקציה של השלמת הצעד.
  - `src/config.ts` ו-`.env.example`: `EXTERNAL_CALLS_PER_DAY`, ברירת מחדל 200.

**ממשקים:**
- **צורכת:**
  - `buildExternalRequest` (משימה 4)
  - `ExternalHttp` (משימה 5)
  - `countCallsToday`, `recordCall` ו-`recordExternalRead` (משימה 2)
  - `resolveExternalCall` (משימה 3)
- **מייצרת:**
  - `extractFields(json: unknown, fields: readonly ExternalField[]) → {label: string; value: string}[]`.
    - כל ערך עובר `stripBidiControls` ו-`toOneLine`, ונחתך ב-500 תווים.
    - נתיב שאינו קיים מושמט.
  - `createExternalAdapter(system, deps: { http: ExternalHttp; callsToday: (systemId) => Promise<number>; recordCall: (...) => Promise<void>; capPerDay: number }) → ExternalAdapter`.
    - `system: 'ext:'+id`, `channel: 'api'`, `serves: ['ext.call','ext.read']`.
    - תוצאה מוצלחת: `output: { fields }`, ו-`externalId` נלקח מ-`idPath`.

**טבלת התוצאות** (כל קוד ממופה למשפט עברי ב-`FAILURE_REASON_HE`):

| מצב | קוד | אפשר לנסות שוב? |
|---|---|---|
| אין סוד | `credential_unavailable` | לא, סופי |
| התקרה היומית מוצתה | `external_daily_cap` | כן |
| פרמטרים לא תקינים | `bad_params` | לא, סופי |
| כתובת אסורה | `external_address_refused` | לא, סופי |
| 2xx | הצלחה | — |
| 401/403 | `external_auth` | לא, סופי |
| קריאה עם 429/5xx | — | כן |
| כתיבה עם 429/503 | — | כן |
| כתיבה עם 5xx אחר | `delivery_unknown` | לא, סופי |
| 4xx אחר | `external_rejected` | לא, סופי |
| פקיעת זמן | `adapter_timeout` | — |
| תקלת רשת עם `sent: false` | — | כן |
| תקלת רשת עם `sent: true` בכתיבה | `delivery_unknown` | לא |

המתאם לעולם לא מכניס טקסט של הספק ל-`message`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים**, עם `ExternalHttp` מדומה:
  - כל שורה בטבלת התוצאות.
  - כותרת `Authorization` היא `Bearer <secret>`, `Basic base64(secret)` או הכותרת שהוגדרה.
  - הסוד לא מופיע ב-`message`, ב-`output` או ב-`canonicalJson` של התוצאה.
  - `extractFields` על נתיבים מקוננים ועל מערכים (`items.0.name`).
  - צעד `ext.read` שהושלם כותב שורת `external_reads` אחת, וה-`fields` שלה שווים לפלט.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.** `recordCall` רץ על כל ניסיון שהגיע ל-`http.send`.
- [ ] **צעד 4:** להריץ, ועוד את `src/orchestrator`. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): adapter — auth from vault, outcome table, declared fields only`.

### משימה 7: ההד בשאלת האישור והקטלוג של המתכנן

**קבצים:**
- **לשנות:**
  - `src/orchestrator/command-echo.ts`: `renderStepEcho` מקבל פרמטר חובה `systems: readonly ExternalSystem[]`, ושני הקוראים מעבירים `bundle.externalSystems`.
  - `src/orchestrator/catalogue.ts`, `src/sdk/planner.ts`, והמבחנים שלהם.

**ממשקים — מה המשימה מייצרת:**
- `renderExternalCatalogue(systems) → string`:
  - פרק ממוין בלי חותמות זמן.
  - לכל מערכת: מזהה ותווית.
  - לכל פעולה: שם, תווית, סוג, תווית מחלקה בעברית, כלי (`ext.read` או `ext.call`), ופרמטרים עם `required`.
  - מרונדר בפרומפט של המתכנן מיד אחרי קטלוג היכולות.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **ההד של צעד `ext.call` מציג:**
    - את תווית הפעולה בעברית ואת תווית המחלקה.
    - את השורה `שיטה וכתובת: POST https://api.example.com/customers/42`, כלומר בדיוק הכתובת ש-`buildExternalRequest` היה מייצר.
    - כל פרמטר בשורה משלו.
    - `סכום` דרך `formatMinor`, במטבע של התקנון.
  - **צעד שבניית הבקשה שלו נכשלת** מסורב כבר בזמן התכנון, עם ההודעה העברית של הבונה. הוא לא מוצג חלקית.
  - **הקטלוג:**
    - `renderExternalCatalogue` זהה בבייט בין שתי קריאות.
    - בפרומפט של המתכנן הוא בא לפני פרק ה-intents או ההוראה.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.** `planAndCheck` (ב-`instruct.ts`) מריץ את `buildExternalRequest` על כל צעד `ext.*`, ופוסל את התוכנית על `ok:false`. זה אותו דפוס שבו צעדי הפנקס נבדקים מראש.
- [ ] **צעד 4:** להריץ. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): echo shows the exact request; planner sees signed operations`.

### משימה 8: הדיווח על מה שקריאה החזירה

**קבצים:**
- **לשנות:** `src/orchestrator/whatsapp-report.ts`, `src/dashboard/views.ts` (תוצאת ההוראה), והמבחנים שלהם

**ממשקים:**
- **צורכת:** `loadReadsForJob` (משימה 2).
- **מייצרת:** `renderReadsForOwner(reads: ReadRow[]) → string`, טקסט בעברית:
  - בלוק לכל קריאה, שכותרתו `מ<תווית המערכת> — <תווית הפעולה>:`.
  - אחריה שורות `label: value`.
  - עד 40 שורות בסך הכול. אם יש יותר, שורה אחרונה אומרת כמה נחתכו.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - משימת ציווי בוס שנסגרה עם `ext.read` אחד מדווחת `בוצע לפי אישורך.` ואחריה השדות המרונדרים.
  - ערך שנושא U+202E מוצג כשהתו מוסר.
  - משימה בלי קריאות מדווחת בדיוק כמו קודם, בייט בבייט.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5: שמירה (commit):** `feat(external): the owner sees what a read returned`.

### משימה 9: פאנל המנהל — טיוטות וסודות

**קבצים:**
- **ליצור:** `src/admin/external-routes.ts`, `src/admin/external-routes.test.ts`
- **לשנות:**
  - `src/admin/server.ts`: נתיבים.
  - `src/admin/business-routes.ts`: מחליפים את "ייבנה בשלב הבא" בקישור וברשימת סטטוסים.
  - `src/tenancy/activity-log.ts`: `external_draft_saved`, `external_draft_deleted`, `external_secret_saved`.
  - `src/tenancy/panel-reads.ts`: לכל מערכת סטטוס `טיוטה` / `ממתין לחתימה` / `חתום` / `שינויים לא חתומים`, ועוד `סוד ✓/חסר` ו-`חתימת התראות ✓/חסר`.
  - `src/tenancy/panel-reads-invariants.test.ts`.

**ממשקים — נתיבים:**
- `GET /businesses/:id/external`.
- `GET /businesses/:id/external/:system`: תיבת טקסט עם JSON הטיוטה או תבנית ריקה, ותצוגה מקדימה בעברית.
- `POST …/save`, `POST …/delete`.
- `POST …/secret`, עם `kind=key|hook|verify` ו-`value`:
  - כותב `putSecret` תחת `externalSecretRefs(id)`.
  - לעולם לא מחזיר את הערך.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - JSON לא תקין, או JSON שלא עובר את `ExternalSystem`, מוצג מחדש עם הודעות zod בעברית לפי נתיב, ושום דבר לא נכתב.
  - שמירה תקינה כותבת את הטיוטה ועוד שורה אחת ב-`platform_activity_log`. ה-`detail` שלה מחזיק רק את מספר הפעולות ודגל אחד, ומבחן מוודא שטקסט ההגדרה לא שם.
  - שמירת סוד מאחסנת אותו. העמוד מציג `✓ שמור` ולעולם לא את הערך.
  - הסטטוס של הגדרה שזהה לחתומה הוא `חתום`; של הגדרה שונה, `שינויים לא חתומים`.
  - מחרוזת בדיקה (PROBE) שנזרעה בשורת `external_events` אינה מוחזרת מאף קריאה של הפאנל. מרחיבים את סריקת ה-PROBE הקיימת.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5: שמירה (commit):** `feat(admin): external system drafts and secrets`.

### משימה 10: בעל העסק חותם, משנה ומסיר מערכת

**קבצים:**
- **ליצור:** `src/charter/amend-external.ts`, `src/charter/amend-external.test.ts`, `src/dashboard/external-connect.ts`, `src/dashboard/external-connect.test.ts`
- **לשנות:** `src/dashboard/server.ts` (נתיבים תחת `/connections/external`), עמוד החיבורים (קישור)

**ממשקים — מה המשימה מייצרת:**
- **בוני תיקונים:**
  - `buildExternalAmendment(active, def, now) → UnsignedCharter`: מוסיף או מחליף את המערכת ואת חיבור ה-`ext:<id>` שלה. כל שדה אחר מועתק מילה במילה.
  - `buildExternalRemoval(active, systemId, now)`.
- **`describeExternalSystem(def, currency) → string[]`:** משפטים בעברית, אחד לכל פעולה, בצורה `העוזרת תוכל: <תווית> (<תווית סוג>)`.
  - לפעולות כסף נוסף `— רק אחרי "כן" שלך`.
  - בסוף נוספות שורות על התראות וסריקה.
- **נתיבים:**
  - `GET /connections/external`.
  - `GET /connections/external/:system/sign`: הגיבוב של ההגדרה שהוצגה נשמר בשדה נסתר.
  - `POST …/sign`:
    - בונה מחדש מהטיוטה השמורה ומשווה את הגיבוב.
    - אז, בטרנזקציה אחת: `installSigned` ועוד `upsertBinding({ system: 'ext:'+id, status: 'live', credentialRef: EXT_<ID>_KEY, endpoint: null, provider: null })`.
    - אחר כך `deleteDraft`.
  - `POST …/remove`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **התיקון:** מעתיק כל שדה שאינו חיבור, בייט בבייט.
  - **חתימה:**
    - עם `base` ישן מחזירה 409, ושום דבר לא מותקן.
    - על טיוטה שנערכה בין ההצגה לשליחה (אי-התאמה בגיבוב) מציגה את התצוגה החדשה, ולא חותמת דבר.
    - אחרי החתימה, `resolveChannel(bundle, bindings, 'ext.call', id)` נפתר.
  - **הסרה:** אחריה המערכת לא נפתרת יותר. הסודות שלה נשארים, והעמוד אומר זאת.
  - **לפני חתימה:** הגדרה שקיימת רק כטיוטה גורמת לשער לדחות `ext.call` ב-`external_operation_unknown`.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5: שמירה (commit):** `feat(external): owner signs, changes and removes an external system`.

### משימה 11: קבלת התראות (webhook)

**קבצים:**
- **ליצור:** `src/external/webhook.ts`, `src/external/webhook.test.ts`
- **לשנות:** `src/dashboard/server.ts`: הנתיב, לפני שער הסשן ושער "אין תקנון"

**ממשקים — מה המשימה מייצרת:**
- `handleExternalWebhook(req, res, deps: { secrets; now })`.
- **קריאת הגוף:** הגוף הגולמי נקרא עם תקרה של 256KB (`readBoundedBody`). מעליה, 413.
- **בדיקות, לפי הסדר:**
  1. העסק רשום ופעיל: `resolveBusinessForHook`, קריאה חדשה **בשם** ב-`src/tenancy/platform.ts`. היא נוספת לרשימה הסגורה ב-CLAUDE.md.
  2. בתוך `withBusiness`, המערכת קיימת בתקנון הפעיל עם `webhook !== null`.
  3. `EXT_<ID>_HOOK` נפתר.
  4. החתימה תקפה, באחת משתי דרכים:
     - HMAC-SHA256 על המטען החתום, כלומר התבנית ממולאת בחותמת הזמן ובבייטים הגולמיים של הגוף. ההשוואה בזמן קבוע, אחרי הסרת התחילית או קריאת הערך מהצמד מפתח-ערך.
     - כותרת סוד משותף, בהשוואת `timingSafeEqual`.

     חותמת זמן מחוץ ל-±300 שניות נחשבת כשל.
  5. לחיצת יד, אם הוגדרה:
     - **`query_challenge` (בקשת GET):** נענית (200, ‏`text/plain`, ‏`nosniff`) רק כשה-mode תואם והאסימון שווה ל-`EXT_<ID>_VERIFY` בהשוואה בזמן קבוע.
     - **`body_challenge` (בקשת POST):** נענית רק אחרי שבדיקה 4 עברה, וכש-`body[typePath] === typeValue`.
     - **בשני המקרים:** ה-challenge חייב להתאים ל-`^[A-Za-z0-9._-]{1,200}# שלב ד' — מערכות חיצוניות: תוכנית בנייה

> תרגום עברי של [2026-11-18-external-systems.md](2026-11-18-external-systems.md). שמות בקוד, נתיבים ופקודות נשארו באנגלית. אם יש סתירה בין השניים, הקובץ האנגלי הוא שהבונים עובדים לפיו.

**המטרה:** איש הצוות הטכני מגדיר בפאנל המנהל חיבור כללי ל-API מוצפן (HTTPS) של עסק, ובעל העסק חותם עליו בתקנון. מאותו רגע העוזרת:
- **פועלת במערכת:** קוראת ממנה ופועלת בה **רק על ציווי בוס שאושר**.
- **לומדת ממנה:** מההתראות שהמערכת שולחת ומהסריקה היומית.
- **מדווחת:** על מה שקראה ומה שעשתה.

כל זה בלי שום פטור חדש בשער ההרשאות.

**הארכיטקטורה:**
- **מבנה בתקנון:** מערכת חיצונית היא אובייקט חתום בתקנון (`externalSystems[]`), ולצידה חיבור רגיל אחד (`CharterConnection`) לכל מערכת. ה-`target` של החיבור הוא מזהה המערכת, כך שבחירת הערוץ וה-bindings עובדים בלי שינוי.
- **שני כלים חדשים:** `ext.read` ו-`ext.call`, בבעלות `ops.systems`. שניהם מסווגים ושניהם יוצאים החוצה.
- **מחלקת הפעולה של קריאה:** נקראת **מהפעולה החתומה**, ולעולם לא מהמטען או מהמודל.
- **מידע נכנס (התראות, סריקות, קריאות):**
  - הוא מצומצם בקוד, בלי מודל, רק לשדות שההגדרה מצהירה עליהם.
  - הוא נשמר כ-`unknown_external`.
  - הסיכום שלו נכתב בלי מודל.
  - מה שנשמר ממנו לזיכרון הוא `chunk` בלבד.

**טכנולוגיות:**
- TypeScript (NodeNext, ESM) ו-zod 4.
- pg עם RLS.
- vitest על Postgres אמיתי.
- `node:https`, בלי תלות חדשה.

**המפרט:** [docs/superpowers/specs/2026-11-13-external-systems-design.md](../specs/2026-11-13-external-systems-design.md). זה כולל את תשובות הבעלים מ-13/11, שגוברות על כל מה שכתוב מעליהן באותו קובץ.

## אילוצים גלובליים

- **השער לא מקבל פטור חדש.** ב-`src/policy/engine.ts` השינוי היחיד הוא הפתרון בשלב 3 (משימה 3), והוא עובר `/security-review`.
- **פעולה חיצונית רצה רק תחת `confirmedCommandCovers`:** ציווי בוס ועוד "כן" אחד. שום מסלול של המנצח, סריקה או התראה לא יוצר משימה עם צעד `ext.*`.
- **פעולות כסף:** סוג `money` ממופה רק למחלקה `payment.make` או `refund.issue`. פעולה כזו לעולם אינה רצה בלי "כן" מפורש של הבוס, בכל מצב.
- **מה המודל יכול לקבוע:** הכתובת, השיטה, הנתיב והמחלקה באים מההגדרה החתומה. המודל ממלא רק את `params`, ובפעולת כסף גם את `amountMinor`. כולם מוצגים במלואם בשאלת האישור.
- **רשת:**
  - HTTPS בלבד.
  - מסרבים לכתובות פרטיות, loopback, link-local, CGNAT, ULA, multicast, unspecified ו-metadata של ענן.
  - הבדיקה נעשית **אחרי פתרון DNS**, על ה-socket שבאמת נמצא בשימוש.
  - לעולם לא עוקבים אחרי הפניה (redirect).
- **סודות:**
  - נשמרים רק במאגר של העסק (`putSecret`), תחת `EXT_<ID>_KEY` ו-`EXT_<ID>_HOOK`, כש-`<ID>` הוא מזהה המערכת באותיות גדולות.
  - לעולם לא מופיעים בהגדרה, בתקנון, בפרומפט, בלוג, בשורת ביקורת, בפאנל או בדשבורד.
- **מידע מבחוץ:** כל מה שנקרא מבחוץ הוא `unknown_external`. מה שנכתב ממנו לזיכרון הוא `chunk` בלבד, ולעולם לא גורע עובדה קיימת.
- **בידוד המדיניות:** אף שורה ב-`src/policy/` לא קוראת דבר מתוך תשובה חיצונית, כולל סכומים. זה אותו כלל שחל על `findings`.
- **גרסת התקנון:** `CURRENT_SCHEMA_VERSION` עולה ל-`'1.4'`, וכל תקנון חתום חייב להיחתם מחדש. זה צפוי, לא באג.
- **שפה:** עברית לבעלים ולאיש הצוות, אנגלית בקוד. שמות מחלקות מוצגים לבעלים רק דרך `src/domain/labels.ts`.
- **טבלאות חדשות:** לכל אחת `business_id`, RLS עם `FORCE` והמדיניות הרגילה של `app_business_id()`, ושלושתם נוצרים במיגרציה של הטבלה.
- **בדיקות שלא הורצו:** כל בדיקה חיה שנבנתה ולא הורצה נכנסת ל-`docs/11-pre-launch-checks.md`.

## הכרעות שקיבלתי בזמן התכנון (⚙ — שלי, לא של הבעלים)

1. **ההגדרה נכתבת כ-JSON:** איש הצוות מדביק את ההגדרה **כ-JSON בתיבת טקסט**. zod מאמת אותה, השגיאות מוצגות בעברית, ואיש הצוות רואה תצוגה מקדימה בעברית. טופס דינמי ל-N פעולות הוא הרבה ממשק בלי תוספת בטיחות, ו-JSON נותן את הגמישות שהבעלים ביקש. *המחיר אם טעיתי:* לבנות טופס בהמשך; הסכמה נשארת כמו שהיא.
2. **גם קריאה שואלת "כן" אחד.** במתג ברירת המחדל, `off`, הרמפה מחזיקה את `external.read` ב-`draft_only`, ולכן ציווי מאושר הוא המסלול היחיד שבכלל יכול להריץ קריאה. *המחיר:* מילה אחת נוספת לכל שאילתה.
3. **התשובות מצומצמות בקוד:** לכל פעולה ולכל סוג התראה מוצהרים עד 20 שדות (`fields`), כל אחד עם נתיב JSON ותווית בעברית. רק הם נשמרים, מוצגים ונלמדים; שום דבר אחר מהתשובה לא נשמר. *המחיר:* איש הצוות צריך לנקוב בשדות, ושדה שלא נקב בו לא ייראה בכלל.
4. **הסיכום לבוס** על ההתראות והסריקות הוא פרק בתדריך היומי/השבועי, ועוד מסך `/systems`. אין ערוץ הודעות חדש. *המחיר:* בעלים שמשאיר את התדריך כבוי רואה את הסיכום רק במסך. זה נאמר במסך וב-docs/10.
5. **ניסיון חוזר:**
   - **כתיבה** שקיבלה 429 או 503 אפשר לנסות שוב.
   - **כתיבה במצב לא ברור:** 5xx אחר, תקלת רשת אחרי שהבקשה נשלחה, או פקיעת זמן, היא `delivery_unknown` או `adapter_timeout`. היא סופית ולא נשלחת שוב בעיוורון.
   - **קריאה** מנסים שוב על כל 429 או 5xx.
6. **יחידות כסף:**
   - רק שקל, דולר, אירו ולירה שטרלינג (שתי ספרות אחרי הנקודה).
   - המטבע חייב להיות זהה לזה של התקנון.
   - ב-`unit: 'major'` נשלח `amountMinor / 100` כמספר JSON.
7. **מותר לחתום לפני שהסוד נשמר.** הסטטוס מציג "חסר סוד", וכל קריאה נכשלת ב-`credential_unavailable` עד שהסוד יישמר.
8. **נקודת קבלת ההתראות** יושבת על שרת הדשבורד (מאחורי ה-proxy), בכתובת `POST /hooks/ext/<businessId>/<systemId>`. אין בה סשן, והאימות נעשה בסוד. סוגי אירועים לא מוכרים נספרים ונזרקים.
9. **הסריקה היומית היא עקיפת שער מתועדת.** היא מצטרפת לרשימה הקצרה: תיוג המייל, האוצר, המחיקה ושמירות המקום ביומן. המפרט דורש סריקה, ודרך השער במצב `off` היא לא הייתה קוראת דבר.
   - **מה מחזיק אותה במקום השער:**
     - היא יכולה להריץ רק את פעולת ה-`read` האחת שבעל העסק חתם עליה כ-`scan`.
     - היא רצה רק במרווח החתום.
     - היא עוברת דרך אותו בונה בקשות, אותו שומר כתובות ואותה תקרה יומית.
     - מה שהיא קוראת רק מלמד.
   - *המחיר אם טעיתי:* סריקה חתומה שקוראת מידע שבעל העסק לא ציפה לו.
   - *ההקלה:* עמוד החתימה אומר את זה במילים.

10. **שלוש תוספות כדי שיותר מערכות אמיתיות ייכנסו (הבעלים, 18/11):**
    - **חתימת התראה עם תחילית ו/או חותמת זמן:** פותחת את Stripe, ‏GitHub ו-Slack.
    - **גוף בקשה כטופס** (form-encoded).
    - **לחיצת היד באימות הראשון של התראות:** פותחת את Meta ו-Slack.

    אף אחת מהן לא מרפה דבר:
    - החתימה עדיין מחושבת על הבייטים הגולמיים עם סוד מהמאגר.
    - חותמת הזמן מוסיפה הגנה מפני שידור חוזר (±300 שניות).
    - תשובה ללחיצת יד מוחזרת רק אחרי בדיקת האסימון או החתימה, כטקסט רגיל, עד 200 תווים מתוך `[A-Za-z0-9._-]`.

    *מה עדיין בחוץ:* OAuth, ‏XML/SOAP, סריקה של כמה עמודים, וחתימת בקשות בסגנון AWS.

## מוקדי סקירה

1. **ערך פרמטר שמכיל `../`, `?`, `#` או `%2F`** לא משנה את הנתיב. כל ערך מקודד כמקטע נתיב יחיד. ממלא-מקום בתבנית בלי פרמטר תואם הוא סירוב, לא מקטע ריק.
2. **שם DNS שנפתר ל-`127.0.0.1`, `169.254.169.254`, `::ffff:10.0.0.1` או `fd00::1`**, או שמשנה כתובת בין הבדיקה לחיבור, מסורב. הבדיקה רצה בתוך ה-`lookup` של ה-socket עצמו.
3. **צעד בתוכנית שנוקב בפעולה מהסוג הלא נכון לכלי שלו** מסורב בשלב 3, ולעולם לא מסווג כמשהו מקל יותר. זה חל על:
   - פעולת `money` תחת `ext.read`.
   - פעולת `read` תחת `ext.call`.
   - מערכת לא מוכרת או פעולה לא מוכרת.
4. **התראה שהגוף שלה JSON תקין, אבל החתימה חושבה על בייטים אחרים** (סודר מחדש, רווחים שונו), מסורבת. ה-HMAC מחושב על הבייטים הגולמיים.
5. **קריאת כסף שגם ה-`params` שלה נושאים את שדה הסכום** מסורבת. אחרת היו בה שני סכומים, אחד שמוצג ואחד שנשלח. כך הסכום שבעל העסק ראה הוא היחיד שיכול להגיע לספק.

---

### משימה 1: סכמת תקנון 1.4 — מערכות חיצוניות ושתי מחלקות חדשות

**קבצים:**
- **ליצור:** `src/domain/external-system.ts`, `src/domain/external-system.test.ts`
- **לשנות:**
  - `src/domain/action.ts`: ה-enum, `NEVER_FULLY_AUTONOMOUS_TABLE` וטבלת הנמענים
  - `src/domain/charter.ts`: השדה, בדיקת הצימוד, וגרסה `'1.4'` עם שורת docblock
  - `src/domain/labels.ts`
  - `src/charter/schema-version.test.ts`
  - `src/charter/interview/build.ts`: בסיס האוטונומיה לשתי המחלקות
  - `src/test/fixtures.ts`
  - `src/charter/compile.ts` ו-`src/domain/policy.ts`: העברת `externalSystems` לבאנדל

**ממשקים — מה המשימה מייצרת:**
- `ExternalSystem` (zod + טיפוס), `ExternalOperation`, `ExternalField`, ו-`OperationKind = 'read'|'change'|'delete'|'money'`.
- `EXTERNAL_SYSTEM_ID = /^[a-z][a-z0-9_]{1,30}$/`.
- `externalSecretRefs(id) → { key: string; hook: string; verify: string }`, שמחזיר `EXT_<ID>_KEY`, ‏`EXT_<ID>_HOOK` ו-`EXT_<ID>_VERIFY`. האחרון נחוץ רק ללחיצת יד מסוג `query_challenge`, שאסימון האימות שלה אינו סוד החתימה.
- `CHANGE_CLASSES = ['crm.write','accounting.write','quote.issue','commitment.make','data.export'] as const`.
- `MONEY_CLASSES = ['payment.make','refund.issue'] as const`.
- `PolicyBundle.externalSystems: ExternalSystem[]`.

**מבנה `ExternalSystem`:**
- **שדות בסיס:** `{ id, label (בעברית), baseUrl, auth, idempotencyHeader, operations, webhook, scan }`.
- **`baseUrl`:** `https:` בלבד, בלי פרטי משתמש, בלי query ובלי fragment.
- **`auth`:** אחד מ-`{ kind: 'header', header }`, `{ kind: 'bearer' }` או `{ kind: 'basic' }`.
- **`idempotencyHeader`:** שם כותרת או null.
- **`operations`:** 1–50 פעולות, כל אחת `{ name, label, kind, actionClass, method, path, params, fields, idPath, amount }`:
  - `name`: `/^[a-z][a-z0-9_]{1,40}$/`.
  - `path`: מתחיל ב-`/`, וממלאי-המקום כתובים `{param}`.
  - `params`: רשימת `{ name, in: 'path'|'query'|'body', required }`.
  - `bodyEncoding`: `'json'` (ברירת מחדל) או `'form'`.
  - `fields`: עד 20 רשומות `{ path: dotted, label }`.
  - `idPath`: נתיב שדה או null.
  - `amount`: `{ field, unit: 'minor'|'major', currency }` או null.
- **`webhook`:** `{ scheme, typePath, events: [{ type, label, fields }], handshake }` או null.
  - **`scheme`:** `{ kind: 'shared-secret', header }`, או `{ kind: 'hmac-sha256', encoding: 'hex'|'base64', signature, signedPayload, timestamp }`:
    - **`signature`:** אחת משתי צורות:
      - `{ from: 'header', header, prefix: string|null }`. ב-GitHub: `X-Hub-Signature-256` עם התחילית `sha256=`.
      - `{ from: 'kv', header, key, separator }`. ב-Stripe: `Stripe-Signature`, המפתח `v1` והמפריד `,`. מספיק ערך אחד תואם.
    - **`signedPayload`:** תבנית שיש בה רק `{timestamp}` ו-`{body}`, עם `{body}` פעם אחת בדיוק. דוגמאות: `'{body}'` (ברירת מחדל), `'{timestamp}.{body}'` (Stripe), `'v0:{timestamp}:{body}'` (Slack).
    - **`timestamp`:** null, `{ from: 'header', header }` (Slack) או `{ from: 'kv', key }` (ב-Stripe המפתח `t`).
      - חובה כשהתבנית משתמשת ב-`{timestamp}`.
      - בשניות unix, ועד ±300 שניות מעכשיו.
  - **`handshake`:** אחד משלושה:
    - null.
    - `{ kind: 'query_challenge', modeParam, modeValue, tokenParam, challengeParam }`: ב-Meta אלה `hub.mode` עם הערך `subscribe`, ‏`hub.verify_token` ו-`hub.challenge`. בקשת GET; האסימון מושווה ל-`EXT_<ID>_VERIFY`.
    - `{ kind: 'body_challenge', typeValue, challengePath }`: ב-Slack זה `url_verification`. בקשת POST, אחרי בדיקת החתימה.
- **`scan`:** `{ operation, sinceParam: string|null, itemsPath: string|null, everyHours: 1..168 }` או null.

**צעדים:**
- [ ] **צעד 1: לכתוב מבחנים שנכשלים** ב-`external-system.test.ts`.
  - **שילובי סוג ומחלקה שמסורבים:**
    - `kind:'read'` עם מחלקה שאינה `external.read`.
    - `kind:'delete'` עם מחלקה שאינה `external.delete`.
    - `kind:'change'` עם מחלקה מחוץ ל-`CHANGE_CLASSES`.
    - `kind:'money'` עם `purchase.place`.
  - **כסף, מה שמסורב:**
    - פעולת `money` בלי `amount`.
    - `amount.currency` שאינו ב-`['ILS','USD','EUR','GBP']`.
    - `field` של סכום שמופיע גם ב-`params`.
  - **כתובות בסיס שמסורבות:** `http://…`, `https://u:p@h`, `https://h/?q=1`.
  - **נתיבים ופרמטרים שמסורבים:**
    - ממלא-מקום בנתיב בלי פרמטר `in:'path'`.
    - פרמטר `in:'path'` בלי ממלא-מקום.
    - שמות פעולה כפולים.
    - `scan.operation` שאינה פעולת `read`.
    - סוג אירוע שמופיע פעמיים ב-`webhook.events`.
  - **מקובל:** ה-fixture `crmFixture()`, שמיוצא מ-`src/test/external-fixtures.ts`.
  - **התראות, מה שמסורב:**
    - `signedPayload` בלי `{body}`, עם `{body}` פעמיים, או עם ממלא-מקום אחר מלבד `{timestamp}` ו-`{body}`.
    - תבנית עם `{timestamp}` כש-`timestamp: null`.
    - `body_challenge` בלי `typePath`.
    - `bodyEncoding: 'form'` על פעולת `GET`.
  - **צימוד לתקנון** (ב-`charter.test.ts`, מבחן נפרד לכל חצי):
    - לכל `externalSystems[i]` יש בדיוק חיבור אחד עם `system === 'ext:'+id`, `serves` שהוא בדיוק `['ext.call','ext.read']`, `target === id` ו-`channel: 'api'`.
    - לכל חיבור שהמערכת שלו מתחילה ב-`ext:` יש הגדרה.
  - **מטבע:** פעולת כסף שהמטבע שלה שונה מ-`money.currency` מסורבת כבר בפריסה, עם הודעה בעברית.
- [ ] **צעד 2: להריץ** `npx vitest run src/domain/external-system.test.ts src/domain/charter.test.ts src/charter/schema-version.test.ts`. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.**
  - להוסיף את `external.read` (נמען `internal`, לא אוטונומית לעולם: `false`) ואת `external.delete` (`internal`, `true`).
  - תוויות: "קריאה ממערכת חיצונית" ו"מחיקה במערכת חיצונית".
  - ברירות מחדל בראיון: `external.read` ב-`auto`, `external.delete` ב-`approve_required`.
  - לעדכן את הרשימה הקפואה ב-`schema-version.test.ts`, להעלות ל-`'1.4'` עם פסקה ב-docblock, ולהעביר את `externalSystems` (ברירת מחדל `[]`) דרך `compileCharter`.
- [ ] **צעד 4: להריץ** את אותם מבחנים ועוד `npm run typecheck`. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(charter): schema 1.4 — external systems and external.read/external.delete`.

### משימה 2: מיגרציה 077 ופונקציות האחסון

**קבצים:**
- **ליצור:** `src/db/migrations/077_external_systems.sql`, `src/external/store.ts`, `src/external/store.test.ts`
- **לשנות:** `src/tenancy/rls.test.ts`, רק אם ספירת הטבלאות הצפויה בו נעוצה

**ממשקים — מה המשימה מייצרת (ב-`src/external/store.ts`):**
- `saveDraft(db, {systemId, definition, staffId}) → void` (upsert), `loadDrafts(db) → DraftRow[]`, `deleteDraft(db, systemId)`.
- `recordExternalRead(db, {jobId, stepId, systemId, operation, fields}) → void`, `loadReadsForJob(db, jobId) → ReadRow[]`.
- `insertEvent(db, {systemId, source:'webhook'|'scan', eventType, itemHash, fields}) → boolean` (false על כפילות), `newEventsSince(db, cursor) → EventRow[]`, `markEventsCurated(db, ids)`.
- `countCallsToday(db, systemId, timeZone) → number`, `recordCall(db, {systemId, outcome})`.
- `recordRejectedHook(db, systemId, reason)`, `lastScanAt(db, systemId)` / `setLastScanAt(db, systemId, at)`.
- בכולן `fields: {label: string; value: string}[]`.

**טבלאות:**
- `external_system_drafts (business_id, system_id, definition jsonb, updated_at, updated_by_staff text)`, מפתח ראשי `(business_id, system_id)`.
- `external_reads (business_id, read_id, job_id, step_id, system_id, operation, fields jsonb, created_at)`.
- `external_events (business_id, event_id, system_id, source, event_type, item_hash, fields jsonb, created_at, curated_at)`, ייחוד על `(business_id, system_id, item_hash)`.
- `external_calls (business_id, system_id, at, outcome)`, בלי תוכן.
- `external_system_state (business_id, system_id, last_scan_at, rejected_hooks int, last_rejected_at)`.
- עמודה חדשה `business_runtime_settings.external_curation_per_day int NULL`.
- על כל הטבלאות: RLS עם `FORCE` והמדיניות הרגילה.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים** ב-`store.test.ts`, דרך `withBusiness(TEST_BUSINESS, …)`:
  - `insertEvent` עם `item_hash` חוזר מחזיר false ומשאיר שורה אחת.
  - `countCallsToday` סופר מחצות מקומית באזור הזמן שנמסר, לא מחצות UTC.
  - שורה שנכתבה לעסק א' אינה נראית לעסק ב'.
- [ ] **צעד 2:** להריץ `npm run migrate:test` על הבסיס הייעודי, ואז את המבחן. **צפוי:** נכשל.
- [ ] **צעד 3:** לכתוב את המיגרציה ואת פונקציות האחסון, במוסכמת `interface XRow` ו-`toX`.
- [ ] **צעד 4:** להריץ את `store.test.ts` ואת `src/tenancy/rls.test.ts`. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): migration 077 — drafts, reads, events, call log`.

### משימה 3: סיווג — `ext.read`/`ext.call` והמחלקה החתומה

**קבצים:**
- **ליצור:** `src/policy/external-class.ts`, `src/policy/external-class.test.ts`
- **לשנות:**
  - `src/policy/classify.ts`:
    - ב-`TOOL_ACTION_CLASS`: `ext.read: 'external.read'`, ו-`ext.call: 'external.delete'` כממלא-מקום, כי זו המחמירה ביותר.
    - שני הכלים נכנסים ל-`OUTBOUND_TOOLS`.
    - ב-`ingestsExternalContent`: `ext.read: true` ו-`ext.call: false`.
  - `src/domain/charter.ts` (`KNOWN_TOOL_NAMES`)
  - `src/charter/capabilities.ts` (רשימת ההרשאות של `ops.systems`)
  - `src/policy/engine.ts` (שלב 3)
  - `src/orchestrator/run-plan.ts` (`classifyStep`, `targetIdOf`)
  - `src/orchestrator/channels.ts` (היעד של `ext.*` הוא `input.system`)
  - `src/policy/positive-controls.test.ts`

**ממשקים — מה המשימה מייצרת:**
- `resolveExternalCall(systems: readonly ExternalSystem[], toolName: string, input: Record<string, unknown>) → { ok: true; system: ExternalSystem; op: ExternalOperation; actionClass: ActionClass } | { ok: false; reason: string }`.
  - קורא רק מפתחות משלו: `system` ו-`operation`.
  - `ext.read` מקבל רק `kind:'read'`; `ext.call` מקבל רק `change`, `delete` או `money`.
- קוד דחייה חדש: `DENY_CODES.externalOperationUnknown = 'external_operation_unknown'`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - `resolveExternalCall` מחזיר את המחלקה החתומה לכל סוג.
  - מחזירים `ok:false`: מערכת לא מוכרת, פעולה לא מוכרת, שם פעולה `constructor` או `__proto__`, ואי-התאמה בין סוג לכלי.
  - **מבחני שער** (עם באנדל שמחזיק את `crmFixture()`):
    - `ext.call` שנוקב בפעולה לא מוכרת נדחה ב-`external_operation_unknown`, ולא נכתבת שורת `audit_log`.
    - `ext.call` על פעולת `change`, תחת מתג `off` ובלי ציווי מאושר, נדחה בשלב 8. נכתבת שורת `intent_to_act`, ו-`facts.actionClass === 'crm.write'`.
    - אותה קריאה תחת ציווי בוס מאושר מותרת, עם הסמן `confirmed_command_exemption`.
  - `classifyStep` והשער מסכימים על כל פעולה ב-fixture: לולאה אחת שבודקת שוויון.
  - **בקרות חיוביות:** `ext.read` ו-`ext.call` נמצאים ב-`OUTBOUND_TOOLS` וב-`KNOWN_TOOL_NAMES`, ואינם ב-`READ_ONLY_TOOLS`.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.**
  - **במנוע:** מיד אחרי בדיקות ההרשאה של שלב 3 ולפני `buildFacts`, לכל `ext.*` לקרוא ל-`resolveExternalCall(ctx.bundle.externalSystems, …)`.
    - על `ok:false` לדחות.
    - אחרת, מיד אחרי `buildFacts`, לדרוס את `facts.actionClass` במחלקה החתומה.
    - הערה בסגנון של בדיקת ההאצלה.
  - **בתוכנית:** `classifyStep` משתמש באותה פונקציה, עם הבאנדל של הריצה.
- [ ] **צעד 4:** להריץ את המבחנים שלמעלה ועוד את `src/policy`, `src/charter` ו-`src/orchestrator/run-plan.test.ts`. **צפוי:** עובר.
- [ ] **צעד 5:** להריץ `/security-review` על השינוי, ולתקן ממצאים בביטחון 8 ומעלה.
- [ ] **צעד 6: שמירה (commit):** `feat(policy): ext.read/ext.call classified from the signed operation`.

### משימה 4: בונה הבקשות

**קבצים:**
- **ליצור:** `src/external/request.ts`, `src/external/request.test.ts`

**ממשקים — מה המשימה מייצרת:**
- `buildExternalRequest(system, op, input: { params?: Record<string, unknown>; amountMinor?: number }, idempotencyKey: string) → { ok: true; method; url: URL; headers: Record<string,string>; body: string | null } | { ok: false; code: 'bad_params'; message: string }`.
  - הכותרות לא כוללות את ההזדהות; משימה 6 מוסיפה אותה.
- `MAJOR_DIVISOR = 100`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **קידוד נתיב:**
    - `{id}` עם `'../admin?x=1#y'` נותן את הנתיב `/customers/..%2Fadmin%3Fx%3D1%23y`.
    - המקור (origin) של הכתובת תמיד שווה לזה של `baseUrl`.
  - **פרמטרים שמחזירים `bad_params`:** פרמטר חובה חסר, פרמטר שהפעולה לא הצהירה עליו, וערך שאינו סקלרי בנתיב או ב-query.
  - **כסף:**
    - `amountMinor: 12345` עם יחידה `major` נותן בגוף JSON את `amount: 123.45`.
    - עם יחידה `minor` נשלח `12345`.
    - פעולת כסף בלי `amountMinor`, או עם `params.amount`, מחזירה `bad_params`.
  - **שונות:**
    - `GET` לא שם פרמטרים מסוג `in:'body'` בשום מקום, ומסרב להם.
    - כותרת ה-idempotency נקבעת רק כש-`idempotencyHeader` אינו null.
    - עם `bodyEncoding: 'form'` נשלח `application/x-www-form-urlencoded`, והסכום נשלח כמחרוזת (`123.45`). ערך שהוא אובייקט או מערך מסורב.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.**
  - כל ערך נתיב עובר `encodeURIComponent`.
  - ערכי query נבנים ב-`URLSearchParams`.
  - הגוף הוא `JSON.stringify` של פרמטרי הגוף ועוד שדה הסכום, או `URLSearchParams` שלהם כש-`bodyEncoding` הוא `'form'`, עם `Content-Type` מתאים.
- [ ] **צעד 4:** להריץ. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): request builder — encoded segments, declared params, one amount`.

### משימה 5: לקוח HTTPS מוגן

**קבצים:**
- **ליצור:** `src/external/http.ts`, `src/external/address-guard.ts`, `src/external/address-guard.test.ts`, `src/external/http.test.ts`

**ממשקים — מה המשימה מייצרת:**
- `isForbiddenAddress(ip: string) → boolean`.
- הממשק `ExternalHttp`: `send(req: { method; url: URL; headers; body: string|null; deadlineMs: number; maxBytes: number }) → Promise<{ kind: 'response'; status: number; body: string } | { kind: 'refused_address' } | { kind: 'too_large' } | { kind: 'network'; sent: boolean } | { kind: 'timeout'; sent: boolean }>`.
- `createGuardedHttps(): ExternalHttp`.
- קבועים: `EXTERNAL_DEADLINE_MS = 30_000`, `EXTERNAL_MAX_BYTES = 1_048_576`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **כתובות אסורות** (`isForbiddenAddress` מחזיר true):
    - `127.0.0.1`, `10.1.2.3`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`
    - `::1`, `fe80::1`, `fd00::1`, `::ffff:10.0.0.1`, `ff02::1`
  - **כתובות מותרות** (`isForbiddenAddress` מחזיר false): `8.8.8.8` ו-`2001:4860:4860::8888`.
  - **מבחני רשת:** מול שרת מקומי של `https.createServer`, עם תעודה בחתימה עצמית שמוזרקת דרך אפשרות `tls` למבחנים בלבד:
    - חיבור דרך שם שנפתר ל-127.0.0.1 מחזיר `refused_address`. זה מוכיח שהשומר רץ בתוך `lookup`.
    - כשהשומר מוזרק כמתירני (נקודת הזרקה למבחנים), חוזר `response`.
    - 302 חוזר כ-`response` עם סטטוס 302, ולא עוקבים אחריו.
    - גוף גדול מ-`maxBytes` מחזיר `too_large`.
    - שרת שלא עונה מחזיר `timeout` עם `sent: true`.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש** עם `https.request(url, { lookup: guardedLookup, … })`.
  - `guardedLookup` קורא ל-`dns.lookup(host, { all: true })` ומסרב אם **אחת** הכתובות אסורה.
  - הדדליין נאכף במירוץ ועם `req.destroy()`, לא ב-`AbortSignal` בלבד.
  - `sent` נדלק כשכתיבת הבקשה הסתיימה.
- [ ] **צעד 4:** להריץ. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): guarded https — post-DNS address check, no redirects, caps`.

### משימה 6: המתאם למערכת חיצונית ורישומו

**קבצים:**
- **ליצור:** `src/orchestrator/adapters/external.ts`, `src/orchestrator/adapters/external.test.ts`, `src/external/extract.ts`, `src/external/extract.test.ts`
- **לשנות:**
  - `src/orchestrator/runtime.ts`: ב-`businessRuntime`, לרשום מתאם אחד לכל מערכת חתומה מהתקנון הפעיל, בלי לכתוב שום binding.
  - `src/orchestrator/execute.ts`: על `ext.read` מוצלח, לקרוא ל-`recordExternalRead` באותה טרנזקציה של השלמת הצעד.
  - `src/config.ts` ו-`.env.example`: `EXTERNAL_CALLS_PER_DAY`, ברירת מחדל 200.

**ממשקים:**
- **צורכת:**
  - `buildExternalRequest` (משימה 4)
  - `ExternalHttp` (משימה 5)
  - `countCallsToday`, `recordCall` ו-`recordExternalRead` (משימה 2)
  - `resolveExternalCall` (משימה 3)
- **מייצרת:**
  - `extractFields(json: unknown, fields: readonly ExternalField[]) → {label: string; value: string}[]`.
    - כל ערך עובר `stripBidiControls` ו-`toOneLine`, ונחתך ב-500 תווים.
    - נתיב שאינו קיים מושמט.
  - `createExternalAdapter(system, deps: { http: ExternalHttp; callsToday: (systemId) => Promise<number>; recordCall: (...) => Promise<void>; capPerDay: number }) → ExternalAdapter`.
    - `system: 'ext:'+id`, `channel: 'api'`, `serves: ['ext.call','ext.read']`.
    - תוצאה מוצלחת: `output: { fields }`, ו-`externalId` נלקח מ-`idPath`.

**טבלת התוצאות** (כל קוד ממופה למשפט עברי ב-`FAILURE_REASON_HE`):

| מצב | קוד | אפשר לנסות שוב? |
|---|---|---|
| אין סוד | `credential_unavailable` | לא, סופי |
| התקרה היומית מוצתה | `external_daily_cap` | כן |
| פרמטרים לא תקינים | `bad_params` | לא, סופי |
| כתובת אסורה | `external_address_refused` | לא, סופי |
| 2xx | הצלחה | — |
| 401/403 | `external_auth` | לא, סופי |
| קריאה עם 429/5xx | — | כן |
| כתיבה עם 429/503 | — | כן |
| כתיבה עם 5xx אחר | `delivery_unknown` | לא, סופי |
| 4xx אחר | `external_rejected` | לא, סופי |
| פקיעת זמן | `adapter_timeout` | — |
| תקלת רשת עם `sent: false` | — | כן |
| תקלת רשת עם `sent: true` בכתיבה | `delivery_unknown` | לא |

המתאם לעולם לא מכניס טקסט של הספק ל-`message`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים**, עם `ExternalHttp` מדומה:
  - כל שורה בטבלת התוצאות.
  - כותרת `Authorization` היא `Bearer <secret>`, `Basic base64(secret)` או הכותרת שהוגדרה.
  - הסוד לא מופיע ב-`message`, ב-`output` או ב-`canonicalJson` של התוצאה.
  - `extractFields` על נתיבים מקוננים ועל מערכים (`items.0.name`).
  - צעד `ext.read` שהושלם כותב שורת `external_reads` אחת, וה-`fields` שלה שווים לפלט.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.** `recordCall` רץ על כל ניסיון שהגיע ל-`http.send`.
- [ ] **צעד 4:** להריץ, ועוד את `src/orchestrator`. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): adapter — auth from vault, outcome table, declared fields only`.

### משימה 7: ההד בשאלת האישור והקטלוג של המתכנן

**קבצים:**
- **לשנות:**
  - `src/orchestrator/command-echo.ts`: `renderStepEcho` מקבל פרמטר חובה `systems: readonly ExternalSystem[]`, ושני הקוראים מעבירים `bundle.externalSystems`.
  - `src/orchestrator/catalogue.ts`, `src/sdk/planner.ts`, והמבחנים שלהם.

**ממשקים — מה המשימה מייצרת:**
- `renderExternalCatalogue(systems) → string`:
  - פרק ממוין בלי חותמות זמן.
  - לכל מערכת: מזהה ותווית.
  - לכל פעולה: שם, תווית, סוג, תווית מחלקה בעברית, כלי (`ext.read` או `ext.call`), ופרמטרים עם `required`.
  - מרונדר בפרומפט של המתכנן מיד אחרי קטלוג היכולות.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **ההד של צעד `ext.call` מציג:**
    - את תווית הפעולה בעברית ואת תווית המחלקה.
    - את השורה `שיטה וכתובת: POST https://api.example.com/customers/42`, כלומר בדיוק הכתובת ש-`buildExternalRequest` היה מייצר.
    - כל פרמטר בשורה משלו.
    - `סכום` דרך `formatMinor`, במטבע של התקנון.
  - **צעד שבניית הבקשה שלו נכשלת** מסורב כבר בזמן התכנון, עם ההודעה העברית של הבונה. הוא לא מוצג חלקית.
  - **הקטלוג:**
    - `renderExternalCatalogue` זהה בבייט בין שתי קריאות.
    - בפרומפט של המתכנן הוא בא לפני פרק ה-intents או ההוראה.
- [ ] **צעד 2:** להריץ. **צפוי:** נכשל.
- [ ] **צעד 3: לממש.** `planAndCheck` (ב-`instruct.ts`) מריץ את `buildExternalRequest` על כל צעד `ext.*`, ופוסל את התוכנית על `ok:false`. זה אותו דפוס שבו צעדי הפנקס נבדקים מראש.
- [ ] **צעד 4:** להריץ. **צפוי:** עובר.
- [ ] **צעד 5: שמירה (commit):** `feat(external): echo shows the exact request; planner sees signed operations`.

### משימה 8: הדיווח על מה שקריאה החזירה

**קבצים:**
- **לשנות:** `src/orchestrator/whatsapp-report.ts`, `src/dashboard/views.ts` (תוצאת ההוראה), והמבחנים שלהם

**ממשקים:**
- **צורכת:** `loadReadsForJob` (משימה 2).
- **מייצרת:** `renderReadsForOwner(reads: ReadRow[]) → string`, טקסט בעברית:
  - בלוק לכל קריאה, שכותרתו `מ<תווית המערכת> — <תווית הפעולה>:`.
  - אחריה שורות `label: value`.
  - עד 40 שורות בסך הכול. אם יש יותר, שורה אחרונה אומרת כמה נחתכו.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - משימת ציווי בוס שנסגרה עם `ext.read` אחד מדווחת `בוצע לפי אישורך.` ואחריה השדות המרונדרים.
  - ערך שנושא U+202E מוצג כשהתו מוסר.
  - משימה בלי קריאות מדווחת בדיוק כמו קודם, בייט בבייט.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5: שמירה (commit):** `feat(external): the owner sees what a read returned`.

### משימה 9: פאנל המנהל — טיוטות וסודות

**קבצים:**
- **ליצור:** `src/admin/external-routes.ts`, `src/admin/external-routes.test.ts`
- **לשנות:**
  - `src/admin/server.ts`: נתיבים.
  - `src/admin/business-routes.ts`: מחליפים את "ייבנה בשלב הבא" בקישור וברשימת סטטוסים.
  - `src/tenancy/activity-log.ts`: `external_draft_saved`, `external_draft_deleted`, `external_secret_saved`.
  - `src/tenancy/panel-reads.ts`: לכל מערכת סטטוס `טיוטה` / `ממתין לחתימה` / `חתום` / `שינויים לא חתומים`, ועוד `סוד ✓/חסר` ו-`חתימת התראות ✓/חסר`.
  - `src/tenancy/panel-reads-invariants.test.ts`.

**ממשקים — נתיבים:**
- `GET /businesses/:id/external`.
- `GET /businesses/:id/external/:system`: תיבת טקסט עם JSON הטיוטה או תבנית ריקה, ותצוגה מקדימה בעברית.
- `POST …/save`, `POST …/delete`.
- `POST …/secret`, עם `kind=key|hook` ו-`value`:
  - כותב `putSecret` תחת `externalSecretRefs(id)`.
  - לעולם לא מחזיר את הערך.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - JSON לא תקין, או JSON שלא עובר את `ExternalSystem`, מוצג מחדש עם הודעות zod בעברית לפי נתיב, ושום דבר לא נכתב.
  - שמירה תקינה כותבת את הטיוטה ועוד שורה אחת ב-`platform_activity_log`. ה-`detail` שלה מחזיק רק את מספר הפעולות ודגל אחד, ומבחן מוודא שטקסט ההגדרה לא שם.
  - שמירת סוד מאחסנת אותו. העמוד מציג `✓ שמור` ולעולם לא את הערך.
  - הסטטוס של הגדרה שזהה לחתומה הוא `חתום`; של הגדרה שונה, `שינויים לא חתומים`.
  - מחרוזת בדיקה (PROBE) שנזרעה בשורת `external_events` אינה מוחזרת מאף קריאה של הפאנל. מרחיבים את סריקת ה-PROBE הקיימת.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5: שמירה (commit):** `feat(admin): external system drafts and secrets`.

### משימה 10: בעל העסק חותם, משנה ומסיר מערכת

**קבצים:**
- **ליצור:** `src/charter/amend-external.ts`, `src/charter/amend-external.test.ts`, `src/dashboard/external-connect.ts`, `src/dashboard/external-connect.test.ts`
- **לשנות:** `src/dashboard/server.ts` (נתיבים תחת `/connections/external`), עמוד החיבורים (קישור)

**ממשקים — מה המשימה מייצרת:**
- **בוני תיקונים:**
  - `buildExternalAmendment(active, def, now) → UnsignedCharter`: מוסיף או מחליף את המערכת ואת חיבור ה-`ext:<id>` שלה. כל שדה אחר מועתק מילה במילה.
  - `buildExternalRemoval(active, systemId, now)`.
- **`describeExternalSystem(def, currency) → string[]`:** משפטים בעברית, אחד לכל פעולה, בצורה `העוזרת תוכל: <תווית> (<תווית סוג>)`.
  - לפעולות כסף נוסף `— רק אחרי "כן" שלך`.
  - בסוף נוספות שורות על התראות וסריקה.
- **נתיבים:**
  - `GET /connections/external`.
  - `GET /connections/external/:system/sign`: הגיבוב של ההגדרה שהוצגה נשמר בשדה נסתר.
  - `POST …/sign`:
    - בונה מחדש מהטיוטה השמורה ומשווה את הגיבוב.
    - אז, בטרנזקציה אחת: `installSigned` ועוד `upsertBinding({ system: 'ext:'+id, status: 'live', credentialRef: EXT_<ID>_KEY, endpoint: null, provider: null })`.
    - אחר כך `deleteDraft`.
  - `POST …/remove`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **התיקון:** מעתיק כל שדה שאינו חיבור, בייט בבייט.
  - **חתימה:**
    - עם `base` ישן מחזירה 409, ושום דבר לא מותקן.
    - על טיוטה שנערכה בין ההצגה לשליחה (אי-התאמה בגיבוב) מציגה את התצוגה החדשה, ולא חותמת דבר.
    - אחרי החתימה, `resolveChannel(bundle, bindings, 'ext.call', id)` נפתר.
  - **הסרה:** אחריה המערכת לא נפתרת יותר. הסודות שלה נשארים, והעמוד אומר זאת.
  - **לפני חתימה:** הגדרה שקיימת רק כטיוטה גורמת לשער לדחות `ext.call` ב-`external_operation_unknown`.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5: שמירה (commit):** `feat(external): owner signs, changes and removes an external system`.

### משימה 11: קבלת התראות (webhook)

**קבצים:**
- **ליצור:** `src/external/webhook.ts`, `src/external/webhook.test.ts`
- **לשנות:** `src/dashboard/server.ts`: הנתיב, לפני שער הסשן ושער "אין תקנון"

**ממשקים — מה המשימה מייצרת:**
- `handleExternalWebhook(req, res, deps: { secrets; now })`.
- **קריאת הגוף:** הגוף הגולמי נקרא עם תקרה של 256KB (`readBoundedBody`). מעליה, 413.
- **בדיקות, לפי הסדר:**
  1. העסק רשום ופעיל: `resolveBusinessForHook`, קריאה חדשה **בשם** ב-`src/tenancy/platform.ts`. היא נוספת לרשימה הסגורה ב-CLAUDE.md.
  2. בתוך `withBusiness`, המערכת קיימת בתקנון הפעיל עם `webhook !== null`.
  3. `EXT_<ID>_HOOK` נפתר.
, אחרת התשובה 401. לחיצת יד לא שומרת דבר.
- **תגובות:**
  - כל כשל: 401 עם גוף ריק, ועוד `recordRejectedHook`.
  - בהצלחה, סוג האירוע נקרא ב-`typePath`:
    - סוג לא מוכר: 202, והאירוע נספר.
    - סוג מוכר: `insertEvent(source:'webhook', fields: extractFields(...), itemHash: sha256 של השדות בצורה קנונית)`, ואז 202.
- **שום דבר בגוף לא בוחר את העסק או את המערכת.**

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - HMAC תקף: 202, ונשמרת שורה אחת עם השדות המוצהרים בלבד.
  - **Stripe:** כותרת `t=…,v1=…` על `{timestamp}.{body}` עוברת.
    - אותה כותרת כשה-`t` ישן ב-301 שניות: 401.
    - שני ערכי `v1` שאחד מהם תואם: עוברת.
  - **GitHub:** `sha256=<hex>` עובר; אותו hex בלי התחילית: 401.
  - **Meta:** בקשת GET עם אסימון אימות נכון מחזירה בדיוק את ה-challenge, כ-`text/plain`.
    - אסימון שגוי, challenge עם `<`, או challenge ארוך מ-200 תווים: 401.
    - שום שורה לא נכתבת.
  - **Slack:** בקשת `url_verification` (POST) עם חתימה תקפה מחזירה את ה-challenge; בלי חתימה תקפה: 401.
  - אותו JSON שסודר מחדש, עם החתימה הישנה: 401 (מוקד סקירה 4).
  - כותרת חסרה או קצרה: 401, בלי לזרוק.
  - עסק מושעה, עסק לא מוכר, או מערכת שאינה בתקנון: 401, ושום שורה לא נכתבת באף עסק.
  - גוף מעל 256KB: 413.
  - מסירה חוזרת של אותה התראה: נשמרת שורה אחת.
  - הנתיב לא דורש סשן. לפני שיש תקנון הוא נגיש רק לעסק שיש לו תקנון; בכל מקרה אחר, 401.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5:** להריץ `/security-review` על השינוי.
- [ ] **צעד 6: שמירה (commit):** `feat(external): signed webhook receiver`.

### משימה 12: סריקה יומית, למידה וסיכום לבעלים

**קבצים:**
- **ליצור:** `src/external/scan.ts`, `src/external/scan.test.ts`, `src/external/learn.ts`, `src/external/learn.test.ts`, `src/dashboard/systems-view.ts`
- **לשנות:**
  - `src/orchestrator/scheduler.ts`: `scanExternalSystems` ואחריו `learnFromExternalEvents`, אחרי `pollMailbox`.
  - `src/memory/curate.ts` ו-`src/memory/curation-brief.ts`: היקף חדש, `'external'`.
    - `chunk` בלבד, כמו במייל.
    - תקרה `externalCurationPerDay`: הגדרה `EXTERNAL_CURATION_PER_DAY`, ברירת מחדל 20, שעמודת העסק יכולה לעקוף.
  - `src/orchestrator/digest-facts.ts` ו-`digest-render.ts`: פרק "ממערכות חיצוניות".
  - `src/dashboard/server.ts`: `/systems`.

**ממשקים — מה המשימה מייצרת:**
- **`scanExternalSystems(db, { http, now }) → { scanned: number; newItems: number; skipped: number }`.**
  - מריץ את פעולת הסריקה החתומה דרך מסלול הבקשה של `createExternalAdapter`: אותו בונה, אותו שומר, אותה תקרה.
  - נקרא ישירות, לא כמשימה. זו קריאה בלי ציווי בוס, ולכן (⚙, הכרעה 9) הסמכות שלה היא חתימת בעל העסק על בלוק ה-`scan` עצמו. זה נאמר ב-docs/10 ובעמוד החתימה.
  - `sinceParam` מקבל את `last_scan_at` בפורמט ISO.
  - `itemsPath` מפצל רשימה לפריטים, וכל פריט נשמר ב-`insertEvent(source:'scan')`.
- **`learnFromExternalEvents(db, { curator }) → { jobs: number; curated: number }`.**
  - לוקח אירועים שלא נלמדו, בקבוצות של עד 20 לכל מערכת.
  - פותח משימה עם `provenance: 'unknown_external'` כליטרל.
  - קורא ל-`curateJob(db, job, { scope: 'external' })` ומסמן את האירועים כנלמדו.
- **פרק התדריך:** דטרמיניסטי.
  - מציג ספירות לפי מערכת וסוג אירוע, ואת השדה הראשון של 5 הפריטים האחרונים.
  - הוא בתוך ההליכה על גרף הייבוא של התדריך, ולכן לא מייבא דבר מתחת ל-`src/sdk/`.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - **סריקה:**
    - רצה רק כשעברו `everyHours`.
    - סריקה שהתשובה שלה לא השתנתה לא מכניסה דבר.
    - סריקה שנחסמה בשומר הכתובות לא מכניסה דבר, ורושמת את הקריאה.
  - **למידה:** משימת הלמידה היא `unknown_external` וכותבת רק שורות `chunk`. מבחן זורע ישות ומוודא שלא נגרעה.
  - **בידוד:** `src/policy/` לא מייבא דבר מתחת ל-`src/external/`, בהליכת BFS על הגרף בסגנון `description-invariants.test.ts`.
  - **תדריך:** מציג את הפרק, ו-`hadContent` נדלק כשיש אירועים חדשים.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5: שמירה (commit):** `feat(external): daily scan, chunk-only learning, owner summary`.

### משימה 13: מחיקה

**קבצים:**
- **לשנות:** `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `src/governance/erasure-plan.test.ts`, ותצוגת המחיקה בדשבורד (שורה בתצוגה המקדימה)

**ממשקים — מה המשימה מייצרת:**
- **פרדיקטים:** `EXTERNAL_READS_ERASED_PREDICATE` ו-`EXTERNAL_EVENTS_ERASED_PREDICATE`, מיוצאים פעם אחת ומשותפים ל-`countItems` ולמבצע.
- **גילוי:** שתי הטבלאות הן מקורות גילוי, דרך `jsonbContentMatches` על `fields`. `external_reads` נמחקת גם לפי `job_id`.
- **`ErasurePlan.externalSystemsKept: string[]`:** התוויות של המערכות שנמצאה בהן שורה תואמת.
  - מוצג בתצוגה המקדימה כ"נשארים במערכת <תווית>".
  - נכנס ל-`planFingerprint`, ממוין.
- **מספר הטבלאות:** רשימת המחיקה עולה מ-36 ל-38 טבלאות.
- **מה לא מחווט:** `external_system_drafts`, `external_calls` ו-`external_system_state` לא מחזיקות שום אדם.

**צעדים:**
- [ ] **צעד 1: מבחנים שנכשלים.**
  - זורעים PROBE (עם `_`) בערך `fields` של שורת `external_reads` ושל שורת `external_events`, מוחקים לפי איש קשר, ומצפים לאפס מופעים בסריקה של כל הסכמה.
  - התצוגה המקדימה מונה את תווית המערכת.
  - טביעת התוכנית משתנה כש-`externalSystemsKept` משתנה.
- [ ] **צעדים 2–4:** להריץ (נכשל), לממש, להריץ (עובר).
- [ ] **צעד 5: שמירה (commit):** `feat(erasure): external reads and events`.

### משימה 14: תיעוד

**קבצים:**
- **לשנות:**
  - `CLAUDE.md`:
    - פרק חדש, "מערכות חיצוניות".
    - רשימת הפקודות.
    - "36 → 38 טבלאות".
    - הוספת `resolveBusinessForHook` לרשימה הסגורה של פעולות חוצות-עסקים.
    - בעיות ידועות.
    - צעד "לחתום מחדש אחרי 1.4" במדריך המעבר.
  - `docs/10-user-settings.md`: על מה בעל העסק חותם, הסמכות של הסריקה, וערוץ הסיכום.
  - `docs/11-pre-launch-checks.md`, שורות:
    - קריאה חיה מול API בדיקה ציבורי.
    - התראה אמיתית מספק דרך ה-proxy.
    - ניסיון DNS-rebinding על שרת הייצור.
    - פעולת כסף מול סביבת בדיקות של ספק.
    - סריקה על נקודת רשימה אמיתית.
  - `docs/08-risks.md`: מערכת חתומה שהספק מפנה מאוחר יותר לכתובת אחרת, ותשובה של ספק שנפרץ.
  - `docs/12-launch-plan.md`.

**צעדים:**
- [ ] **צעד 1:** לכתוב את המסמכים. כל טענה מפנה לקובץ שהיא מתארת.
- [ ] **צעד 2:** להריץ `npm run typecheck` ו-`npm test` על הבסיס הייעודי. **צפוי:** ירוק.
- [ ] **צעד 3: שמירה (commit):** `docs: stage D — external systems`.
