# שדרת החיבור — תוכנית ביצוע

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** להפוך הצהרת חיבור בתקנון לחיבור אמיתי לספק חיצוני — מאגר הרשאות OAuth מוצפן, שירות אסימונים, מרשם ספקים, וטקס הרשאה בדשבורד — ולהוכיח זאת בקריאת יומן אמיתית אחת מול Google.

**Architecture:** שורת הרשאה מוצפנת באותו צופן ובאותו מפתח אב שהסודות משתמשים בהם, עם קישור AAD `grant:<system>` שהופך הרשאה וסוד לזרים מבנית. שירות האסימונים מיושם כ-`CredentialSource` **מורכב מעל** הקיים, ולכן `performStep`, `AdapterCall` ומתאם הדואר אינם משתנים. הספקים נרשמים כמתאמים לפי שם המערכת שהתקנון מצהיר עליו, ועמודת `provider` ב-binding קובעת איזה קוד רץ.

**Tech Stack:** TypeScript NodeNext ESM (`.js` בכל ייבוא יחסי) · Postgres 17 דרך `pg` · zod · vitest מול בסיס נתונים אמיתי · `node:crypto` (AES-GCM, כבר עטוף ב-`secret-cipher.ts`) · `fetch` מקומי של Node לקריאות הספק.

**Spec:** [docs/superpowers/specs/2026-09-28-connector-spine-design.md](../specs/2026-09-28-connector-spine-design.md)

## Global Constraints

- **מזהה עסק חובה בכל נתיב הרשאה ואסימון, בלי ברירת מחדל.** הדפוס `options.businessId ?? config.businessId` **אסור** בכל קוד שנוגע בהרשאה או באסימון. השמטה חייבת להיות שגיאת קומפילציה.
- **ערך אסימון אינו מופיע** באף עמודת טקסט, באף לוג, ב-`process.env`, ובאף תת-תהליך. גם לא ב-`connection_bindings.last_error`.
- **ה-AAD להרשאה הוא `grant:<system>`** — אותיות קטנות ונקודתיים, כך שלא ייתכן שסוד ייפתח כהרשאה או להיפך. אל תנרמלו לאותיות גדולות.
- **`putSecret` אינו משתנה ואינו נקרא מקוד חדש.** מאגר הסודות נשאר עם כותב אחד — ה-CLI.
- **`evaluateToolCall` אינו משתנה בבייט אחד.** אין שלב אחד-עשר.
- **`AdapterCall`, `performStep` ומתאם הדואר אינם משתנים** — לא בהתנהגות ולא בטיפוסים (מפרט §3.1א, §4.4).
- **`retryable: true` הוא הצהרה שכלום לא נוצר.** ניסיון חוזר אוטומטי על 401 מותר **רק** לכלי קריאה-בלבד.
- **`revoked_at` נבדק בכל קריאה**, גם כשאסימון הגישה במטמון בתוקף.
- **כל ייבוא יחסי נגמר ב-`.js`**, גם מקבצי `.ts`.
- **מבחנים רצים מול Postgres אמיתי.** אין mock ואין DB בזיכרון. `resetDatabase()` ב-`src/test/db.ts` נוקב בטבלאות ביד — **טבלה חדשה שלא תתווסף לשם תדלוף בין מבחנים.**
- **עברית לבני אדם, אנגלית לקוד.** הודעות סירוב ופלט למפעיל בעברית; מזהים, הערות ושגיאות פנימיות באנגלית.
- **מבחן שלילי חייב לאשר שהדבר הנבדק רץ בפועל.** אסרשן על היעדר בלי חצי חיובי לפניו הוא מבחן שעובר מהסיבה הלא נכונה.

---

## מפת הקבצים

| קובץ | אחריות |
|---|---|
| `src/db/migrations/032_oauth_grants.sql` | טבלת ההרשאות |
| `src/db/migrations/033_binding_provider.sql` | עמודת `provider` ב-`connection_bindings` |
| `src/db/migrations/034_oauth_states.sql` | טבלת ה-`state` החד-פעמי של טקס ההרשאה |
| `src/governance/oauth-grants.ts` | קריאה, כתיבה, ביטול וסימון של שורת הרשאה. **הכותב היחיד** |
| `src/orchestrator/oauth-token.ts` | `CredentialSource` מורכב: הרשאה → אסימון גישה; נפילה למאגר הסודות |
| `src/orchestrator/adapters/google-calendar.ts` | מתאם Google ליומן, `calendar.read` בלבד |
| `src/governance/oauth-state.ts` | יצירה וצריכה של `state` חד-פעמי |
| `src/dashboard/oauth-consent.ts` | בניית כתובת ההסכמה, PKCE, והחלפת קוד באסימון |
| `src/dashboard/oauth-routes.ts` | שלושת הנתיבים: התחלה, חזרה, ביטול |
| `src/dashboard/connection-groups.ts` | כותרת עברית לכל סוג חיבור, נגזרת מ-`serves` |
| `src/charter/connector-invariants.test.ts` | שתי סריקות המקור |

**קבצים קיימים שמשתנים, ובמדויק:** `src/governance/credential-store.ts` (מייצא את `liveKeyId`) · `src/cli/secret-key.ts` (החלפת מפתח מכסה גם הרשאות) · `src/orchestrator/bindings.ts` (עמודת `provider`) · `src/orchestrator/runtime.ts` (הרכבה תוספתית) · `src/orchestrator/run-plan.ts` (כתיבת בריאות ה-binding) · `src/dashboard/server.ts` + `views.ts` (נתיבים ומסך) · `scripts/live-thread-status.ts` (שורות מוכנות) · `src/test/db.ts` (שלוש טבלאות חדשות) · `CLAUDE.md` + `docs/live-thread-runbook.md`.

---

## Task 1: מאגר ההרשאות

**Files:**
- Create: `src/db/migrations/032_oauth_grants.sql`
- Create: `src/governance/oauth-grants.ts`
- Create: `src/governance/oauth-grants.test.ts`
- Modify: `src/governance/credential-store.ts` — להוסיף `export` ל-`liveKeyId` (שורה 149)
- Modify: `src/test/db.ts` — להוסיף `oauth_grants` לרשימת ה-TRUNCATE, **לפני** `credentials`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret`/`SecretAad` מ-`../governance/secret-cipher.js` · `verifyKeyState` מ-`./master-key.js` · `ROTATION_LOCK_SCOPE` ו-`liveKeyId` מ-`./credential-store.js` · `withTransaction`, `getPool`, `acquireAdvisoryLock`, `Queryable` מהמקומות שבהם `credential-store.ts` מייבא אותם (העתק את שורות הייבוא משם).
- Produces:

```ts
export const GRANT_AAD_PREFIX = 'grant:';
export function grantAad(businessId: string, system: string): SecretAad;

export interface OAuthGrantSummary {
  system: string;
  provider: string;
  credentialRef: string;
  account: string;
  scopes: string[];
  grantedAt: string;
  grantedBy: string;
  lastRefreshedAt: string | null;
  refreshCount: number;
  revokedAt: string | null;
  needsReauthAt: string | null;
}
export interface OAuthGrant extends OAuthGrantSummary { refreshToken: string }

