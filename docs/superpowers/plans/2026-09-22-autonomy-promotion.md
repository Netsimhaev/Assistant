# קידום רמת החופש — תוכנית ביצוע

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** בעל העסק בוחר עד לאן מותר לעוזרת לטפס, המדידה מעלה אותה בסוגי פעולה שהיא הוכיחה בהם את עצמה, כל טעות מורידה אותה מיד, וכל תיקון שלו נשמר כעובדה שהיא תזכור.

**Architecture:** המתג מרים את **רצפת הרמפה** בלבד, ו-`policy/engine.ts` אינו משתנה כלל. הרמפה היא תקרה אחת מתוך חמש שמצורפות במינימום, ושתיים אחרות תמיד נוכחות — ולכן הרפיה שלה לעולם אינה חורגת מהתקנון החתום. כל מספר במערכת הזו **נגזר מהמקור בכל קריאה**: רצף ההסכמות מ-`approval_requests`, ספירת הירידות מטבלת אירועים. אין מונה שמתוחזק בצד.

**Tech Stack:** TypeScript NodeNext ESM, zod, Postgres 17 דרך `pg`, vitest מול בסיס נתונים אמיתי.

**Spec:** [docs/superpowers/specs/2026-09-22-autonomy-promotion-design.md](../specs/2026-09-22-autonomy-promotion-design.md)

## Global Constraints

- `.js` בכל ייבוא יחסי, גם מקובצי `.ts`.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — כולם דלוקים.
- עברית לכל מה שאדם קורא; אנגלית למזהים, להערות ולשגיאות פנימיות.
- **`src/policy/engine.ts` אינו משתנה בתוכנית הזו.** משימה שנראה שצריכה לגעת בו — לעצור ולדווח.
- **כל מספר נגזר מהמקור.** `autonomy_ramp.samples`, `approved_without_edit` ו-`incidents` נשארים ריקים (מפרט §4.1, §9.3).
- כל בקרה נכתבת כרשימה חיובית; "כל מה שאינו X" כבר גרף כאן שלוש פעמים משהו שלא התכוונו אליו.
- מבחן שלילי שעובר גם בלי הקוד שהוא מכסה אינו מבחן.
- הערה מתארת מה הקוד עושה; קובץ שהיא מצטטת חייב לומר את מה שנטען — לפתוח אותו לפני.
- המבחנים רצים מול Postgres אמיתי, ו-`npm test` מורץ **לבד ובחזית**. ריצה מקבילה נראית בדיוק כמו רגרסיה המונית.

---

## מבנה הקבצים

| קובץ | אחריות |
|---|---|
| `src/db/migrations/026_autonomy_promotion.sql` | שלוש טבלאות: מצב המתג, סימוני הבוס, אירועי הרמפה |
| `src/governance/autonomy-mode.ts` | קריאה וכתיבה של המתג, והרצפה שהוא מרמז עליה |
| `src/orchestrator/ramp.ts` | **שינוי** — `loadRampLevel` מכבד את הרצפה |
| `src/governance/agreement.ts` | רצף ההסכמות, נגזר מ-`approval_requests` |
| `src/orchestrator/promote.ts` | פס ההערכה: מי עולה, מי יורד |
| `src/governance/corrections.ts` | סימון טעות: מוריד **וגם** כותב זיכרון |
| `src/dashboard/autonomous-actions.ts` | השאילתה שמזינה את המסך |
| `src/dashboard/server.ts`, `views.ts` | **שינוי** — שני מסכים ושני נתיבי POST |
| `src/orchestrator/scheduler.ts` | **שינוי** — הפס החדש, אחרון |
| `src/domain/audit.ts` | **שינוי** — סוג ביקורת `autonomy_change` |

---

### Task 1: המתג — סכמה, קריאה, כתיבה

**Files:**
- Create: `src/db/migrations/026_autonomy_promotion.sql`
- Create: `src/governance/autonomy-mode.ts`
- Modify: `src/domain/audit.ts` — להוסיף `'autonomy_change'` ל-`AuditKind`
- Test: `src/governance/autonomy-mode.test.ts`

**Interfaces:**
- Produces: `AutonomyMode` (zod enum + type), `loadAutonomyMode(options): Promise<AutonomyMode>`, `setAutonomyMode(mode: AutonomyMode, by: string, options): Promise<void>`, `rampFloorForMode(mode: AutonomyMode): AutonomyLevel`.

- [ ] **Step 1: המיגרציה**

צור `src/db/migrations/026_autonomy_promotion.sql`:

```sql
-- The owner's dial. One row per business; absent means `off`.
CREATE TABLE autonomy_mode (
    business_id TEXT PRIMARY KEY,
    mode        TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  TEXT NOT NULL,
    CONSTRAINT autonomy_mode_known CHECK (mode IN ('off', 'ask', 'learn'))
);

-- The owner marking an autonomous action as wrong. Feeds BOTH the demotion
-- (spec 6.1) and the memory the assistant carries forward (spec 7).
CREATE TABLE autonomy_marks (
    mark_id      TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL,
    job_id       TEXT NOT NULL,
    step_id      TEXT NOT NULL,
    action_class TEXT NOT NULL,
    note         TEXT NOT NULL,
    marked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    marked_by    TEXT NOT NULL
);
CREATE INDEX autonomy_marks_class_idx ON autonomy_marks (business_id, action_class, marked_at DESC);

-- Every promotion and every demotion. This table is why the demotion count
-- stays DERIVED (spec 6.4, 9.1): "has this class fallen twice" is a row
-- count here, never a counter maintained beside the truth.
CREATE TABLE autonomy_events (
    event_id     TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL,
    action_class TEXT NOT NULL,
    direction    TEXT NOT NULL,
    from_level   TEXT NOT NULL,
    to_level     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT autonomy_events_direction CHECK (direction IN ('promote', 'demote'))
);
CREATE INDEX autonomy_events_class_idx ON autonomy_events (business_id, action_class, at DESC);
```

- [ ] **Step 2: סוג הביקורת**

ב-`src/domain/audit.ts`, הוסף איבר אחרון ל-`AuditKind` (אחרי `'curation'`), עם דוקבלוק בסגנון השכנים:

```ts
  /**
   * The owner moved the dial, or the measurement moved a class up or down.
   * Carries the class, both levels and the reason — never a recipient and
   * never message content: an autonomy change is a fact about the system's
   * own permissions, not about whoever the action was aimed at.
   */
  'autonomy_change',
```

