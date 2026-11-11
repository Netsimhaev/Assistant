# Multi-Tenant (Stage A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One server process and one shared Postgres run every business. Each business sees, runs and stores only its own data, behind two walls: code-level business scoping and Postgres Row Level Security.

**Architecture:**
- A `businesses` registry replaces the `BUSINESS_ID` env var.
- Every data path takes the business explicitly. Production code queries only through a business-scoped connection (`withBusiness`), which sets a session-level `app.business_id`. RLS policies call `app_business_id()`, which throws when no business is set.
- A small, named set of cross-business operations runs on a separate BYPASSRLS pool.
- The scheduler loops over active businesses one at a time.
- The dashboard serves every business. Each request's business comes from its session.

**Tech Stack:** TypeScript (ESM, NodeNext), `pg`, PostgreSQL 17 (Supabase in production: direct or session connections only, no transaction pooler), vitest.

**Spec:** [docs/superpowers/specs/2026-11-11-multi-tenant-design.md](../specs/2026-11-11-multi-tenant-design.md). Read it before any task. Every "§" below refers to it.

## Global Constraints

- **No production default for the business.** By the end of Task 12 there is no `config.businessId`, no `BUSINESS_ID` and no `getPool()` in production code. A `businessId` parameter is never optional (`?`) and never defaulted. See §5.2.
- **Business id format:** `^[a-z0-9-]{3,63}$`, and it must also pass `SafeLookupKey`. *Plan deviation from spec §5.1, which says 40:* test ids such as `test-business-health-probe-throw-mid-outage` are 43 characters, and 63 is Postgres's identifier limit.
- **No foreign keys from data tables to `businesses`.** *Plan deviation from spec §5.1:* hundreds of tests insert rows for ad-hoc business ids, and a foreign key would force every test to register its ids first. Existence is enforced where a business is chosen instead: the scheduler takes its list from `businesses`, login resolves only registered, active businesses, and the CLIs refuse unknown ids. RLS is the wall; a foreign key would be a typo guard only.
- **The RLS context is session-level, never transaction-level** (`set_config('app.business_id', $1, false)`). A connection whose reset fails is destroyed with `release(true)`, never returned to the pool. See §5.6.
- **`app_business_id()` raises when `app.business_id` is NULL or `''`.** Policies never call `current_setting` directly. See §5.6.
- **Roles:**
  - `assistant_app` is a NOLOGIN group: NOBYPASSRLS, owns nothing.
  - `assistant_platform` is a LOGIN role with BYPASSRLS. BYPASSRLS is not inherited, so it must be set on the login role itself.
  - The migrator is whatever role `DATABASE_MIGRATE_URL` or `TEST_DATABASE_URL` uses.
  - Login roles for the app are members of `assistant_app`.
- **Env names:**
  - Production: `DATABASE_URL` (app login), `DATABASE_PLATFORM_URL`, `DATABASE_MIGRATE_URL`.
  - Tests: `TEST_DATABASE_URL` stays the migrator/superuser, as today. The app and platform test URLs are derived from it (Task 1). Never print a URL.
- **Cross-business operations** (§5.7) run only through `src/tenancy/platform.ts` on the platform pool. Only `src/tenancy/`, `src/cli/`, `src/db/` and `src/orchestrator/run-scheduler.ts` may import `src/db/platform-pool.ts`.
- **Hebrew for humans, English for code.** Refusals, CLI messages meant for the owner, and dashboard copy are in Hebrew.
- **`.js` on every relative import.**
- **Tests run on a dedicated database** (CLAUDE.md, "הרצת מבחנים במקביל ל-hook"). Subagents use `assistant_test_sdd`.
- **Migrations are new files, never edits to old ones.** Numbering starts at `062_`.

## Review Focus

1. **A query that throws inside `withBusiness`.** The next checkout of that connection must not carry the old business. Task 1 test: `a connection that errored mid-use comes back with no business`.
2. **A suspended business with a live session.** The next request is refused (`החשבון מושהה — פנה למנהל המערכת`), not served. Task 10 test.
3. **Login email with different case or surrounding spaces.** It resolves to the same user, and a second user with the same email in other case is refused. Tasks 2 and 10 tests.
4. **A CLI given a malformed or unknown business id.** It refuses before writing anything. Task 2 test.
5. **A scheduler with zero active businesses.** The pass completes and logs `0 businesses`, with no throw. Task 9 test.
6. **A pre-migration cookie** (old `sid` holding only a token, no business part). It is treated as logged out, never as an error page. Task 10 test.

---

### Task 1: Roles, the business-scoped pool, and the test harness