export interface WriteGrantInput {
  businessId: string;
  system: string;
  provider: string;
  credentialRef: string;
  account: string;
  scopes: readonly string[];
  refreshToken: string;
  grantedBy: string;
}
export async function writeGrant(input: WriteGrantInput, key: Buffer, options?: { db?: Queryable }): Promise<void>;
export async function readGrantByRef(credentialRef: string, businessId: string, key: Buffer, options?: { db?: Queryable }): Promise<OAuthGrant | null>;
export async function readGrantBySystem(system: string, businessId: string, key: Buffer, options?: { db?: Queryable }): Promise<OAuthGrant | null>;
export async function listGrants(businessId: string, options?: { db?: Queryable }): Promise<OAuthGrantSummary[]>;
export async function recordRefresh(system: string, businessId: string, rotatedRefreshToken: string | null, key: Buffer, options?: { db?: Queryable }): Promise<void>;
export async function revokeGrant(system: string, businessId: string, by: string, options?: { db?: Queryable }): Promise<boolean>;
export async function markNeedsReauth(system: string, businessId: string, options?: { db?: Queryable }): Promise<void>;
export class OAuthGrantError extends Error {}
```

- [ ] **Step 1: כתוב את המיגרציה**

```sql
-- One encrypted OAuth grant per (business, system). The refresh token never
-- appears in any other column. Sealed under the same master key as
-- `credentials`, but with AAD `grant:<system>` -- a string a real secret ref
-- can never equal, because `credentials.ref` is constrained to
-- ^[A-Z0-9_]+$. That is what makes a grant and a secret structurally
-- unopenable as one another, with no blocklist to maintain.
CREATE TABLE oauth_grants (
    business_id       TEXT NOT NULL,
    system            TEXT NOT NULL,
    provider          TEXT NOT NULL,
    -- The ref the binding names. This is how the row is FOUND (spec 3.1a):
    -- performStep resolves by ref, so the grant answers to the same ref.
    credential_ref    TEXT NOT NULL,
    account           TEXT NOT NULL,
    scopes            TEXT[] NOT NULL,
    ciphertext        BYTEA NOT NULL,
    nonce             BYTEA NOT NULL,
    key_id            TEXT NOT NULL,
    granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by        TEXT NOT NULL,
    last_refreshed_at TIMESTAMPTZ,
    refresh_count     INTEGER NOT NULL DEFAULT 0,
    -- Soft, like a retired memory: a business needs to know access EXISTED.
    revoked_at        TIMESTAMPTZ,
    -- Set when the provider refuses the refresh token: the owner must consent
    -- again. Distinct from `revoked_at`, which is the owner's own act.
    needs_reauth_at   TIMESTAMPTZ,
    PRIMARY KEY (business_id, system),
    CONSTRAINT oauth_grants_ref_shape CHECK (credential_ref ~ '^[A-Z0-9_]+$')
);

-- The lookup performStep drives. Unique per business so a ref cannot address
-- two grants; a ref shared with a static secret is refused in code, not here,
-- because the two live in different tables.
CREATE UNIQUE INDEX oauth_grants_by_ref ON oauth_grants (business_id, credential_ref);
```

- [ ] **Step 2: הוסף את הטבלה ל-`resetDatabase`**

ב-`src/test/db.ts`, בתוך משפט ה-`TRUNCATE`, מיד **לפני** השורה `credentials,`:

```
      oauth_grants,
```

- [ ] **Step 3: ייצא את `liveKeyId`**

ב-`src/governance/credential-store.ts` שורה 149, הוסף `export`:

```ts
export async function liveKeyId(db: Queryable): Promise<string> {
```

והוסף לדוקבלוק שלה שורה אחת: `Exported for \`oauth-grants.ts\`, which seals rows under the same live key id and must not read the key-state table a second way.`

- [ ] **Step 4: כתוב את המבחן שנכשל**

`src/governance/oauth-grants.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { decryptSecret } from './secret-cipher.js';
import { writeKeyState } from './master-key.js';
import { listGrants, readGrantByRef, readGrantBySystem, revokeGrant, writeGrant } from './oauth-grants.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';
const KEY = randomBytes(32);

const GRANT = {
  system: 'office-calendar',
  provider: 'google',
  credentialRef: 'OFFICE_CALENDAR',
  account: 'owner@example.com',
  scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  refreshToken: 'refresh-token-value-A',
  grantedBy: 'owner',
} as const;

describe('the OAuth grant store', () => {
  beforeEach(async () => {
    await resetDatabase();
    await writeKeyState(KEY, 'KEY-test', { businessId: BUSINESS });
    await writeKeyState(KEY, 'KEY-test', { businessId: OTHER });
  });

  afterAll(async () => {
    await closePool();
  });

  it('round-trips a grant, and the token is nowhere but the ciphertext', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);

    const read = await readGrantByRef(GRANT.credentialRef, BUSINESS, KEY);
    expect(read?.refreshToken).toBe(GRANT.refreshToken);
    expect(read?.account).toBe(GRANT.account);
    expect(read?.scopes).toEqual([...GRANT.scopes]);

    // The positive half is above. Now: the value appears in no other column.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM oauth_grants
        WHERE business_id = $1
          AND (provider LIKE $2 OR credential_ref LIKE $2 OR account LIKE $2
               OR array_to_string(scopes, ' ') LIKE $2 OR granted_by LIKE $2)`,
      [BUSINESS, `%${GRANT.refreshToken}%`],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('gives each business its own grant when both store the same ref', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    await writeGrant({ businessId: OTHER, ...GRANT, refreshToken: 'refresh-token-value-B' }, KEY);

    expect((await readGrantByRef(GRANT.credentialRef, BUSINESS, KEY))?.refreshToken).toBe('refresh-token-value-A');
    expect((await readGrantByRef(GRANT.credentialRef, OTHER, KEY))?.refreshToken).toBe('refresh-token-value-B');
  });

  it('cannot be opened as if it were a secret', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const { rows } = await getPool().query<{ ciphertext: Buffer; nonce: Buffer }>(
      'SELECT ciphertext, nonce FROM oauth_grants WHERE business_id = $1 AND system = $2',
      [BUSINESS, GRANT.system],
    );
    const sealed = { ciphertext: rows[0]!.ciphertext, nonce: rows[0]!.nonce };

    // The AAD a secret would be opened under: the bare ref, uppercase.
    expect(decryptSecret(sealed, KEY, { businessId: BUSINESS, ref: GRANT.credentialRef })).toBeNull();
    // And the AAD it was actually sealed under opens it -- the positive half,
    // so the null above is the binding working and not a broken write.
    expect(decryptSecret(sealed, KEY, { businessId: BUSINESS, ref: `grant:${GRANT.system}` })).toBe(GRANT.refreshToken);
  });

  it('revokes softly: the row stays, and a read refuses it', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    expect(await revokeGrant(GRANT.system, BUSINESS, 'owner')).toBe(true);

    expect(await readGrantBySystem(GRANT.system, BUSINESS, KEY)).toBeNull();
    const summaries = await listGrants(BUSINESS);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.revokedAt).not.toBeNull();
  });

  it('never returns the token from listGrants', async () => {
    await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
    const summaries = await listGrants(BUSINESS);
    expect(JSON.stringify(summaries)).not.toContain(GRANT.refreshToken);
    expect(summaries[0]?.account).toBe(GRANT.account);
  });
});
```

- [ ] **Step 5: הרץ ואמת שנכשל**

Run: `npx vitest run src/governance/oauth-grants.test.ts`
Expected: FAIL — `Cannot find module './oauth-grants.js'`

- [ ] **Step 6: כתוב את המימוש**

`src/governance/oauth-grants.ts`. העתק את שורות הייבוא של `credential-store.ts` (אותם `getPool`/`withTransaction`/`acquireAdvisoryLock`/`Queryable`). הליבה:

```ts
/** The AAD every grant row is sealed under. Lowercase and colon-bearing on
 *  purpose: `credentials.ref` is constrained to ^[A-Z0-9_]+$, so this string
 *  can never equal a real secret ref, and neither row can be opened as the
 *  other. The same trick `key-check` and `key-recovery` already rely on.
 *  Do NOT "clean" it to uppercase. */