ל-`audit_log.kind` אין אילוץ `CHECK` ב-SQL — נבדק — ולכן אין מיגרציה נוספת.

- [ ] **Step 3: כתוב את המבחן הנופל**

צור `src/governance/autonomy-mode.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { loadAutonomyMode, rampFloorForMode, setAutonomyMode } from './autonomy-mode.js';

const BUSINESS = 'test-business';

describe('the owner dial', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('is off when nobody has set it', async () => {
    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
  });

  /**
   * The floor is the whole mechanism (spec 3.1): the dial does not enter the
   * gate, it only decides how low the ramp may sit.
   */
  it('maps each mode to the ramp floor it implies', () => {
    expect(rampFloorForMode('off')).toBe('draft_only');
    expect(rampFloorForMode('ask')).toBe('approve_required');
    expect(rampFloorForMode('learn')).toBe('approve_required');
  });

  it('stores what the owner chose and reads it back', async () => {
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('learn');
  });

  it('records the change in the audit trail, naming both levels and who', async () => {
    await setAutonomyMode('ask', 'owner@example.com', { businessId: BUSINESS });
    const { rows } = await getPool().query<{ reason: string; on_behalf_of: string }>(
      `SELECT reason, on_behalf_of FROM audit_log
        WHERE business_id = $1 AND kind = 'autonomy_change' ORDER BY seq DESC LIMIT 1`,
      [BUSINESS],
    );
    expect(rows[0]?.reason).toContain('off');
    expect(rows[0]?.reason).toContain('ask');
    expect(rows[0]?.on_behalf_of).toBe('owner@example.com');
  });

  /**
   * A value this build cannot rank must never be treated as a permission.
   * The CHECK constraint stops it at the database, so this writes past the
   * constraint deliberately to prove the reader is defended on its own.
   */
  it('falls to off on a mode string this build does not know', async () => {
    await getPool().query('ALTER TABLE autonomy_mode DROP CONSTRAINT autonomy_mode_known');
    try {
      await getPool().query(
        `INSERT INTO autonomy_mode (business_id, mode, updated_by) VALUES ($1, 'wide_open', 'x')`,
        [BUSINESS],
      );
      expect(await loadAutonomyMode({ businessId: BUSINESS })).toBe('off');
    } finally {
      await getPool().query(
        `ALTER TABLE autonomy_mode ADD CONSTRAINT autonomy_mode_known
           CHECK (mode IN ('off', 'ask', 'learn'))`,
      );
    }
  });
});
```

- [ ] **Step 4: הרץ וראה אותו נופל**

```bash
npm run migrate:test && npx vitest run src/governance/autonomy-mode.test.ts
```
צפוי: FAIL — `Cannot find module './autonomy-mode.js'`.

- [ ] **Step 5: המימוש**

צור `src/governance/autonomy-mode.ts`:

```ts
/**
 * The owner's dial: how much freedom the assistant may earn.
 *
 * This is deliberately NOT a second permission system beside the charter.
 * The charter already caps every action class and is signed; this decides
 * one thing only — how low the earned ramp may sit (spec §3.1) — and the
 * gate combines the two by minimum, so the dial can never widen what the
 * owner signed.
 *
 * It needs no signature for that reason. What it does get is an audit row
 * naming both levels and the person, because a change to how much the
 * assistant may do on her own is exactly the kind of fact a business needs
 * to be able to reconstruct later.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import type { AutonomyLevel } from '../domain/trust.js';

export const AutonomyMode = z.enum(['off', 'ask', 'learn']);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

/** What a new install has, and what an unreadable value falls back to. */
const MODE_FLOOR: AutonomyMode = 'off';

/**
 * The ramp floor each mode implies.
 *
 * `ask` and `learn` share a floor and differ only in whether the measurement
 * may climb above it (`promote.ts`). Keeping them the same here is the point:
 * turning learning off must not silently take away the level the owner
 * already decided the assistant should work at.
 */
export function rampFloorForMode(mode: AutonomyMode): AutonomyLevel {
  return mode === 'off' ? 'draft_only' : 'approve_required';
}

export async function loadAutonomyMode(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyMode> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ mode: string }>(
    'SELECT mode FROM autonomy_mode WHERE business_id = $1',
    [options.businessId ?? config.businessId],
  );

  const stored = rows[0]?.mode;
  if (stored === undefined) return MODE_FLOOR;

  // Parsed, not cast — the column is TEXT, so a rollback or a hand-edited row
  // can hold a value this build cannot rank. The same decision `loadRampLevel`
  // makes for the same reason: a value nobody can read is never permissive.
  const parsed = AutonomyMode.safeParse(stored);
  return parsed.success ? parsed.data : MODE_FLOOR;
}

export async function setAutonomyMode(
  mode: AutonomyMode,
  by: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const previous = await loadAutonomyMode({ businessId, db });

  await db.query(
    `INSERT INTO autonomy_mode (business_id, mode, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (business_id)
     DO UPDATE SET mode = EXCLUDED.mode, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [businessId, mode, by],
  );

  await appendAudit(
    {
      actor: 'human',
      onBehalfOf: by,
      kind: 'autonomy_change',
      charterVersion: 'unknown',
      provenance: 'boss',
      inputHash: canonicalHash({ from: previous, to: mode }),
      reason: `רמת החופש שונתה מ-${previous} ל-${mode} על ידי ${by}`,
    },
    { businessId },
  );
}
```

- [ ] **Step 6: הרץ עד ירוק**

```bash
npx vitest run src/governance/autonomy-mode.test.ts && npm run typecheck
```
צפוי: 5 עוברים, typecheck נקי.

- [ ] **Step 7: הוכח שהמבחן נושך**

שנה ב-`loadAutonomyMode` את `parsed.success ? parsed.data : MODE_FLOOR` ל-`stored as AutonomyMode`, הרץ שוב, וודא שהמבחן **"falls to off on a mode string this build does not know"** נופל. החזר, וודא שהקובץ זהה בייט-בבייט.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/026_autonomy_promotion.sql src/governance/autonomy-mode.ts src/governance/autonomy-mode.test.ts src/domain/audit.ts
git commit -m "The owner's dial, and the ramp floor it implies"
```

---

### Task 2: הרצפה נכנסת לרמפה — והתקנון עדיין גובר