**Files:**
- Modify: `src/db/pool.ts`, `src/config.ts`, `src/test/db.ts`, `.env.example`
- Create: `src/db/roles.ts`, `src/db/platform-pool.ts`, `src/db/migrations/062_app_business_id.sql`, `src/db/pool-business.test.ts`

**Interfaces — produces:**
- `export interface BusinessDb extends Queryable { readonly businessId: string; readonly inTransaction: boolean }`, in `pool.ts`.
- `export async function withBusiness<T>(businessId: string, fn: (db: BusinessDb) => Promise<T>): Promise<T>`
  - Validates the id format, checks out a client from the **app** pool, then runs `SELECT set_config('app.business_id', $1, false)`.
  - After `fn`, in `finally`, runs `RESET app.business_id` and releases. If that reset throws, releases with `release(true)`.
- `export async function transaction<T>(db: BusinessDb, fn: (tx: BusinessDb) => Promise<T>): Promise<T>`
  - On a db that is already in a transaction, runs `fn(db)` (it joins).
  - Otherwise runs BEGIN/COMMIT/ROLLBACK on that client.
- `export async function withBusinessTransaction<T>(businessId: string, fn: (tx: BusinessDb) => Promise<T>): Promise<T>`
- `export function isValidBusinessId(id: string): boolean`: regex from Global Constraints, plus `SafeLookupKey`.
- `getPool()`, `withTransaction()` and `acquireAdvisoryLock()` stay for now. Task 12 deletes `getPool()` and `withTransaction()`.
- `src/db/platform-pool.ts`: `export async function withPlatform<T>(fn: (db: Queryable) => Promise<T>): Promise<T>`, on a pool built from `config.databasePlatformUrl`.
- `src/db/roles.ts`: `export async function ensureRoles(admin: Queryable, logins: { app: { user: string; password: string }; platform: { user: string; password: string } }): Promise<void>`
  - Idempotent `DO` blocks: `CREATE ROLE assistant_app NOLOGIN NOBYPASSRLS` if missing.
  - App login: `CREATE/ALTER ROLE <app.user> LOGIN PASSWORD … NOBYPASSRLS IN ROLE assistant_app`.
  - Platform login: `CREATE/ALTER ROLE <platform.user> LOGIN PASSWORD … BYPASSRLS`.
  - Grants `CONNECT`, plus `USAGE` on schema `public`.
- npm script `db:roles` (`tsx src/db/roles.ts`). It reads `DATABASE_MIGRATE_URL` as admin and takes user and password from `DATABASE_URL` / `DATABASE_PLATFORM_URL`.
- `config`:
  - `databaseUrl` (app). In tests it is derived from `TEST_DATABASE_URL`, with user `assistant_app_test` and password `TEST_APP_PASSWORD = 'assistant-app-test-only'`.
  - `databasePlatformUrl`. In tests: user `assistant_platform_test`, password `'assistant-platform-test-only'`.
  - `databaseMigrateUrl`. In tests: `TEST_DATABASE_URL`.
  - The test-only passwords are constants in `config.ts`, used only when `isTest`.
- `src/test/db.ts`:
  - `ensureSchema()` runs `ensureRoles` with the test logins, then `migrate()`, both on the migrator pool.
  - `export function testDb(): pg.Pool` (migrator pool) is for test seeding and assertions.
  - `resetDatabase()` TRUNCATEs through `testDb()`.
- `migrate.ts` runs on the migrator pool (`config.databaseMigrateUrl`).
- `062_app_business_id.sql`:
  - `CREATE FUNCTION app_business_id() RETURNS text LANGUAGE plpgsql STABLE`: read `current_setting('app.business_id', true)` and `RAISE EXCEPTION 'no business context'` if NULL or `''`.
  - `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO assistant_app`, `GRANT USAGE ON ALL SEQUENCES …`, and `ALTER DEFAULT PRIVILEGES` for both. No RLS yet.

- [ ] **Step 1: Write failing tests in `src/db/pool-business.test.ts`**
  - `sets the business for the connection`: inside `withBusiness('biz-a', db => db.query("SELECT app_business_id() AS b"))`, expect `b === 'biz-a'`.
  - `a connection that errored mid-use comes back with no business`: set `max: 1` via a test pool override, throw inside `withBusiness('biz-a')`, then use the next checkout. Expect a raw `SELECT app_business_id()` on that same pooled client to reject with `/no business context/`.
  - `refuses a malformed business id before touching the pool`: `withBusiness('Bad_ID', …)` rejects, and `fn` is never called.
  - `transaction joins an open transaction`: inside `transaction(db, …)`, a nested `transaction(tx, …)` sees `tx.inTransaction === true`, and a throw in the inner rolls back the outer.
  - `runs as a role that cannot bypass RLS`: `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` is `false` inside `withBusiness`.