export const GRANT_AAD_PREFIX = 'grant:';

export function grantAad(businessId: string, system: string): SecretAad {
  return { businessId, ref: `${GRANT_AAD_PREFIX}${system}` };
}

export async function writeGrant(
  input: WriteGrantInput,
  key: Buffer,
  options: { db?: Queryable } = {},
): Promise<void> {
  const write = async (db: Queryable): Promise<void> => {
    // The SAME lock putSecret takes, not a narrower one: it serialises two
    // concurrent refreshes (which would store a token the provider already
    // invalidated) AND key rotation, which reads the key id and writes rows
    // in separate statements.
    await acquireAdvisoryLock(db, ROTATION_LOCK_SCOPE);
    await verifyKeyState(key, { businessId: input.businessId, db });
    const keyId = await liveKeyId(db);
    const sealed = encryptSecret(input.refreshToken, key, grantAad(input.businessId, input.system));

    await db.query(
      `INSERT INTO oauth_grants
         (business_id, system, provider, credential_ref, account, scopes,
          ciphertext, nonce, key_id, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (business_id, system) DO UPDATE
         SET provider = EXCLUDED.provider,
             credential_ref = EXCLUDED.credential_ref,
             account = EXCLUDED.account,
             scopes = EXCLUDED.scopes,
             ciphertext = EXCLUDED.ciphertext,
             nonce = EXCLUDED.nonce,
             key_id = EXCLUDED.key_id,
             granted_at = now(),
             granted_by = EXCLUDED.granted_by,
             last_refreshed_at = NULL,
             refresh_count = 0,
             revoked_at = NULL,
             needs_reauth_at = NULL`,
      [input.businessId, input.system, input.provider, input.credentialRef, input.account,
       [...input.scopes], sealed.ciphertext, sealed.nonce, keyId, input.grantedBy],
    );
  };
  if (options.db) return write(options.db);
  await withTransaction((tx) => write(tx));
}
```

`readGrantByRef` ו-`readGrantBySystem` חולקות מימוש פרטי אחד. שניהם מסננים **`revoked_at IS NULL`** — שורה שבוטלה אינה נקראת — ומחזירים `null` אם הפענוח נכשל (מפתח שגוי), בדיוק כפי ש-`storedCredentials` עושה. `listGrants` **אינו מקבל מפתח בכלל** — הטיפוס שלו הוא מה שמונע ממנו להחזיר אסימון. `revokeGrant` הוא `UPDATE ... SET revoked_at = now() WHERE revoked_at IS NULL` ומחזיר האם שורה השתנתה. `markNeedsReauth` כותב `needs_reauth_at = now()` ואינו נוגע ב-`revoked_at`. `recordRefresh` מעלה את המונה, כותב חותמת, ומחליף את הצופן **רק** אם הספק סיבב את אסימון הרענון.

- [ ] **Step 7: הרץ ואמת שעובר**

Run: `npx vitest run src/governance/oauth-grants.test.ts`
Expected: PASS, 5 מבחנים

- [ ] **Step 8: הרץ מוטציה אחת ואמת שהיא מאדימה**

שנה את ה-AAD ב-`grantAad` ל-`{ businessId, ref: system.toUpperCase() }`.
Run: `npx vitest run src/governance/oauth-grants.test.ts`
Expected: FAIL על `cannot be opened as if it were a secret`. **החזר את השינוי.**

- [ ] **Step 9: Commit**

```bash
git add src/db/migrations/032_oauth_grants.sql src/governance/oauth-grants.ts src/governance/oauth-grants.test.ts src/governance/credential-store.ts src/test/db.ts
git commit -m "The grant store: sealed under the same key, unopenable as a secret"
```

---

## Task 2: החלפת מפתח אב מכסה גם הרשאות

**Files:**
- Modify: `src/cli/secret-key.ts` — בתוך `rotate`, אחרי לולאת `credentials` (סביב שורה 563)
- Create: `src/cli/secret-key-grants.test.ts`

**Interfaces:**
- Consumes: `readGrantBySystem`, `writeGrant`, `grantAad` מ-`../governance/oauth-grants.js`
- Produces: אין ממשק חדש. התנהגות: אחרי `rotate`, שורת הרשאה נפתחת במפתח החדש ולא בישן.

- [ ] **Step 1: כתוב את המבחן שנכשל**

```ts
it('re-encrypts OAuth grants too, so rotation does not kill every connection', async () => {
  await writeKeyState(OLD_KEY, 'KEY-old', { businessId: BUSINESS });
  await writeGrant({ businessId: BUSINESS, ...GRANT }, OLD_KEY);

  await runRotate(); // the CLI's rotate, with the test's key path and passphrase deps

  const newKey = await loadMasterKey(KEY_PATH);
  // The positive half first: the new key is genuinely different, so the read
  // below proves re-encryption and not that nothing happened.
  expect(newKey.equals(OLD_KEY)).toBe(false);
  expect((await readGrantBySystem(GRANT.system, BUSINESS, newKey))?.refreshToken).toBe(GRANT.refreshToken);
  expect(await readGrantBySystem(GRANT.system, BUSINESS, OLD_KEY)).toBeNull();
});
```

הרכב את `runRotate` לפי הדפוס שכבר קיים ב-`src/cli/secret-key.test.ts` — אותם `deps` ואותה דרך להזין סיסמה.

- [ ] **Step 2: הרץ ואמת שנכשל**

Run: `npx vitest run src/cli/secret-key-grants.test.ts`
Expected: FAIL — ההרשאה נפתחת עוד במפתח הישן ולא בחדש.

- [ ] **Step 3: הוסף את הלולאה השנייה ב-`rotate`**

מיד אחרי לולאת ה-`credentials` ולפני `writeKeyState`, בתוך אותה טרנזקציה:

```ts
    // The same loop for grants. A new table that is not wired here means a key
    // rotation silently kills every connection: the row stays sealed under the
    // old key while `credential_key_state` says otherwise, and nothing throws
    // until the next refresh. This is the defect class erasure was burned by
    // twice, and `connector-invariants.test.ts` is what keeps it closed.
    const { rows: grantRows } = await tx.query<{
      business_id: string; system: string; ciphertext: Buffer; nonce: Buffer;
    }>('SELECT business_id, system, ciphertext, nonce FROM oauth_grants FOR UPDATE');

    for (const row of grantRows) {
      const plain = decryptSecret(
        { ciphertext: row.ciphertext, nonce: row.nonce },
        oldKey,
        grantAad(row.business_id, row.system),
      );
      if (plain === null) {
        throw new Error(
          `החלפת המפתח בוטלה: הרשאת ה-OAuth (${row.business_id}, ${row.system}) אינה ` +
            'נפתחת במפתח הנוכחי — שום שורה לא שונתה.',
        );
      }
      const sealed = encryptSecret(plain, newKey, grantAad(row.business_id, row.system));
      await tx.query(
        `UPDATE oauth_grants SET ciphertext = $1, nonce = $2, key_id = $3
           WHERE business_id = $4 AND system = $5`,
        [sealed.ciphertext, sealed.nonce, newKeyId, row.business_id, row.system],
      );
    }