זו המשימה היחידה בתוכנית שמרפפת תקרה. כל שאר הבטיחות נשענת על כך שהמבחן בצעד 1 עובר **בהתנהגות**, לא בטענה.

**Files:**
- Modify: `src/orchestrator/ramp.ts` — `loadRampLevel`
- Test: `src/orchestrator/ramp-floor.test.ts`

**Interfaces:**
- Consumes: `loadAutonomyMode`, `rampFloorForMode` (Task 1).
- Produces: התנהגות חדשה ל-`loadRampLevel` — החתימה אינה משתנה.

- [ ] **Step 1: כתוב את המבחן הנופל — התקנון גובר**

צור `src/orchestrator/ramp-floor.test.ts`. השתמש בעוזרי הקובץ הקיימים ב-`src/orchestrator/ramp-raise.test.ts` לזריעת תקנון ומשימה; **אל תשכפל אותם**, ייבא או חקה את אותו דפוס לאחר שקראת אותו.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { loadRampLevel, setRampLevel } from './ramp.js';
import { evaluateToolCall } from '../policy/engine.js';

const BUSINESS = 'test-business';

describe('the dial raises the ramp floor, and the charter still wins', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('floors at draft_only while the dial is off, whatever the row says', async () => {
    await setRampLevel('email.reply', 'auto', { businessId: BUSINESS });
    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('auto');
    // Nothing was written to the ramp that the mode can lower — the mode only
    // ever RAISES a floor. `off` means the floor is `draft_only`, which a
    // stored `auto` already clears, so the stored value stands.
    expect(await loadRampLevel('calendar.create', { businessId: BUSINESS })).toBe('draft_only');
  });

  it('lifts a class with no row to approve_required once the dial is on', async () => {
    await setAutonomyMode('ask', 'owner@example.com', { businessId: BUSINESS });
    expect(await loadRampLevel('calendar.create', { businessId: BUSINESS })).toBe('approve_required');
  });

  it('never lowers a stored level that already sits above the floor', async () => {
    await setAutonomyMode('ask', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('auto_notify');
  });

  /**
   * Spec §12.1 — the one test without which the whole design is unsafe.
   * Asserted through a real gate decision, never by comparing tables: the
   * charter pins `email.initiate` at `approve_required`, so a ramp shouting
   * `auto` must still produce a card.
   */
  it('still raises a card when the charter caps the class, however high the ramp', async () => {
    const bundle = await installCharter(buildCharter({ version: 'c1' }), { businessId: BUSINESS });
    await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
    await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });

    // Three POSITIONAL arguments — `(toolName, toolInput, ctx)` — not one
    // object. Copied from `src/policy/standing-approval.test.ts:42`, which is
    // the shape the gate really has.
    const decision = await evaluateToolCall(
      'mail.send',
      { to: 'stranger@nowhere.example', subject: 'x', body: 'y' },
      {
        agent: 'comms.email',
        bundle,
        provenance: 'boss',
        chainDepth: 0,
        counterpartyTags: [],
        businessId: BUSINESS,
        jobId: null,
        rampLevel: await loadRampLevel('email.initiate', { businessId: BUSINESS }),
      },
    );

    expect(decision.outcome).toBe('queue_approval');
  });
});
```

**הערה למבצע:** הצורה למעלה נבדקה מול `src/policy/engine.ts` ומול קובץ מבחן קיים, אחרי שהניסוח הראשון של התוכנית הזו טעה בה. אם היא בכל זאת אינה מתאימה — הקוד צודק, לא התוכנית: עדכן ודווח על הפער.

- [ ] **Step 2: הרץ וראה אותו נופל**

```bash
npx vitest run src/orchestrator/ramp-floor.test.ts
```
צפוי: **"lifts a class with no row to approve_required once the dial is on"** נופל עם `expected 'draft_only' to be 'approve_required'`.

- [ ] **Step 3: המימוש**

ב-`src/orchestrator/ramp.ts`, הוסף את הייבוא ושנה את `loadRampLevel`:

```ts
import { loadAutonomyMode, rampFloorForMode } from '../governance/autonomy-mode.js';
import { AutonomyLevel, mostRestrictiveAutonomy, permits } from '../domain/trust.js';
```

```ts
export async function loadRampLevel(
  actionClass: ActionClass,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyLevel> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<RampRow>(
    `SELECT level FROM autonomy_ramp
      WHERE business_id = $1 AND action_class = $2`,
    [options.businessId ?? config.businessId, actionClass],
  );

  // The owner's dial decides how low this may sit (spec §3.1). It RAISES a
  // floor and never lowers a stored level: a class that already earned more
  // than the floor keeps what it earned.
  //
  // This is the only place in the system where a ceiling is relaxed, and it
  // is safe for one reason, stated rather than assumed: the ramp is one of
  // five ceilings `effectiveAutonomy` combines by minimum, and two of them —
  // the signed charter's own cap for the class, and the provenance ceiling —
  // are ALWAYS present. `ramp-floor.test.ts` proves it through a real gate
  // decision, because a comment claiming it would not be a control.
  const floor = rampFloorForMode(await loadAutonomyMode({ ...options, db }));

  const stored = rows[0]?.level;
  if (stored === undefined) return floor;

  const parsed = AutonomyLevel.safeParse(stored);
  if (!parsed.success) return floor;
  return permits(parsed.data, floor) ? parsed.data : floor;
}
```

**שים לב ל-`RAMP_FLOOR`:** הקבוע נשאר בקובץ ונשאר בשימוש ב-`rampLevelForPlan`. עדכן את הדוקבלוק שלו כך שיאמר מה נכון עכשיו — שהוא רצפת ברירת המחדל של `rampLevelForPlan`, בעוד רצפת `loadRampLevel` נגזרת מהמתג.

- [ ] **Step 4: הרץ עד ירוק**

```bash
npx vitest run src/orchestrator/ramp-floor.test.ts src/orchestrator/ramp.test.ts src/orchestrator/ramp-raise.test.ts && npm run typecheck
```

- [ ] **Step 5: הוכח ששני המבחנים נושכים — לא אחד**

א. החלף `permits(parsed.data, floor) ? parsed.data : floor` ב-`parsed.data`. צפוי: **"lifts a class with no row"** נשאר ירוק אבל מבחן אחר נופל? אם **שום** מבחן לא נופל, כתוב מבחן שכן — ערך שמור `draft_only` תחת מתג `ask` חייב לעלות ל-`approve_required`.
ב. החלף את `return floor` (במקרה של שורה חסרה) ב-`return RAMP_FLOOR`. צפוי: **"lifts a class with no row"** נופל.
דווח מה ראית בשני המקרים. החזר, וודא זהות בייט-בבייט.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/ramp.ts src/orchestrator/ramp-floor.test.ts
git commit -m "The dial raises the ramp floor; the charter still caps every class"
```