- [ ] **Step 2:** Run `TEST_DATABASE_URL="$SDD" npx vitest run src/db/pool-business.test.ts`. Expected: FAIL (`withBusiness` not exported).
- [ ] **Step 3:** Implement the interfaces above. A test-only `__setAppPoolMaxForTest(n)` export is allowed for the `max: 1` test.
- [ ] **Step 4:** Run the file, then the full suite on `$SDD`. Expected: the file passes and the suite stays at 4548 passing. Existing code still uses `getPool()`, which now points at the app login. No RLS is enabled yet, so nothing else changes.
- [ ] **Step 5:** Commit `feat(tenancy): business-scoped connections and database roles`.

### Task 2: The `businesses` registry, child `business_id` columns, CLIs

**Files:**
- Create:
  - `src/db/migrations/063_businesses.sql`
  - `src/tenancy/businesses.ts`, `src/tenancy/platform.ts`
  - `src/cli/business.ts`
  - `src/tenancy/businesses.test.ts`
- Modify: `package.json` scripts, `src/test/db.ts`

**Interfaces — produces:**
- `063_businesses.sql`:
  - `businesses (business_id TEXT PRIMARY KEY CHECK (business_id ~ '^[a-z0-9-]{3,63}$'), display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120), status TEXT NOT NULL CHECK (status IN ('active','suspended')) DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), suspended_at TIMESTAMPTZ)`.
  - Backfill one `active` row per distinct `business_id` found in `charter_versions`, `jobs` and `dashboard_users`, with `display_name` = the id.
  - `ALTER TABLE job_steps ADD COLUMN business_id TEXT`, filled from `jobs`, then `SET NOT NULL`. The same for `document_versions`, filled from `document_productions`.
  - Code that INSERTs into those two tables must now pass `business_id`. Find the writers with grep: `INSERT INTO job_steps` and `INSERT INTO document_versions`.
- `src/tenancy/businesses.ts` (runs on the platform pool via `withPlatform`):
  - `createBusiness(id, displayName): Promise<void>`. Refuses invalid ids, duplicate ids and empty names. Errors are Hebrew `TenancyError` messages.
  - `setBusinessStatus(id, 'active' | 'suspended'): Promise<void>`.
  - `getBusiness(id): Promise<{ businessId: string; displayName: string; status: 'active' | 'suspended' } | null>`.
- `src/tenancy/platform.ts`: `listActiveBusinesses(): Promise<string[]>`, ordered by `business_id`. Later tasks add `resolveLogin` (Task 10) and `cleanupOAuthStates` / rotation access (Task 12).
- CLI `npm run business -- create <id> "<name>" | suspend <id> | resume <id> | list`. Prints Hebrew confirmations. `list` shows id, name and status only.
- `src/test/db.ts`: `export async function registerBusiness(id = 'test-business', status = 'active')`, for tests that need registry rows (scheduler, login).

- [ ] **Step 1: Write failing tests in `src/tenancy/businesses.test.ts`**
  - `creates and lists an active business`.
  - `refuses a malformed id before writing`: try `'Bad_ID'`, `'ab'`, a 64-character id, and `'__proto__'`. Each rejects, and `businesses` stays empty.
  - `refuses a duplicate id`.
  - `suspended businesses are not listed`.
  - `job_steps rows written by transition carry the job's business_id`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, including the `job_steps` and `document_versions` writers.
- [ ] **Step 4:** Run the file and the full suite on `$SDD`. Expected: all pass.
- [ ] **Step 5:** Commit `feat(tenancy): businesses registry`.

### Tasks 3–7: Thread the business through every data path

**The shared rule for Tasks 3–7.** Each task owns a set of folders and converts every exported function in them to this rule:

- A function that reads or writes business data takes `db: BusinessDb` as a **required** parameter. This replaces `options.tx ?? getPool()` and `withTransaction`. It uses `db.businessId` and never takes a separate `businessId`. *Plan decision:* one source of truth means a function cannot be given business A's id with business B's connection. Pure functions that only need the id, such as path builders, take `businessId: string`, required.
- Atomic work uses `transaction(db, tx => …)`. Session advisory locks (`pg_try_advisory_lock`) are taken on the `BusinessDb` that does the work. Keep the lock key strings exactly as they are today.
- A function that opens its own connection today (the ten `getPool().connect()` sites, entry points) becomes `withBusiness(businessId, db => …)` with `businessId: string` required.
- **Callers outside the task's folders** that break are fixed minimally: wrap the call in `withBusiness(<the businessId already in scope, or config.businessId>, db => …)`, and mark the line `// TENANCY-TODO(task N)`, where N is the task that owns that caller. The owning task removes the marker. Task 12 fails if any marker remains.
- Tests for the converted functions move to `withBusiness(TEST_BUSINESS, db => …)`, with `TEST_BUSINESS` exported from `src/test/db.ts` as `'test-business'`. Seeding and assertions in tests use `testDb()`.
- Gate per task: `npm run typecheck` is clean, the full suite on `$SDD` passes, and a task-local scan finds no `getPool(` and no `config.businessId` in the task's folders, outside `// TENANCY-TODO` lines owned by other tasks.

