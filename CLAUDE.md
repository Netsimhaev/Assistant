# עוזרת אישית עסקית

עוזרת AI שמחליפה מזכירה/פקידת משרד, מותקנת בנפרד אצל כל עסק.
**שלב 0 — עמוד השדרה של הממשל. בבנייה.** הארכיטקטורה המלאה: [docs/00-overview.md](docs/00-overview.md).

---

## פקודות

```bash
npm test          # vitest run — 65 מבחנים
npm run typecheck # tsc --noEmit
npm run build     # tsc
npm run migrate   # מריץ מיגרציות על DATABASE_URL
npm run test:watch
```

**המבחנים דורשים Postgres אמיתי.** אין mock ואין DB בזיכרון. נדרשים שני בסיסי נתונים — `assistant_dev` ו-`assistant_test` — ו-`.env` עם `DATABASE_URL` ו-`TEST_DATABASE_URL` (ראה `.env.example`). נבדק על PostgreSQL 17.11.

הבחירה בין בסיסי הנתונים אוטומטית: `vitest.config.ts` מגדיר `NODE_ENV=test`, ו-`src/config.ts` בוחר לפיו את `TEST_DATABASE_URL`. אין צורך להגדיר ידנית.

`npm run migrate:test` מריץ מיגרציות על בסיס הבדיקות. הוא מעביר `--test-db`, ש-`src/config.ts` קורא מ-`process.argv` — לא מ-env, כי ESM מרים imports ולכן הגדרת `process.env` במודול אחר מגיעה מאוחר מדי.

---

## הארכיטקטורה

ה-Orchestrator הוא שירות TypeScript דטרמיניסטי עם מכונת מצבים עמידה, **לא** סשן Claude שמנהל סוכנים. 15 סוכנים בחמש מחלקות. התקנון העסקי מקומפל לפרדיקטים שנאכפים ב-hooks — לא פרוזה שמבקשים מהמודל לציית לה.

**הכול עובר דרך שער אחד:** `evaluateToolCall` ב-[src/policy/engine.ts](src/policy/engine.ts). תשעה שלבים, מסודרים כך שכל שלב זול ומוחלט יותר מהבא:

```
1 kill switch → 2 תקנון עדכני → 3 הרשאת כלי → 4 קריאה-בלבד? →
5 איסור מוחלט → 6 doNotContact → 7 אוטונומיה → 8 תקציב → 9 סיכון
                                      ⇓
                          allow | deny | queue_approval
```

---

## כללים שהקוד אוכף בשקט

אלה הדברים שלא רואים מקריאת הקוד ושגרמו כבר לתקלות.

**שכבת היכולות דוחה לפני התקנון.** כלל `forbidden` בתקנון שמכוון למחלקת פעולה שאף סוכן לא נגיש אליה הוא **קוד מת** — השער יחזיר `tool_not_allowlisted` ולא `forbidden`. שלושה כלים בבעלות אף אחד בכוונה (`UNOWNED_TOOLS` ב-`capabilities.ts`).

**כלי כתיבה חדש דורש שתי עריכות.** להוסיף ל-`TOOL_ACTION_CLASS` ב-[src/policy/classify.ts](src/policy/classify.ts) **וגם** ל-allowlist של סוכן ב-[src/charter/capabilities.ts](src/charter/capabilities.ts). כלי שחסר בשתיהן מטופל כקריאה-בלבד ו**עובר את השער בשקט**. זה הבאג שהפיל תשעה מבחנים בסשן שבנה את השלד.

**`READ_ONLY_TOOLS` עוקף את שלבים 5–9 לגמרי.** מי שנשאר שם עם תופעות לוואי אמיתיות: `file.write`, `media.generate_image`, `media.generate_video`. אם מוסיפים שם משהו, לוודא שהוא באמת לא צריך שער.

**`browser.click`/`browser.fill` מסווגים כ-`browser.interact`, לא קריאה-בלבד.** הבסיס הוא `auto` — הגידור לא בא מהמחלקה אלא מ**תקרת המקור** מעליה: שרשרת שקראה דף לא אמין היא `open_web` ולכן `draft_only`. קליק שנושא `amountMinor > 0` מתעדן ל-`purchase.place`. הטריגר הוא הסכום ולעולם לא תווית הכפתור — הדף נכתב על ידי מי ששולט באתר, והתאמה לטקסט שלו היא קריאת הקלט של התוקף כמדיניות.

**מחלקה שיוצאת מהמכונה לא בהכרח פונה לאדם.** `COUNTERPARTY_ADDRESSED_CLASSES` מפריד בין "הודעה לנמען" לבין "בקשה לשרת". ההסלמה `one_unknown` שייכת רק לראשונה — בלי ההפרדה הזו כל קליק בדפדפן הפך ל"מגע ראשון עם גורם לא מזוהה" ונשלח לתור אישורים.