---

### Task 3: רצף ההסכמות, נגזר מהמקור

**Files:**
- Create: `src/governance/agreement.ts`
- Test: `src/governance/agreement.test.ts`

**Interfaces:**
- Produces: `STREAK_REQUIRED` (10), `approvalStreak(actionClass: ActionClass, options): Promise<number>`.

- [ ] **Step 1: כתוב את המבחן הנופל**

צור `src/governance/agreement.test.ts`. לזריעת כרטיסים השתמש ב-`enqueueApproval` וב-`decide` מ-`src/governance/approvals.ts`; **קרא את שתי החתימות לפני הכתיבה** — `enqueueApproval` מקבל `{ facts, risk, ... }` ו-`decide(approvalId, outcome, { by, channel, editedInput? })`.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { approvalStreak, STREAK_REQUIRED } from './agreement.js';

const BUSINESS = 'test-business';

/** Seed one decided card. `edited` produces `approved_with_edit`. */
async function card(
  outcome: 'approved' | 'denied',
  opts: { edited?: boolean } = {},
): Promise<void> {
  // …enqueueApproval for action class 'email.reply', then decide(...)
  // with `editedInput` supplied when opts.edited is true…
}

describe('the agreement streak', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('is zero with no history at all', async () => {
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(0);
  });

  it('counts consecutive clean approvals, newest first', async () => {
    for (let i = 0; i < 3; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(3);
  });

  /**
   * Spec §4.2 — the decision the whole measurement turns on. An edit means
   * the owner had to work, which is the time this project exists to save.
   */
  it('treats an approval the owner edited as a break, not a win', async () => {
    await card('approved', { edited: true });
    for (let i = 0; i < 4; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(4);
  });

  it('breaks on a denial', async () => {
    await card('denied');
    for (let i = 0; i < 2; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(2);
  });

  /**
   * Spec §4.3 — an expired card says nobody answered. That is not the
   * assistant being right and not her being wrong, so it must neither count
   * nor break. Seeded by writing the state directly, because expiry is the
   * scheduler's job and this is a unit of the reader.
   */
  it('ignores an expired card entirely — it neither counts nor breaks', async () => {
    for (let i = 0; i < 2; i += 1) await card('approved');
    // …write one row with state 'expired' and a decided_at between the two…
    for (let i = 0; i < 2; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(4);
  });

  it('never reports more than the required streak', async () => {
    for (let i = 0; i < STREAK_REQUIRED + 5; i += 1) await card('approved');
    expect(await approvalStreak('email.reply', { businessId: BUSINESS })).toBe(STREAK_REQUIRED);
  });

  it('counts each action class on its own', async () => {
    for (let i = 0; i < 3; i += 1) await card('approved');
    expect(await approvalStreak('calendar.create', { businessId: BUSINESS })).toBe(0);
  });
});
```

**המבצע משלים את `card` ואת זריעת שורת ה-`expired`** מול החתימות האמיתיות. `card` חייב להבטיח `decided_at` עולה בין קריאות — אם הרזולוציה של `now()` גורמת לשתי שורות לשתף חותמת, קבע `decided_at` במפורש בשאילתה, אחרת הסדר אינו דטרמיניסטי והמבחן יהבהב.

- [ ] **Step 2: הרץ וראה אותו נופל**

```bash
npx vitest run src/governance/agreement.test.ts
```
צפוי: FAIL — `Cannot find module './agreement.js'`.

- [ ] **Step 3: המימוש**

צור `src/governance/agreement.ts`:

```ts
/**
 * How many times in a row the owner approved what the assistant proposed,
 * without changing a word.
 *
 * Derived from `approval_requests` on every call, never accumulated. A
 * counter maintained beside its source can drift from it without anyone
 * noticing — the failure this codebase has already paid for twice — while a
 * derived number is right by construction, and right retroactively after a
 * bug is fixed. The counter columns migration 001 put on `autonomy_ramp`
 * stay empty on purpose (spec §4.1).
 */
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { ActionClass } from '../domain/action.js';

/** How long a clean run must be before a class earns a step. Spec §13. */
export const STREAK_REQUIRED = 10;

/**
 * The three states that carry a verdict, named positively.
 *
 * `expired` and `cancelled` are excluded because they say nobody answered or
 * the request was withdrawn — neither is the assistant being right and
 * neither is her being wrong, so they must not count AND must not break a
 * run (spec §4.3). Excluding them in the query rather than filtering after
 * is what makes them invisible to the streak instead of fatal to it.
 */
const DECIDED_STATES = ['approved', 'approved_with_edit', 'denied'] as const;

export async function approvalStreak(
  actionClass: ActionClass,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<number> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ state: string }>(
    `SELECT state FROM approval_requests
      WHERE business_id = $1 AND action_class = $2 AND state = ANY($3::text[])
      ORDER BY decided_at DESC
      LIMIT $4`,
    [options.businessId ?? config.businessId, actionClass, [...DECIDED_STATES], STREAK_REQUIRED],
  );

  let streak = 0;
  for (const row of rows) {
    // Positive: only a clean approval extends the run. `approved_with_edit`
    // and `denied` both stop it, and anything else this build does not know
    // stops it too — an unreadable state is never a permissive one.
    if (row.state !== 'approved') break;
    streak += 1;
  }
  return streak;
}
```

- [ ] **Step 4: הרץ עד ירוק**

```bash
npx vitest run src/governance/agreement.test.ts && npm run typecheck
```

- [ ] **Step 5: הוכח שהמבחנים נושכים**

שלוש מוטציות, אחת בכל פעם, עם החזרה ואימות זהות בייט-בבייט אחרי כל אחת:
א. `if (row.state !== 'approved') break;` → `if (row.state === 'denied') break;` — צפוי: **"treats an approval the owner edited as a break"** נופל.
ב. הוסף `'expired'` ל-`DECIDED_STATES` — צפוי: **"ignores an expired card entirely"** נופל.
ג. הסר את `AND action_class = $2` — צפוי: **"counts each action class on its own"** נופל.
דווח מה ראית בכל אחת.

- [ ] **Step 6: Commit**

```bash
git add src/governance/agreement.ts src/governance/agreement.test.ts
git commit -m "The agreement streak, derived from the approvals themselves"
```

---

### Task 4: פס ההערכה — מי עולה ומי יורד

**Files:**
- Create: `src/orchestrator/promote.ts`
- Modify: `src/orchestrator/scheduler.ts` — פס חדש, אחרון
- Test: `src/orchestrator/promote.test.ts`

**Interfaces:**
- Consumes: `loadAutonomyMode` (T1), `loadRampLevel`/`setRampLevel` (T2), `approvalStreak`/`STREAK_REQUIRED` (T3).
- Produces: `evaluateAutonomy(options): Promise<AutonomyPassResult>` עם `AutonomyPassResult = { promoted: ActionClass[]; demoted: ActionClass[] }`; `SchedulerPassResult` מקבל שדה `autonomy: AutonomyPassResult`.

- [ ] **Step 1: כתוב את המבחנים הנופלים**

צור `src/orchestrator/promote.test.ts` עם אלה, לפחות:

```ts
it('does not move anything while the dial is off, however long the streak', async () => {
  // …seed STREAK_REQUIRED + 5 clean approvals for 'email.reply', mode 'off'…
  const result = await evaluateAutonomy({ businessId: BUSINESS });
  expect(result.promoted).toEqual([]);
  // The assertion that matters: the level itself did not move.
  expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('draft_only');
});

it('does not promote on the dial at ask — measuring is not climbing', async () => {
  // …mode 'ask', full clean streak…
  expect((await evaluateAutonomy({ businessId: BUSINESS })).promoted).toEqual([]);
  expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('approve_required');
});

it('promotes one step at learn once the streak is complete', async () => {
  // …mode 'learn', STREAK_REQUIRED clean approvals…
  expect((await evaluateAutonomy({ businessId: BUSINESS })).promoted).toContain('email.reply');
  expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('auto_notify');
});

it('does not promote one short of the streak', async () => {
  // …STREAK_REQUIRED - 1 clean approvals…
  expect((await evaluateAutonomy({ businessId: BUSINESS })).promoted).toEqual([]);
});

it('writes one event row per move, which is what the demotion count reads', async () => {
  // …promote once, then assert exactly one 'promote' row for the class…
});

it('demotes on an owner mark, and the streak starts again', async () => {
  // …promote to auto_notify, insert an autonomy_marks row, evaluate…
  expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('approve_required');
});

it('demotes on a failed job with no human involved at all', async () => {
  // …promote, then create a job whose bound plan declares 'email.reply' and
  // transition it to 'failed', then evaluate…
  expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('approve_required');
});

it('stops climbing after two demotions, even on a perfect streak', async () => {
  // …two 'demote' event rows, then a full clean streak…
  expect((await evaluateAutonomy({ businessId: BUSINESS })).promoted).toEqual([]);
});

it('never promotes above auto_notify', async () => {
  // …level already auto_notify, full streak…
  expect(await loadRampLevel('email.reply', { businessId: BUSINESS })).toBe('auto_notify');
});
```

- [ ] **Step 2: הרץ וראה אותם נופלים**

```bash
npx vitest run src/orchestrator/promote.test.ts
```
צפוי: FAIL — `Cannot find module './promote.js'`.

- [ ] **Step 3: המימוש**

צור `src/orchestrator/promote.ts`. שלד מלא, כולל שתי השאילתות הנגזרות:

```ts
/**
 * The pass that moves a class up when it has earned it and down the moment
 * it has not.
 *
 * Everything it reads is derived: the streak from `approval_requests`, the
 * demotion count from `autonomy_events`, the failures from the job record.
 * Nothing here maintains a counter, so nothing here can drift.
 */
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { ActionClass } from '../domain/action.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { STREAK_REQUIRED, approvalStreak } from '../governance/agreement.js';
import { loadRampLevel, setRampLevel } from './ramp.js';

export interface AutonomyPassResult {
  promoted: ActionClass[];
  demoted: ActionClass[];
}

/** The single rung the measurement may earn. Spec §2.3, §5.4. */
const EARNED_STEP: { from: AutonomyLevel; to: AutonomyLevel } = {
  from: 'approve_required',
  to: 'auto_notify',
};

/** Two falls and the class waits for the owner. Spec §6.4. */
const DEMOTIONS_BEFORE_STOP = 2;

async function lastEventAt(
  actionClass: ActionClass,
  businessId: string,
  db: Queryable,
): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date }>(
    `SELECT at FROM autonomy_events
      WHERE business_id = $1 AND action_class = $2
      ORDER BY at DESC LIMIT 1`,
    [businessId, actionClass],
  );
  return rows[0]?.at ?? null;
}