**Task 3 — the core:** `src/audit/`, `src/policy/`, `src/charter/`, and `src/governance/`, except `erasure*`, which goes in Task 6.
- `evaluateToolCall` takes `ctx.db: BusinessDb` and uses `ctx.db.businessId`. Today's `ctx.businessId` is removed.
- `loadActiveCharter(db)`, `probeActiveCharter(db)`, `activeCharterVersion(db)`, `appendAudit(db, …)`, `checkKillSwitch(db, scope)`, `trip(db, …)`, `release(db, …)`.
- `trip()` keeps its "write commits first on its own connection" asymmetry, implemented as a fresh `withBusiness(db.businessId, …)` for the state write (CLAUDE.md, the killswitch paragraph).
- `liveKeyId()` stays as is until Task 12.
- Commit: `refactor(tenancy): core takes BusinessDb`.

**Task 4 — the orchestrator:** `src/orchestrator/`, except `scheduler.ts`, `run-scheduler.ts` and `runtime.ts`, which are Tasks 8 and 9.
- `runPlan`, `runPlanForJob`, `executeStep`, `transition`, `createJob`, `loadJob`, `runDueJobs(db, …)`, `closeVerifiedJobs(db, …)`, and the rest.
- `runDueJobs` keeps its per-job `withBusiness` and advisory lock, because each job runs on its own connection.
- Commit: `refactor(tenancy): orchestrator takes BusinessDb`.

**Task 5 — the domain folders:** `src/memory/`, `src/ledger/`, `src/meetings/`, `src/mail/`, `src/calendar/`, `src/whatsapp/`, `src/documents/`, `src/production/`.
- Commit: `refactor(tenancy): domains take BusinessDb`.

**Task 6 — erasure and the governance leftovers:** `src/governance/erasure*.ts`, `credential-store.ts`, `oauth-grants.ts`, `instructions.ts`, `instruction-confirmations.ts`, and every settings module.
- `buildErasurePlan(db, anchor)` and `executeErasure(db, plan)`.
- The erasure invariant test still scans every table.
- Commit: `refactor(tenancy): erasure and settings take BusinessDb`.

**Task 7 — the SDK and the CLIs:** `src/sdk/`, `src/cli/`.
- Every CLI that touches a business requires `--business <id>`. With it missing, or failing `isValidBusinessId`, or unknown to `getBusiness`, the CLI prints `חסר מזהה עסק: --business <id>` or `העסק <id> לא קיים`, exits with code 2, and writes nothing.
- The affected scripts: `owner:create`, `owner:password`, `kill`, `secret`, `ramp:set`, `doc:ingest`, `job:seed`, and every `sdk:*` script.
- `secret:key` stays server-wide.
- Add one test per CLI family to `src/cli/cli.test.ts`: `refuses to run without --business`.
- Commit: `refactor(tenancy): CLIs and SDK scripts require --business`.

### Task 8: Server runtime, per-business runtime, settings in the database

**Files:**
- Create:
  - `src/db/migrations/064_runtime_settings.sql`
  - `src/tenancy/runtime-settings.ts`, `src/tenancy/platform-credentials.ts`
  - `src/cli/business-settings.ts`, `src/cli/import-env.ts`
  - Tests next to each new file
- Modify: `src/orchestrator/runtime.ts`, `src/orchestrator/runtime.test.ts`, the OAuth token HTTP modules (`google-token-http.ts`, `microsoft-token-http.ts`), `.env.example`