```

הוסף את מספר ההרשאות ל-`rotated` שהפקודה מדפיסה, כשתי ספירות נפרדות ולא אחת מאוחדת: "12 סודות ו-2 הרשאות" אומר למפעיל יותר מ-"14 שורות".

- [ ] **Step 4: הרץ ואמת שעובר**

Run: `npx vitest run src/cli/secret-key-grants.test.ts src/cli/secret-key.test.ts`
Expected: PASS בשני הקבצים

- [ ] **Step 5: Commit**

```bash
git add src/cli/secret-key.ts src/cli/secret-key-grants.test.ts
git commit -m "Key rotation covers grants, or it kills every connection in silence"
```

---

## Task 3: שירות האסימונים כ-`CredentialSource` מורכב

**Files:**
- Create: `src/orchestrator/oauth-token.ts`
- Create: `src/orchestrator/oauth-token.test.ts`

**Interfaces:**
- Consumes: `CredentialSource`, `createCredentialHandle` מ-`./credentials.js` ו-`./adapters/types.js` (ראה מאיפה `credentials.ts` מייבא) · `readGrantByRef`, `recordRefresh`, `markNeedsReauth` מ-`../governance/oauth-grants.js`
- Produces:

```ts
/** The one network call this module makes. Injectable for the same reason
 *  `createSmtpTransport`'s factory is: the step that costs money and needs a
 *  provider must be drivable by a test without one. */
export interface TokenHttp {
  exchangeRefresh(input: {
    provider: string;
    refreshToken: string;
    signal: AbortSignal;
  }): Promise<RefreshOutcome>;
}
export type RefreshOutcome =
  | { ok: true; accessToken: string; expiresInSeconds: number; rotatedRefreshToken: string | null }
  | { ok: false; kind: 'rejected' | 'transient'; message: string };

export class AmbiguousCredentialRefError extends Error {}
export class OAuthRefreshRejectedError extends Error {}   // terminal
export class OAuthRefreshTransientError extends Error {}  // retryable

export function oauthCredentials(options: {
  key: Buffer;
  fallback: CredentialSource;
  http: TokenHttp;
  now?: () => number;
}): CredentialSource;
```

- [ ] **Step 1: כתוב את המבחנים שנכשלים**

```ts
it('mints an access token from a stored grant', async () => {
  await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
  const http = recordingHttp({ accessToken: 'access-1', expiresInSeconds: 3600 });
  const source = oauthCredentials({ key: KEY, fallback: NEVER_CALLED, http });

  const handle = await source.resolve(GRANT.credentialRef, BUSINESS);

  expect(handle?.value).toBe('access-1');
  expect(http.calls).toHaveLength(1);
  expect(http.calls[0]?.refreshToken).toBe(GRANT.refreshToken);
});

it('falls through to the static store for a ref that is not a grant', async () => {
  const fallback = stubSource({ OFFICE_MAIL: 'smtp-password' });
  const source = oauthCredentials({ key: KEY, fallback, http: NEVER_CALLED_HTTP });

  expect((await source.resolve('OFFICE_MAIL', BUSINESS))?.value).toBe('smtp-password');
});

it('refuses a ref that exists as BOTH a grant and a secret', async () => {
  await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
  const fallback = stubSource({ [GRANT.credentialRef]: 'also-a-secret' });
  const source = oauthCredentials({ key: KEY, fallback, http: NEVER_CALLED_HTTP });

  await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(AmbiguousCredentialRefError);
});

it('reuses a cached access token, and still checks revocation every call', async () => {
  await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
  const http = recordingHttp({ accessToken: 'access-1', expiresInSeconds: 3600 });
  const source = oauthCredentials({ key: KEY, fallback: NEVER_CALLED, http });

  expect((await source.resolve(GRANT.credentialRef, BUSINESS))?.value).toBe('access-1');
  expect((await source.resolve(GRANT.credentialRef, BUSINESS))?.value).toBe('access-1');
  // Positive half: the cache is real -- one exchange, not two.
  expect(http.calls).toHaveLength(1);

  await revokeGrant(GRANT.system, BUSINESS, 'owner');
  // And it is still refused immediately, while that cached token is valid.
  expect(await source.resolve(GRANT.credentialRef, BUSINESS)).toBeNull();
});

it('marks the grant for re-authorisation when the provider rejects the refresh token', async () => {
  await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
  const source = oauthCredentials({
    key: KEY, fallback: NEVER_CALLED,
    http: { exchangeRefresh: async () => ({ ok: false, kind: 'rejected', message: 'invalid_grant' }) },
  });

  await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(OAuthRefreshRejectedError);
  expect((await listGrants(BUSINESS))[0]?.needsReauthAt).not.toBeNull();
});

it('stores a rotated refresh token, so the next call uses the new one', async () => {
  await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
  const http = recordingHttp({ accessToken: 'a', expiresInSeconds: 1, rotatedRefreshToken: 'refresh-2' });
  const source = oauthCredentials({ key: KEY, fallback: NEVER_CALLED, http, now: clock() });

  await source.resolve(GRANT.credentialRef, BUSINESS);
  expect((await readGrantBySystem(GRANT.system, BUSINESS, KEY))?.refreshToken).toBe('refresh-2');
});
```

`recordingHttp` ו-`stubSource` הם עוזרים בקובץ המבחן עצמו — **אל תוסיף עוזרים לקוד הייצור**. `NEVER_CALLED` הוא `CredentialSource` ש-`resolve` שלו זורק; זה מה שמוכיח שהנפילה לא קרתה כשלא הייתה צריכה לקרות.

- [ ] **Step 2: הרץ ואמת שנכשל**

Run: `npx vitest run src/orchestrator/oauth-token.test.ts`
Expected: FAIL — `Cannot find module './oauth-token.js'`

- [ ] **Step 3: כתוב את המימוש**

סדר הפעולות ב-`resolve(ref, businessId)`, וכל שורה בו נחוצה:

```ts
async resolve(ref: string, businessId: string): Promise<CredentialHandle | null> {
  // 1. The governance read happens on EVERY call, cached token or not. This
  //    is what makes revocation immediate instead of "within the hour".
  const grant = await readGrantByRef(ref, businessId, options.key);

  // 2. Ambiguity is a refusal, not a choice -- the rule `resolveChannel`
  //    already applies to two matches at one level.
  if (grant !== null && (await options.fallback.resolve(ref, businessId)) !== null) {
    throw new AmbiguousCredentialRefError(
      `ההפניה "${ref}" קיימת גם כסוד וגם כהרשאת OAuth — יש להסיר אחת מהן`,
    );
  }
  if (grant === null) return options.fallback.resolve(ref, businessId);

  // 3. Cache hit: the access token only. The refresh token is never cached.
  const cached = cache.get(cacheKey(businessId, grant.system));
  if (cached !== undefined && cached.expiresAtMs > nowMs() + SKEW_MS) {
    return createCredentialHandle(ref, cached.accessToken);
  }

  const outcome = await options.http.exchangeRefresh({ ... });
  if (!outcome.ok && outcome.kind === 'rejected') {
    await markNeedsReauth(grant.system, businessId);
    cache.delete(cacheKey(businessId, grant.system));
    throw new OAuthRefreshRejectedError(...);   // terminal
  }
  if (!outcome.ok) throw new OAuthRefreshTransientError(...); // retryable
  await recordRefresh(grant.system, businessId, outcome.rotatedRefreshToken, options.key);
  cache.set(...);
  return createCredentialHandle(ref, outcome.accessToken);
}
```

**המטמון הוא `Map` בתוך הסגור של `oauthCredentials`**, לא משתנה מודול — כך ששני מקרים של השירות אינם חולקים אסימונים, ומבחן אינו דולף לשכנו. `SKEW_MS` הוא 60 שניות: אסימון שנותרו לו שניות ייחשב פג, כי הקריאה עצמה לוקחת זמן.

**הערה חיונית לדוקבלוק המודול:** לכתוב במפורש שזו חריגה מוצהרת מהכלל "לפתור בכל שליחה, לעולם לא לשמור", ולנקוב בשלושת הדברים שמחזיקים אותה — אסימון הרענון לא במטמון, הביטול נבדק בכל קריאה, והמטמון נמחק בכל כשל הזדהות.

- [ ] **Step 4: הרץ ואמת שעובר**

Run: `npx vitest run src/orchestrator/oauth-token.test.ts`
Expected: PASS, 6 מבחנים

- [ ] **Step 5: שורת הביקורת על כשל רענון**

מפרט §2.5 מונה שלושה מקרים שנרשמים, ו**שניים מהם בטקס ההרשאה (Task 5). השלישי הוא כאן**: כשל רענון. הוסף מבחן ומימוש:

```ts
it('writes one audit row when the provider rejects the refresh token', async () => {
  await writeGrant({ businessId: BUSINESS, ...GRANT }, KEY);
  const source = oauthCredentials({ key: KEY, fallback: NEVER_CALLED, http: REJECTING_HTTP });

  await expect(source.resolve(GRANT.credentialRef, BUSINESS)).rejects.toThrow(OAuthRefreshRejectedError);

  const { rows } = await getPool().query<{ kind: string; reason: string }>(
    `SELECT kind, reason FROM audit_log WHERE business_id = $1 ORDER BY seq DESC LIMIT 1`, [BUSINESS],
  );
  expect(rows[0]?.kind).toBe('credential_change');
  expect(rows[0]?.reason).toContain(GRANT.system);
  // The token is never in the reason, and neither is the provider's raw body.
  expect(rows[0]?.reason).not.toContain(GRANT.refreshToken);
});
```

השורה נכתבת בדפוס של `auditAction` ב-`src/cli/secret.ts`: `actor: 'human'` הופך ל-`'orchestrator'` כאן (אין אדם בלולאה), `charterVersion: 'n/a'` — זה יושב ליד השער ולא מאחוריו — ו-`reason` נבנה מהמערכת ומהספק בלבד. **רענון מוצלח אינו נרשם** (§2.5); אל תוסיף שורה עליו.

- [ ] **Step 6: שתי מוטציות**

(א) הזז את בדיקת הביטול לתוך ענף החמצת-המטמון בלבד → חייב להאדים את `reuses a cached access token`.
(ב) בענף הדו-משמעות, החזר את ההרשאה במקום לזרוק → חייב להאדים את `refuses a ref that exists as BOTH`.
**החזר את שתיהן.**

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/oauth-token.ts src/orchestrator/oauth-token.test.ts
git commit -m "The token service is the existing interface, composed over the existing store"
```