async function demotionCount(
  actionClass: ActionClass,
  businessId: string,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM autonomy_events
      WHERE business_id = $1 AND action_class = $2 AND direction = 'demote'`,
    [businessId, actionClass],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Owner marks on this class since the last move. Spec §6.1. */
async function markCount(
  actionClass: ActionClass,
  businessId: string,
  since: Date | null,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM autonomy_marks
      WHERE business_id = $1 AND action_class = $2
        AND ($3::timestamptz IS NULL OR marked_at > $3)`,
    [businessId, actionClass, since],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Jobs that reached `failed` since the last move, whose bound plan declares
 * this action class.
 *
 * `job_steps` is the timestamp source because the phase change and its row
 * are written in one transaction, so "when did this fail" is answerable
 * exactly. The plan is matched by jsonb containment rather than by unpacking
 * the steps, which keeps the predicate one expression and indexable.
 *
 * Attribution is deliberately broad (spec §6.1.1): a plan that declares the
 * class counts, even when another step is what actually failed. Broad here
 * means the assistant goes back to asking, which is the safe direction.
 */
async function failureCount(
  actionClass: ActionClass,
  businessId: string,
  since: Date | null,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(DISTINCT jp.job_id)::text AS n
       FROM job_plans jp
       JOIN job_steps js ON js.job_id = jp.job_id
      WHERE jp.business_id = $1
        AND js.to_phase = 'failed'
        AND ($3::timestamptz IS NULL OR js.at > $3)
        AND jp.plan @> $2::jsonb`,
    [businessId, JSON.stringify({ steps: [{ expectedActionClass: actionClass }] }), since],
  );
  return Number(rows[0]?.n ?? '0');
}

async function record(
  direction: 'promote' | 'demote',
  actionClass: ActionClass,
  from: AutonomyLevel,
  to: AutonomyLevel,
  reason: string,
  businessId: string,
  db: Queryable,
): Promise<void> {
  await db.query(
    `INSERT INTO autonomy_events
       (event_id, business_id, action_class, direction, from_level, to_level, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [`AE-${ulid()}`, businessId, actionClass, direction, from, to, reason],
  );
  await db.query(
    `UPDATE autonomy_ramp
        SET ${direction === 'promote' ? 'promoted_at' : 'demoted_at'} = now(), updated_at = now()
      WHERE business_id = $1 AND action_class = $2`,
    [businessId, actionClass],
  );
  await appendAudit(
    {
      actor: 'orchestrator',
      kind: 'autonomy_change',
      actionClass,
      charterVersion: 'unknown',
      provenance: 'boss',
      inputHash: canonicalHash({ actionClass, direction, from, to }),
      reason: `${actionClass}: ${from} → ${to} (${reason})`,
    },
    { businessId },
  );
}

export async function evaluateAutonomy(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<AutonomyPassResult> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const mode = await loadAutonomyMode({ businessId, db });

  const promoted: ActionClass[] = [];
  const demoted: ActionClass[] = [];

  for (const actionClass of ActionClass.options) {
    // One class failing to evaluate must not stop the rest. A promotion that
    // did not happen is late; a pass that threw is the whole mechanism down.
    try {
      const level = await loadRampLevel(actionClass, { businessId, db });
      const since = await lastEventAt(actionClass, businessId, db);

      // Demotion first, and regardless of mode: a class that is already
      // acting on its own must be able to come back down even after the
      // owner has turned learning off.
      if (level === EARNED_STEP.to) {
        const bad =
          (await markCount(actionClass, businessId, since, db)) +
          (await failureCount(actionClass, businessId, since, db));
        if (bad > 0) {
          await setRampLevel(actionClass, EARNED_STEP.from, { businessId, db });
          await record('demote', actionClass, EARNED_STEP.to, EARNED_STEP.from,
            'סימון של הבוס או משימה שנכשלה', businessId, db);
          demoted.push(actionClass);
          continue;
        }
      }

      if (mode !== 'learn') continue;
      if (level !== EARNED_STEP.from) continue;
      if ((await demotionCount(actionClass, businessId, db)) >= DEMOTIONS_BEFORE_STOP) continue;
      if ((await approvalStreak(actionClass, { businessId, db })) < STREAK_REQUIRED) continue;

      await setRampLevel(actionClass, EARNED_STEP.to, { businessId, db });
      await record('promote', actionClass, EARNED_STEP.from, EARNED_STEP.to,
        `${STREAK_REQUIRED} אישורים רצופים ללא שינוי`, businessId, db);
      promoted.push(actionClass);
    } catch {
      // Swallowed per class, by design — see above.
    }
  }

  return { promoted, demoted };
}
```

- [ ] **Step 4: חווט ל-scheduler**

ב-`src/orchestrator/scheduler.ts`: ייבא `evaluateAutonomy`, הוסף `autonomy: AutonomyPassResult` ל-`SchedulerPassResult`, וקרא לו **אחרי** `closeVerifiedJobs`, עם דוקבלוק שמסביר למה אחרון — הוא צורך את מה שהסבב הזה בדיוק ייצר: כרטיס שהוכרע ומשימה שהסתיימה.

```ts
  const verified = await closeVerifiedJobs(options);
  // Last, and for the same reason `closeVerifiedJobs` runs after the plans:
  // this pass reads what this very round produced — an approval just decided,
  // a job just failed. Run it earlier and every evaluation trails a pass
  // behind the evidence that justifies it.
  const autonomy = await evaluateAutonomy(options);
  return { tick: tickResult, scan, scanError, conduct, due, verified, autonomy };
```

- [ ] **Step 5: הרץ עד ירוק**

```bash
npx vitest run src/orchestrator/promote.test.ts src/orchestrator/scheduler.test.ts && npm run typecheck
```

- [ ] **Step 6: הוכח שהבקרות נושכות**

ארבע מוטציות, אחת בכל פעם:
א. הסר את `if (mode !== 'learn') continue;` — צפוי: **"does not promote on the dial at ask"** נופל.
ב. החלף `< STREAK_REQUIRED` ב-`< STREAK_REQUIRED - 1` — צפוי: **"does not promote one short"** נופל.
ג. הסר את בדיקת `demotionCount` — צפוי: **"stops climbing after two demotions"** נופל.
ד. הסר את `failureCount` מהסכום — צפוי: **"demotes on a failed job with no human involved"** נופל.
החזר אחרי כל אחת ואמת זהות בייט-בבייט. דווח מה ראית.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/promote.ts src/orchestrator/promote.test.ts src/orchestrator/scheduler.ts
git commit -m "Earned promotion, immediate demotion, and both derived from the record"
```

---

### Task 5: הסימון — מוריד וגם מלמד

**Files:**
- Create: `src/governance/corrections.ts`
- Test: `src/governance/corrections.test.ts`

**Interfaces:**
- Consumes: `createJob` (`src/orchestrator/jobs.js`), `writeMemory` (`src/memory/store.js`), `loadActiveCharter` (`src/charter/store.js`).
- Produces: `recordCorrection(input: CorrectionInput, options): Promise<{ markId: string; remembered: boolean }>` עם `CorrectionInput = { jobId: string; stepId: string; actionClass: ActionClass; note: string; by: string }`.

- [ ] **Step 1: כתוב את המבחן הנופל — החתימה היא של הבוס**

```ts
/**
 * Spec §7.4, and the dangerous point of the whole feature. `writeMemory`
 * reads provenance from the JOB, deliberately — a caller that can declare
 * its own trust level can launder a stranger's claim into the owner's
 * knowledge. A correction to a card born of an external document would
 * therefore be stamped `unknown_external` and lose its standing.
 *
 * The fix is not a new field. The correction opens its own job with `boss`
 * as a literal, exactly as the instruction door does.
 *
 * This asserts BEHAVIOUR — the stored row's provenance — and not a type.
 */
it('stamps the correction with the owner, even on a job born of a stranger', async () => {
  const strangerJob = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
    title: 'מסמך מבחוץ',
    businessId: BUSINESS,
  });
  // …bind a plan whose step 's1' sends to dana@example.com…

  await recordCorrection(
    { jobId: strangerJob.jobId, stepId: 's1', actionClass: 'email.reply',
      note: 'הנוסח היה רשמי מדי', by: 'owner@example.com' },
    { businessId: BUSINESS },
  );

  const rows = await recallMemories({ subjectKey: 'dana@example.com' }, { businessId: BUSINESS });
  expect(rows[0]?.provenance).toBe('boss');
});

it('records the mark so the next pass can demote on it', async () => {
  // …assert one autonomy_marks row with the class and the note…
});

/**
 * Spec §7.3 — the planner's memory block has a hard character budget and
 * fills in subject order, so corrections that accumulate would push real
 * facts about other people out of the prompt entirely. Replace-on-write is
 * what stops learning from damaging memory.
 */
it('supersedes an earlier correction on the same person and action class', async () => {
  // …two corrections, same recipient and class…
  // `recallMemories` already filters `retired_at IS NULL` in its own WHERE —
  // verified in `src/memory/store.ts`. `MemoryRecord` carries NO `retiredAt`
  // field, so filtering here would not compile. What comes back IS the live set.
  const live = await recallMemories({ subjectKey: 'dana@example.com' }, { businessId: BUSINESS });
  expect(live).toHaveLength(1);
  expect(JSON.stringify(live[0]?.body)).toContain('השני');
});

/**
 * A positive rule: a memory is written only when a recipient can actually be
 * resolved from the step. Inventing a subject key for an action with no
 * addressee would file the lesson where nothing will ever recall it.
 */
it('still demotes but remembers nothing when the step names no recipient', async () => {
  // …step input with no address…
  const result = await recordCorrection(/* … */);
  expect(result.remembered).toBe(false);
  // …assert the mark row exists anyway…
});
```

**המבצע קורא לפני הכתיבה:** `src/memory/store.ts` ל-`writeMemory`/`recallMemories`, `src/orchestrator/plan-store.ts` ל-`bindPlanToJob`, ו-`src/domain/action.ts` לפונקציה שכבר עונה על "האם הצעד הזה פונה לאדם" — **אל תכתוב שנייה**.

- [ ] **Step 2: הרץ וראה אותו נופל**

```bash
npx vitest run src/governance/corrections.test.ts
```

- [ ] **Step 3: המימוש**

צור `src/governance/corrections.ts`. שלד:

```ts
export async function recordCorrection(
  input: CorrectionInput,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<{ markId: string; remembered: boolean }> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const markId = `AM-${ulid()}`;
  await db.query(
    `INSERT INTO autonomy_marks
       (mark_id, business_id, job_id, step_id, action_class, note, marked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [markId, businessId, input.jobId, input.stepId, input.actionClass, input.note, input.by],
  );

  const subjectKey = await recipientOfStep(input.jobId, input.stepId, businessId, db);
  if (subjectKey === null) return { markId, remembered: false };

  const active = await loadActiveCharter(businessId);
  if (active === null) return { markId, remembered: false };

  // The correction carries the OWNER's provenance, not the job's. Not a new
  // field on `writeMemory` — a job of its own, with the literal in the call,
  // the same structural choice `instruct.ts` makes and `instruction-
  // invariants.test.ts` locks. See spec §7.4.
  const job = await createJob({
    charterVersion: active.bundle.charterVersion,
    provenance: 'boss',
    title: `תיקון של הבוס — ${input.actionClass}`,
    businessId,
  });

  await writeMemory(
    {
      jobId: job.jobId,
      kind: 'preference',
      subjectKey,
      // The attribute is the action class, so replace-on-write is per person
      // AND per kind of action: a correction about drafting replies does not
      // erase one about scheduling. The existing partial unique index does
      // the superseding; no new code (spec §7.2).
      attribute: `תיקון — ${input.actionClass}`,
      body: { value: input.note },
      sourceRef: `סימון בדיעבד ${markId}`,
    },
    { businessId },
  );

  return { markId, remembered: true };
}
```

- [ ] **Step 4: הרץ עד ירוק**, ואז **Step 5: מוטציה** — החלף את הליטרל `'boss'` ב-`(await loadJob(input.jobId, { businessId }))?.provenance ?? 'boss'` וּודא שמבחן החתימה נופל. החזר ואמת זהות.

- [ ] **Step 6: Commit**

```bash
git add src/governance/corrections.ts src/governance/corrections.test.ts
git commit -m "A correction lowers the level and teaches, under the owner's own provenance"
```

---

### Task 6: שני המסכים

**Files:**
- Create: `src/dashboard/autonomous-actions.ts`
- Modify: `src/dashboard/views.ts`, `src/dashboard/server.ts`
- Test: `src/dashboard/autonomous-actions.test.ts`, ותוספות ל-`src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: `recordCorrection` (T5), `loadAutonomyMode`/`setAutonomyMode` (T1).
- Produces: `listAutonomousActions(options): Promise<AutonomousAction[]>`; נתיבים `GET /autonomy`, `POST /autonomy/mode`, `GET /autonomy/actions`, `POST /autonomy/actions/:jobId/:stepId/mark`.