**Interfaces — produces:**
- `064_runtime_settings.sql`:
  - `business_runtime_settings` (PK `business_id`). Columns:
    - `notify_to TEXT`
    - `notify_smtp_host TEXT`, `notify_smtp_port INT`, `notify_smtp_secure BOOLEAN`, `notify_smtp_from TEXT`, `notify_smtp_user TEXT`, `notify_smtp_allow_cleartext BOOLEAN NOT NULL DEFAULT false`
    - `mail_system TEXT`
    - `whatsapp_enabled BOOLEAN NOT NULL DEFAULT false`
    - `inbox_enabled BOOLEAN NOT NULL DEFAULT false`
    - One nullable `INT CHECK (>= 0)` column per daily cap, named after the env var in snake case: `document_reads_per_day`, `documents_per_day`, `mail_reads_per_day`, `mail_curation_per_day`, `curation_runs_per_day`, `delegations_per_day`, `ledger_nudges_per_day`, `whatsapp_transcribe_boss_per_day`, `whatsapp_transcribe_other_per_day`, `whatsapp_instructions_per_day`, `whatsapp_question_window_minutes`, `whatsapp_max_audio_seconds`.
    - `updated_at`
  - `platform_credentials (ref TEXT PRIMARY KEY, key_id TEXT NOT NULL, nonce BYTEA NOT NULL, ciphertext BYTEA NOT NULL, updated_at)`
  - `server_key_state (singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), key_id TEXT NOT NULL, check_nonce BYTEA NOT NULL, check_value BYTEA NOT NULL, created_at)`, backfilled from the one `credential_key_state` row if exactly one exists.
- `runtime-settings.ts`:
  - `loadRuntimeSettings(db): Promise<RuntimeSettings>`. With no row, every channel is off.
  - `saveRuntimeSettings(db, patch)`.
  - `capFor(settings, 'documentReadsPerDay'): number`. Returns the per-business value, or `config.<cap>` when it is NULL.
- `platform-credentials.ts`: `putPlatformSecret(ref, value)`, `resolvePlatformSecret(ref): Promise<string | null>`.
  - AAD is `platform:<ref>`, with the `ref` matching `CREDENTIAL_REF_PATTERN`.
  - Access goes through `withPlatform`.
  - Used for `GOOGLE_OAUTH_CLIENT_ID/SECRET` and `MICROSOFT_OAUTH_CLIENT_ID/SECRET`.
- `runtime.ts`:
  - `buildServerRuntime(env = process.env): Promise<ServerRuntime>`, once per process: master key, tool paths, adapter factories, server warnings.
  - `businessRuntime(server: ServerRuntime, db: BusinessDb): Promise<Runtime>`. Builds notify, WhatsApp and inbox from `loadRuntimeSettings(db)` and the business's credentials.
    - The fixed secret names are `NOTIFY_SMTP_PASS`, `GREEN_API_INSTANCE_ID` and `GREEN_API_TOKEN`.
    - It returns `warnings` for that business. The `Runtime` shape stays the same.
    - It is rebuilt on every pass and never cached.
- CLI `npm run business:settings -- --business <id> [--notify-to …] [--smtp-host …] … [--whatsapp on|off] [--inbox on|off] [--cap name=value]`. It prints the resulting row without secrets.
- CLI `npm run tenancy:import-env -- --business <id>`:
  - Copies today's env settings into the business's row.
  - Moves the four OAuth client secrets from that business's `credentials` into `platform_credentials`.
  - Prints what it moved and what was missing, never values.
- Every `config.<cap>` read outside `config.ts` becomes `capFor(settings, …)`. The settings object is threaded from `businessRuntime`, or loaded with `loadRuntimeSettings(db)` at the consumer.

- [ ] **Step 1: Failing tests**
  - `a business with no settings row has no notify, no WhatsApp, no inbox, and says so in warnings`.
  - `settings change takes effect on the next businessRuntime call without restart`.
  - `two businesses get their own notify recipients`.
  - `capFor falls back to the server default only when NULL` (a stored `0` stays `0`).
  - `platform secret does not open as a business secret and vice versa`, with the same `ref` string in both stores.
  - `import-env moves settings and OAuth clients and prints no secret value`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Rework `runtime.test.ts` from env objects to settings rows.
- [ ] **Step 4:** Run the files and the full suite on `$SDD`. Expected: all pass.
- [ ] **Step 5:** Commit `feat(tenancy): per-business runtime and settings`.

### Task 9: The scheduler runs every active business

**Files:** Modify `src/orchestrator/scheduler.ts`, `src/orchestrator/run-scheduler.ts`, `src/orchestrator/scheduler-log.ts`. Create `src/orchestrator/scheduler-tenants.test.ts`.