---

## Task 4: עמודת הספק, מתאם Google ליומן, והרכבה תוספתית

**Files:**
- Create: `src/db/migrations/033_binding_provider.sql`
- Create: `src/orchestrator/adapters/google-calendar.ts`
- Create: `src/orchestrator/adapters/google-calendar.test.ts`
- Modify: `src/domain/connection.ts` — שדה `provider` ב-`ConnectionBinding`
- Modify: `src/orchestrator/bindings.ts` — קריאה וכתיבה של העמודה
- Modify: `src/orchestrator/runtime.ts` — הרכבה תוספתית
- Modify: `src/orchestrator/runtime.test.ts` — מבחן הרשמה
- Modify: `src/domain/charter.ts` — הוסף `calendar.read` ל-`KNOWN_TOOL_NAMES` **אם אינו שם** (בדוק; לפי הסריקה הוא כן שם)

**Interfaces:**
- Consumes: `ExternalAdapter`, `AdapterCall`, `AdapterResult` מ-`./types.js`
- Produces:

```ts
export const GOOGLE_CALENDAR_SERVED_TOOLS: readonly string[] = ['calendar.read'];
export interface CalendarHttp {
  listEvents(input: {
    accessToken: string; calendarId: string; timeMinIso: string; maxResults: number; signal: AbortSignal;
  }): Promise<{ status: number; body: unknown }>;
}
export function createGoogleCalendarAdapter(options: { system: string; http?: CalendarHttp }): ExternalAdapter;
export const CalendarReadInput: z.ZodType<{ calendarId?: string; fromIso?: string; maxResults?: number }>;
```

- [ ] **Step 1: המיגרציה**

```sql
-- Which vendor's API implements this system today. Operational, like
-- `endpoint` beside it: the charter decides whether the system exists, on
-- which channel, and which tools it serves -- this only says whose code runs.
-- Nullable: a connection served by an env-configured adapter (the mail
-- transport) has no provider, and must keep working untouched.
ALTER TABLE connection_bindings ADD COLUMN provider TEXT;
```

- [ ] **Step 2: כתוב את המבחן שנכשל**

```ts
it('reads events with the access token, and refuses any other tool', async () => {
  const http = { listEvents: async (i) => { seen = i; return { status: 200, body: { items: [{ id: 'e1', summary: 'פגישה' }] } }; } };
  const adapter = createGoogleCalendarAdapter({ system: 'office-calendar', http });

  const result = await adapter.execute(call({ toolName: 'calendar.read', credential: handle('access-1') }));
  expect(result.ok).toBe(true);
  expect(seen?.accessToken).toBe('access-1');

  const wrong = await adapter.execute(call({ toolName: 'mail.send', credential: handle('access-1') }));
  expect(wrong).toMatchObject({ ok: false, retryable: false, code: 'unsupported_tool' });
});

it('refuses without a credential rather than calling the provider', async () => {
  let called = false;
  const adapter = createGoogleCalendarAdapter({ system: 'office-calendar', http: { listEvents: async () => { called = true; throw new Error('unreachable'); } } });
  const result = await adapter.execute(call({ toolName: 'calendar.read', credential: null }));
  expect(result).toMatchObject({ ok: false, retryable: false, code: 'credential_unavailable' });
  expect(called).toBe(false);
});

it('classifies 401 as retryable for this read-only tool, and 5xx as retryable, and 403 as terminal', async () => {
  for (const [status, expected] of [[401, true], [503, true], [403, false]] as const) {
    const adapter = createGoogleCalendarAdapter({ system: 'office-calendar', http: { listEvents: async () => ({ status, body: {} }) } });
    const result = await adapter.execute(call({ toolName: 'calendar.read', credential: handle('a') }));
    expect(result).toMatchObject({ ok: false, retryable: expected });
  }
});

it('never puts the access token in the returned message', async () => {
  const adapter = createGoogleCalendarAdapter({ system: 'office-calendar', http: { listEvents: async () => ({ status: 403, body: { error: { message: 'Forbidden' } } }) } });
  const result = await adapter.execute(call({ toolName: 'calendar.read', credential: handle('SENTINEL-TOKEN') }));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.message).not.toContain('SENTINEL-TOKEN');
  expect(result.message.length).toBeGreaterThan(0); // positive half
});
```

- [ ] **Step 3: הרץ ואמת שנכשל**

Run: `npx vitest run src/orchestrator/adapters/google-calendar.test.ts`
Expected: FAIL — `Cannot find module './google-calendar.js'`

- [ ] **Step 4: המתאם**

