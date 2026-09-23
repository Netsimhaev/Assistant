# מנהל הסודות — תוכנית ביצוע

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** הסודות של המערכות החיצוניות יוצאים ממשתני הסביבה ונשמרים מוצפנים בבסיס הנתונים, לפי עסק, נפתחים במפתח שיושב בקובץ מוגן מחוץ לו — וכל שימוש של בעל הפלטפורמה בכוח הזה נרשם.

**Architecture:** הגבול כבר קיים — `CredentialSource` הוא ממשק בן פונקציה אחת שתוכנן להחלפה, ו**אף מתאם לא משתנה**. שתי תוספות מעצבות את הכול: פתירת סוד תדרוש מזהה עסק **חובה ובלי ברירת מחדל**, ומזהה העסק יימסר להצפנה כנתון מאומת — כך ששורה שתועתק בין לקוחות לא תיפתח, ובאג בתנאי שאילתה אינו מספיק כדי לחצות את הגבול.

**Tech Stack:** TypeScript NodeNext ESM, `node:crypto` (AES-256-GCM, scrypt), Postgres 17 דרך `pg`, vitest מול בסיס נתונים אמיתי.

**Spec:** [docs/superpowers/specs/2026-09-23-credential-broker-design.md](../specs/2026-09-23-credential-broker-design.md)

## Global Constraints

- `.js` בכל ייבוא יחסי, גם מקובצי `.ts`.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — כולם דלוקים.
- עברית לכל מה שאדם קורא; אנגלית למזהים, להערות ולשגיאות פנימיות.
- **ערך של סוד לא נכתב לשום מקום פרט לעמודת הצופן.** לא ללוג, לא לשורת ביקורת, לא להודעת שגיאה, לא לפלט של כלי.
- **`src/policy/engine.ts` אינו משתנה בתוכנית הזו.** משימה שנראה שצריכה לגעת בו — לעצור ולדווח.
- **מזהה העסק בנתיב הסודות הוא חובה ואין לו ברירת מחדל.** הדפוס `?? config.businessId` שמותר בכל מקום אחר — אסור כאן.
- כל בקרה נכתבת כרשימה חיובית; "כל מה שאינו X" כבר גרף כאן שלוש פעמים משהו שלא התכוונו אליו.
- מבחן שלילי שעובר גם בלי הקוד שהוא מכסה אינו מבחן.
- הערה מתארת מה הקוד עושה; קובץ שהיא מצטטת חייב לומר את מה שנטען — לפתוח אותו לפני.
- המבחנים רצים מול Postgres אמיתי, ו-`npm test` מורץ **לבד ובחזית**. ריצה מקבילה נראית בדיוק כמו רגרסיה המונית.

---

## מבנה הקבצים

| קובץ | אחריות |
|---|---|
| `src/db/migrations/027_credentials.sql` | שתי טבלאות: הסודות המוצפנים, ומצב המפתח |
| `src/governance/secret-cipher.ts` | הצפנה ופענוח בלבד. בלי DB, בלי קבצים |
| `src/governance/master-key.ts` | קריאת קובץ המפתח, אימותו מול מצב המפתח, וסירוב לעלות |
| `src/orchestrator/credentials.ts` | **שינוי** — `resolve(ref, businessId)`, חובה |
| `src/governance/credential-store.ts` | המאגר המוצפן: קריאה, כתיבה, הסרה, לפי עסק |
| `src/orchestrator/runtime.ts` | **שינוי** — הייצור מקבל את המאגר, לא את הסביבה |
| `src/cli/secret.ts` | הכלי של בעל הפלטפורמה — סודות |
| `src/cli/secret-key.ts` | הכלי — יצירת מפתח, החלפה, שחזור |
| `src/domain/audit.ts` | **שינוי** — סוג ביקורת `credential_change` |

---

### Task 1: הסכמה וההצפנה

**Files:**
- Create: `src/db/migrations/027_credentials.sql`
- Create: `src/governance/secret-cipher.ts`
- Modify: `src/test/db.ts` — שתי הטבלאות החדשות לרשימת ה-TRUNCATE
- Test: `src/governance/secret-cipher.test.ts`

**Interfaces:**
- Produces: `encryptSecret(plain: string, key: Buffer, aad: SecretAad): Sealed`, `decryptSecret(sealed: Sealed, key: Buffer, aad: SecretAad): string | null`, `SecretAad = { businessId: string; ref: string }`, `Sealed = { ciphertext: Buffer; nonce: Buffer }`.

- [ ] **Step 1: המיגרציה**

צור `src/db/migrations/027_credentials.sql`:

```sql
-- One encrypted secret per (business, ref). The value never appears in any
-- other column, here or anywhere else in the schema.
CREATE TABLE credentials (
    business_id  TEXT NOT NULL,
    ref          TEXT NOT NULL,
    ciphertext   BYTEA NOT NULL,
    nonce        BYTEA NOT NULL,
    key_id       TEXT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   TEXT NOT NULL,
    PRIMARY KEY (business_id, ref),
    CONSTRAINT credentials_ref_shape CHECK (ref ~ '^[A-Z0-9_]+$')
);

-- Which key is live, and a value that proves a key file is the right one
-- BEFORE anything tries to decrypt a real secret (spec 5.1). One row.
CREATE TABLE credential_key_state (
    business_id  TEXT PRIMARY KEY,
    key_id       TEXT NOT NULL,
    check_nonce  BYTEA NOT NULL,
    check_value  BYTEA NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**הערה למבצע על `business_id` בטבלה השנייה:** המפתח הוא של ההתקנה ולא של עסק בודד, אבל העמודה קיימת כדי שהטבלה תתיישר עם כל שאר הסכמה ועם העולם הרב-עסקי שהמפרט §2.3 מתאר. שורה אחת בפועל.

- [ ] **Step 2: שלוש הטבלאות לרשימת האיפוס**

`src/test/db.ts` מונה את הטבלאות **ביד**, וההערה בקובץ מזהירה שטבלה שנשמטת מדליפה מצב בין מבחנים. הוסף `credentials` ו-`credential_key_state` לרשימת ה-`TRUNCATE`.

- [ ] **Step 3: כתוב את המבחן הנופל**

צור `src/governance/secret-cipher.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secret-cipher.js';

const KEY = randomBytes(32);
const AAD = { businessId: 'biz-a', ref: 'OFFICE_MAIL' };

describe('the secret cipher', () => {
  it('returns exactly what was sealed', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    expect(decryptSecret(sealed, KEY, AAD)).toBe('hunter2');
  });

  it('never produces the same ciphertext twice for the same input', () => {
    const a = encryptSecret('hunter2', KEY, AAD);
    const b = encryptSecret('hunter2', KEY, AAD);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  /**
   * Spec §4.4 — the control this whole design rests on, and the one that does
   * NOT depend on our having written the queries correctly. A row lifted from
   * one customer into another's must fail to open, not open wrongly.
   */
  it('refuses to open a row under a different business', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    expect(decryptSecret(sealed, KEY, { ...AAD, businessId: 'biz-b' })).toBeNull();
  });

  it('refuses to open a row under a different ref', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    expect(decryptSecret(sealed, KEY, { ...AAD, ref: 'OTHER_MAIL' })).toBeNull();
  });

  it('refuses to open with the wrong key', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    expect(decryptSecret(sealed, randomBytes(32), AAD)).toBeNull();
  });

  /**
   * A tampered row must be REFUSED, never returned altered. GCM authenticates,
   * so this is a property of the mode — the test is here because relying on a
   * property nobody checked is how it gets swapped for one that lacks it.
   */
  it('refuses a ciphertext that was altered by a single byte', () => {
    const sealed = encryptSecret('hunter2', KEY, AAD);
    const tampered = Buffer.from(sealed.ciphertext);
    const first = tampered[0];
    if (first === undefined) throw new Error('empty ciphertext');
    tampered[0] = first ^ 0x01;
    expect(decryptSecret({ ...sealed, ciphertext: tampered }, KEY, AAD)).toBeNull();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encryptSecret('hunter2', randomBytes(16), AAD)).toThrow();
  });
});
```

- [ ] **Step 4: הרץ וראה אותו נופל**

```bash
npm run migrate:test && npx vitest run src/governance/secret-cipher.test.ts
```
צפוי: FAIL — `Cannot find module './secret-cipher.js'`.

- [ ] **Step 5: המימוש**

צור `src/governance/secret-cipher.ts`:

```ts
/**
 * Sealing and opening one secret. No database, no files, no configuration —
 * so every property below is provable without any of them.
 *
 * **The business id and the ref are authenticated, not merely stored**
 * (spec §4.4). They are passed to the cipher as additional authenticated
 * data, which means the sealed bytes are bound to the row they belong to: a
 * ciphertext lifted from one customer's row into another's fails to open
 * rather than opening wrongly.
 *
 * That gives two independent controls on the same boundary — the `WHERE`
 * clause that filters by business, and this. A dropped predicate, a wrong
 * join, a swapped parameter: the class of bug that actually happens is not
 * enough on its own to hand one customer another's secret. This is the only
 * control in the design that does not depend on our having written the
 * queries correctly, which is why it is here and not left to the store.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretAad {
  businessId: string;
  ref: string;
}

export interface Sealed {
  /** Ciphertext with the GCM tag appended. */
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * The bytes the cipher authenticates alongside the secret.
 *
 * A length-prefixed join rather than a separator, so that a business called
 * `a` with ref `B_C` and a business called `a_B` with ref `C` cannot produce
 * the same authenticated data — an ambiguity that would quietly undo the
 * binding this function exists to create.
 */