**כסף הוא מספר שלם ביחידות מינור, תמיד.** `readAmountMinor` ב-[src/policy/facts.ts](src/policy/facts.ts) **זורק `TypeError`** על עשרוני במקום לעגל. שים לב: זו חריגה ולא `deny` — היא יוצאת מ-`evaluateToolCall` ולא משאירה רשומת ביקורת.

**שלבים 1–4 של השער לא כותבים ביקורת.** דחיית kill-switch, תקנון ישן, או כלי לא מורשה — כולן לא משאירות שורה ב-`audit_log`. רישום הכוונה מתחיל בשלב 5.

**`canonicalJson` חייב להישאר דטרמיניסטי.** שלושה hash-ים נשענים עליו: חתימת התקנון, שרשרת הביקורת, ושומר ה-TOCTOU של האישורים. שינוי בסדר המפתחות או בטיפול ב-`undefined` שובר את שלושתם בשקט. הוא זורק על `NaN`/`Infinity` בכוונה — עיגול שקט של ערך שלא עושה round-trip הוא בדיוק סוג הבאג שהתקרות נועדו למנוע.

**`audit_log` הוא append-only ברמת ה-DB.** trigger בשם `audit_log_no_update` דוחה UPDATE ו-DELETE. מבחן שצריך לשבש חייב `ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update` ולהחזיר אחריו.

**`resetDatabase()` משתמש ב-TRUNCATE ולא DELETE** — מאותה סיבה. זו תכונה של הסכמה, לא מכשול לעקוף.

**עברית לבני אדם, אנגלית לקוד.** הודעות דחייה, פלט `render.ts` והמסמכים בעברית. מזהים, הערות ושגיאות פנימיות באנגלית. (חריגה ידועה: הודעות ב-`budget.ts` באנגלית — לא עקבי עם שאר משטח הדחייה.)

**עיצוב כסף במקום אחד** — `formatMinor` ב-[src/util/money.ts](src/util/money.ts). כרטיס אישור, סיבת דחייה והתקנון החתום חייבים להציג אותו סכום זהה.

**`refineActionClass` בודק חיובית, לא בשלילה.** שדה שרשור נחשב קיים רק אם הוא מחרוזת לא ריקה. `=== undefined` הפך `inReplyTo: null` ל-`email.reply` והנמיך אוטונומיה. כל צורה לא מוכרת חייבת להניב את המחלקה **המחמירה** יותר.

**תקרת ההנחה נבדקת לפני קיצור הדרך של `amountMinor === 0`.** הנחה היא אחוז, וקריאת הכלי שנותנת אותה לא נושאת סכום כלל.

**כתיבת ביקורת מצטרפת לטרנזקציה של הקורא רק אם הוא סיפק אחת.** `pg_advisory_xact_lock` הוא ברמת טרנזקציה — העברת ה-pool החשוף תיקח ותשחרר את המנעול בתוך משפט אחד ותבטל בשקט את הסריאליזציה ששומרת על השרשרת.

**`.js` בכל import יחסי**, גם מקבצי `.ts`. נדרש על ידי `NodeNext` + `"type": "module"`.

**שלושה דגלי tsconfig שנושכים:** `noUncheckedIndexedAccess` (מכריח `rows[0]?.x` בכל קוד DB), `exactOptionalPropertyTypes` (מכריח spread מותנה כמו `ctx.norms ? { norms: ctx.norms } : {}`), `verbatimModuleSyntax` (מכריח הפרדה מדויקת בין `import` ל-`import type`).

**מוסכמה בכל מודול שקורא שורות DB:** `interface XRow` פרטי + פונקציית `toX(row)`. SQL ב-snake_case, TS ב-camelCase.

**סכמת zod והטיפוס המוסק חולקים שם אחד** — `export const ActionClass = z.enum([...]); export type ActionClass = z.infer<typeof ActionClass>;`. זו התבנית בכל `src/domain/`.

---

## המבחנים המבניים הם מעקה

[src/charter/capabilities.test.ts](src/charter/capabilities.test.ts) אינו בודק התנהגות אלא **אינווריאנטים**. עשרה, וכל אחד חוסם דרך שבה הטבלאות יוצאות מסנכרון ומייצרות חור שקט או חוק מת. אם אחד מהם נכשל, התיקון הוא כמעט תמיד בטבלאות — לא במבחן.

שניים שאסור לרכך:
- **סוכני ההסגר** (`intake.triage`, `know.reader`) חייבים להישאר עם **אפס** כלים מסווגים
- **`ops.web`** חייב להישאר עם `COLLABORATION_GRAPH` ריק — סשן דפדפן שנחטף לא יגיע לכלי תקשורת דרך שליח

---

## בסיום משימה

חל על משימות שבהן **משהו השתנה** — לא על שאלה, לא על קריאת קוד, ולא באמצע משימה רב-שלבית.