בנה אותו בדיוק על שלד `createMailAdapter`: אותה בדיקת `serves` בתוך `execute` (כי `AdapterRegistry.get` אינו בודק אותה), אותה בדיקת `call.signal.aborted` לפני כל דבר, `credential === null` → `credential_unavailable` סופי, ואימות `call.input` ב-zod (`CalendarReadInput`) — **שום דבר לא מצהיר על צורת המטען והמתכנן ממציא אותה משם הכלי**. ברירת מחדל ל-`http`: מימוש שקורא ל-`fetch` של Node מול `https://www.googleapis.com/calendar/v3/...`, עם `Authorization: Bearer`. הפלט הוא רשימה מצומצמת של אירועים (`id`, `summary`, `start`, `end`) — **לא גוף התשובה הגולמי**, שנושא יותר ממה שמישהו ביקש.

- [ ] **Step 5: חווט את העמודה ואת ההרכבה**

`ConnectionBinding` מקבל `provider: z.string().min(1).nullable()`; `bindings.ts` קורא וכותב אותה. ב-`runtime.ts`, **בנוסף** למה שקיים: טען את החיבורים שהתקנון מצהיר עליהם ואת ה-bindings, וכל מערכת שה-binding שלה נושא `provider === 'google'` ושהערוץ שלה `api` מקבלת מתאם `createGoogleCalendarAdapter`. **נרשם גם בלי הרשאה** — היעדר הרשאה הוא כשל בזמן ריצה, לא מתאם נעדר. מתאם הדואר נשאר בדיוק כפי שהוא.

- [ ] **Step 6: מבחן ההרשמה + מוטציה**

```ts
it('registers the provider adapter for a declared system even with no grant stored', async () => {
  await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
  await upsertBinding({ system: 'office-calendar', status: 'live', endpoint: null, credentialRef: 'OFFICE_CALENDAR', provider: 'google', lastOkAt: null, lastError: null }, { by: 'test' });

  const runtime = await buildRuntime();
  expect(runtime.registry.get('office-calendar')).not.toBeNull();
});
```

מוטציה: להרשות רק כשיש שורת הרשאה → המבחן חייב להאדים. **החזר.**

- [ ] **Step 7: מבחן השרשרת המלאה — הקריאה המוכיחה, במבחן**

**קרא קודם את ההכרעה הזו, כי היא מבטלת גרסה מוקדמת של הצעד הזה.** גרסה קודמת הריצה את הקריאה דרך `runPlanForJob`. **זה לא יכול לעבוד:** `calendar.read` נמצא ב-`READ_ONLY_TOOLS` ואינו ב-`OUTBOUND_TOOLS`, ולכן `needsChannel` שקר ו-`performStep` (`src/orchestrator/run-plan.ts:496`) מנתב את הצעד כ**צעד מקומי** — שום מתאם לא נקרא ושום credential לא נפתר. הרחבת `needsChannel`, או הוספת הכלי לרשימת היוצאים, היא שינוי בפרדיקט מדיניות משותף ש-`crm.read` ו-`memory.recall` נשענים עליו במפורש (ראה ההערה ב-`run-plan.ts:292`), והיא **שייכת לתת-פרויקט 2** ולא לכאן.

לכן השרשרת נבדקת **ישירות**, שכבה אחת מתחת לאורקסטרטור: תקנון → binding → הרשאה → אסימון → מתאם.

```ts
it('drives the real chain: declared connection, live binding, stored grant, minted token, events back', async () => {
  await installCharter(buildCharter({ connections: [CALENDAR_CONNECTION] }), { businessId: BUSINESS });
  await writeKeyState(KEY, 'KEY-e2e', { businessId: BUSINESS });
  await upsertBinding({ system: 'office-calendar', status: 'live', endpoint: null,
    credentialRef: 'OFFICE_CALENDAR', provider: 'google', lastOkAt: null, lastError: null }, { by: 'test' });
  await writeGrant({ businessId: BUSINESS, system: 'office-calendar', provider: 'google',
    credentialRef: 'OFFICE_CALENDAR', account: 'owner@example.com',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    refreshToken: 'refresh-e2e', grantedBy: 'owner' }, KEY);

  const seen: string[] = [];
  const credentials = oauthCredentials({
    key: KEY,
    fallback: { resolve: async () => null },
    http: { exchangeRefresh: async () => ({ ok: true, accessToken: 'access-e2e', expiresInSeconds: 3600, rotatedRefreshToken: null }) },
  });
  const adapter = createGoogleCalendarAdapter({
    system: 'office-calendar',
    http: { listEvents: async (i) => { seen.push(i.accessToken); return { status: 200, body: { items: [{ id: 'e1', summary: 'פגישה אמיתית' }] } }; } },
  });

  // The two halves the spine exists to join: the binding names a ref, and that
  // ref resolves to a freshly minted access token. Asserted BEFORE the call, so
  // the assertions below cannot pass on a chain that never started.
  const bindings = await loadBindings({ businessId: BUSINESS });
  const ref = bindings.find((b) => b.system === 'office-calendar')?.credentialRef;
  expect(ref).toBe('OFFICE_CALENDAR');
  const credential = await credentials.resolve(ref!, BUSINESS);
  expect(credential?.value).toBe('access-e2e');

  const result = await adapter.execute({
    toolName: 'calendar.read', input: {}, credential, endpoint: null,
    idempotencyKey: 'e2e-1', signal: AbortSignal.timeout(5_000),
  });

  expect(result.ok).toBe(true);
  expect(seen).toEqual(['access-e2e']);
  if (!result.ok) throw new Error('unreachable');
  expect(result.output).toMatchObject({ events: [{ id: 'e1' }] });
});
```

- [ ] **Step 8: חווט את שירות האסימונים לתוך ההרכבה**

`oauthCredentials` הוא `CredentialSource`, ו-`buildRuntime` הוא מי שבונה את המקור שעובר ל-`runDueJobs`. בלי החיווט הזה המודול מתקמפל בלי קורא בייצור — הפגם שהפרויקט הזה שילם עליו שש פעמים.

ב-`runtime.ts`, החלף את המקור שנבנה היום ב-**הרכבה**:

```ts
const credentials = oauthCredentials({
  key,
  fallback: storedCredentials(key),
  http: overrides.tokenHttp ?? defaultTokenHttp(),
});
```

`storedCredentials(key)` נשאר בדיוק כפי שהוא ונעשה ה-fallback — כלומר **מתאם הדואר ממשיך לפתור את הסוד שלו באותה דרך בדיוק**, וזו הנקודה: ההרכבה מוסיפה ואינה מחליפה. הוסף `tokenHttp` ו-`calendarHttp` ל-`overrides` לצד התפר הקיים `createTransport`, עם אותו כלל: **הייצור קורא `buildRuntime()` בלי אף ארגומנט בשלושת האתרים.**

- [ ] **Step 9: סקריפט ההרצה החיה**

`scripts/connector-calendar.ts` — מה שההרצה החיה מריצה, במקביל ל-`scripts/live-thread-status.ts`:

