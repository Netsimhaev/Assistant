# Daily and Weekly Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant sends the owner a short, honest summary of what happened — on a schedule he chooses — where successes are counted and anything that did not go smoothly is named with its reason.

**Architecture:** A deterministic pipeline with **no model call anywhere**: a facts reader computes counts and named exceptions for a time window; a pure renderer turns them into Hebrew; the rendered text is **stored as sent** and then delivered best-effort to the screen, email and WhatsApp. The scheduler runs it last in each pass. The stored digest is content about people, so it is wired into erasure in both roles.

**Tech Stack:** TypeScript (NodeNext ESM), PostgreSQL 17 via `pg`, zod, vitest against a real database.

**Spec:** [docs/superpowers/specs/2026-10-07-daily-weekly-digest-design.md](../specs/2026-10-07-daily-weekly-digest-design.md) — read it alongside this plan; every task argues from it.

## Global Constraints

- **Hebrew for humans, English for code.** Every string the owner reads is Hebrew; identifiers, comments and internal errors are English.
- **No model, anywhere in the digest.** Spec §2 decision 2. Nothing in the digest path may import, directly or transitively, a module that calls a model. Task 4 locks this with a **transitive** invariant — on this codebase the equivalent boundary was crossed twice through independent helper chains before anyone noticed.
- **The stored digest is never recomputed.** Spec §2 decision 4. The text is rendered once and read back verbatim.
- **Storage precedes delivery.** Spec §6. Deliver-then-store loses the record of something the owner was already told.
- **A channel that is not connected is stated, never silenced.** Spec §6. "Not sent" and "nothing to send" must not look alike.
- **Wired into erasure in BOTH roles** — deletion target and contact-anchor discovery source. Spec §7. This repo has twice wired a new content store to one half only.
- **Positive checks, never negative.** A value that could not be read is never permissive.
- **The owner's stored settings are guarded by database constraints, not by a permissive read.** Spec §9's closing note: an invalid hour cannot be written in the first place.
- **The digest is not a tool.** No entry in `TOOL_ACTION_CLASS`, `READ_ONLY_TOOLS` or `AGENT_ALLOWLISTS`. It is reachable only from the scheduler and from the owner's own screen.
- **`know.digest` is not built as an agent.** Spec §2.1. Do not add an implementation behind that name.
- `.js` on every relative import, including from `.ts` files (NodeNext + `"type": "module"`).
- Strict tsconfig: `noUncheckedIndexedAccess` (`rows[0]?.x`), `exactOptionalPropertyTypes` (**conditional spread only** — `x ? { x } : {}`, never `x: undefined`), `verbatimModuleSyntax`, `noUnusedLocals`.
- Real Postgres in tests; no mocks, no in-memory database. `resetDatabase()` from `src/test/db.ts`.
- `interface XRow` + `toX(row)` per module reading DB rows; SQL `snake_case`, TS `camelCase`.
- **Never run the full suite from inside a task** — the controller runs it in the foreground. A concurrent run collides on the shared test database; this repo has six documented collision signatures.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/040_digest.sql` | Create: `digest_settings` (one row per business) and `digests` (stored snapshots with per-channel delivery outcome) |
| `src/governance/digest-settings.ts` | Create: load and save the owner's choices. Follows `governance/autonomy-mode.ts` exactly |
| `src/orchestrator/digest-window.ts` | Create: pure scheduling arithmetic — is a window due, its bounds, gap merging. No DB, no I/O |
| `src/orchestrator/digest-facts.ts` | Create: read-only computation of `DigestFacts` for a window |
| `src/orchestrator/digest-render.ts` | Create: pure `DigestFacts` → Hebrew text. No DB, no model, no clock |
| `src/orchestrator/digest-store.ts` | Create: store a rendered digest, record per-channel delivery, read back verbatim |
| `src/orchestrator/digest-run.ts` | Create: the scheduler step — due? → facts → render → store → deliver |
| `src/dashboard/digest-view.ts` | Create: the screen — stored digests, plus a live "today so far" clearly marked as live |
| `src/orchestrator/scheduler.ts` | Modify: run the digest **last** in the pass |
| `src/dashboard/server.ts` | Modify: `GET /digest`, `POST /digest/settings` |
| `src/dashboard/views.ts` | Modify: nav link |
| `src/orchestrator/whatsapp-report.ts` | Modify: export `isGateDenialCode` so the digest reuses the gate-denial sentence rather than re-deciding it |
| `src/governance/erasure-plan.ts` | Modify: deletion predicate **and** a discovery query |
| `src/governance/erasure.ts` | Modify: delete the rows the plan counted |
| `src/governance/erasure-invariants.test.ts` | Modify: seed the probe into `digests` |
| `src/test/db.ts` | Modify: add both tables to the TRUNCATE list |
| `docs/10-user-settings.md` | Modify: setting 3, and the changelog row |

**Why the pipeline is four files and not one.** `digest-window.ts` and `digest-render.ts` are pure — no database, no clock of their own — which is what lets the gnarliest logic (window arithmetic, gap merging, the 20-item cap) be tested exhaustively without fixtures. `digest-facts.ts` only reads; `digest-store.ts` only writes. A single file would make the no-model invariant in Task 4 meaningless, because it would import the database layer and the renderer together.

---

### Task 1: The settings table and its store

**Files:**
- Create: `src/db/migrations/040_digest.sql`
- Create: `src/governance/digest-settings.ts`
- Create: `src/governance/digest-settings.test.ts`
- Modify: `src/test/db.ts` (add `digest_settings` and `digests` to the TRUNCATE list)

**Interfaces:**
- Consumes: `src/db/pool.js` (`getPool`, `Queryable`), `src/config.js` (`config.businessId`).
- Produces:
```ts
export const DigestSchedule = z.enum(['off', 'daily', 'weekly', 'both']);
export type DigestSchedule = z.infer<typeof DigestSchedule>;

export interface DigestSettings {
  schedule: DigestSchedule;
  dailyHour: number;        // 0-23, charter time zone
  weeklyDay: number;        // 0 = Sunday … 6 = Saturday
  weeklyHour: number;       // 0-23
  toEmail: boolean;
  toWhatsApp: boolean;
  updatedAt: string;
  updatedBy: string;
}

export const DIGEST_DEFAULTS: Readonly<DigestSettings>;

export async function loadDigestSettings(
  options?: { businessId?: string; db?: Queryable },
): Promise<DigestSettings>;