- [ ] **Step 1: השאילתה, ומבחן שנושך**

`listAutonomousActions` מחזיר צעדים שבוצעו **בלי כרטיס אישור**: יש שורת `job_step_results` מסוג `completed`, ואין `approval_requests` עם אותו `job_id` שנוצל. מבחן חובה: **צעד שכן עבר כרטיס אינו מופיע ברשימה** — בלעדיו השאילתה מציגה הכול והמסך משקר.

- [ ] **Step 2: המסכים**

`renderAutonomy(mode, csrf)` — שלוש אפשרויות המתג, כל אחת עם משפט אחד בעברית שאומר מה היא עושה, והנוכחית מסומנת. `renderAutonomousActions(actions, csrf)` — טבלה, החדש למעלה, ולכל שורה טופס עם שדה נימוק וכפתור "זו הייתה טעות".

כל ערך שמקורו בתוכן — נמען, כותרת — עובר `escLabel` ולא `esc`, כי `escLabel` הוא היחיד שמסיר גם תווי כיווניות. קרא את הדוקבלוק שלו ב-`views.ts` לפני.

- [ ] **Step 3: הנתיבים**

מאחורי הסשן ומאחורי `verifyCsrfToken`, בדיוק כמו `/erase` ו-`/password`. שני ה-POST מפנים מחדש (Post/Redirect/Get) ואינם מרנדרים במקום — למעט מסך שגיאה. **`POST .../mark` אינו מבטל את הפעולה ואינו מתקן אותה** (מפרט §8.4); הוא קורא ל-`recordCorrection` בלבד.