```ts
import { config } from '../src/config.js';
import { loadMasterKey } from '../src/governance/master-key.js';
import { storedCredentials } from '../src/governance/credential-store.js';
import { loadBindings } from '../src/orchestrator/bindings.js';
import { oauthCredentials, defaultTokenHttp } from '../src/orchestrator/oauth-token.js';
import { createGoogleCalendarAdapter } from '../src/orchestrator/adapters/google-calendar.js';
import { closePool } from '../src/db/pool.js';

const businessId = config.businessId;
const key = await loadMasterKey(config.credentialKeyPath);
const binding = (await loadBindings({ businessId })).find((b) => b.system === 'office-calendar');

if (binding?.credentialRef == null) {
  console.log('MISS  office-calendar — הרץ scripts/seed-charter.ts, ואז אשר גישה במסך החיבורים');
} else {
  const credentials = oauthCredentials({
    key,
    fallback: storedCredentials(key),
    http: defaultTokenHttp(),
  });
  const credential = await credentials.resolve(binding.credentialRef, businessId);
  const adapter = createGoogleCalendarAdapter({ system: 'office-calendar' });
  const result = await adapter.execute({
    toolName: 'calendar.read',
    input: {},
    credential,
    endpoint: binding.endpoint,
    idempotencyKey: `manual-${Date.now()}`,
    signal: AbortSignal.timeout(20_000),
  });
  console.log(JSON.stringify(result, null, 2));
}
await closePool();
```

הוסף `"connector:calendar": "tsx scripts/connector-calendar.ts"` ל-`package.json`. אם `config` אינו חושף `credentialKeyPath`, קרא את `CREDENTIAL_KEY_PATH` באותה דרך שבה `src/cli/secret.ts` קורא אותו — **אל תמציא שם שדה**.

- [ ] **Step 10: הרץ**


Run: `npm run typecheck && npx vitest run src/orchestrator/adapters src/orchestrator/runtime.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/db/migrations/033_binding_provider.sql scripts/connector-calendar.ts package.json src/domain/connection.ts src/orchestrator/bindings.ts src/orchestrator/adapters/google-calendar.ts src/orchestrator/adapters/google-calendar.test.ts src/orchestrator/runtime.ts src/orchestrator/runtime.test.ts
git commit -m "The provider is operational, not signed: a column on the binding and one adapter"
```

---

## Task 5: טקס ההרשאה

**Files:**
- Create: `src/db/migrations/034_oauth_states.sql`
- Create: `src/governance/oauth-state.ts` + `.test.ts`
- Create: `src/dashboard/oauth-consent.ts` + `.test.ts`
- Create: `src/dashboard/oauth-routes.ts`
- Modify: `src/dashboard/server.ts` — שלושה נתיבים
- Modify: `src/test/db.ts` — `oauth_states`

**Interfaces:**
- Produces:

```ts
export async function createState(input: { businessId: string; system: string; sessionId: string; codeVerifier: string }): Promise<string>;
export async function consumeState(state: string, businessId: string): Promise<{ system: string; sessionId: string; codeVerifier: string } | null>;
export function buildConsentUrl(input: { provider: string; clientId: string; redirectUri: string; scopes: readonly string[]; state: string; codeChallenge: string }): string;
export function codeChallengeFor(verifier: string): string;
```

- [ ] **Step 1: המיגרציה**

```sql
-- Single-use, session-bound, short-lived. Without this table the `state`
-- parameter is a string the browser hands back, and anyone who can make the
-- owner's browser complete a flow can bind THEIR account to this business.
CREATE TABLE oauth_states (
    state         TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL,
    system        TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ
);
```

- [ ] **Step 2: מבחנים שנכשלים**

```ts
it('consumes a state exactly once', async () => {
  const state = await createState({ businessId: BUSINESS, system: 'office-calendar', sessionId: 's1', codeVerifier: 'v1' });
  expect((await consumeState(state, BUSINESS))?.system).toBe('office-calendar');
  expect(await consumeState(state, BUSINESS)).toBeNull();
});

it('refuses a state from another business, and an expired one', async () => {
  const state = await createState({ businessId: BUSINESS, system: 'office-calendar', sessionId: 's1', codeVerifier: 'v1' });
  expect(await consumeState(state, 'other-business')).toBeNull();
  await getPool().query(`UPDATE oauth_states SET expires_at = now() - interval '1 minute'`);
  expect(await consumeState(state, BUSINESS)).toBeNull();
});

it('asks the provider for a refresh token explicitly', () => {
  const url = buildConsentUrl({ provider: 'google', clientId: 'cid', redirectUri: 'http://127.0.0.1:4173/oauth/callback', scopes: ['s'], state: 'st', codeChallenge: 'ch' });
  // Without these two Google returns no refresh token, and the flow looks
  // successful and dies within the hour.
  expect(url).toContain('access_type=offline');
  expect(url).toContain('prompt=consent');
  expect(url).toContain('code_challenge_method=S256');
});
```

- [ ] **Step 3: הרץ, ואז מַמֵּש**

Run: `npx vitest run src/governance/oauth-state.test.ts src/dashboard/oauth-consent.test.ts`
Expected: FAIL, ואחרי המימוש PASS.

`consumeState` הוא **משפט אחד**, מאותה סיבה שתביעת אישור היא משפט אחד: קרא-ואז-כתוב מתיר לשניים להתקדם.

```ts
export async function consumeState(
  state: string,
  businessId: string,
  options: { db?: Queryable } = {},
): Promise<{ system: string; sessionId: string; codeVerifier: string } | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ system: string; session_id: string; code_verifier: string }>(
    `UPDATE oauth_states
        SET consumed_at = now()
      WHERE state = $1
        AND business_id = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING system, session_id, code_verifier`,
    [state, businessId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { system: row.system, sessionId: row.session_id, codeVerifier: row.code_verifier };
}
```

- [ ] **Step 4: שלושת הנתיבים**

`GET /oauth/:system/start` — דורש סשן, מייצר `codeVerifier` ו-`state`, שומר, ומפנה לספק.
`GET /oauth/callback` — **מאמת את ה-`state` מול הרשומה** ולא מהשאילתה; מחליף קוד באסימון; קורא את החשבון ואת ההיקפים **שנענו**; כותב הרשאה; רושם שורת ביקורת `credential_change`; מרנדר הצלחה. `error=access_denied` → מסך בעברית, לא 500.
`POST /oauth/:system/revoke` — CSRF, ביטול מקומי **קודם** (הסמכותי), ואז ניסיון ביטול אצל הספק במאמץ סביר, ואז שורת ביקורת.

**סוד היישום נקרא מהמאגר הקיים** דרך `storedCredentials`, לא מ-env, ולא מהמאגר החדש.

- [ ] **Step 5: מבחן הנתיבים + מוטציה**

מבחן: התחלה → חזרה עם ה-`state` הנכון → נכתבה הרשאה; חזרה עם `state` שהומצא → נדחית ולא נכתבה הרשאה. מוטציה: לקרוא את `system` מהשאילתה במקום מהרשומה → חייב להאדים.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/034_oauth_states.sql src/governance/oauth-state.ts src/governance/oauth-state.test.ts src/dashboard/oauth-consent.ts src/dashboard/oauth-consent.test.ts src/dashboard/oauth-routes.ts src/dashboard/server.ts src/test/db.ts
git commit -m "The consent flow: state is the gate, not the session"
```

---

## Task 6: מסך החיבורים, עם כותרת לכל סוג

**Files:**
- Create: `src/dashboard/connection-groups.ts` + `.test.ts`
- Modify: `src/dashboard/views.ts`, `src/dashboard/server.ts` (`GET /connections`)

**Interfaces:**

```ts
export type ConnectionGroup = 'mail' | 'calendar' | 'crm' | 'accounting' | 'whatsapp' | 'other';
export const GROUP_LABELS: Record<ConnectionGroup, string>; // 'חיבור דואר', ...
export function groupForServes(serves: readonly string[]): ConnectionGroup;
```

- [ ] **Step 1: מבחן שנכשל**

```ts
it('names each group from the tools the connection serves', () => {
  expect(groupForServes(['mail.send', 'mail.draft'])).toBe('mail');
  expect(groupForServes(['calendar.read'])).toBe('calendar');
  expect(groupForServes(['crm.read', 'crm.write'])).toBe('crm');
  expect(groupForServes(['accounting.write'])).toBe('accounting');
  expect(groupForServes(['wa.send_message'])).toBe('whatsapp');
});