**Interfaces:**
- Consumes: `listActiveBusinesses`, `withBusiness`, `buildServerRuntime`, `businessRuntime`.
- Produces:
  - `schedulerPass(db: BusinessDb, options: { now?; limit?; runtime: Runtime; inbox?; … })`. It takes the business from `db`, and `runtime` is required.
  - `export async function runAllBusinesses(server: ServerRuntime, options: { now?: Date; perBusinessDeadlineMs: number; state: TenantLoopState }): Promise<TenantPassReport>`, in a new `src/orchestrator/tenants.ts`.
  - `TenantLoopState = { inFlight: Set<string>; resumeFrom: string | null }`.
  - `TenantPassReport = { ran: string[]; skippedInFlight: string[]; failed: { businessId: string; reason: 'threw' | 'deadline' }[]; notReached: string[] }`.
  - The default per-business deadline is `SCHEDULER_BUSINESS_DEADLINE_MS`, 120000.
- Behaviour (§5.3):
  - Businesses run in order of `business_id`, starting at `resumeFrom`.
  - Each one runs `withBusiness(id, db => schedulerPass(db, { runtime: await businessRuntime(server, db) }))` inside `withDeadline`.
  - A business that throws or passes the deadline is recorded in `failed`, and the loop continues. On a deadline it stays in `inFlight` until its promise actually settles.
  - A business already in `inFlight` is skipped (`skippedInFlight`).
  - If the interval's time budget (`SCHEDULER_INTERVAL_MS`) runs out, the remaining businesses go to `notReached` and `resumeFrom` is set to the first of them.
  - Each failure writes one `audit_log` row in that business's chain, kind `tool_call` with reason `scheduler_pass_failed:<threw|deadline>`, counts only. Use the existing audit API with `db`.
- `run-scheduler.ts`: `buildServerRuntime` once, then `runAllBusinesses` every interval. It logs `N businesses, ran X, failed Y, skipped Z` and never logs a business's content.

- [ ] **Step 1: Failing tests in `scheduler-tenants.test.ts`**
  - `runs each active business once per pass, in id order`.
  - `a business that throws does not stop the next one`.
  - `a business past its deadline is skipped while still in flight and runs again once it settles`.
  - `a suspended business is not run`.
  - `zero active businesses completes and reports zero` (Review Focus 5).
  - `resumes from the first business not reached`.
  - `a failure writes one count-only audit row in that business's chain and none in others`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Update the 19 `schedulerPass({...})` test call sites.
- [ ] **Step 4:** Run the file and the full suite on `$SDD`. Expected: all pass.
- [ ] **Step 5:** Commit `feat(tenancy): scheduler runs every business in isolation`.

### Task 10: One dashboard for every business — login by email, session under RLS

**Files:**
- Create: `src/db/migrations/065_dashboard_login.sql`, `src/dashboard/tenant-session.test.ts`
- Modify: `src/dashboard/server.ts`, `src/dashboard/auth.ts`, `src/dashboard/run-dashboard.ts`, `src/dashboard/oauth-routes.ts`, `src/dashboard/unknown-user-throttle.ts`, `src/cli/create-owner.ts`, `src/tenancy/platform.ts`

**Interfaces — produces:**
- `065_dashboard_login.sql`:
  - `dashboard_users ADD COLUMN login TEXT`. Backfill `login = username`, then `SET NOT NULL`, and add `CREATE UNIQUE INDEX dashboard_users_login_unique ON dashboard_users (lower(login))`.
  - `dashboard_unknown_user_throttle` becomes one row for the server. Drop its `business_id` from the key, keeping one row.
  - Write the migration to match the current shape, which you can find in its migration file.
- `platform.ts`: `resolveLogin(login: string): Promise<{ businessId: string; status: 'active' | 'suspended' } | null>`.
  - It trims and lowercases, then matches on `lower(login)`.
  - It returns only the business id and status, never any other column.
- `owner:create --business <id> --email <address>` stores the address as `login`. It refuses an address that fails `EMAIL_SHAPE`, and a `login` already used by any business (`הכתובת כבר רשומה`).
- Cookie: `sid=<businessId>.<token>`.
  - `parseSessionCookie(value): { businessId: string; token: string } | null` returns `null` for a value with no `.`, or with an invalid business id.
  - The server then opens `withBusiness(businessId, db => verifySessionDetails(db, token))`.
  - An old cookie carrying only a token parses to `null` and is treated as logged out (Review Focus 6).
- Login flow:
  1. `resolveLogin(email)`. When it returns `null`, record a failure in the server-wide unknown-user throttle and show the same generic failure as today.
  2. A `suspended` business is refused with `החשבון מושהה — פנה למנהל המערכת`, without a password check.
  3. `withBusiness(businessId, db => login(db, …))`, with the failure counters and lockout on that business's row.
  4. `startSession`, then the cookie.
- Every authenticated request:
  - The business comes from the cookie's business part, and the session row must match under RLS.
  - Before routing, `getBusiness` must show the business as `active`. Otherwise refuse with the suspended message and revoke nothing.
  - `route()` receives `db: BusinessDb` instead of `businessId`.
