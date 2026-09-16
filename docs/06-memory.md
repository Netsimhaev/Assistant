# ארכיטקטורת הזיכרון

> **המלצה חד-משמעית: Postgres יחיד עם pgvector ל-L0–L5, ואחסון אובייקטים אחד לקבצים.**
>
> **מצב המימוש:** הותקן **PostgreSQL 17.11** (16 אינו זמין ב-winget; 17 בשל ונתמך). **pgvector טרם הותקן** — הוא נדרש רק ל-L3, שנבנה בשלב 1, והתקנתו ב-Windows דורשת שרשרת בנייה של MSVC. אין טעם להתקין אותה בשביל תלות של שלב 1.
>
> לא Pinecone. לא graph DB נפרד. לא Redis.
>
> בקנה מידה של עסק בודד, הפשטות התפעולית והעקביות הטרנזקציונית בין כתיבת זיכרון לרשומת הביקורת שלה שוות הרבה יותר מכל יתרון ביצועים של מאגר מתמחה.
>
> **מצב המימוש (תת-פרויקט ב', 15/09):** ל-L1 (ישויות) ול-L4 (העדפות) יש עכשיו כותב שרץ מעצמו — האוצֵר (`src/memory/curate.ts`), שרץ בהופ `verify → remember` על כל משימה שקראה או תיקשרה, ומחליט בעצמו אילו עובדות ראוי לזכור, בלי שתוכנית תבקש זאת במפורש. השליפה חזרה לתכנון עצמו: `recallForPlanning` ([src/memory/recall-planning.ts](../src/memory/recall-planning.ts)) מרכיבה בלוק ומוסיפה אותו לפרומפט המתכנן אוטומטית — ראה `CLAUDE.md` לכללים המדויקים. **L3 עדיין לא נבנה** — אין pgvector, אין הטמעות, אין דמיון סמנטי — והשליפה בכל הפרויקט, גם בגרסה הזו, היא **לפי נושא ולפי מילה** (subject key מדויק, ו-`ILIKE` על הטקסט הגולמי), לא ההיברידיות (BM25 + וקטורי) שסעיף 4 למטה מתאר כיעד. זה פחות מהמפרט ויותר מהכלום שקדם לו.

> **שתי מגבלות אמיתיות בשליפה האוטומטית, לא תיאורטיות:** ראשית, `recallForPlanning` נקראת רק על נושאים שנפתרו לכתובת מייל מלאה בטקסט ההוראה עצמה (`emailAddressesIn`) — הוראה רגילה כמו "תשיבי לרונית" בלי כתובת מפורשת אינה מזהה נושא כלל, ולכן מקבלת **בלוק זיכרון ריק**; פותר משם לכתובת עדיין לא קיים. שנית, מסך "מה נזכר" (`GET /memory`) מציג לכל היותר `MAX_RECALL` (20) שורות בלי pagination, ואינו מציג זיכרון גרוע כלל — `recallMemories` מקבעת `retired_at IS NULL` בלי אפשרות לעקוף, כך שאין דרך לראות מהמסך מה הפסיק להיות נכון ומתי.

---

## 1. שבע השכבות

| שכבה | תוכן | אחסון | נכתב על ידי | דפוס קריאה |
|---|---|---|---|---|
| **L0 תקנון** | חוקים, קול, זהות, תקרות | Postgres, שורות מגורסות + hash חתום | **בני אדם בלבד** (דרך הצעות של `gov.charter`) | מקומפל לתחילית כל פרומפט, במטמון |
| **L1 ישויות** | אנשים, ארגונים, לקוחות, ספקים, מוצרים, עסקאות | Postgres רלציוני | `know.memory` בלבד | חיפוש לפי מפתח → "כרטיס ישות" (≤400 טוקנים) |
| **L2 אפיזודות / ביקורת** | כל פעולה שבוצעה, עם ראיות | Postgres append-only, משורשר-hash | Orchestrator + hooks | סינון לפי זמן/ישות, N אחרונים |
| **L3 מסמכים וסמנטיקה** | מיילים, קבצים מצורפים, מאמרים, סיכומי פגישות, chunks + embeddings | Postgres + pgvector | `know.memory` בלבד | היברידי BM25 + וקטורי, מדורג מחדש, top-k |
| **L4 העדפות נלמדות** | "הלקוח הזה מעדיף עברית", "הבוס לא נפגש לפני 09:30" | Postgres, שורות מובנות | `know.memory` בלבד | סינון לפי נושא, פעילות בלבד |
| **L5 משימות ומעקבים** | jobs, plans, steps, follow-ups, approvals | Postgres | Orchestrator בלבד | שאילתות תפעוליות |
| **L6 זיכרון עבודה** | תמלילי סשן | סשני SDK + דיסק, TTL 30 יום | SDK | ל-resume בלבד |
| **קבצים** | מצורפים, מסמכים שנוצרו, צילומי מסך | MinIO/S3, ממוען-תוכן | כל אחד, דרך `file.write` | לפי URI + sha256 |

---

## 2. טיפוסי הרשומות המרכזיים

```ts
export interface EntityRecord {
  id: string;
  type: 'person'|'org'|'customer'|'supplier'|'product'|'deal'|'project';
  displayName: string;
  aliases: string[];                       // לצורך זיהוי
  identifiers: {
    emails: string[]; phones: string[]; taxId?: string;
    externalIds: Record<string,string>;
  };
  attributes: Record<string, unknown>;     // מוטפס לפי סוג הישות
  relations: { predicate: string; targetId: string }[];   // 'מספק', 'עובד ב'
  sensitivity: DataClass;
  card: string;                            // סיכום מרונדר ≤400 טוקנים, מתחדש בשינוי
  confidence: number;
  lastSeenAt: string; updatedAt: string; updatedBy: 'curator';
}

export interface PreferenceRecord {
  id: string;
  subject: { kind: 'business'|'person'|'entity'|'channel'; id: string };
  statement: string;                       // "מעדיף פגישות בבוקר"
  polarity: 'do' | 'dont';
  scope: { actionClasses?: ActionClass[]; channels?: Channel[] };
  confidence: number;                      // 0–1
  observedCount: number; contradictedCount: number;
  evidence: EvidenceRef[];                 // **חייב להיות לא ריק**
  status: 'candidate' | 'active' | 'retired';
  approvedBy?: string;                     // נדרש כשהביטחון מתחת לסף
  firstObservedAt: string; lastObservedAt: string;
}

export interface DocChunk {
  id: string; docId: string;
  entityIds: string[];
  text: string;
  embedding: number[];                     // pgvector
  sensitivity: DataClass;
  provenance: TrustLevel;                  // נוסע עם הטקסט **לנצח**
  sourceSpan: [number, number];
  createdAt: string;
}
```

### שתי נקודות שמחזיקות את כל המודל

**`PreferenceRecord.status`** הוא המנגנון שמונע מהעוזרת "ללמוד" משהו שגוי ולפעול לפיו. העדפה נכנסת כ-`candidate` עם ראיות; היא הופכת ל-`active` רק מעל סף הביטחון בתקנון או באישור מפורש של הבוס; `contradictedCount` שעולה מוציא אותה לגמלאות.

> **העדפה מועמדת רשאית להשפיע על טיוטה, אך לעולם לא להצדיק פעולה אוטונומית.**

**`DocChunk.provenance` שנוסע עם הטקסט** הוא קריטי: תוכן שהגיע ממייל לא-אמין עדיין מתויג `unknown_external` כשהוא נשלף שמונה חודשים אחר כך, וכלי האחזור עוטף אותו בהתאם.

---

## 3. מי רשאי לכתוב

| שכבה | הכותב | כל השאר |
|---|---|---|
| L0 | בני אדם (חתום) | רשאים להציע תיקונים |
| L1, L3, L4 | `know.memory` **בלבד** | פולטים envelopes מסוג `MemoryProposal` |
| L2 | Orchestrator + hooks (אוטומטי) | אף אחד לא כותב ישירות |
| L5 | Orchestrator | סוכנים קוראים ל-`tasks.update_state`, ה-Orchestrator מאמת |

כלי הכתיבה של ה-Curator הם **שרת MCP בתוך התהליך**, כך שמסלול הכתיבה הוא קוד TypeScript שמאמת, מבצע דדופליקציה, מיישב סתירות, וכותב את רשומת הביקורת **באותה טרנזקציה**.

> מודל אינו יכול להשחית את הזיכרון על ידי הפקת פלט פגום — הוא יכול רק לייצר הצעה שנדחית.

---

## 4. אחזור בלי להציף את ההקשר

כלי אחד — `memory.recall(query, scopes, maxTokens, entityHints?)` — שמחזיר תוצאה **ארוזה שמורכבת בקוד, לא על ידי מודל**:

```
תקציב 3000 טוקנים →
  400  תמצית תקנון רלוונטית למחלקת הפעולה הנוכחית      (תמיד)
  400  כרטיס(י) ישות לצדדים שזוהו                       (תמיד אם זוהו)
  300  העדפות פעילות לאותם נושאים                       (active בלבד)
  600  N האפיזודות האחרונות שמערבות את הישויות          (מובנה, תמציתי)
 1200  top-k chunks: BM25 ∪ וקטורי → RRF → דירוג מחדש → דדופ
  100  שמור לעטיפת "תוכן לא-אמין"
```

### כללים שנאכפים בקוד

- **קיצוץ קשיח מהקצה הפחות חשוב.** לעולם לא לחרוג מ-`maxTokens`.
- Chunks מתויגים `unknown_external`/`open_web` מוחזרים בתוך עטיפת נתונים מפורשת עם באנר מקור, ו**אינם מוחזרים כלל** לסוכן שהצעד הנוכחי שלו נושא סמכות הוצאה — אלא אם ה-envelope ביקש אותם במפורש.
- **הצנזור לפי `charter.data.redactBeforeSending` חל בזמן האחזור**, לא רק בזמן השליחה — כדי ש-PII לא ייכנס להקשר שעלול להירשם בלוג בהמשך.
- כל recall נרשם עם השאילתה והמזהים שהוחזרו, כדי שאפשר יהיה לענות על "**למה היא חשבה את זה?**"

> **אנטי-דפוס שנדחה במפורש:** לתת לסוכנים כלי `search_everything` כללי ולתת להם לשוטט. זה חסר גבול בעלות, בלתי צפוי בהשהיה, ובלתי אפשרי לביקורת.

---

## 5. פרטיות ושימור

- **שום דבר לא עוזב את המופע** מלבד לספקי משנה מוצהרים (Anthropic ל-inference, וספק המייל/יומן/וואטסאפ שהעסק כבר משתמש בו). `charter.data.subprocessorsAllowed` נאכף בשכבת האינטגרציה: **שרת MCP שאינו ברשימה אינו נטען.**
- **שימור לכל מחלקת נתונים** עם משימת ניקוי לילית. הניקויים עצמם נרשמים בביקורת.
- **זכות למחיקה:** `memory.forget(entityId)` מדרדר ל-L1/L3/L4 ומציב מצבות ב-L2 — רשומות הביקורת נשמרות אך התוכן שלהן מצונזר, כדי לשמר את שרשרת ה-hash.
- **מחלקות health/legal/financial** נופלות כברירת מחדל ל-`mayShareExternally: 'never'` ומוחרגות מכל אחזור לתוך סוכן עם סמכות יוצאת, אלא אם התקנון מתיר במפורש.
- **Credentials לעולם לא בזיכרון.** הם חיים ב-CredentialBroker. `DataClass.credentials` קיים בסכמה אך ורק כדי ש-credential שדלף וזוהה במסמך נכנס יוכל להיות מסומן ומצונזר.