function aadBytes(aad: SecretAad): Buffer {
  return Buffer.from(
    `${aad.businessId.length}:${aad.businessId}:${aad.ref.length}:${aad.ref}`,
    'utf8',
  );
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    // Thrown, not returned as null: a short key is a broken installation, not
    // a secret that failed to open. The two must not be indistinguishable.
    throw new Error(`secret-cipher: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

export function encryptSecret(plain: string, key: Buffer, aad: SecretAad): Sealed {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aadBytes(aad));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/**
 * Returns `null` for every failure — wrong key, wrong business, wrong ref,
 * altered bytes — and never distinguishes between them to the caller.
 *
 * Deliberate: the caller's only correct response to any of them is the same
 * (`credential_unavailable`, a final failure), and a message that says WHICH
 * check failed tells whoever provoked it something about the stored row.
 * The operator's diagnosis comes from the key check at startup
 * (`master-key.ts`), which runs before any real secret is touched.
 */
export function decryptSecret(sealed: Sealed, key: Buffer, aad: SecretAad): string | null {
  assertKey(key);
  if (sealed.ciphertext.length <= TAG_BYTES) return null;
  if (sealed.nonce.length !== NONCE_BYTES) return null;

  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce);
    decipher.setAAD(aadBytes(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // `final()` throws when the tag does not verify. That is the expected
    // path for every wrong-key and wrong-row case above, not an exception.
    return null;
  }
}
```

- [ ] **Step 6: הרץ עד ירוק**

```bash
npx vitest run src/governance/secret-cipher.test.ts && npm run typecheck
```
צפוי: 7 עוברים, typecheck נקי.

- [ ] **Step 7: הוכח שהבקרה המרכזית נושכת**

הסר את שתי השורות `setAAD(...)` (בהצפנה ובפענוח). הרץ שוב. צפוי: **שני המבחנים על עסק אחר ועל הפניה אחרת נופלים**, והשאר נשארים ירוקים. אם **לא** נפלו — הבקרה שהמפרט נשען עליה אינה נבדקת ויש לתקן לפני שממשיכים. החזר, ואמת זהות בייט-בבייט.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/027_credentials.sql src/governance/secret-cipher.ts src/governance/secret-cipher.test.ts src/test/db.ts
git commit -m "Seal a secret to the row it belongs to"
```

---

### Task 2: קובץ המפתח, ואימותו בעלייה

**Files:**
- Create: `src/governance/master-key.ts`
- Test: `src/governance/master-key.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret` (T1).
- Produces: `loadMasterKey(path: string): Promise<Buffer>`, `MasterKeyError`, `verifyKeyState(key: Buffer, options): Promise<void>`, `writeKeyState(key: Buffer, keyId: string, options): Promise<void>`, `KEY_BYTES = 32`.

- [ ] **Step 1: כתוב את המבחן הנופל**

צור `src/governance/master-key.test.ts`. השתמש ב-`node:fs/promises` ובתיקייה זמנית; **קרא קודם קובץ מבחן קיים שכותב קבצים זמניים** (`src/documents/` מלא בהם) וחקה את דפוס הניקוי שלו.

```ts
it('reads a 32-byte key file', async () => {
  // …write 32 random bytes, expect loadMasterKey to return them…
});

it('refuses a key file that is the wrong length', async () => {
  // …write 16 bytes, expect a MasterKeyError mentioning the length…
});

it('refuses when the file does not exist', async () => {
  // …expect a MasterKeyError, not an ENOENT leaking through…
});

/**
 * Spec §4.2 — permissions. On a POSIX filesystem a key readable by everyone
 * is a key that is not protected, and the install must refuse rather than
 * run with it. Windows reports a different mode, so the check is skipped
 * there and the test says so rather than asserting something untrue.
 */
it('refuses a world-readable key file on POSIX', async () => {
  // …chmod 0o644, expect MasterKeyError; skip on win32 with a stated reason…
});

/**
 * Spec §5.1 — a wrong or damaged key must be caught at startup, BEFORE any
 * real secret is touched. Without this, a replaced key file surfaces as a
 * customer's email failing at three in the morning rather than as a refusal
 * to start.
 */
it('accepts the key that wrote the key state', async () => {
  // …writeKeyState with key A, then verifyKeyState with key A resolves…
});

it('refuses a different key against a stored key state', async () => {
  // …writeKeyState with key A, verifyKeyState with key B rejects…
});

it('accepts any key when no key state has been written yet', async () => {
  // …a fresh install has no rows; verification must not block it…
});
```

- [ ] **Step 2: הרץ וראה אותו נופל**

```bash
npx vitest run src/governance/master-key.test.ts
```
צפוי: FAIL — `Cannot find module './master-key.js'`.

- [ ] **Step 3: המימוש**

צור `src/governance/master-key.ts`. הנקודות שחייבות להיות בו:

```ts
/**
 * The key lives in a file, and is read once into process memory.
 *
 * NOT an environment variable, and the difference is not stylistic: the
 * environment is inherited by child processes, appears in crash dumps, and
 * reaches logs. This project already guards against exactly that elsewhere —
 * the curator's SDK call is given `env: { PATH }` and nothing else — so a
 * master key in the environment would be the one secret handled less
 * carefully than the model prompts.
 */
export const KEY_BYTES = 32;

/**
 * Every failure to obtain a usable key. One error type, because the caller's
 * response to all of them is identical: refuse to start.
 */
export class MasterKeyError extends Error {}
```

`loadMasterKey` קורא את הקובץ, ו**מסרב** (זורק `MasterKeyError` עם הודעה בעברית לאדם) כאשר: הקובץ אינו קיים, אורכו אינו `KEY_BYTES`, או — על מערכות POSIX — ההרשאות מתירות קריאה לקבוצה או לאחרים. על Windows דלג על בדיקת ההרשאות **עם הערה שאומרת למה**, ולא בשקט.

`writeKeyState` מצפין ערך אימות ידוע בעזרת המפתח וכותב את השורה. `verifyKeyState` קורא את השורה, מנסה לפענח, **וזורק אם נכשל** — ואם אין שורה כלל, חוזר בשקט: התקנה חדשה אינה שגויה.

**חשוב:** ערך האימות אינו סוד ואין בעיה שהוא ידוע. מה שהוא מוכיח הוא שהמפתח שבקובץ הוא אותו מפתח שהצפין אותו.

- [ ] **Step 4: הרץ עד ירוק, ואז שתי מוטציות**

א. הפוך את `verifyKeyState` לכך שהוא בולע כישלון פענוח ולא זורק. צפוי: **"refuses a different key"** נופל.
ב. הסר את בדיקת האורך מ-`loadMasterKey`. צפוי: **"refuses a key file that is the wrong length"** נופל.
החזר אחרי כל אחת ואמת זהות בייט-בבייט. דווח מה ראית.

- [ ] **Step 5: Commit**

```bash
git add src/governance/master-key.ts src/governance/master-key.test.ts
git commit -m "The key file, and a wrong key that fails at startup rather than at 3am"
```

---

### Task 3: מזהה העסק נעשה חובה

משימה מכנית וקטנה בכוונה, מופרדת משאר העבודה: היא משנה חתימה שכל הקוד נוגע בה, ואם היא תיכנס יחד עם לוגיקה חדשה, סקירה לא תוכל להפריד בין השתיים.

**Files:**
- Modify: `src/orchestrator/credentials.ts`
- Modify: `src/orchestrator/run-plan.ts` — אתר הקריאה
- Modify: `src/orchestrator/adapters/adapters.test.ts` — **כאן** יושבים מבחני `envCredentials`

**היקף אמיתי, שנמדד ולא שוער.** `envCredentials` מוזכר ב-13 קובצי מבחן, אבל **רובם רק בונים מקור ומעבירים אותו הלאה** — והבנייה אינה משתנה. הקבצים שנשברים הם אלה שקוראים ל-`resolve` ישירות, וזה **`src/orchestrator/adapters/adapters.test.ts` בלבד**, עם כעשר קריאות. אם הקומפיילר מוצא עוד — תקן ודווח כמה היו.

**Interfaces:**
- Produces: `CredentialSource.resolve(ref: string, businessId: string): Promise<CredentialHandle | null>` — שני הארגומנטים חובה.

- [ ] **Step 1: שנה את הממשק**

```ts
export interface CredentialSource {
  /**
   * `businessId` is REQUIRED and has no default anywhere in this path.
   *
   * Everywhere else in this codebase the business is
   * `options.businessId ?? config.businessId`. Here that pattern is
   * forbidden: an omitted business would read silently as "the one in the
   * configuration", which is precisely the mechanism by which one customer
   * reads another's secret. Required means an omission is a compile error
   * rather than a wrong lookup at run time.
   */
  resolve(ref: string, businessId: string): Promise<CredentialHandle | null>;
}
```

`envCredentials` מקבל את הפרמטר החדש ו**מתעלם ממנו** — עם הערה שאומרת שהוא קיים למבחנים בלבד ושהמאגר האמיתי (T4) הוא זה שמשתמש בו. אל תמציא לו קידומת לפי עסק; זה היה מנגנון שני לא נבדק.

- [ ] **Step 2: אתר הקריאה**

ב-`src/orchestrator/run-plan.ts`, בפונקציה `performStep` (סביב שורה 485), שנה:

```ts
  const credential =
    credentialRef === null
      ? null
      : await request.credentials.resolve(credentialRef, request.job.businessId);
```

`request.job` הוא `Job` והוא נושא `businessId` — אומת. אין כאן מידע שצריך להשיג, רק להעביר אותו במקום להניח אותו.

- [ ] **Step 3: הרץ**

```bash
npm run typecheck && npx vitest run src/orchestrator/adapters/adapters.test.ts src/orchestrator/external.test.ts
```
`external.test.ts` הוא המקום שבו `credential_unavailable` נבדק בפועל — אומת — ולכן הוא הקובץ שמוכיח שאתר הקריאה עדיין מתנהג נכון. אם `typecheck` מוצא קוראים נוספים שלא ידעתי עליהם, **תקן ודווח כמה היו והיכן**: זו בדיוק המטרה של הפיכת השדה לחובה — הקומפיילר מוצא אותם במקומי.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/credentials.ts src/orchestrator/run-plan.ts src/orchestrator/adapters/adapters.test.ts
git commit -m "Resolving a secret requires a business, with no default to fall back to"
```

---

### Task 4: המאגר המוצפן, והחיווט

**Files:**
- Create: `src/governance/credential-store.ts`
- Modify: `src/orchestrator/runtime.ts`
- Test: `src/governance/credential-store.test.ts`, ותוספת ל-`src/orchestrator/runtime.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (T1), `loadMasterKey`/`verifyKeyState` (T2), `CredentialSource` (T3).
- Produces: `storedCredentials(key: Buffer, options?): CredentialSource`, `putSecret(input, options): Promise<void>`, `removeSecret(ref, businessId, options): Promise<boolean>`, `listSecretRefs(businessId, options): Promise<SecretSummary[]>` עם `SecretSummary = { ref: string; keyId: string; updatedAt: Date; updatedBy: string }`.

- [ ] **Step 1: כתוב את המבחנים הנופלים**

```ts
it('returns the secret that was stored', async () => { /* … */ });

/**
 * Control one of two (spec §9.1): the query filters by business.
 */
it('does not return another business\'s secret', async () => {
  // …put under biz-a, resolve under biz-b, expect null…
});

/**
 * Control two of two, and it must be tested SEPARATELY (spec §9.1): even if
 * the query returned the wrong row, the cipher refuses to open it. Seed the
 * row directly with the WRONG business_id so the query cannot save us, and
 * assert the resolve still returns null.
 */
it('refuses a row whose ciphertext belongs to another business, even when the query hands it over', async () => {
  // …encrypt for biz-a, INSERT it under biz-b's business_id by hand,
  //   resolve under biz-b, expect null…
});

it('replaces a secret rather than storing a second row for the same ref', async () => { /* … */ });

it('returns null for a ref that was never stored', async () => { /* … */ });

it('refuses a ref that is not the legal shape', async () => {
  // …lowercase, punctuation — expect null WITHOUT a query being needed…
});

it('lists refs with their metadata and never a value', async () => {
  // …assert the returned objects have no field carrying the secret…
});

/**
 * The handle's protection is the reason a secret cannot reach the
 * append-only audit log. Asserted as BEHAVIOUR on a real handle rather than
 * as a claim about the type (spec §9.2).
 */
it('hands back a handle whose value survives neither JSON nor the canonical serialiser', async () => {
  // …JSON.stringify(handle) has no secret; canonicalJson(handle) has none…
});
```

- [ ] **Step 2: הרץ וראה אותם נופלים**, ואז **Step 3: המימוש**

`storedCredentials(key)` מחזיר `CredentialSource`. `resolve(ref, businessId)`:
1. דוחה הפניה שאינה תואמת את `CREDENTIAL_REF_PATTERN` **לפני** כל פנייה לבסיס הנתונים;
2. שולף `WHERE business_id = $1 AND ref = $2`;
3. מפענח עם `{ businessId, ref }` כנתון המאומת — **אותו `businessId` שנמסר לפונקציה, לעולם לא זה שחזר מהשורה**. הערה בקוד חייבת לומר למה: שימוש בערך מהשורה היה הופך את הבקרה השנייה לחסרת משמעות, כי היא הייתה מאשרת את עצמה;
4. מחזיר `createCredentialHandle(ref, value)` או `null`.

- [ ] **Step 4: החיווט**

ב-`src/orchestrator/runtime.ts`, `buildRuntime` מקבל את המפתח ובונה `storedCredentials(key)` במקום `envCredentials(env)`. אם המפתח אינו נטען — הפעולה הנכונה היא **לסרב לעלות**, לא להמשיך בלי סודות: התקנה שרצה בלי סודות מייצרת כשלים שנראים כמו תקלות רשת.

- [ ] **Step 5: בקרה חיובית**

ב-`runtime.test.ts`, מבחן שמאמת שהמקור שהייצור בונה הוא המאגר המוצפן ולא זה של המבחנים. הפרויקט הזה כבר נכווה מכך שרכיב שקיים ואיש אינו משתמש בו הוא בדיוק הרכיב שמישהו מחבר בטעות.

- [ ] **Step 6: שתי מוטציות, ושתיהן חובה**

א. הסר את `AND business_id = $1` מהשאילתה. צפוי: **"does not return another business's secret"** נופל, ו**"refuses a row whose ciphertext belongs to another business"** נשאר ירוק — כי הצופן תופס אותו. זה בדיוק מה ששתי הבקרות אמורות להראות.
ב. החלף את `businessId` שנמסר לפונקציה ב-`row.business_id` בקריאה לפענוח. צפוי: **המבחן השני נופל**. אם לא — הבקרה השנייה אינה נבדקת.
דווח מה ראית בשתיהן. החזר ואמת זהות.

- [ ] **Step 7: Commit**

```bash
git add src/governance/credential-store.ts src/governance/credential-store.test.ts src/orchestrator/runtime.ts src/orchestrator/runtime.test.ts
git commit -m "The encrypted store, with the two controls tested apart"
```

---

### Task 5: הכלי — סודות, וביקורת

**Files:**
- Create: `src/cli/secret.ts`
- Modify: `src/domain/audit.ts` — `'credential_change'`
- Modify: `package.json` — `"secret": "tsx src/cli/secret.ts"`
- Test: `src/cli/secret.test.ts`

**Interfaces:**
- Consumes: `putSecret`, `removeSecret`, `listSecretRefs`, `storedCredentials` (T4), `loadMasterKey` (T2).
- Produces: `runSecretCli(argv: string[], deps: SecretCliDeps): Promise<void>` עם `SecretCliDeps = { log: (line: string) => void; readSecret: () => Promise<string>; businessId?: string }`.

- [ ] **Step 1: סוג הביקורת**

הוסף `'credential_change'` ל-`AuditKind` עם דוקבלוק בסגנון השכנים, שאומר שהשורה נושאת את העסק, ההפניה והמפעיל — **ולעולם לא את הערך**. ל-`audit_log.kind` אין אילוץ `CHECK` ב-SQL — אומת — ולכן אין מיגרציה.

- [ ] **Step 2: כתוב את המבחנים הנופלים**

```ts
it('stores a secret read from the input, not from argv', async () => {
  // …runSecretCli(['put', 'biz-a', 'OFFICE_MAIL'], { readSecret: async () => 'hunter2' })
  //   then resolve it back…
});

/**
 * Spec §6.2 — an argument appears in shell history and in the machine's
 * process list, so the secret would leak at the exact moment of securing it.
 */
it('refuses a put that carries the secret as an argument', async () => {
  // …four positional args → throws, and nothing is written…
});

/**
 * Spec §9.6 — no path prints a value. Asserted over EVERY line the tool
 * emitted, for every command, not just the one that seemed risky.
 */
it('never prints the secret, in any command', async () => {
  // …put, list, test — assert no emitted line contains the secret…
});

it('reports whether a ref resolves without revealing what it resolves to', async () => { /* … */ });

it('writes an audit row naming the business, the ref and the operator', async () => { /* … */ });

it('writes no audit row that contains the value', async () => {
  // …scan every audit_log text column for the secret…
});

it('refuses an unknown command and names the valid ones', async () => { /* … */ });
```

- [ ] **Step 3: המימוש** — פקודות `put`, `list`, `remove`, `test`. אין `show`; המפרט §6.3 מתעד שזו הכרעה של בעל הפרויקט עם המחיר לצידה.

- [ ] **Step 4: הרץ, ואז מוטציה** — גרום ל-`put` לקבל את הסוד מ-argv. צפוי: **"refuses a put that carries the secret as an argument"** נופל. החזר ואמת זהות.

- [ ] **Step 5: Commit**

```bash
git add src/cli/secret.ts src/cli/secret.test.ts src/domain/audit.ts package.json
git commit -m "The platform owner's tool: stdin in, never a value out"
```

---

### Task 6: הכלי — המפתח ושרידותו

**Files:**
- Create: `src/cli/secret-key.ts`
- Modify: `package.json` — `"secret:key": "tsx src/cli/secret-key.ts"`
- Test: `src/cli/secret-key.test.ts`

**Interfaces:**
- Consumes: `loadMasterKey`, `writeKeyState`, `verifyKeyState`, `KEY_BYTES` (T2); `encryptSecret`/`decryptSecret` (T1).
- Produces: `runSecretKeyCli(argv, deps): Promise<void>`; פקודות `create`, `rotate`, `restore`.

- [ ] **Step 1: כתוב את המבחנים הנופלים**

```ts
/**
 * Spec §5.2 — the recovery copy. Losing the key file must be a nuisance, not
 * a catastrophe; losing the passphrase as well is the catastrophe, and that
 * residue is stated rather than engineered away.
 */
it('restores exactly the original key from the recovery copy', async () => { /* … */ });

it('refuses to restore with the wrong passphrase', async () => { /* … */ });

/**
 * Spec §5.3 — shown once at creation, never again. A tool that can reprint
 * the key is a tool that will be asked to.
 */
it('prints the key once at creation and has no command that prints it again', async () => { /* … */ });

it('writes the key state so a later verification can recognise this key', async () => { /* … */ });

it('refuses to create a key where one already exists, rather than overwriting it', async () => {
  // …overwriting a key file orphans every stored secret, irreversibly…
});

/**
 * Spec §4.5 — rotation re-encrypts every row under the new key and leaves
 * none behind. A partial rotation is worse than none: some rows open with
 * the old key, some with the new, and no single key opens the install.
 */
it('re-encrypts every stored secret on rotation, leaving none under the old key', async () => { /* … */ });
```

- [ ] **Step 2: המימוש.** `create` מייצר `KEY_BYTES` אקראיים, כותב את קובץ המפתח בהרשאות מצומצמות, כותב את מצב המפתח, מייצר את עותק השחזור המוגן בסיסמה (נגזרת ב-`scrypt` — אותו מנגנון שהדשבורד כבר משתמש בו לסיסמאות; **קרא את `src/dashboard/auth.ts` לפני**), ומדפיס את המפתח פעם אחת עם אזהרה בעברית. `restore` הופך את זה. `rotate` מצפין מחדש את כל השורות **בטרנזקציה אחת** ומעדכן את מצב המפתח — אחרת החלפה שנקטעה משאירה התקנה ששום מפתח יחיד אינו פותח.

- [ ] **Step 3: הרץ, ואז מוטציה** — הפוך את `rotate` לכתיבה מחוץ לטרנזקציה והפל אותה באמצע. צפוי: **מבחן ההחלפה** נופל. החזר ואמת זהות.

- [ ] **Step 4: Commit**

```bash
git add src/cli/secret-key.ts src/cli/secret-key.test.ts package.json
git commit -m "Key creation, rotation, and a recovery copy that costs nothing to store"
```

---

### Task 7: תיעוד

**Files:**
- Modify: `CLAUDE.md`, `docs/09-roadmap.md`, `.env.example`, `docs/10-user-settings.md`

- [ ] **Step 1: CLAUDE.md** — ב"כללים שהקוד אוכף בשקט", פסקאות על: שמזהה העסק בנתיב הסודות הוא חובה ובלי ברירת מחדל, **ולמה** הדפוס המקובל בשאר המערכת אסור דווקא כאן; ששתי בקרות הבידוד בלתי-תלויות ושרק אחת מהן אינה תלויה בכתיבת שאילתה נכונה; שהמפתח בקובץ ולא בסביבה, עם הנימוק על ירושה לתת-תהליכים; ושאובדן שלוש שכבות השרידות הוא בלתי הפיך.

- [ ] **Step 2: `.env.example`** — הנתיב לקובץ המפתח, עם הערה שהקובץ עצמו **אינו** נכנס לגיט ואינו מגובה יחד עם בסיס הנתונים.

- [ ] **Step 3: `docs/09-roadmap.md`** — לסגור את `CredentialBroker` בשלב 0, ולציין במפורש מה **לא** נבנה: כספת חיצונית, פיצול מפתח, והזנת סוד על ידי הלקוח.

- [ ] **Step 4: `docs/10-user-settings.md`** — הקובץ המתעדכן של הגדרות המשתמש. להוסיף ערך על החיבורים: מי מכניס את הסוד (בעל הפלטפורמה), ומה הלקוח **אינו** יכול לעשות — כולל שאינו יכול לראות או להחליף את הסוד בעצמו.

- [ ] **Step 5: ספירת המבחנים** — `npm test` לבד ובחזית, לקרוא את המספר בפועל, ולעדכן את שורת `npm test` בראש `CLAUDE.md`.

- [ ] **Step 6: Commit**

---

## Self-Review

**כיסוי המפרט.** §3.1–3.3 → T3. §3.4 → T4 צעד 5. §3.5 → T3 (ללא שינוי חוזה). §4.1–4.2 → T2. §4.3–4.4 → T1. §4.5 → T6. §5.1 → T2. §5.2–5.3 → T6. §5.5 → T7 צעד 2. §6.1–6.3 → T5. §6.4–6.6 → T5. §7 → T1 (מיגרציה) ו-T5 (סוג הביקורת). §8 → T7 צעד 3. §9.1 → T1 צעד 7 **ו**-T4 צעד 6 — שתי הבקרות, בשתי רמות, כל אחת עם המוטציה שלה. §9.2 → T4. §9.3 → T2. §9.4 → T6. §9.5 → T4. §9.6 → T5. §9.7 → כל מבחן שלילי בתוכנית מאמת גם שהפעולה בוצעה.

**מצייני מקום.** משימות 4, 5 ו-6 נותנות את גופי המבחנים כשמות ותגובות ולא כקוד מלא — **מוצהר כאן ולא מוסתר**. הסיבה: שלושתן זורעות מול בסיס נתונים אמיתי וחתימות שהמבצע חייב לקרוא בעצמו (`putSecret`, `appendAudit`, `scrypt`), והכתבת גוף מבחן מול חתימה שלא הרצתי היא בדיוק מה שהכניס שישה פגמים לתוכנית הקודמת. כל אחת מהן נושאת במקום זאת **מוטציה ספציפית שחייבת להפיל מבחן נקוב בשם** — וזו הבדיקה האמיתית שהמבחן שווה משהו.

**עקביות טיפוסים.** `SecretAad` ו-`Sealed` מוגדרים ב-T1 ונצרכים ב-T2, T4, T6. `KEY_BYTES` מ-T2 נצרך ב-T6. `CredentialSource.resolve(ref, businessId)` מ-T3 ממומש ב-T4 ונצרך ב-`run-plan.ts`. `storedCredentials` מ-T4 נצרך ב-T5. `SecretSummary` מוגדר ב-T4 ומוחזר ל-T5.

**מה שאומת בקוד לפני הכתיבה, ולא הונח:** `performStep` (שורה 431) מקבל `request` שנושא `job`, ו-`Job` נושא `businessId` — כך שהשינוי ב-T3 הוא העברת ערך שכבר ביד ולא השגת מידע חדש. `createCredentialHandle` בונה את הערך כתכונה לא-מנייתית, ולכן הגנת ההידית ב-T4 קיימת ואינה נכתבת מחדש. ל-`audit_log.kind` אין אילוץ `CHECK` ב-SQL, ולכן סוג ביקורת חדש ב-T5 אינו דורש מיגרציה. `src/dashboard/auth.ts` כבר משתמש ב-`scrypt` ובגזירת מפתח, והוא התקדים ל-T6.

**שני פגמים שהסריקה שלי תפסה בתוכנית הזו לפני השיגור.** משימה 3 הפנתה ל-`src/orchestrator/credentials.test.ts` ול-`src/orchestrator/run-plan.test.ts` — **שניהם אינם קיימים**. מבחני `envCredentials` יושבים ב-`src/orchestrator/adapters/adapters.test.ts`, ו-`credential_unavailable` נבדק ב-`external.test.ts`. תוקן, ובאותה הזדמנות נמדד ההיקף האמיתי: 13 קבצים מזכירים את `envCredentials`, אבל רק אחד קורא ל-`resolve` ישירות ולכן רק הוא נשבר. רשום כאן ולא נמחק בשקט, כי בתוכנית הקודמת שישה פגמים בטקסט שלי הגיעו עד למבצעים.

**סיכון שנרשם למבצעים.** בדיקת ההרשאות ב-T2 תלויה במערכת ההפעלה: Windows מדווח מצב קבצים אחרת, ולכן הבדיקה מדלגת שם **עם הערה מפורשת** ולא בשקט. מבחן שמדלג בשקט מדווח ירוק על עבודה שלא נעשתה.