- OAuth callback: the `oauth_states` row's `business_id` must equal the session's business. On a mismatch, refuse with `ההרשאה התחילה בחשבון אחר — התחילי מחדש` and write no grant.
- `createServer(options)` no longer takes `businessId`.

- [ ] **Step 1: Failing tests in `tenant-session.test.ts`** (use the existing server-test harness in `server.test.ts`)
  - `two businesses on one server: each owner sees only their own approvals`.
  - `login is case and whitespace insensitive` (Review Focus 3).
  - `owner:create refuses an email already used by another business, in any case` (Review Focus 3).
  - `a forged cookie with another business id is a miss, not a session`.
  - `an old token-only cookie is treated as logged out` (Review Focus 6).
  - `a suspended business is refused at login and on the next request of a live session` (Review Focus 2).
  - `an OAuth callback whose state belongs to another business writes no grant`.
  - `unknown-login failures throttle server-wide and never lock a real account`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Update `server.test.ts` helpers to log in by email.
- [ ] **Step 4:** Run the file and the full suite on `$SDD`. Expected: all pass.
- [ ] **Step 5:** Commit `feat(tenancy): one dashboard, login by email, session under RLS`.

### Task 11: Files scoped to the business

**Files:** Modify:
- `src/sdk/know-reader.ts`, `src/sdk/gate-hook.ts`
- `src/orchestrator/local-tools.ts`
- `src/documents/inbox-scan.ts`, `src/production/save.ts`
- `src/governance/document-settings.ts` (or wherever `saveDocumentSettings` lives)
- `src/config.ts`, `.env.example`

Test: extend `src/sdk/gate-hook.test.ts`, `inbox-scan.test.ts` and `save.test.ts`.

**Interfaces — produces:**
- `businessDocumentRoot(businessId: string): string`, in `src/tenancy/paths.ts`, returns `join(config.documentRoot, businessId)`.
- The reader's `documentRoot` and the gate's `binding.documentRoot` are always `businessDocumentRoot(id)`.
- `config.documentInboxRoot` comes from `DOCUMENT_INBOX_ROOT`, which renames `DOCUMENT_INBOX`. A business's inbox is `join(documentInboxRoot, businessId)`, scanned only when `inbox_enabled`.
- `config.documentSaveRoot` comes from `DOCUMENT_SAVE_ROOT`. `saveDocumentSettings` refuses a base folder outside `join(documentSaveRoot, businessId)` with `התיקייה חייבת להיות בתוך התיקייה של העסק בשרת`. `doc.save` re-checks this at write time.

- [ ] **Step 1: Failing tests**
  - `a reader for business A cannot open a path under business B's folder` (gate refusal).
  - `the reader subprocess cwd is the business folder`.
  - `inbox scans only the business's own subfolder, and none when inbox is disabled`.
  - `save settings refuse a folder of another business`.
  - `doc.save refuses a stored base folder that is outside the business root`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the files and the full suite on `$SDD`. Expected: all pass.
- [ ] **Step 5:** Commit `fix(tenancy): documents, inbox and saves scoped to the business`.

### Task 12: Remove the defaults; declared cross-business operations; key state per server

**Files:**
- Modify:
  - `src/config.ts`, `src/db/pool.ts`
  - `src/governance/credential-store.ts`, `src/governance/oauth-grants.ts`
  - `src/cli/secret-key.ts`, `src/dashboard/oauth-state.ts`, `src/tenancy/platform.ts`
  - `.env.example`
- Create: `src/tenancy/no-default-business.test.ts`, `src/tenancy/platform-imports.test.ts`

**Interfaces — produces:**
- `config.businessId` and `BUSINESS_ID` are deleted, and `getPool()` and `withTransaction()` are deleted from `pool.ts`. Fix whatever the compiler finds, and remove every `// TENANCY-TODO`.
- `liveKeyId()` reads `server_key_state`. `secret-key.ts create/restore/rotate` work on `server_key_state`, and rotation re-encrypts `credentials`, `oauth_grants` and `platform_credentials` for **all** businesses via `withPlatform`.
  - The rotation lock `ROTATION_LOCK_SCOPE` stays as it is, and `putSecret` still takes it.
  - Drop `credential_key_state` in migration `066_drop_business_key_state.sql`, after the backfill from Task 8.
- `platform.ts` gains `cleanupOAuthStates(): Promise<number>`. `oauth-state.ts` calls it instead of its unscoped `DELETE`.
- `no-default-business.test.ts`:
  - Recursively scans `src/` excluding `*.test.ts` and `src/test/`.
  - Fails on any of: `config.businessId`, `BUSINESS_ID`, `getPool(`, `withTransaction(`, `TENANCY-TODO`, `businessId?:`, `businessId: string =`, `businessId =` used as a parameter default.
  - First asserts that each pattern matches a sample string, and that the scan saw at least 300 files.