export async function setDigestSettings(
  input: Omit<DigestSettings, 'updatedAt' | 'updatedBy'>,
  updatedBy: string,
  options?: { businessId?: string; db?: Queryable },
): Promise<DigestSettings>;
```

- [ ] **Step 1: Write the migration**

A new file, never an edit to an existing migration — the runner tracks by filename, so editing in place leaves every database that already ran the old file disagreeing with it.

```sql
-- 040_digest.sql
--
-- Two tables, and they are deliberately not one.
--
-- `digest_settings` is the owner's CHOICE — one row per business, like
-- `autonomy_mode` (026). `digests` is the RECORD of what was sent, and spec §2
-- decision 4 is that it is snapshotted and never recomputed: a digest whose
-- numbers change afterwards is not a record of what the owner was told, and it
-- is worthless at the exact moment he needs it ("what did you tell me on
-- Tuesday").
--
-- The CHECKs on the hour and day columns are the enforcement layer the spec
-- names in §9: these are the owner's choices in the database, not environment
-- values, so an invalid hour must be impossible to WRITE rather than read as
-- "switch off" at run time. A setting of his that vanishes quietly because a
-- reader mis-parsed it is exactly the behaviour this project refuses.

CREATE TABLE digest_settings (
    business_id   TEXT PRIMARY KEY,
    schedule      TEXT        NOT NULL,
    daily_hour    SMALLINT    NOT NULL,
    weekly_day    SMALLINT    NOT NULL,
    weekly_hour   SMALLINT    NOT NULL,
    to_email      BOOLEAN     NOT NULL,
    to_whatsapp   BOOLEAN     NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    TEXT        NOT NULL,
    CONSTRAINT digest_settings_schedule_known
      CHECK (schedule IN ('off', 'daily', 'weekly', 'both')),
    CONSTRAINT digest_settings_daily_hour_valid  CHECK (daily_hour  BETWEEN 0 AND 23),
    CONSTRAINT digest_settings_weekly_hour_valid CHECK (weekly_hour BETWEEN 0 AND 23),
    CONSTRAINT digest_settings_weekly_day_valid  CHECK (weekly_day  BETWEEN 0 AND 6)
);

-- `kind` is the digest's own type, not a channel: one row covers all three
-- destinations, and each destination's outcome is a column below. Storing one
-- row per channel would let the three disagree about what the text said.
--
-- `window_start`/`window_end` are stored because the digest states its own
-- window in its text (spec §5), and a reader must be able to check that claim
-- against the row rather than trust the prose.
--
-- The three delivery columns are nullable on purpose: NULL means "not
-- attempted" (the owner did not enable that channel), which is a different
-- fact from 'skipped_not_connected' — the channel was wanted and could not be
-- reached. Spec §6: "not sent" and "nothing to send" must not look alike.
CREATE TABLE digests (
    digest_id     TEXT PRIMARY KEY,
    business_id   TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    window_start  TIMESTAMPTZ NOT NULL,
    window_end    TIMESTAMPTZ NOT NULL,
    body          TEXT        NOT NULL,
    had_content   BOOLEAN     NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- REMOVED by migration 041 during Task 5. This column was never read
    -- anywhere, was absent from the spec, and — being set unconditionally at
    -- insert — merely duplicated created_at. A nullable timestamp named
    -- screen_at also invites the next reader to believe it records when the
    -- owner SAW the digest, which nothing in this system knows. Left here as
    -- the historical record of what was planned; do not re-add it.
    screen_at     TIMESTAMPTZ,
    email_state   TEXT,
    whatsapp_state TEXT,
    CONSTRAINT digests_kind_known CHECK (kind IN ('daily', 'weekly')),
    CONSTRAINT digests_window_ordered CHECK (window_end > window_start),
    CONSTRAINT digests_email_state_known
      CHECK (email_state IS NULL OR email_state IN ('sent', 'failed', 'skipped_not_connected')),
    CONSTRAINT digests_whatsapp_state_known
      CHECK (whatsapp_state IS NULL OR whatsapp_state IN ('sent', 'failed', 'skipped_not_connected'))
);

-- The scheduler asks "what was the last window of this kind I sent?" on every
-- pass; without this it is a sequential scan that grows forever.
CREATE INDEX digests_business_kind_window_idx
  ON digests (business_id, kind, window_end DESC);
```

- [ ] **Step 2: Add both tables to the test reset**

`resetDatabase()` uses a hand-written table list. A new table missing from it leaks rows between tests, and the failure looks like a flaky test rather than a missing line.

In `src/test/db.ts`, add `digest_settings` and `digests` to the `TRUNCATE TABLE` list.

- [ ] **Step 3: Write the failing tests**

```ts
// src/governance/digest-settings.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../test/db.js';
import { DIGEST_DEFAULTS, loadDigestSettings, setDigestSettings } from './digest-settings.js';

const BUSINESS = 'test-business';

describe('digest settings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * Spec §4: the main switch is off by default. A fresh installation does not
   * start emailing the owner before he asked — the same shape `autonomy_mode`
   * and the document inbox already hold.
   */
  it('reads as off for a business that never chose, without writing a row', async () => {
    const settings = await loadDigestSettings({ businessId: BUSINESS });
    expect(settings.schedule).toBe('off');
    expect(settings.toEmail).toBe(false);
    expect(settings.toWhatsApp).toBe(false);
    expect(settings.dailyHour).toBe(DIGEST_DEFAULTS.dailyHour);
  });

  it('round-trips a choice the owner made', async () => {
    await setDigestSettings(
      { schedule: 'both', dailyHour: 7, weeklyDay: 0, weeklyHour: 9, toEmail: true, toWhatsApp: false },
      'owner',
      { businessId: BUSINESS },
    );

    const settings = await loadDigestSettings({ businessId: BUSINESS });
    expect(settings.schedule).toBe('both');
    expect(settings.dailyHour).toBe(7);
    expect(settings.weeklyHour).toBe(9);
    expect(settings.toEmail).toBe(true);
    expect(settings.updatedBy).toBe('owner');
  });

  /**
   * Spec §9's closing note: these are the owner's choices in the database, so
   * an invalid hour must be impossible to WRITE. The database refuses it — the
   * reader never has to decide what a 25th hour means.
   */
  it('refuses an hour outside the day at the database level', async () => {
    await expect(
      setDigestSettings(
        { schedule: 'daily', dailyHour: 25, weeklyDay: 0, weeklyHour: 9, toEmail: false, toWhatsApp: false },
        'owner',
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow();
  });

  it('keeps one business out of another, under the same defaults', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 6, weeklyDay: 0, weeklyHour: 9, toEmail: true, toWhatsApp: false },
      'owner',
      { businessId: BUSINESS },
    );

    const other = await loadDigestSettings({ businessId: 'other-business' });
    expect(other.schedule).toBe('off');
  });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `npx vitest run src/governance/digest-settings.test.ts`
Expected: FAIL — `Cannot find module './digest-settings.js'`.

- [ ] **Step 5: Write the implementation**

```ts
// src/governance/digest-settings.ts
import { z } from 'zod';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';

export const DigestSchedule = z.enum(['off', 'daily', 'weekly', 'both']);
export type DigestSchedule = z.infer<typeof DigestSchedule>;

export interface DigestSettings {
  schedule: DigestSchedule;
  dailyHour: number;
  weeklyDay: number;
  weeklyHour: number;
  toEmail: boolean;
  toWhatsApp: boolean;
  updatedAt: string;
  updatedBy: string;
}

/**
 * **Off, and every channel but the screen disabled.** Spec §4: a fresh
 * installation does not start sending before the owner asked — the same
 * default `autonomy_mode` ('off') and `DOCUMENT_INBOX` (absent) already hold,
 * and for the same reason: a switch that starts on is a switch nobody chose.
 *
 * Returned for a business with no row at all, and `loadDigestSettings` does
 * NOT write one. An absent row and a row saying 'off' mean the same thing to
 * every reader, and writing on read would turn a question into a decision.
 */
export const DIGEST_DEFAULTS: Readonly<DigestSettings> = Object.freeze({
  schedule: 'off',
  dailyHour: 8,
  weeklyDay: 0,
  weeklyHour: 8,
  toEmail: false,
  toWhatsApp: false,
  updatedAt: '',
  updatedBy: '',
});

interface SettingsRow {
  schedule: string;
  daily_hour: number;
  weekly_day: number;
  weekly_hour: number;
  to_email: boolean;
  to_whatsapp: boolean;
  updated_at: string;
  updated_by: string;
}

function toSettings(row: SettingsRow): DigestSettings {
  return {
    schedule: DigestSchedule.parse(row.schedule),
    dailyHour: row.daily_hour,
    weeklyDay: row.weekly_day,
    weeklyHour: row.weekly_hour,
    toEmail: row.to_email,
    toWhatsApp: row.to_whatsapp,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

const COLUMNS = `schedule, daily_hour, weekly_day, weekly_hour, to_email, to_whatsapp,
                 updated_at::text AS updated_at, updated_by`;

export async function loadDigestSettings(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DigestSettings> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<SettingsRow>(
    `SELECT ${COLUMNS} FROM digest_settings WHERE business_id = $1`,
    [businessId],
  );

  const row = rows[0];
  return row === undefined ? { ...DIGEST_DEFAULTS } : toSettings(row);
}

export async function setDigestSettings(
  input: Omit<DigestSettings, 'updatedAt' | 'updatedBy'>,
  updatedBy: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DigestSettings> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<SettingsRow>(
    `INSERT INTO digest_settings
       (business_id, schedule, daily_hour, weekly_day, weekly_hour, to_email, to_whatsapp, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (business_id) DO UPDATE
       SET schedule = EXCLUDED.schedule,
           daily_hour = EXCLUDED.daily_hour,
           weekly_day = EXCLUDED.weekly_day,
           weekly_hour = EXCLUDED.weekly_hour,
           to_email = EXCLUDED.to_email,
           to_whatsapp = EXCLUDED.to_whatsapp,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by
     RETURNING ${COLUMNS}`,
    [businessId, input.schedule, input.dailyHour, input.weeklyDay, input.weeklyHour,
     input.toEmail, input.toWhatsApp, updatedBy],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('digest settings vanished mid-upsert');
  return toSettings(row);
}
```

- [ ] **Step 6: Run the migration on the test database and re-run the tests**

Run: `npm run migrate:test` then `npx vitest run src/governance/digest-settings.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Mutation-verify the default**

Change `DIGEST_DEFAULTS.schedule` to `'daily'`. The first test must FAIL on `expect(settings.schedule).toBe('off')`. Restore it and re-confirm green. **Trace the failure to that assertion** — a mutation that fails elsewhere is not evidence for this one.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/040_digest.sql src/governance/digest-settings.ts \
        src/governance/digest-settings.test.ts src/test/db.ts
git commit -m "Digest settings: off by default, and an invalid hour cannot be written"
```

---

### Task 2: The window arithmetic

The gnarliest logic in the plan, and the only one with no database at all — which is why it comes before the readers.

**Files:**
- Create: `src/orchestrator/digest-window.ts`
- Create: `src/orchestrator/digest-window.test.ts`

**Interfaces:**
- Consumes: `DigestSettings`, `DigestSchedule` from `../governance/digest-settings.js`.
- Produces:
```ts
export type DigestKind = 'daily' | 'weekly';

export interface DigestWindow {
  kind: DigestKind;
  /** Inclusive lower bound. */
  start: Date;
  /** The SCHEDULED moment this window closes at — never the send moment. */
  end: Date;
  /** How many scheduled windows this one absorbs. 1 is the ordinary case. */
  windowsCovered: number;
}

export function scheduledHourFor(settings: DigestSettings, kind: DigestKind): number;

export function dueWindow(
  settings: DigestSettings,
  kind: DigestKind,
  lastSentEnd: Date | null,
  now: Date,
  timeZone: string,
): DigestWindow | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/orchestrator/digest-window.test.ts
import { describe, expect, it } from 'vitest';
import { DIGEST_DEFAULTS } from '../governance/digest-settings.js';
import { dueWindow } from './digest-window.js';

const TZ = 'Asia/Jerusalem';
const daily = { ...DIGEST_DEFAULTS, schedule: 'daily' as const, dailyHour: 8 };

describe('dueWindow', () => {
  /**
   * Spec §4: the switch is off by default, and off means nothing is ever due —
   * not "due but undelivered". A reader that returns a window for an off
   * schedule makes the switch cosmetic.
   */
  it('returns nothing while the schedule is off', () => {
    const off = { ...DIGEST_DEFAULTS, schedule: 'off' as const };
    expect(dueWindow(off, 'daily', null, new Date('2026-10-07T09:00:00+03:00'), TZ)).toBeNull();
  });

  it('returns nothing before the scheduled hour has passed', () => {
    const now = new Date('2026-10-07T07:30:00+03:00');
    expect(dueWindow(daily, 'daily', null, now, TZ)).toBeNull();
  });

  /**
   * Spec §5: the window is ANCHORED to the scheduled hour, not to the send
   * moment. Sent at 09:00 for an 08:00 schedule, the window still ends at
   * 08:00 — otherwise every late pass drags the anchor forward and the windows
   * drift until they overlap.
   */
  it('anchors the window to the scheduled hour even when the pass is late', () => {
    const now = new Date('2026-10-07T09:17:00+03:00');
    const window = dueWindow(daily, 'daily', null, now, TZ);
    expect(window).not.toBeNull();
    expect(window?.end.toISOString()).toBe(new Date('2026-10-07T08:00:00+03:00').toISOString());
    expect(window?.start.toISOString()).toBe(new Date('2026-10-06T08:00:00+03:00').toISOString());
    expect(window?.windowsCovered).toBe(1);
  });

  it('returns nothing once that window has already been sent', () => {
    const now = new Date('2026-10-07T09:17:00+03:00');
    const lastSent = new Date('2026-10-07T08:00:00+03:00');
    expect(dueWindow(daily, 'daily', lastSent, now, TZ)).toBeNull();
  });

  /**
   * Spec §5: several missed windows of the same kind become ONE digest that
   * declares the gap. Three retroactive dailies at once are noise; one that
   * admits the gap is information.
   */
  it('merges three missed days into one window that states how many it covers', () => {
    const now = new Date('2026-10-07T09:00:00+03:00');
    const lastSent = new Date('2026-10-04T08:00:00+03:00');
    const window = dueWindow(daily, 'daily', lastSent, now, TZ);
    expect(window?.start.toISOString()).toBe(lastSent.toISOString());
    expect(window?.end.toISOString()).toBe(new Date('2026-10-07T08:00:00+03:00').toISOString());
    expect(window?.windowsCovered).toBe(3);
  });

  /**
   * Spec §5: gap merging happens WITHIN a kind and never across them. A weekly
   * neither swallows missed dailies nor is made redundant by them — they answer
   * two different questions, and that overlap is deliberate.
   */
  it('computes the weekly window independently of the daily one', () => {
    const both = { ...DIGEST_DEFAULTS, schedule: 'both' as const, dailyHour: 8, weeklyDay: 0, weeklyHour: 8 };
    const now = new Date('2026-10-11T09:00:00+03:00'); // Sunday
    const weekly = dueWindow(both, 'weekly', null, now, TZ);
    expect(weekly).not.toBeNull();
    expect(weekly?.end.toISOString()).toBe(new Date('2026-10-11T08:00:00+03:00').toISOString());
    expect(weekly?.start.toISOString()).toBe(new Date('2026-10-04T08:00:00+03:00').toISOString());
  });

  it('returns nothing for a kind the schedule does not include', () => {
    const now = new Date('2026-10-11T09:00:00+03:00');
    expect(dueWindow(daily, 'weekly', null, now, TZ)).toBeNull();
  });

  /**
   * The time zone comes from the charter (spec §4), so "08:00" must be 08:00
   * THERE. Reading it in UTC would send the digest at the wrong hour for most
   * of the year and silently shift it twice a year with daylight saving.
   */
  it('reads the scheduled hour in the charter time zone, not in UTC', () => {
    const now = new Date('2026-10-07T06:30:00Z'); // 09:30 in Jerusalem
    expect(dueWindow(daily, 'daily', null, now, TZ)).not.toBeNull();
    expect(dueWindow(daily, 'daily', null, now, 'UTC')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/orchestrator/digest-window.test.ts`
Expected: FAIL — `Cannot find module './digest-window.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/orchestrator/digest-window.ts
import type { DigestSettings } from '../governance/digest-settings.js';

export type DigestKind = 'daily' | 'weekly';

export interface DigestWindow {
  kind: DigestKind;
  start: Date;
  end: Date;
  windowsCovered: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Which kinds each schedule includes — a positive table, never a negation. */
const KINDS_FOR_SCHEDULE: Readonly<Record<DigestSettings['schedule'], readonly DigestKind[]>> =
  Object.freeze({
    off: [],
    daily: ['daily'],
    weekly: ['weekly'],
    both: ['daily', 'weekly'],
  });

export function scheduledHourFor(settings: DigestSettings, kind: DigestKind): number {
  return kind === 'daily' ? settings.dailyHour : settings.weeklyHour;
}

/**
 * The parts of an instant as they read in a given IANA zone.
 *
 * `Intl` and not arithmetic on the UTC offset: the offset at a FUTURE or PAST
 * moment is exactly what daylight saving makes unsafe to assume, and this
 * codebase already learned that once — `nextTimeAt` in the quiet-hours path
 * probes forward in minutes rather than constructing a local date, for the same
 * reason and with the same note.
 */
function partsIn(at: Date, timeZone: string): { hour: number; weekday: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', weekday: 'short',
  });
  const parts = new Map(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    hour: Number(parts.get('hour') ?? '0'),
    weekday: weekdays.indexOf(parts.get('weekday') ?? 'Sun'),
    ymd: `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`,
  };
}

/**
 * The most recent moment at or before `now` at which this kind was scheduled
 * to fire, in the charter's zone.
 *
 * Found by stepping backwards an hour at a time from `now` rather than by
 * constructing a local timestamp — the same probing approach, and the same
 * reason, as `partsIn` above. At most 8 days of hours, so the loop is bounded
 * and cheap; an unbounded search here would be a hang on a bad zone.
 */
function lastScheduledMoment(
  settings: DigestSettings,
  kind: DigestKind,
  now: Date,
  timeZone: string,
): Date | null {
  const wantedHour = scheduledHourFor(settings, kind);
  const maxHoursBack = kind === 'daily' ? 48 : 8 * 24;

  for (let back = 0; back <= maxHoursBack; back += 1) {
    const candidate = new Date(now.getTime() - back * 60 * 60 * 1000);
    const parts = partsIn(candidate, timeZone);
    if (parts.hour !== wantedHour) continue;
    if (kind === 'weekly' && parts.weekday !== settings.weeklyDay) continue;
    // Truncate to the top of that hour: the schedule is hour-granular (spec §4).
    const atHour = new Date(candidate.getTime() - candidate.getTime() % (60 * 60 * 1000));
    return atHour;
  }
  return null;
}

/**
 * The window this kind owes the owner right now, or `null` when it owes none.
 *
 * **`end` is the SCHEDULED moment and never `now`** — spec §5. A pass that runs
 * late still reports the window that closed on the hour; anchoring to the send
 * moment would drag every later window forward until they overlap, and the
 * digest's own claim about its period would stop being checkable against the
 * stored row.
 *
 * **Several missed windows of one kind collapse into one** that carries
 * `windowsCovered > 1`, which the renderer turns into a sentence admitting the
 * gap. Spec §5: three retroactive dailies at once are noise.
 *
 * **Gap merging never crosses kinds.** This function is called once per kind
 * and knows nothing about the other, which is what keeps the weekly from
 * swallowing missed dailies — they answer two different questions, and the
 * overlap between them is deliberate.
 */
export function dueWindow(
  settings: DigestSettings,
  kind: DigestKind,
  lastSentEnd: Date | null,
  now: Date,
  timeZone: string,
): DigestWindow | null {
  if (!KINDS_FOR_SCHEDULE[settings.schedule].includes(kind)) return null;

  const end = lastScheduledMoment(settings, kind, now, timeZone);
  if (end === null) return null;
  if (lastSentEnd !== null && lastSentEnd.getTime() >= end.getTime()) return null;

  const span = kind === 'daily' ? DAY_MS : WEEK_MS;
  const start = lastSentEnd === null ? new Date(end.getTime() - span) : lastSentEnd;
  const covered = Math.max(1, Math.round((end.getTime() - start.getTime()) / span));

  return { kind, start, end, windowsCovered: covered };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/orchestrator/digest-window.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation-verify the anchor and the merge**

Two mutations, each run on its own and each traced to the assertion it lands on:

1. Replace `end` with `now` in the returned window. The anchoring test must FAIL on the `window?.end` comparison — **not** on a type error.
2. Hard-code `windowsCovered: 1`. The merge test must FAIL on `toBe(3)`.

Restore after each and re-confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/digest-window.ts src/orchestrator/digest-window.test.ts
git commit -m "Digest windows: anchored to the scheduled hour, merged within a kind"
```

---

### Task 3: The facts reader

**Files:**
- Create: `src/orchestrator/digest-facts.ts`
- Create: `src/orchestrator/digest-facts.test.ts`
- Modify: `src/orchestrator/whatsapp-report.ts` (export `isGateDenialCode`)

**Interfaces:**
- Consumes: `DigestWindow` from `./digest-window.js`; `failedText` and `isGateDenialCode` from `./whatsapp-report.js`.
- Produces:
```ts
/** One thing that did not go smoothly, already phrased in Hebrew. */
export interface DigestException {
  /** What it was — a job title, a document name, an approval summary. */
  subject: string;
  /** Why, in Hebrew. Never an engine code and never English. */
  reason: string;
}

export interface DigestFacts {
  window: DigestWindow;
  /** Point-in-time, NOT window-scoped — spec §3.1. */
  waiting: {
    approvals: number;
    openQuestions: number;
    deferred: number;
  };
  /** Window-scoped counts — spec §3.2. */
  done: {
    jobsCompleted: number;
    messagesSent: number;
    documentsRead: number;
    memoriesWritten: number;
  };
  /** Window-scoped and NAMED — spec §3.3. */
  exceptions: readonly DigestException[];
  /** Window-scoped — spec §3.4. */
  permissionChanges: readonly DigestException[];
  /**
   * Spec §3.5 — both measures. `rolling30Minor` and `ceilingMinor` use the
   * **rolling 30-day window the money gate actually enforces**
   * (`spentInWindows`, policy/budget.ts:26-33), NEVER a calendar month: a
   * spend figure shown against a ceiling measured over a different window is
   * two numbers on one line that cannot be compared, and nothing on the screen
   * would say so.
   */
  cost: {
    windowMinor: number;
    rolling30Minor: number;
    ceilingMinor: number;
    currency: string;
  };
}

/**
 * `ceilings` is passed IN, not loaded here. The money ceiling lives in the
 * signed charter (`CompiledCeilings.monthlyMinor`, domain/policy.ts:107-116) —
 * there is none in `src/config.ts`. Both callers already hold the bundle
 * because each needs the charter's time zone, so this is one field and no new
 * failure mode in a module that must stay read-only and throw-free.
 */
export async function collectDigestFacts(
  window: DigestWindow,
  ceilings: { monthlyMinor: number; currency: string },
  options?: { businessId?: string; db?: Queryable },
): Promise<DigestFacts>;
```

- [ ] **Step 1: Export the gate-denial check from the WhatsApp report**

The digest must not re-decide what a gate denial is. `whatsapp-report.ts` already owns that question and its Hebrew sentence; a second copy would be two owners of one rule, which this repo has paid for before.

Change `function isGateDenialCode` to `export function isGateDenialCode` in `src/orchestrator/whatsapp-report.ts`. **Change nothing else in that file** — its tests must keep passing untouched.

- [ ] **Step 2: Write the failing tests**

```ts
// src/orchestrator/digest-facts.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../test/db.js';
import { getPool } from '../db/pool.js';
import { collectDigestFacts } from './digest-facts.js';

const BUSINESS = 'test-business';
const WINDOW = {
  kind: 'daily' as const,
  start: new Date('2026-10-06T08:00:00+03:00'),
  end: new Date('2026-10-07T08:00:00+03:00'),
  windowsCovered: 1,
};
/** Passed in, never loaded here — see the note on `collectDigestFacts`. */
const CEILINGS = { monthlyMinor: 50_000, currency: 'ILS' };

describe('collectDigestFacts', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('reports an empty window as empty rather than as missing', async () => {
    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.done.jobsCompleted).toBe(0);
    expect(facts.exceptions).toEqual([]);
    expect(facts.waiting.approvals).toBe(0);
  });

  /**
   * Spec §3.2 versus §3.3: a job that closed is a NUMBER, a job that failed is
   * a NAME. The two must not be counted together, or "7 tasks completed" would
   * include the one that broke.
   */
  it('counts a closed job and names a failed one with its Hebrew reason', async () => {
    const db = getPool();
    await db.query(
      `INSERT INTO jobs (job_id, business_id, title, phase, provenance, content_ingested, closed_at)
       VALUES ('J-ok', $1, 'שליחת הצעת מחיר', 'closed', 'boss', false, $2),
              ('J-bad', $1, 'עדכון המערכת', 'failed', 'boss', false, $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00')],
    );
    await db.query(
      `INSERT INTO job_steps (job_id, from_phase, to_phase, actor, reason)
       VALUES ('J-bad', 'execute', 'failed', 'orchestrator', 'adapter_timeout')`,
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.done.jobsCompleted).toBe(1);
    expect(facts.exceptions).toHaveLength(1);
    expect(facts.exceptions[0]?.subject).toContain('עדכון המערכת');
    // Hebrew, never the raw engine code.
    expect(facts.exceptions[0]?.reason).not.toContain('adapter_timeout');
    expect(facts.exceptions[0]?.reason).not.toMatch(/[A-Za-z]/);
  });

  /**
   * Spec §3.1 is point-in-time, not window-scoped: an approval still pending
   * belongs in "waiting" whenever the digest is sent, regardless of whether it
   * was raised inside this window.
   */
  it('counts a pending approval raised BEFORE the window as still waiting', async () => {
    await getPool().query(
      `INSERT INTO approval_requests
         (approval_id, business_id, proposed_tool, summary, detail, state, input_hash, expires_at, created_at)
       VALUES ('AP-1', $1, 'mail.send', 'הצעה לדנה', '', 'pending', 'h', $2, $3)`,
      [BUSINESS, new Date('2026-10-09T08:00:00+03:00'), new Date('2026-10-01T08:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.waiting.approvals).toBe(1);
  });

  /**
   * Spec §3.4: a promotion means she may now act without asking, and nothing
   * else in the system tells the owner after the fact. If this block misses it,
   * he learns about it from the result.
   */
  it('names an autonomy promotion that happened inside the window', async () => {
    await getPool().query(
      // event_id is TEXT PRIMARY KEY with no default (migration 026).
      `INSERT INTO autonomy_events
         (event_id, business_id, action_class, direction, from_level, to_level, reason, at)
       VALUES ('AE-t1', $1, 'email.reply', 'promote', 'approve_required', 'auto_notify', '10 אישורים נקיים', $2)`,
      [BUSINESS, new Date('2026-10-07T06:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.permissionChanges).toHaveLength(1);
    expect(facts.permissionChanges[0]?.subject).toContain('email.reply');
  });

  /**
   * Real columns: action_class and currency are both NOT NULL, there is no
   * `kind`, and `id` is BIGSERIAL (migration 001:202-216).
   */
  it('reports the window cost and the rolling 30 days against the ceiling', async () => {
    await getPool().query(
      `INSERT INTO spend_ledger
         (business_id, job_id, action_class, amount_minor, currency, idempotency_key, at)
       VALUES ($1, 'J-ok', 'email.reply', 1250, 'ILS', 'k1', $2)`,
      [BUSINESS, new Date('2026-10-07T07:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.cost.windowMinor).toBe(1250);
    expect(facts.cost.rolling30Minor).toBeGreaterThanOrEqual(1250);
    expect(facts.cost.ceilingMinor).toBe(CEILINGS.monthlyMinor);
  });

  /**
   * The gate sums `at >= now() - interval '30 days'`. A calendar-month figure
   * shown against that ceiling is not comparable to it — this is the assertion
   * that keeps the two definitions from drifting apart.
   */
  it('counts spend from before the first of the month inside the rolling window', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await getPool().query(
      `INSERT INTO spend_ledger
         (business_id, job_id, action_class, amount_minor, currency, idempotency_key, at)
       VALUES ($1, 'J-old', 'email.reply', 700, 'ILS', 'k2', $2)`,
      [BUSINESS, twentyDaysAgo],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.cost.rolling30Minor).toBe(700);
    expect(facts.cost.windowMinor).toBe(0);
  });

  it('keeps one business's facts out of another's window', async () => {
    await getPool().query(
      `INSERT INTO jobs (job_id, business_id, title, phase, provenance, content_ingested, closed_at)
       VALUES ('J-other', 'other-business', 'לא שלנו', 'closed', 'boss', false, $1)`,
      [new Date('2026-10-07T07:00:00+03:00')],
    );

    const facts = await collectDigestFacts(WINDOW, CEILINGS, { businessId: BUSINESS });
    expect(facts.done.jobsCompleted).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run src/orchestrator/digest-facts.test.ts`
Expected: FAIL — `Cannot find module './digest-facts.js'`.

- [ ] **Step 4: Write the implementation**

Read-only throughout: this module runs `SELECT` and nothing else, which is what makes it safe to call from the live screen as well as from the scheduler.

```ts
// src/orchestrator/digest-facts.ts
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import type { DigestWindow } from './digest-window.js';
import { failedText, isGateDenialCode, NOT_PERMITTED_TEXT } from './whatsapp-report.js';

export interface DigestException {
  subject: string;
  reason: string;
}

export interface DigestFacts {
  window: DigestWindow;
  waiting: { approvals: number; openQuestions: number; deferred: number };
  done: { jobsCompleted: number; messagesSent: number; documentsRead: number; memoriesWritten: number };
  exceptions: readonly DigestException[];
  permissionChanges: readonly DigestException[];
  cost: { windowMinor: number; monthMinor: number; monthCeilingMinor: number };
}

/** The cap from spec §9. The renderer adds "ועוד N" above it. */
export const MAX_NAMED_EXCEPTIONS = 20;

async function countOf(db: Queryable, sql: string, params: readonly unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(sql, [...params]);
  return Number(rows[0]?.n ?? '0');
}

/**
 * The Hebrew sentence for a failure, deciding gate denial against breakage the
 * way `whatsapp-report.ts` already does — **by calling it, never by repeating
 * the rule.** A gate denial is not a failure: the assistant did not break, she
 * is not permitted to do that yet, and while every action class sits at
 * `draft_only` this is the commonest reason of all.
 */
function reasonInHebrew(rawReason: string | null): string {
  if (rawReason !== null && isGateDenialCode(rawReason)) return NOT_PERMITTED_TEXT;
  return failedText(rawReason);
}

export async function collectDigestFacts(
  window: DigestWindow,
  ceilings: { monthlyMinor: number; currency: string },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<DigestFacts> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const { start, end } = window;

  // ---- §3.1 waiting: point-in-time, deliberately NOT bounded by the window.
  const approvals = await countOf(
    db,
    `SELECT count(*)::text AS n FROM approval_requests
      WHERE business_id = $1 AND state = 'pending' AND expires_at > now()`,
    [businessId],
  );
  const openQuestions = await countOf(
    db,
    `SELECT count(*)::text AS n FROM boss_instructions i
       JOIN jobs j ON j.job_id = i.job_id AND j.business_id = i.business_id
      WHERE i.business_id = $1 AND i.answer IS NULL AND j.phase = 'understand'`,
    [businessId],
  );
  const deferred = await countOf(
    db,
    `SELECT count(*)::text AS n FROM jobs
      WHERE business_id = $1 AND phase = 'await_approval'
        AND NOT EXISTS (
          SELECT 1 FROM approval_requests a
           WHERE a.business_id = jobs.business_id AND a.job_id = jobs.job_id
             AND a.state = 'pending' AND a.expires_at > now())`,
    [businessId],
  );

  // ---- §3.2 done: window-scoped counts, no names.
  const jobsCompleted = await countOf(
    db,
    `SELECT count(*)::text AS n FROM jobs
      WHERE business_id = $1 AND phase = 'closed' AND closed_at >= $2 AND closed_at < $3`,
    [businessId, start, end],
  );
  const messagesSent = await countOf(
    db,
    `SELECT count(*)::text AS n FROM job_step_results r
       JOIN jobs j ON j.job_id = r.job_id AND j.business_id = r.business_id
      WHERE r.business_id = $1 AND r.status = 'completed' AND r.performed IS TRUE
        AND r.external_id IS NOT NULL AND j.closed_at >= $2 AND j.closed_at < $3`,
    [businessId, start, end],
  );
  const documentsRead = await countOf(
    db,
    `SELECT count(*)::text AS n FROM document_readings
      WHERE business_id = $1 AND created_at >= $2 AND created_at < $3`,
    [businessId, start, end],
  );
  const memoriesWritten = await countOf(
    db,
    `SELECT count(*)::text AS n FROM memories
      WHERE business_id = $1 AND created_at >= $2 AND created_at < $3`,
    [businessId, start, end],
  );

  // ---- §3.3 exceptions: window-scoped and NAMED, with the Hebrew reason.
  const { rows: failedJobs } = await db.query<{ title: string; reason: string | null }>(
    `SELECT j.title, (
        SELECT s.reason FROM job_steps s
         WHERE s.job_id = j.job_id ORDER BY s.at DESC LIMIT 1
      ) AS reason
       FROM jobs j
      WHERE j.business_id = $1 AND j.phase = 'failed'
        AND j.closed_at >= $2 AND j.closed_at < $3
      ORDER BY j.closed_at DESC
      LIMIT ${MAX_NAMED_EXCEPTIONS + 1}`,
    [businessId, start, end],
  );
  // The column is `reason` — there is no `rejected_reason` (migration 012:41).
  const { rows: rejectedDocs } = await db.query<{ original_name: string; reason: string | null }>(
    `SELECT original_name, reason FROM documents
      WHERE business_id = $1 AND status = 'rejected'
        AND created_at >= $2 AND created_at < $3
      ORDER BY created_at DESC
      LIMIT ${MAX_NAMED_EXCEPTIONS + 1}`,
    [businessId, start, end],
  );
  const { rows: expiredApprovals } = await db.query<{ summary: string }>(
    `SELECT summary FROM approval_requests
      WHERE business_id = $1 AND state = 'expired'
        AND decided_at >= $2 AND decided_at < $3
      ORDER BY decided_at DESC
      LIMIT ${MAX_NAMED_EXCEPTIONS + 1}`,
    [businessId, start, end],
  );

  const exceptions: DigestException[] = [
    ...failedJobs.map((r) => ({ subject: r.title, reason: reasonInHebrew(r.reason) })),
    ...rejectedDocs.map((r) => ({
      subject: r.original_name,
      reason: r.reason ?? 'המסמך נדחה בקליטה.',
    })),
    ...expiredApprovals.map((r) => ({
      subject: r.summary,
      reason: 'האישור פג בלי שהוכרע, והעבודה לא בוצעה.',
    })),
  ];

  // ---- §3.4 permission changes: window-scoped.
  const { rows: autonomyRows } = await db.query<{
    action_class: string; direction: string; from_level: string; to_level: string;
  }>(
    `SELECT action_class, direction, from_level, to_level FROM autonomy_events
      WHERE business_id = $1 AND at >= $2 AND at < $3
      ORDER BY at DESC`,
    [businessId, start, end],
  );
  const permissionChanges: DigestException[] = autonomyRows.map((r) => ({
    subject: r.action_class,
    reason: r.direction === 'promote'
      ? `הורשתה לפעול בלי לשאול (מ-${r.from_level} ל-${r.to_level}).`
      : `הוחזרה לשאול לפני פעולה (מ-${r.from_level} ל-${r.to_level}).`,
  }));

  // ---- §3.5 cost: both measures.
  const windowMinor = await countOf(
    db,
    `SELECT coalesce(sum(amount_minor), 0)::text AS n FROM spend_ledger
      WHERE business_id = $1 AND at >= $2 AND at < $3`,
    [businessId, start, end],
  );
  // **The gate's own window, verbatim.** `spentInWindows`
  // (policy/budget.ts:26-33) sums `at >= now() - interval '30 days'`, and
  // `checkBudget` compares that sum to `ceilings.monthlyMinor`. A calendar
  // month here would print a figure that is not comparable to the ceiling
  // beside it, and nothing the owner sees would say so.
  const rolling30Minor = await countOf(
    db,
    `SELECT coalesce(sum(amount_minor), 0)::text AS n FROM spend_ledger
      WHERE business_id = $1 AND at >= now() - interval '30 days'`,
    [businessId],
  );

  return {
    window,
    waiting: { approvals, openQuestions, deferred },
    done: { jobsCompleted, messagesSent, documentsRead, memoriesWritten },
    exceptions,
    permissionChanges,
    cost: {
      windowMinor,
      rolling30Minor,
      ceilingMinor: ceilings.monthlyMinor,
      currency: ceilings.currency,
    },
  };
}
```

**Every column and config name above was verified against the migrations before this task was dispatched** — see the rulings R1-R5 in the ledger, which corrected three of them. `config` is no longer imported for a ceiling; it is still imported for `config.businessId`. If you nonetheless find a name that does not resolve, **open the migration and use the real one, and report it** — do not invent a column. A query that silently matches nothing turns this whole block into a quiet zero, which is the failure mode this digest exists to prevent.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/orchestrator/digest-facts.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Mutation-verify the counted/named split and the window bound**

1. Change the `jobsCompleted` query to drop `AND phase = 'closed'`. The counted/named test must FAIL because the failed job is now also counted.
2. Drop `AND closed_at >= $2` from `jobsCompleted`. No current test covers that — **write one**: seed a job closed a week before the window and assert it is not counted. Then re-run the mutation and watch the new test fail.
3. Drop `AND expires_at > now()` from the `approvals` count. Seed an already-expired pending row and assert it is not counted as waiting; the mutation must fail that.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/digest-facts.ts src/orchestrator/digest-facts.test.ts \
        src/orchestrator/whatsapp-report.ts
git commit -m "Digest facts: successes counted, exceptions named with the Hebrew reason already in the system"
```

---

### Task 4: The renderer, and the no-model invariant

**Files:**
- Create: `src/orchestrator/digest-render.ts`
- Create: `src/orchestrator/digest-render.test.ts`
- Create: `src/orchestrator/digest-invariants.test.ts`

**Interfaces:**
- Consumes: `DigestFacts`, `MAX_NAMED_EXCEPTIONS` from `./digest-facts.js`; `stripBidiControls` from `../util/bidi.js`.
- Produces:
```ts
export interface RenderedDigest {
  body: string;
  /** False when the window held nothing worth interrupting him for — spec §2 decision 3. */
  hadContent: boolean;
}

export function renderDigest(facts: DigestFacts): RenderedDigest;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/orchestrator/digest-render.test.ts
import { describe, expect, it } from 'vitest';
import type { DigestFacts } from './digest-facts.js';
import { renderDigest } from './digest-render.js';

function facts(over: Partial<DigestFacts> = {}): DigestFacts {
  return {
    window: {
      kind: 'daily',
      start: new Date('2026-10-06T08:00:00+03:00'),
      end: new Date('2026-10-07T08:00:00+03:00'),
      windowsCovered: 1,
    },
    waiting: { approvals: 0, openQuestions: 0, deferred: 0 },
    done: { jobsCompleted: 0, messagesSent: 0, documentsRead: 0, memoriesWritten: 0 },
    exceptions: [],
    permissionChanges: [],
    cost: { windowMinor: 0, rolling30Minor: 0, ceilingMinor: 50000, currency: 'ILS' },
    ...over,
  };
}

describe('renderDigest', () => {
  /**
   * Spec §2 decision 3: an empty day is said, not hidden and not padded. The
   * screen still receives it so the record stays continuous; `hadContent`
   * false is what keeps it out of his inbox.
   */
  it('says plainly that nothing happened, and marks the window as empty', () => {
    const out = renderDigest(facts());
    expect(out.hadContent).toBe(false);
    expect(out.body).toContain('לא קרה');
  });

  /** Spec §5: the digest states its own window, so the claim is checkable. */
  it('states the period it covers', () => {
    const out = renderDigest(facts());
    expect(out.body).toContain('06');
    expect(out.body).toContain('07');
  });

  /**
   * Spec §3: "what is waiting" leads, because it is the only part that will not
   * happen without him. A digest that opens with how much she managed buries
   * the one thing he has to act on.
   */
  it('puts what is waiting before what was done', () => {
    const out = renderDigest(facts({
      waiting: { approvals: 2, openQuestions: 1, deferred: 0 },
      done: { jobsCompleted: 7, messagesSent: 3, documentsRead: 1, memoriesWritten: 2 },
    }));
    expect(out.body.indexOf('ממתין')).toBeLessThan(out.body.indexOf('7'));
    expect(out.hadContent).toBe(true);
  });

  /** Spec §1.1: successes are a number, exceptions are a name and a reason. */
  it('counts successes and names each exception with its reason', () => {
    const out = renderDigest(facts({
      done: { jobsCompleted: 7, messagesSent: 3, documentsRead: 0, memoriesWritten: 0 },
      exceptions: [{ subject: 'עדכון המערכת', reason: 'החיבור לא נענה בזמן.' }],
    }));
    expect(out.body).toContain('7');
    expect(out.body).toContain('עדכון המערכת');
    expect(out.body).toContain('החיבור לא נענה בזמן.');
  });

  /** Spec §9: capped at 20 with "+N", never truncated silently. */
  it('caps the named list and says how many it did not list', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      subject: `משימה ${i}`, reason: 'נכשלה.',
    }));
    const out = renderDigest(facts({ exceptions: many }));
    expect(out.body).toContain('משימה 0');
    expect(out.body).not.toContain('משימה 22');
    expect(out.body).toContain('3');
  });

  /** Spec §3.4 — the block that exists so a promotion is never discovered from the result. */
  it('reports a permission change', () => {
    const out = renderDigest(facts({
      permissionChanges: [{ subject: 'email.reply', reason: 'הורשתה לפעול בלי לשאול.' }],
    }));
    expect(out.body).toContain('email.reply');
    expect(out.hadContent).toBe(true);
  });

  /** Spec §5: a merged window admits the gap rather than rewriting history. */
  it('admits the gap when it covers more than one scheduled window', () => {
    const out = renderDigest(facts({
      window: {
        kind: 'daily',
        start: new Date('2026-10-04T08:00:00+03:00'),
        end: new Date('2026-10-07T08:00:00+03:00'),
        windowsCovered: 3,
      },
    }));
    expect(out.body).toContain('3');
  });

  /**
   * A document name is chosen by whoever sent the file, and a direction
   * override inside it rearranges what the owner READS while leaving the bytes
   * untouched — and the digest is what he acts on. Same hazard `escLabel`
   * exists for, same single owner (`util/bidi.ts`).
   *
   * The positive half is load-bearing: a strip that ate the whole subject would
   * satisfy the absence check alone, and the test would then be asserting that
   * the owner is told nothing.
   */
  it('strips direction overrides from a subject a stranger chose', () => {
    const out = renderDigest(facts({
      exceptions: [{ subject: 'חשבונית‮gpj.exe', reason: 'נדחה.' }],
    }));
    expect(out.body).not.toContain('‮');
    expect(out.body).toContain('חשבונית');
  });

  it('writes nothing in Latin letters to the owner', () => {
    const out = renderDigest(facts({
      done: { jobsCompleted: 2, messagesSent: 1, documentsRead: 0, memoriesWritten: 0 },
    }));
    // Action-class names are identifiers and may appear; prose may not.
    expect(out.body.replace(/[a-z_.]+/g, '')).not.toMatch(/[A-Za-z]/);
  });
});
```

```ts
// src/orchestrator/digest-invariants.test.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **The digest contains no model call, and this walks the whole import graph
 * rather than one hop.** Spec §2 decision 2.
 *
 * One-hop checks are not enough here and this repo has the scar to prove it:
 * on the WhatsApp branch the equivalent boundary (`gov.verify` must not reach a
 * module that reads document content) was crossed TWICE through independent
 * helper chains before anyone noticed, and both would have passed a check that
 * only read the file's own import lines.
 */
const ROOT = join(process.cwd(), 'src');

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const match of source.matchAll(/from\s+'(\.[^']+)\.js'/g)) {
    const rel = match[1];
    if (rel !== undefined) out.push(rel);
  }
  return out;
}

function resolveFrom(file: string, rel: string): string | null {
  const base = join(file, '..', `${rel}.ts`);
  try {
    if (statSync(base).isFile()) return base;
  } catch {
    return null;
  }
  return null;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const rel of importsOf(current)) {
      const resolved = resolveFrom(current, rel);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

describe('the digest calls no model', () => {
  it('cannot reach a module that talks to a model, at any depth', () => {
    const reached = reachableFrom(join(ROOT, 'orchestrator', 'digest-run.ts'));

    // Every `src/sdk/*` module is a model caller or a step away from one.
    const offenders = [...reached].filter((f) => f.includes(join('src', 'sdk')));
    expect(offenders).toEqual([]);
  });

  /**
   * The walk must be proved to actually walk. Without this, a future edit that
   * breaks `resolveFrom` leaves the test green over a graph of ONE file — green
   * for the wrong reason, which is the failure this project names repeatedly.
   */
  it('really traverses more than the entry file', () => {
    const reached = reachableFrom(join(ROOT, 'orchestrator', 'digest-run.ts'));
    expect(reached.size).toBeGreaterThan(5);
    expect([...reached].some((f) => f.endsWith(join('orchestrator', 'digest-render.ts')))).toBe(true);
  });
});
```

- [ ] **Step 2: Run both test files and watch them fail**

Run: `npx vitest run src/orchestrator/digest-render.test.ts src/orchestrator/digest-invariants.test.ts`
Expected: FAIL — missing modules.

- [ ] **Step 3: Write the renderer**

Pure: no database, no clock of its own, no model. Everything it needs arrives in `facts`.

```ts
// src/orchestrator/digest-render.ts
import { formatMinor } from '../util/money.js';
import { stripBidiControls } from '../util/bidi.js';
import type { DigestException, DigestFacts } from './digest-facts.js';
import { MAX_NAMED_EXCEPTIONS } from './digest-facts.js';

export interface RenderedDigest {
  body: string;
  hadContent: boolean;
}

const KIND_LABEL: Readonly<Record<DigestFacts['window']['kind'], string>> = Object.freeze({
  daily: 'תדריך יומי',
  weekly: 'תדריך שבועי',
});

function day(at: Date): string {
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit' }).format(at);
}

/**
 * Every value that reaches the owner's eyes passes through here, and nothing
 * else composes a subject line. A document name is chosen by whoever sent the
 * file; a direction override inside it rearranges what he READS while leaving
 * the bytes that were acted on untouched.
 */
function safe(value: string): string {
  return stripBidiControls(value);
}

function namedList(items: readonly DigestException[]): string[] {
  const shown = items.slice(0, MAX_NAMED_EXCEPTIONS);
  const lines = shown.map((e) => `· ${safe(e.subject)} — ${safe(e.reason)}`);
  const hidden = items.length - shown.length;
  if (hidden > 0) lines.push(`· ועוד ${hidden} שלא נמנו כאן.`);
  return lines;
}

export function renderDigest(facts: DigestFacts): RenderedDigest {
  const { window: w, waiting, done, exceptions, permissionChanges, cost } = facts;
  const lines: string[] = [];

  lines.push(`${KIND_LABEL[w.kind]} · ${day(w.start)}–${day(w.end)}`);

  // Spec §5: a merged window admits the gap instead of rewriting history.
  if (w.windowsCovered > 1) {
    lines.push(`(לא יצא תדריך ${w.windowsCovered} פעמים, וזה מכסה את כל התקופה.)`);
  }

  // §3.1 — leads, because it is the only part that will not happen without him.
  const waitingTotal = waiting.approvals + waiting.openQuestions + waiting.deferred;
  if (waitingTotal > 0) {
    lines.push('', 'ממתין לך:');
    if (waiting.approvals > 0) lines.push(`· ${waiting.approvals} אישורים שלא הוכרעו.`);
    if (waiting.openQuestions > 0) lines.push(`· ${waiting.openQuestions} שאלות שלי שממתינות לתשובה.`);
    if (waiting.deferred > 0) lines.push(`· ${waiting.deferred} משימות שעוצרות עד שתכריע.`);
  }

  // §3.2 — numbers only, no names.
  const doneTotal = done.jobsCompleted + done.messagesSent + done.documentsRead + done.memoriesWritten;
  if (doneTotal > 0) {
    lines.push('', 'מה נעשה:');
    if (done.jobsCompleted > 0) lines.push(`· ${done.jobsCompleted} משימות הושלמו.`);
    if (done.messagesSent > 0) lines.push(`· ${done.messagesSent} הודעות יצאו.`);
    if (done.documentsRead > 0) lines.push(`· ${done.documentsRead} מסמכים נקראו.`);
    if (done.memoriesWritten > 0) lines.push(`· ${done.memoriesWritten} דברים נרשמו לזיכרון.`);
  }

  // §3.3 — named, with the reason.
  if (exceptions.length > 0) {
    lines.push('', 'מה לא עבר חלק:', ...namedList(exceptions));
  }

  // §3.4 — the block that stops a promotion being discovered from the result.
  if (permissionChanges.length > 0) {
    lines.push('', 'מה השתנה בהרשאות שלי:', ...namedList(permissionChanges));
  }

  // §3.5 — both measures: what it cost, and how much is left.
  //
  // **"ב-30 הימים האחרונים", never "החודש".** The ceiling beside it is
  // enforced over a rolling 30 days (`spentInWindows`, policy/budget.ts), so
  // calling the figure a calendar month would make the two numbers on this one
  // line incomparable while reading as though they were not.
  if (cost.windowMinor > 0 || cost.rolling30Minor > 0) {
    lines.push(
      '',
      `עלות: ${formatMinor(cost.windowMinor, cost.currency)} בתקופה · ` +
        `${formatMinor(cost.rolling30Minor, cost.currency)} מתוך ` +
        `${formatMinor(cost.ceilingMinor, cost.currency)} ב-30 הימים האחרונים.`,
    );
  }

  const hadContent =
    waitingTotal > 0 || doneTotal > 0 || exceptions.length > 0 || permissionChanges.length > 0;

  // Spec §2 decision 3: an empty day is SAID. The screen still gets it so the
  // record stays continuous; `hadContent` is what keeps it out of his inbox.
  if (!hadContent) lines.push('', 'לא קרה כלום בתקופה הזו.');

  return { body: lines.join('\n'), hadContent };
}
```

- [ ] **Step 4: Run both test files and watch them pass**

Run: `npx vitest run src/orchestrator/digest-render.test.ts src/orchestrator/digest-invariants.test.ts`
Expected: PASS.

**Ruled before dispatch (ledger R6):** `digest-run.ts` does not exist yet — Task 6
creates it. Write the invariant pointed at `digest-render.ts`, and leave a one-line
comment at the walk's entry saying it must move to `digest-run.ts` once that file
exists. Task 6 is separately instructed to move it, so do not try to anticipate the
file. The second test — that the walk really traverses more than the entry file — is
what keeps this intermediate state honest: a graph of one file would satisfy the
first test for the wrong reason.

- [ ] **Step 5: Mutation-verify the three claims**

1. Replace `safe()` with the identity function. The bidi test must FAIL on the override assertion.
2. Remove the `hidden > 0` branch. The cap test must FAIL on the `'3'` assertion.
3. Move the "what is waiting" block after "what was done". The ordering test must FAIL on the `indexOf` comparison.

Each on its own, each traced to the assertion it lands on, each restored.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/digest-render.ts src/orchestrator/digest-render.test.ts \
        src/orchestrator/digest-invariants.test.ts
git commit -m "Digest renderer: no model, waiting first, exceptions named and bidi-stripped"
```

---

### Task 5: Storage, read-back, and the delivery record

**Files:**
- Create: `src/orchestrator/digest-store.ts`
- Create: `src/orchestrator/digest-store.test.ts`

**Interfaces:**
- Consumes: `DigestWindow`, `RenderedDigest`.
- Produces:
```ts
export type ChannelState = 'sent' | 'failed' | 'skipped_not_connected';

export interface StoredDigest {
  digestId: string;
  kind: DigestKind;
  windowStart: string;
  windowEnd: string;
  body: string;
  hadContent: boolean;
  createdAt: string;
  emailState: ChannelState | null;
  whatsappState: ChannelState | null;
}

export async function storeDigest(
  input: { window: DigestWindow; rendered: RenderedDigest },
  options?: { businessId?: string; db?: Queryable },
): Promise<StoredDigest>;

export async function recordChannel(
  digestId: string,
  channel: 'email' | 'whatsapp',
  state: ChannelState,
  options?: { businessId?: string; db?: Queryable },
): Promise<void>;

export async function lastWindowEnd(
  kind: DigestKind,
  options?: { businessId?: string; db?: Queryable },
): Promise<Date | null>;

export async function recentDigests(
  options?: { businessId?: string; limit?: number; db?: Queryable },
): Promise<StoredDigest[]>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/orchestrator/digest-store.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../test/db.js';
import { lastWindowEnd, recentDigests, recordChannel, storeDigest } from './digest-store.js';

const BUSINESS = 'test-business';
const WINDOW = {
  kind: 'daily' as const,
  start: new Date('2026-10-06T08:00:00+03:00'),
  end: new Date('2026-10-07T08:00:00+03:00'),
  windowsCovered: 1,
};

describe('digest store', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * Spec §2 decision 4: the body is read back VERBATIM. If storage round-tripped
   * through a recomputation, last Tuesday's digest would show today's numbers
   * and stop being a record of what the owner was told.
   */
  it('reads the body back exactly as it was stored', async () => {
    const body = 'תדריך יומי · 06/10–07/10\n\nלא קרה כלום בתקופה הזו.';
    const stored = await storeDigest(
      { window: WINDOW, rendered: { body, hadContent: false } },
      { businessId: BUSINESS },
    );
    const back = await recentDigests({ businessId: BUSINESS });
    expect(back).toHaveLength(1);
    expect(back[0]?.body).toBe(body);
    expect(back[0]?.digestId).toBe(stored.digestId);
  });

  /**
   * Spec §6: NULL means the channel was never asked for; a state means it was
   * wanted. "Not sent" and "nothing to send" must not look alike.
   */
  it('leaves an unasked channel null and records an asked one', async () => {
    const stored = await storeDigest(
      { window: WINDOW, rendered: { body: 'x', hadContent: true } },
      { businessId: BUSINESS },
    );
    expect(stored.emailState).toBeNull();

    await recordChannel(stored.digestId, 'email', 'skipped_not_connected', { businessId: BUSINESS });
    const back = await recentDigests({ businessId: BUSINESS });
    expect(back[0]?.emailState).toBe('skipped_not_connected');
    expect(back[0]?.whatsappState).toBeNull();
  });

  it('reports the last window end per kind, not across kinds', async () => {
    await storeDigest({ window: WINDOW, rendered: { body: 'a', hadContent: true } }, { businessId: BUSINESS });
    expect((await lastWindowEnd('daily', { businessId: BUSINESS }))?.toISOString())
      .toBe(WINDOW.end.toISOString());
    expect(await lastWindowEnd('weekly', { businessId: BUSINESS })).toBeNull();
  });

  it('keeps one business out of another', async () => {
    await storeDigest({ window: WINDOW, rendered: { body: 'a', hadContent: true } }, { businessId: BUSINESS });
    expect(await recentDigests({ businessId: 'other-business' })).toEqual([]);
  });

  /**
   * `recordChannel` on an id that matches no row must THROW, not pass quietly.
   * A silent miss means the delivery outcome of a digest the owner received is
   * lost, and nothing would ever say so — the same rule `settleMessage` and
   * `markContentIngested` already carry.
   */
  it('throws when asked to record a channel for a digest that does not exist', async () => {
    await expect(
      recordChannel('DG-nope', 'email', 'sent', { businessId: BUSINESS }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/orchestrator/digest-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/orchestrator/digest-store.ts
import { ulid } from 'ulid';
import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { getPool } from '../db/pool.js';
import type { DigestKind, DigestWindow } from './digest-window.js';
import type { RenderedDigest } from './digest-render.js';

export type ChannelState = 'sent' | 'failed' | 'skipped_not_connected';

export interface StoredDigest {
  digestId: string;
  kind: DigestKind;
  windowStart: string;
  windowEnd: string;
  body: string;
  hadContent: boolean;
  createdAt: string;
  emailState: ChannelState | null;
  whatsappState: ChannelState | null;
}

interface DigestRow {
  digest_id: string;
  kind: string;
  window_start: string;
  window_end: string;
  body: string;
  had_content: boolean;
  created_at: string;
  email_state: string | null;
  whatsapp_state: string | null;
}

const COLUMNS = `digest_id, kind, window_start::text AS window_start, window_end::text AS window_end,
                 body, had_content, created_at::text AS created_at, email_state, whatsapp_state`;

function toStored(row: DigestRow): StoredDigest {
  return {
    digestId: row.digest_id,
    kind: row.kind as DigestKind,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    body: row.body,
    hadContent: row.had_content,
    createdAt: row.created_at,
    emailState: row.email_state as ChannelState | null,
    whatsappState: row.whatsapp_state as ChannelState | null,
  };
}

/**
 * Writes the rendered digest down **before** anything is delivered — spec §6.
 *
 * Deliver-then-store leaves a window in which the owner has been told
 * something no record exists of. Store-then-deliver leaves at worst a stored
 * digest whose delivery outcome is unknown, which the next pass can see and an
 * operator can read. That is the same direction `trip()` and the WhatsApp
 * report already chose, and for the same reason.
 */
export async function storeDigest(
  input: { window: DigestWindow; rendered: RenderedDigest },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StoredDigest> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const id = `DG-${ulid()}`;

  const { rows } = await db.query<DigestRow>(
    `INSERT INTO digests
       (digest_id, business_id, kind, window_start, window_end, body, had_content, screen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING ${COLUMNS}`,
    [id, businessId, input.window.kind, input.window.start, input.window.end,
     input.rendered.body, input.rendered.hadContent],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('digest vanished mid-insert');
  return toStored(row);
}

/**
 * Throws when `digestId` under `businessId` matches no row.
 *
 * A silent miss would lose the delivery outcome of a digest the owner may
 * already have received, and nothing downstream would ever say so — the same
 * reasoning `settleMessage` (`whatsapp/store.ts`) and `markContentIngested`
 * (`documents/read.ts`) already apply to their own UPDATEs.
 */
export async function recordChannel(
  digestId: string,
  channel: 'email' | 'whatsapp',
  state: ChannelState,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const column = channel === 'email' ? 'email_state' : 'whatsapp_state';

  const { rowCount } = await db.query(
    `UPDATE digests SET ${column} = $3 WHERE digest_id = $1 AND business_id = $2`,
    [digestId, businessId, state],
  );
  if (rowCount !== 1) {
    throw new Error(`digest ${digestId} not found for business ${businessId}`);
  }
}

export async function lastWindowEnd(
  kind: DigestKind,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<Date | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();

  const { rows } = await db.query<{ window_end: string }>(
    `SELECT window_end::text AS window_end FROM digests
      WHERE business_id = $1 AND kind = $2
      ORDER BY window_end DESC LIMIT 1`,
    [businessId, kind],
  );
  const row = rows[0];
  return row === undefined ? null : new Date(row.window_end);
}

export async function recentDigests(
  options: { businessId?: string; limit?: number; db?: Queryable } = {},
): Promise<StoredDigest[]> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const limit = options.limit ?? 30;

  const { rows } = await db.query<DigestRow>(
    `SELECT ${COLUMNS} FROM digests
      WHERE business_id = $1
      ORDER BY window_end DESC, digest_id DESC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map(toStored);
}
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/orchestrator/digest-store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-verify verbatim read-back and the throw**

1. Make `recentDigests` return `body: ''`. The verbatim test must FAIL on the body comparison.
2. Change `recordChannel`'s `rowCount !== 1` to `rowCount < 0`. The throw test must FAIL.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/digest-store.ts src/orchestrator/digest-store.test.ts
git commit -m "Digest store: stored before delivery, read back verbatim, a missed update throws"
```

---

### Task 6: The scheduler step and the three channels

**Files:**
- Create: `src/orchestrator/digest-run.ts`
- Create: `src/orchestrator/digest-run.test.ts`
- Modify: `src/orchestrator/scheduler.ts` (run the digest **last**)
- Modify: `src/orchestrator/digest-invariants.test.ts` (point the walk at `digest-run.ts`)

**Interfaces:**
- Consumes: everything from Tasks 1–5, plus `loadActiveCharter` from `../charter/store.js` for the time zone **and the money ceiling** (`bundle.ceilings.monthlyMinor` / `.currency`, which `collectDigestFacts` takes as its second argument).
- **The two delivery seams, with their real signatures — do not re-derive these:**
  - `sendAlert(subject: string, body: string): Promise<{ ok: boolean; error?: string }>` (`orchestrator/runtime.ts:61`)
  - `BossMessenger.send({ text: string; jobId: string | null }): Promise<{ ok: boolean; error?: string }>` (`whatsapp/messenger.ts:68-72`) — it never takes a recipient and never throws. Pass `jobId: null`: a digest belongs to no single job.
- Produces:
```ts
export interface DigestRunResult {
  sent: readonly { kind: DigestKind; digestId: string }[];
  /** Windows that were due but produced nothing worth interrupting him for. */
  screenOnly: number;
  errored: string | null;
}

export function runDigests(options: {
  businessId?: string;
  now?: Date;
  sendAlert?: (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  messenger?: BossMessenger;
}): Promise<DigestRunResult>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/orchestrator/digest-run.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../test/db.js';
import { setDigestSettings } from '../governance/digest-settings.js';
import { recentDigests } from './digest-store.js';
import { runDigests } from './digest-run.js';

const BUSINESS = 'test-business';

describe('runDigests', () => {
  beforeEach(async () => {
    await resetDatabase();
    // A signed charter must exist: the time zone comes from it (spec §4).
    // Use the project's existing fixture helper rather than inserting by hand.
  });

  /** Spec §4: off means nothing is produced at all. */
  it('does nothing while the schedule is off', async () => {
    const result = await runDigests({ businessId: BUSINESS, now: new Date('2026-10-07T09:00:00+03:00') });
    expect(result.sent).toEqual([]);
    expect(await recentDigests({ businessId: BUSINESS })).toEqual([]);
  });

  /**
   * Spec §2 decision 3: an empty window reaches the SCREEN but not the inbox.
   * A daily email that is usually empty teaches him to ignore the one that is
   * not — and then he misses the day that mattered.
   */
  it('stores an empty window for the screen without sending email', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: true, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    const calls: string[] = [];
    const result = await runDigests({
      businessId: BUSINESS,
      now: new Date('2026-10-07T09:00:00+03:00'),
      sendAlert: async (subject) => { calls.push(subject); return { ok: true }; },
    });

    expect(result.screenOnly).toBe(1);
    expect(calls).toEqual([]);
    const stored = await recentDigests({ businessId: BUSINESS });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.hadContent).toBe(false);
    expect(stored[0]?.emailState).toBeNull();
  });

  /**
   * Spec §6: a channel the owner enabled but which cannot be reached is SAID,
   * not silenced. "Not sent" and "nothing to send" must not look alike.
   */
  it('records that WhatsApp was wanted and not connected, rather than skipping quietly', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: false, toWhatsApp: true },
      'owner', { businessId: BUSINESS },
    );
    // Seed one closed job so the window has content.
    // ... (use the project's job fixture helper)

    await runDigests({ businessId: BUSINESS, now: new Date('2026-10-07T09:00:00+03:00') });
    const stored = await recentDigests({ businessId: BUSINESS });
    expect(stored[0]?.whatsappState).toBe('skipped_not_connected');
  });

  /** Spec §6: a send failure is recorded on the row and never thrown. */
  it('records a failed email without failing the digest', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: true, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    // ... seed content

    const result = await runDigests({
      businessId: BUSINESS,
      now: new Date('2026-10-07T09:00:00+03:00'),
      sendAlert: async () => ({ ok: false, error: 'smtp down' }),
    });

    expect(result.errored).toBeNull();
    const stored = await recentDigests({ businessId: BUSINESS });
    expect(stored[0]?.emailState).toBe('failed');
  });

  /** Spec §5: the same window is not sent twice. */
  it('does not resend a window it already sent', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: false, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    const now = new Date('2026-10-07T09:00:00+03:00');
    await runDigests({ businessId: BUSINESS, now });
    await runDigests({ businessId: BUSINESS, now });
    expect(await recentDigests({ businessId: BUSINESS })).toHaveLength(1);
  });

  /** Spec §5: both kinds fire independently, and the overlap is deliberate. */
  it('sends a daily and a weekly for the same moment when both are on', async () => {
    await setDigestSettings(
      { schedule: 'both', dailyHour: 8, weeklyDay: 0, weeklyHour: 8, toEmail: false, toWhatsApp: false },
      'owner', { businessId: BUSINESS },
    );
    const result = await runDigests({
      businessId: BUSINESS,
      now: new Date('2026-10-11T09:00:00+03:00'), // Sunday
    });
    expect(result.sent.map((s) => s.kind).sort()).toEqual(['daily', 'weekly']);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/orchestrator/digest-run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the runner**

Shape, with the decisions that matter stated in the code:

```ts
// src/orchestrator/digest-run.ts
//
// **The digest runs LAST in the scheduler pass.** After the plans, after the
// closes, after the WhatsApp report — otherwise it reports on a period that
// ended half a second after it looked. The same ordering argument that put
// `closeVerifiedJobs` after the plans.
//
// **No model is reachable from this file, at any depth.** Spec §2 decision 2,
// locked by a transitive import walk in `digest-invariants.test.ts`.
```

For each kind in `['daily', 'weekly']`:
1. `loadDigestSettings` — if `schedule` is `'off'`, return immediately with `sent: []`.
2. `loadActiveCharter` for the time zone. **Let a stale-charter throw be caught here and returned as `errored`** — the pass still has approvals to expire, exactly as `scanError` and `whatsappError` already do. Do not let it escape `runDigests`.
3. `lastWindowEnd(kind)` → `dueWindow(settings, kind, lastEnd, now, timeZone)`. `null` → next kind.
4. `collectDigestFacts(window)` → `renderDigest(facts)`.
5. **`storeDigest` — before any delivery.**
6. Deliver, each channel independently, each outcome recorded with `recordChannel`, each failure caught and never rethrown:
   - **email**: only when `settings.toEmail` **and** `rendered.hadContent`. No `sendAlert` supplied → `'skipped_not_connected'`.
   - **whatsapp**: only when `settings.toWhatsApp` **and** `rendered.hadContent`. No messenger → `'skipped_not_connected'`.
   - **screen**: already satisfied by the stored row.

- [ ] **Step 4: Wire it into the scheduler, last**

In `src/orchestrator/scheduler.ts`, after the `evaluateAutonomy` call (today the final step), add the digest and extend `SchedulerPassResult` with `digest: DigestRunResult | null` — `null` when the schedule is off, following `conduct`'s own docblock: "the loop did not run" and "it ran and found nothing" are different facts.

- [ ] **Step 5: Point the no-model invariant at the real entry (ledger R6 — required)**

Task 4 wrote `digest-invariants.test.ts` walking from `digest-render.ts`, because
`digest-run.ts` did not exist yet. **Change the entry to `digest-run.ts` now** and
remove the comment Task 4 left there. Then re-confirm BOTH of its tests pass —
especially the one asserting the walk traverses more than the entry file, since
`digest-run.ts` is the file that actually reaches the database and the charter, and
a walk that silently resolves nothing from it would report "no model reachable"
about a graph of one file.

- [ ] **Step 6: Run the touched tests**

Run: `npx vitest run src/orchestrator/digest-run.test.ts src/orchestrator/digest-invariants.test.ts src/orchestrator/scheduler.test.ts src/orchestrator/scheduler-runs-plans.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation-verify the four load-bearing claims**

1. Deliver before storing. **Write a test first** that fails on that order (store a digest with a throwing `sendAlert` and assert the row exists), then mutate and watch it fail.
2. Send email when `hadContent` is false. The empty-window test must FAIL on `calls` being non-empty.
3. Skip `recordChannel` when a channel is unreachable. The not-connected test must FAIL on `'skipped_not_connected'`.
4. Move the digest before `runDueJobs` in the pass. **Write a test** that seeds work completing in the same pass and asserts the digest counts it; the mutation must make it fail.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/digest-run.ts src/orchestrator/digest-run.test.ts \
        src/orchestrator/digest-invariants.test.ts src/orchestrator/scheduler.ts
git commit -m "Digests run last in the pass, stored before delivery, every channel's outcome recorded"
```

---

### Task 7: The screen and the settings form

**Files:**
- Create: `src/dashboard/digest-view.ts`
- Create: `src/dashboard/digest-view.test.ts`
- Modify: `src/dashboard/server.ts` (`GET /digest`, `POST /digest/settings`)
- Modify: `src/dashboard/server.test.ts`
- Modify: `src/dashboard/views.ts` (nav link, both nav strings)

**Interfaces:**
- Consumes: `recentDigests`, `StoredDigest`, `loadDigestSettings`, `DigestSettings`, `collectDigestFacts`, `renderDigest`.
- Produces:
```ts
export function renderDigestScreen(options: {
  settings: DigestSettings;
  stored: readonly StoredDigest[];
  live: { body: string; windowLabel: string };
  csrf: string;
}): string;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/dashboard/digest-view.test.ts
import { describe, expect, it } from 'vitest';
import { DIGEST_DEFAULTS } from '../governance/digest-settings.js';
import { renderDigestScreen } from './digest-view.js';

const live = { body: 'תדריך יומי · היום עד כה', windowLabel: '07/10 08:00 – עכשיו' };

describe('renderDigestScreen', () => {
  /**
   * Spec §4: the live view exists so the owner can see what a digest looks like
   * without committing to a schedule — and it must never be mistaken for a
   * stored one. The stored digest is a record; the live one is a preview.
   */
  it('marks the live view as live and distinguishes it from a stored digest', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [],
      live,
      csrf: 'c',
    });
    expect(html).toContain('עד כה');
    expect(html).toContain('טרם נשלח');
  });

  it('says plainly when no digest has ever been sent', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [], live, csrf: 'c',
    });
    expect(html).toContain('לא נשלח עדיין');
  });

  /** Spec §6: an unreachable channel is shown, not hidden. */
  it('shows that a channel was wanted and could not be reached', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [{
        digestId: 'DG-1', kind: 'daily',
        windowStart: '2026-10-06 08:00:00+03', windowEnd: '2026-10-07 08:00:00+03',
        body: 'גוף', hadContent: true, createdAt: '2026-10-07 08:00:01+03',
        emailState: 'failed', whatsappState: 'skipped_not_connected',
      }],
      live, csrf: 'c',
    });
    expect(html).toContain('לא נשלח');
    expect(html).toContain('לא היה מחובר');
  });

  /** A stored body can carry a document name a stranger chose. */
  it('escapes and bidi-strips a stored body', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [{
        digestId: 'DG-1', kind: 'daily',
        windowStart: '2026-10-06 08:00:00+03', windowEnd: '2026-10-07 08:00:00+03',
        body: '<script>alert(1)</script>‮גרר', hadContent: true,
        createdAt: '2026-10-07 08:00:01+03', emailState: null, whatsappState: null,
      }],
      live, csrf: 'c',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('‮');
    expect(html).toContain('גרר');
  });

  it('carries a CSRF token on the settings form', () => {
    const html = renderDigestScreen({
      settings: { ...DIGEST_DEFAULTS, updatedAt: '', updatedBy: '' },
      stored: [], live, csrf: 'tok-123',
    });
    expect(html).toContain('tok-123');
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/dashboard/digest-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the renderer and the routes**

- `renderDigestScreen` is its own module because `views.ts` is already over 1,600 lines. Use `escLabel` (exported) for every value the owner reads — it escapes HTML **and** strips bidi in one call.
- `GET /digest`: behind the owner session and the password gate, registered in the same block as `/connections`. It computes the **live** view by calling `collectDigestFacts` + `renderDigest` for the window from the last scheduled hour to now, labelled as live. Stored digests come from `recentDigests`.
- `POST /digest/settings`: `readFormBody`, `verifyCsrfToken(session.sessionId, form.get('csrf'))`, then `setDigestSettings(..., 'owner')`. An out-of-range hour is refused by the database (Task 1); render the form again with a Hebrew message rather than a 500.
- Nav: add `<a href="/digest">מה קרה</a>` to **both** nav strings in `views.ts`.

- [ ] **Step 4: Run the touched tests**

Run: `npx vitest run src/dashboard/digest-view.test.ts src/dashboard/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-verify**

1. Swap `escLabel` for raw interpolation in the stored body. The escaping test must FAIL on both assertions.
2. Remove the live/stored distinction label. The first test must FAIL on `'טרם נשלח'`.
3. Drop the CSRF field. The CSRF test must FAIL, and the POST test in `server.test.ts` must reject.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/digest-view.ts src/dashboard/digest-view.test.ts \
        src/dashboard/server.ts src/dashboard/server.test.ts src/dashboard/views.ts
git commit -m "The digest screen: stored digests as records, today so far marked as live"
```

---

### Task 8: Erasure, in both roles

**Files:**
- Modify: `src/governance/erasure-plan.ts`
- Modify: `src/governance/erasure.ts`
- Modify: `src/governance/erasure-invariants.test.ts`
- Modify: `src/governance/erasure-plan.test.ts`
- Modify: `docs/10-user-settings.md`

**Interfaces:**
- Consumes: the existing predicate/discovery pattern in `erasure-plan.ts`.
- Produces: `export const DIGESTS_ERASED_PREDICATE` plus a discovery query that adds matching digests' ids to the plan.

- [ ] **Step 1: Read the two halves before writing either**

`erasure-plan.ts` holds exported predicate constants and discovery queries; `countItems` and the executor both name the twelve tables **by hand**. Read `WHATSAPP_MESSAGES_ERASED_PREDICATE` and the `idsFrom(...)` discovery block around it: that pair — a deletion target **and** a discovery source — is the shape to copy.

**Both halves, not one.** CLAUDE.md records two separate occasions when a new content store was wired to closure only and the discovery half was forgotten, and the second of them was found by a security review on the WhatsApp branch after the controller had already ruled it could wait.

- [ ] **Step 2: Write the failing tests**

Add to `src/governance/erasure-plan.test.ts`:

```ts
/**
 * Spec §7: the stored digest NAMES failures, so a document name, a recipient or
 * a contact name can land in its body. Once stored it survives, and "forget
 * about Ronit" must reach it.
 */
it('finds a digest whose body mentions the contact, and counts it for deletion', async () => {
  // Seed a digest whose body contains the anchor's identifier.
  // Assert the plan's digest count is 1 and the id appears in the plan.
});

/**
 * The discovery half, which is the one this repo has twice forgotten: a search
 * by the person's name must FIND the digest, not merely delete it once it was
 * found through something else.
 */
it('discovers a digest by its body alone, with no job or document linking to it', async () => {
  // Seed a digest mentioning the anchor and NOTHING else referencing it.
  // Assert the plan still counts it.
});
```

Add to `src/governance/erasure-invariants.test.ts`: seed the `PROBE` identifier into a `digests.body` row alongside the existing twelve seed sites, so the schema-derived sweep can actually catch a regression here. **Seeding is what makes the sweep able to find it — the sweep itself is derived from `information_schema`, but the deletion list is hand-written, so a table missing from the list will not be deleted even though the sweep would notice.**

- [ ] **Step 3: Run and watch fail**

Run: `npx vitest run src/governance/erasure-plan.test.ts src/governance/erasure-invariants.test.ts`
Expected: FAIL — the digest is neither discovered nor deleted, and the probe survives.

- [ ] **Step 4: Wire both halves**

1. `DIGESTS_ERASED_PREDICATE` — matches by `business_id` plus `digest_id = ANY(...)`, exactly as the plan's other id-list predicates do.
2. A discovery query that adds digest ids whose `body` matches the contact anchor, using `likeLiteral` **and** a real `ESCAPE` clause. CLAUDE.md records that one of these predicates declared `ESCAPE ''` — the escape was silently off, the escaped pattern matched nothing, and the sweep stayed green only because the probe happened to contain no wildcard. **The probe's underscore is why that is caught now; keep it.**
3. Name `digests` in `countItems` **and** in the executor, with the same parameters derived in the same place.

- [ ] **Step 5: Run and watch pass**

Run: `npx vitest run src/governance/erasure-plan.test.ts src/governance/erasure.test.ts src/governance/erasure-invariants.test.ts src/dashboard/erasure-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-verify both halves separately**

**Two mutations, because one test passing does not prove two wirings:**
1. Remove the discovery query, keep the predicate. The discovery test must FAIL while the deletion test still passes.
2. Remove `digests` from the executor, keep discovery. The invariant sweep must FAIL on the surviving probe.

If a single mutation fails both tests, the two halves are not independently covered — say so and fix the tests.

- [ ] **Step 7: Document the setting**

In `docs/10-user-settings.md` add **setting 3 — התדריך היומי והשבועי**: what the owner chooses, that the switch is off by default, that the time zone comes from the charter, that the screen always receives it while email and WhatsApp are opt-in and only when there is something to say, and that a channel which cannot be reached is stated rather than silenced. Add a changelog row. Move nothing out of "מה שהוחלט וטרם נבנה" that is not actually built.

- [ ] **Step 8: Commit**

```bash
git add src/governance/erasure-plan.ts src/governance/erasure.ts \
        src/governance/erasure-plan.test.ts src/governance/erasure-invariants.test.ts \
        docs/10-user-settings.md
git commit -m "The stored digest is erasable, in both roles: deletion target and discovery source"
```

---

## Self-Review

**1. Spec coverage.** Every section maps to a task: §1.1 and §3 → Tasks 3–4; §2 decision 1 → Task 4 (counted vs named); decision 2 → Task 4's transitive invariant; decision 3 → Tasks 4 and 6 (`hadContent`); decision 4 → Task 5 (verbatim read-back); §2.1 (`know.digest` not an agent) → Global Constraints, enforced by the absence of any allowlist edit in any task; §4 → Tasks 1 and 7; §5 → Task 2 and Task 6 step 7.4; §6 → Tasks 5 and 6; §7 → Task 8; §8 → Global Constraints; §9 → Tasks 1, 3 (`MAX_NAMED_EXCEPTIONS`) and 4; §10's seven controls → Task 4 (1), Task 5 (2, 3), Task 6 (4), Task 8 (5), Task 2 (6, 7).

**Gap found and closed:** §10 control 6 ("the daily/weekly overlap is deliberate") had no test. Task 2's "computes the weekly window independently" and Task 6's "sends a daily and a weekly for the same moment" together cover it; a reviewer should check both exist.

**2. Placeholder scan.** Three places deliberately say "use the project's existing fixture helper" rather than inventing a seeding API I have not read — Task 6's charter and job fixtures. That is a direction to read real code, not a TBD, and the task says to report any correction. Task 3 carries the same instruction for three column names I did not verify.

**3. Type consistency.** `DigestKind` is defined in `digest-window.ts` and imported by `digest-facts.ts`, `digest-store.ts` and `digest-run.ts` — one definition. `DigestFacts` is produced by Task 3 and consumed by Task 4 under that exact name. `RenderedDigest` is produced by Task 4 and consumed by Task 5's `storeDigest`. `ChannelState` is defined once in Task 5 and used by Task 6's `recordChannel` calls and Task 7's screen. `MAX_NAMED_EXCEPTIONS` is exported from `digest-facts.ts` and imported by the renderer so the cap and the "+N" cannot disagree.