**1. לבדוק לפני שמדווחים.** להריץ `npm run typecheck` ו-`npm test`. יש hook שמריץ אותם אוטומטית בסוף התור, אבל הוא הרשת ולא הבקרה — עדיף לגלות כשל תוך כדי ולתקן, מאשר לדווח "סיימתי" ואז לראות אדום.

**2. להעמיק באבטחה כשהשינוי נגע בליבה.** הרצת `/security-review` על השינוי כשנגעת ב-`policy/engine.ts`, `charter/capabilities.ts`, `policy/classify.ts`, `util/canonical.ts`, `audit/log.ts`, או בקבצי מיגרציה. לשאר השינויים המבחנים מספיקים.

**3. להודיע על הסיום ולסכם בפסקה קצרה** — מה נעשה, מה אומת בפועל, ומה נשאר פתוח. אם בדיקה נכשלה או דילגתי על משהו, לומר את זה במפורש.

**4. לתת המלצה להמשך ו-2–4 אפשרויות.** המלצה אחת מנומקת, ואחריה אפשרויות קונקרטיות שאפשר לבחור מהן.

---

## בעיות ידועות

**החלטות מודעות שממתינות להכרעה — לא באגים, אבל גם לא סגורות:**

**נסגר ב-18/08:** שער הדפדפן הוכרע — ראה למעלה. מה שנותר פתוח הוא **קשירת התוכנית** (בקרה 4 ב-`docs/08-risks.md`): השוואת הסכום החי ב-DOM לסכום המאושר. דורשת תוכניות, כלומר Orchestrator.

`redactedInput` מחזיר את הקלט הגולמי; `charter.data.redactBeforeSending` נקרא על ידי אף אחד. שעות השקט מופיעות במסמך החתום ואין להן נקודת אכיפה. שתיהן ממתינות ל-Orchestrator.

`recordSpend` עדיין בלי קורא, ולכן `spend_ledger` ריק ותקרות היום/החודש אינן נאכפות בפועל. זה נסגר כשיהיה מבצע — לא לפני.

**מה שתוקן ולמה זה חוזר על עצמו:** שמונה פגמים תוקנו בסקירה של 18/08. ארבעה מהם היו אותו פגם — שדה שהתקנון מקמפל ואף שלב בשער לא קורא. המבחן `compiled policy has a reader` תופס את המחלקה הזו מכנית מעכשיו.

## מה עוד לא נבנה בשלב 0

Orchestrator (מכונת המצבים — הטבלאות קיימות, הלוגיקה לא) · תור pg-boss ו-scheduler · פרוטוקול ה-envelope ומרשם ה-intents · מסירת אישורים בפועל (ה-broker מייצר ומכריע, אף אחד לא רואה) · CredentialBroker · רמפת האוטונומיה · סוכן אחד end-to-end מול ה-Agent SDK · pgvector ושכבות L1/L3/L4.

`NormsLookup` ב-`policy/risk.ts` הוא ממשק עם מימוש ריק (`NO_HISTORY`, z=0 תמיד). זה הופך את המערכת **מתירנית יותר** בהתחלה, וזה בטוח רק כי הרמפה מחזיקה הכול ב-`draft_only` — שני המנגנונים נושאים משקל יחד.

**ה-Agent SDK עדיין לא חובר.** ל-`evaluateToolCall` אין קורא מלבד המבחנים. חתימות ה-SDK מסומנות כשאלה פתוחה ב-[docs/09-roadmap.md](docs/09-roadmap.md).

---

## מפת המסמכים

| קובץ | תוכן |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | חזון, חמש החלטות היסוד, דיאגרמה, SDK מול בנייה עצמית |
| [docs/01-agents.md](docs/01-agents.md) | 15 הסוכנים — אחריות, כלים, אוטונומיה, מודל |
| [docs/02-orchestrator.md](docs/02-orchestrator.md) | מכונת המצבים, תכנון, מקביליות, כשלים |
| [docs/03-protocol.md](docs/03-protocol.md) | envelope, contextRefs, אימות, מניעת לולאות |
| [docs/04-charter.md](docs/04-charter.md) | סכמת התקנון ושבע נקודות האכיפה |
| [docs/05-approvals.md](docs/05-approvals.md) | שבעת ממדי הסיכון, אישורים, kill switch, רמפה |
| [docs/06-memory.md](docs/06-memory.md) | שבע שכבות הזיכרון |
| [docs/07-walkthroughs.md](docs/07-walkthroughs.md) | שלושה תרחישים end-to-end |
| [docs/08-risks.md](docs/08-risks.md) | prompt injection, דפדפן, עלויות, אחריות |
| [docs/08b-whatsapp-bridge.md](docs/08b-whatsapp-bridge.md) | `WhatsAppGateway` ושלושת מימושיו |
| [docs/09-roadmap.md](docs/09-roadmap.md) | חמשת השלבים ושאלות פתוחות |