- `platform-imports.test.ts`:
  - Only `src/tenancy/**`, `src/cli/**`, `src/db/**` and `src/orchestrator/run-scheduler.ts` import `platform-pool`.
  - The test asserts it found at least one importer.

- [ ] **Step 1:** Write both invariant tests, plus `rotation re-encrypts every business's secrets and platform secrets in one transaction`. Run. Expected: FAIL.
- [ ] **Step 2:** Delete the defaults and fix until the typecheck is clean.
- [ ] **Step 3:** Run the full suite on `$SDD`. Expected: all pass, and both scans green.
- [ ] **Step 4:** Commit `refactor(tenancy): no default business anywhere`.

### Task 13: Close the wall — RLS on every business table

**Files:**
- Create: `src/db/migrations/067_rls.sql`, `src/tenancy/rls.test.ts`
- Modify: `docs/11-pre-launch-checks.md`

**Interfaces — produces:**
- `067_rls.sql`: a `DO` block that loops over every table in `public` that has a `business_id` column, read from `information_schema.columns`. For each:
  - `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;`
  - `CREATE POLICY tenant_isolation ON … USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id());`
  - Excluded by name: `businesses`, `schema_migrations`, `platform_credentials`, `server_key_state`, `dashboard_unknown_user_throttle`.
  - Revoke all on those excluded tables from `assistant_app`, then grant back only what the app path provably uses. Today that is: `SELECT` on `businesses`, `SELECT/UPDATE` on `dashboard_unknown_user_throttle` and `SELECT` on `server_key_state`. Read the code; do not guess.
  - Any future migration that adds a `business_id` table must add the policy itself, and `rls.test.ts` fails by name if it does not.
- `rls.test.ts`: tables come from `information_schema.columns WHERE column_name = 'business_id'`, never a hand-written list.
  - First assert at least 55 tables were found.
  - Seed one row per table for `biz-a` via `testDb()`. Use a generic seeder that fills NOT NULL columns with type-appropriate values. Tables with CHECKs it cannot satisfy are seeded by a hand-written per-table entry, and the test fails naming any table it could not seed.
  - Then, under `withBusiness('biz-b')`:
    - (1) `SELECT count(*)` = 0
    - (2) `UPDATE … SET business_id = business_id` affects 0
    - (3) `DELETE` affects 0
    - (4) an `INSERT` with `business_id = 'biz-a'` rejects
  - And on a connection set then reset: (5) a SELECT rejects with `no business context`.
  - `a table with business_id and no policy fails by name`: create a temp table in the test with `business_id`, without a policy, and assert the check reports it. Then drop it.
- `docs/11-pre-launch-checks.md` gets new ☐ lines:
  - Supabase allows `CREATE ROLE … BYPASSRLS` for the platform login, or supply an alternative.
  - Connections use direct or session mode, never the transaction pooler.
  - The overhead of `set_config` and `RESET` per checkout is measured under load.
  - Two real businesses run on one server end to end.

- [ ] **Step 1:** Write `rls.test.ts`. Run it. Expected: FAIL (no policies).
- [ ] **Step 2:** Write `067_rls.sql`, then migrate `$SDD`.
- [ ] **Step 3:** Run the full suite on `$SDD`. Expected: all pass. Production code now runs under RLS as `assistant_app` in every test. Any failure is a query without a context: fix the query, never the policy.
- [ ] **Step 4:** Commit `feat(tenancy): row level security on every business table`.

### Task 14: Documentation and the dev install

**Files:**
- `CLAUDE.md`: architecture line and commands, and a new "ריבוי עסקים" subsection with the rules from this plan's Global Constraints, the two-wall argument, and the declared cross-business list. Update the known-issues entries that mention single-business assumptions, such as the multi-scheduler note.
- `docs/09-roadmap.md`, `docs/10-user-settings.md` (note: settings are per business), `.env.example` (final shape), `docs/dashboard-deployment.md` (login by email).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** On the dev database, run in order: `npm run db:roles`, `npm run migrate`, `npm run business -- list` (expect `dev-business active`), then `npm run tenancy:import-env -- --business dev-business`. Record the output, with no secrets, in the task report. **Do not run this against any database other than the dev one.**
- [ ] **Step 3:** Run `npm run typecheck` and the full suite on `$SDD`. Expected: all pass.
- [ ] **Step 4:** Commit `docs(tenancy): one server, many businesses`.