- [ ] **Step 4: מבחני המסלול** ב-`server.test.ts`: בקשה בלי סשן → הפניה לכניסה; POST בלי אסימון CSRF תקף → 403; סימון תקין → נוצרת שורת `autonomy_marks`.

- [ ] **Step 5: הרץ, מוטציה** — הסר את בדיקת ה-CSRF מנתיב הסימון ווַדא שהמבחן אדום. החזר.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/autonomous-actions.ts src/dashboard/autonomous-actions.test.ts src/dashboard/views.ts src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "Two screens: the dial, and what she did on her own"
```

---

### Task 7: תיעוד

**Files:**
- Modify: `CLAUDE.md`, `docs/05-approvals.md`, `docs/09-roadmap.md`

- [ ] **Step 1: CLAUDE.md** — ב"כללים שהקוד אוכף בשקט", פסקאות על: שהמתג מרים רצפה ואינו נוגע בשער, ושזה בטוח **רק** מפני שהרמפה היא תקרה אחת מחמש שמצורפות במינימום; שכל מספר כאן נגזר ולמה; שהמדרגה הראשונה אינה ניתנת להרווחה מבנית; ש-`auto_notify` ו-`auto` זהות באכיפה היום ולכן יש מדרגה מורווחת אחת בלבד; ושתיקון הבוס נכתב תחת משימה בפרובננס `boss` ולא בשדה חדש.

- [ ] **Step 2: docs/05-approvals.md** — לתאר את הרמפה כפי שהיא עכשיו: מי מעלה, מי מוריד, ומה הבורר של בעל העסק.

- [ ] **Step 3: docs/09-roadmap.md** — לסגור את "קידום רמת החופש" בשלב 0, ולציין במפורש מה **לא** נבנה: `auto_notify → auto`, התראה יזומה, וביטחון לפי צד-שיח מהזיכרון.

- [ ] **Step 4: ספירת המבחנים** — `npm test` לבד ובחזית, לקרוא את המספר בפועל, ולעדכן את שורת `npm test` בראש `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/05-approvals.md docs/09-roadmap.md
git commit -m "Document earned autonomy: what moves it, and what it cannot move"
```

---

## Self-Review

**כיסוי המפרט.** §3 → T1+T2. §4 → T3. §5 → T4. §6 → T4 (הירידה) + T5 (הסימון). §7 → T5. §8 → T6. §9.1 → T1 (שלוש הטבלאות). §9.3 → נאכף בכך ש-T4 כותב רק `promoted_at`/`demoted_at`. §10 → T4 צעד 4. §11 → T7 צעד 3. §12.1 → T2 צעד 1, המבחן האחרון. §12.2 → T4. §12.3–12.4 → T3. §12.5–12.6 → T4. §12.7–12.8 → T5. §12.9 → T4. §12.10 → כל מבחן "לא קודם" מאמת גם את הרמה בפועל ולא רק את המערך הריק. §13 → הקבועים ב-T3 ו-T4.

**מצייני מקום.** שתי משימות — 6 ו-7 — נכתבו בצעדים מתארים ולא בקוד מלא, במכוון ומוצהר: הן עורכות קבצים גדולים וקיימים (`views.ts`, `server.ts`, `CLAUDE.md`) שבהם הדפוס הנכון הוא של הקובץ ולא שלי, ולהכתיב להן קוד היה מייצר סתירה עם השכנים. לכל צעד בהן יש בכל זאת בדיקה ספציפית שחייבת לעבור. **ב-T3 וב-T5 השארתי גופי מבחן להשלמה מול החתימות האמיתיות** — גם זה מוצהר בגוף המשימה, עם הוראה מפורשת לקרוא את הקובץ לפני.

**עקביות טיפוסים.** `AutonomyMode` מוגדר ב-T1 ונצרך ב-T2 ו-T4. `rampFloorForMode` מוגדר ב-T1, נצרך ב-T2 בלבד. `approvalStreak`/`STREAK_REQUIRED` מ-T3 נצרכים ב-T4. `evaluateAutonomy` ו-`AutonomyPassResult` מ-T4 נצרכים ב-scheduler. `recordCorrection` מ-T5 נצרך ב-T6. שלוש הטבלאות של T1 נקראות ב-T4 (`autonomy_events`, `autonomy_marks`) וב-T6.

**סריקת קדם שהרצתי על התוכנית הזו, ושני פגמים שהיא תפסה בטקסט שלי.** שניהם היו חוסמים מבצע, ושניהם תוקנו לפני השיגור:

1. **`evaluateToolCall` מקבל שלושה ארגומנטים מיקומיים** — `(toolName, toolInput, ctx)` — ואני כתבתי אובייקט אחד. המבחן המרכזי של T2, זה שכל הבטיחות תלויה בו, לא היה מתקמפל. תוקן מול `src/policy/standing-approval.test.ts:42`.
2. **ל-`MemoryRecord` אין שדה `retiredAt`.** סיננתי לפיו ב-T5, וזה לא היה מתקמפל. `recallMemories` כבר מסנן `retired_at IS NULL` בשאילתה שלו, ולכן מה שחוזר **הוא** הקבוצה החיה.

**מה שאומת בנוסף ונמצא נכון:** `ActionClass.options` קיים (zod enum); `loadActiveCharter` מחזיר `{ bundle, ... }` כך ש-`active.bundle.charterVersion` נכון; ל-`audit_log.kind` אין אילוץ `CHECK` ב-SQL ולכן סוג ביקורת חדש אינו דורש מיגרציה; `job_steps` נושא `to_phase` ו-`at`, שהם מקור חלון הכשלים ב-T4; `ulid` זמין ובשימוש בייצור.

**מה שנשאר לא-מאומת בכוונה:** גופי המבחנים של T3 ו-T5 מסתמכים על `enqueueApproval`, `decide` ו-`bindPlanToJob`. חתימותיהן נקראו אך הקריאות עצמן לא הורצו. כל אחת מהמשימות מורה במפורש לקרוא את הקובץ לפני הכתיבה ולדווח על פער — הקוד צודק, לא התוכנית.