it('puts an unrecognised connection under "other" rather than hiding it', () => {
  expect(groupForServes(['something.new'])).toBe('other');
  expect(GROUP_LABELS.other).toBe('אחר');
});

it('shows a declared connection that was never authorised', async () => {
  // …render the screen for a charter that declares office-calendar with no grant
  expect(html).toContain('חיבור יומן');
  expect(html).toContain('טרם אושר');
});
```

- [ ] **Step 2: הרץ, מַמֵּש, הרץ**

מיפוי **חיובי** מתחילית שם הכלי לקבוצה. המסך מציג לכל חיבור: יש הרשאה / טרם אושר / דורש אישור מחדש · החשבון · ההיקפים שנענו · מתי רוענן · כפתור ביטול. **הקיבוץ הוא תצוגה בלבד** — אמור זאת בדוקבלוק, כי תווית שהופכת להרשאה היא הדרך שבה נוחות הופכת לעקיפה.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/connection-groups.ts src/dashboard/connection-groups.test.ts src/dashboard/views.ts src/dashboard/server.ts
git commit -m "One heading per kind of connection, derived from what it serves"
```

---

## Task 7: לשדות הבריאות יש כותב וקורא

**Files:**
- Modify: `src/orchestrator/run-plan.ts` — אחרי `callWithDeadline` (סביב שורה 577)
- Modify: `src/orchestrator/bindings.ts` — `recordBindingOutcome`
- Modify: `scripts/live-thread-status.ts`
- Create: `src/orchestrator/binding-health.test.ts`

**Interfaces:**

```ts
export async function recordBindingOutcome(
  input: { businessId: string; system: string; ok: boolean; errorCode?: string; errorMessage?: string },
  options?: { db?: Queryable },
): Promise<void>;
```

- [ ] **Step 1: מבחן שנכשל**

```ts
it('stamps last_ok_at on success and clears the error', async () => { /* run a step through a stub adapter that succeeds */ });
it('records the classified code on failure, never the credential value', async () => {
  // the stub adapter fails with a message containing SENTINEL-TOKEN
  expect(row.last_error).not.toContain('SENTINEL-TOKEN');
  expect(row.last_error).toContain('credential_unavailable'); // positive half
});
it('leaves status live on a transient failure', async () => { expect(row.status).toBe('live'); });
```

- [ ] **Step 2: מַמֵּש**

```ts
export async function recordBindingOutcome(
  input: { businessId: string; system: string; ok: boolean; errorCode?: string; errorMessage?: string },
  options: { db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  // `last_error` carries the code and message the ADAPTER classified -- never a
  // provider's raw body, and never anything derived from the credential. Same
  // rule the audit row's `reason` holds.
  const detail = input.ok ? null : `${input.errorCode ?? 'unknown'} — ${input.errorMessage ?? ''}`.trim();
  await db.query(
    `UPDATE connection_bindings
        SET last_ok_at = CASE WHEN $3 THEN now() ELSE last_ok_at END,
            last_error = $4
      WHERE business_id = $1 AND system = $2`,
    [input.businessId, input.system, input.ok, detail],
  );
}
```

`recordBindingOutcome` נקרא **אחרי** התוצאה ולפני שהיא מוחזרת. `last_error` מקבל את `code` ואת `message` של `AdapterResult` — **שדות שהמתאם עצמו סיווג**, לא שגיאה גולמית של ספק. הכתיבה אינה מפילה את הצעד אם היא נכשלת: זו תצוגה, לא בקרה.

- [ ] **Step 3: שורות בדוח המוכנות**

הוסף: שורה לכל חיבור מוצהר עם מצב ההרשאה; שורה עם **כתובת החזרה** שהדשבורד יבנה, כדי שאי-התאמה לרישום אצל הספק תיראה לפני ההרצה ולא בתוכה.

- [ ] **Step 4: הרץ + Commit**

```bash
npm run typecheck && npx vitest run src/orchestrator/binding-health.test.ts
git add src/orchestrator/run-plan.ts src/orchestrator/bindings.ts src/orchestrator/binding-health.test.ts scripts/live-thread-status.ts
git commit -m "The binding's health fields get a writer and a reader, six instances late"
```

---

## Task 8: האינווריאנטים, סריקת הדליפה, והתיעוד

**Files:**
- Create: `src/charter/connector-invariants.test.ts`
- Modify: `CLAUDE.md`, `docs/live-thread-runbook.md`, `.env.example`

- [ ] **Step 1: שתי סריקות המקור**

```ts
it('only the token service and the dashboard import the grant writer', () => {
  // Recursive walk over all of src/, in the pattern of
  // erasure-invariants.test.ts -- NOT a hand-written file list, which would
  // skip a directory added later. Assert the walk actually read files.
  expect(scanned.length).toBeGreaterThan(100);
  expect(importers.sort()).toEqual([
    'src/dashboard/oauth-routes.ts',
    'src/orchestrator/oauth-token.ts',
  ]);
});

it('key rotation names the grant table', () => {
  expect(readFileSync('src/cli/secret-key.ts', 'utf8')).toContain('FROM oauth_grants');
});
```

- [ ] **Step 2: סריקת הדליפה מקצה לקצה**

זרע אסימון עם מזהה ייחודי, הרץ קריאה מלאה, ואז שלוף **כל** עמודות ה-`text`/`varchar`/`json`/`jsonb`/`ARRAY` מ-`information_schema.columns` ודרוש אפס מופעים. אשר קודם שהסריקה מצאה מעל 200 עמודות — **סריקה ריקה שעוברת אינה בקרה.**

- [ ] **Step 3: התיעוד**

`CLAUDE.md` — פסקה ב"כללים שהקוד אוכף בשקט": מה ההפרדה המבנית בין הרשאה לסוד, שהמטמון הוא חריגה מוצהרת עם שלושת הדברים שמחזיקים אותה, שהביטול המקומי הוא הסמכותי, ושהחלפת מפתח מכסה שתי טבלאות. `docs/live-thread-runbook.md` — פרק על טקס ההרשאה ושורה בטבלת הכשלים לכל אחד מסיווגי הכשל. `.env.example` — הפניית סוד היישום, בלי ערך.

- [ ] **Step 4: החבילה המלאה + Commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "The invariants that hold the write path narrow, and the docs"
```

---

## הסגירה: הרצה חיה

**אינה משימה בתוכנית ואינה ניתנת לדילוג.** לפי המפרט §7.4, תת-הפרויקט אינו סגור עד שכל שלושת אלה בוצעו **בפועל**:

1. הבעלים פותח את מסך החיבורים, מאשר גישה ליומן, ואז `npm run connector:calendar` מדפיס אירועים אמיתיים מהיומן של העסק. (ראה ההכרעה ב-Task 4 Step 7: השרשרת מוכחת שכבה אחת מתחת ל-runPlan, וחיווט כלי קריאה חיצוני לתוך מריץ התוכניות הוא תת-פרויקט 2.)
2. **סריקת דליפה** על כל בסיס הנתונים ועל לוגי התהליכים.
3. **בדיקת ביטול** — ללחוץ ביטול, ולראות שהקריאה הבאה מסרבת.

"כל המבחנים ירוקים" אינו תחליף לאף אחת מהשלוש.
