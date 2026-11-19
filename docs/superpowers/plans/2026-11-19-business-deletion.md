# Whole-Business Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The head admin deletes a suspended business from the admin panel, after retyping its name. Every row and every file the business has on the server is removed, and nothing records that the deletion happened.

**Architecture:**
- **Database step.** Migration 081 adds a `SECURITY DEFINER` function, owned by the table owner, that deletes one business's rows from every table that has a `business_id` column. It finds the tables at runtime from `information_schema`, so a table added later is covered automatically. It is the only actor `audit_log` lets delete.
- **Orchestration.** A tenancy module `src/tenancy/business-deletion.ts` runs the steps in order:
  1. check the guards;
  2. revoke OAuth grants at Google on a best-effort basis;
  3. delete the rows;
  4. delete the files;
  5. delete the `businesses` row last.

  A failed file step leaves the business in status `deleting`, so the head admin can retry it.
- **Running passes.** The scheduler records when each business's pass starts and ends, so a deletion can refuse while a pass is in flight.

**Tech Stack:** TypeScript (NodeNext ESM), pg + RLS, plpgsql, vitest on real Postgres.

**Spec:** [docs/superpowers/specs/2026-11-19-business-deletion-design.md](../specs/2026-11-19-business-deletion-design.md), approved by the owner on 19/11.

## Global Constraints

- **Who and when.** Only an active head admin (`platform_staff.is_head`), only from the admin panel, only for a business whose status is `suspended` (or `deleting`, when retrying the file step). The typed name must equal `businesses.display_name` after trimming leading and trailing whitespace ⚙. No other normalisation.
- **No record survives in the system's data.** Nothing in `audit_log`, `platform_activity_log` or any other table states that a deletion happened. Server stdout/stderr keep ordinary error handling (owner's answer, option A). No code writes a deliberate "deleted" line there either.
- **What is deleted:**
  - every row with `business_id = <id>` in every table;
  - the business's rows in `platform_activity_log`;
  - `<DOCUMENT_ROOT>/<id>` and `<DOCUMENT_INBOX_ROOT>/<id>`;
  - finally the `businesses` row.
- **What is NOT deleted:** `<DOCUMENT_SAVE_ROOT>/<id>` (the customer also reaches it); `platform_credentials`, `server_key_state`, `platform_staff*` and other businesses' rows; anything held at providers.
- **OAuth.** Revoke every live grant at the provider when the provider has a `revokeUrl` (Google), on a best-effort basis. A failure never stops the deletion. Microsoft has no revoke endpoint.
- **Id reuse.** `createBusiness` refuses, with a Hebrew message, an id whose document, inbox or save folder exists and holds any file, and an id whose row is in status `deleting`.
- **The privileged function** is executable only by `assistant_platform_group`. It is called from exactly one file, `src/tenancy/business-deletion.ts`, and an invariant test locks that.
- **Text.** Hebrew for people, English for code. Every new table or function obeys the RLS rules in CLAUDE.md "ריבוי עסקים".
- **Pre-launch list.** Every built-but-unrun live check goes into `docs/11-pre-launch-checks.md`.

## Rulings made while planning (⚙)

1. **Discover tables at runtime, not from a list.**
   - **Decision:** The function deletes in rounds. In each round it tries every table with `business_id` and retries tables that a foreign key blocked. It stops when a round removes nothing more, and raises if rows remain.
   - **Why:** This covers future tables by construction, and needs no hand-kept foreign-key order.
   - **Cost if wrong:** Somewhat slower on large businesses.
2. **How `audit_log` allows the delete.**
   - **Decision:** The trigger allows `DELETE` only when `current_user` is the table owner (true inside the `SECURITY DEFINER` function, never for the app account) **and** `current_setting('app.deleting_business', true) = OLD.business_id`.
   - **Why:** The app account can set the setting but is never the owner.
   - **Cost if wrong:** None known. An invariant test proves the app account still cannot delete.
3. **One transaction for the rows.**
   - **Decision:** All rows are deleted in one transaction.
   - **Why:** A business of tens of thousands of rows is fine for Postgres in one transaction, and a crash then leaves everything or nothing.
   - **Cost if wrong:** A very large business could hold locks for seconds. It is suspended, so no one is waiting on them.
4. **Detecting a running pass.**
   - **Decision:** `businesses.pass_started_at` and `pass_finished_at` are written by the scheduler process, through two named tenancy functions, at the start and end of each business pass. A pass counts as in flight when `pass_started_at > coalesce(pass_finished_at, '-infinity')` and `pass_started_at > now() - interval '30 minutes'`. The 30-minute bound means a crashed process cannot block deletion forever.
   - **Cost if wrong:** A pass hung for longer than 30 minutes would not block the deletion. The business is suspended, so the next interval does not start a new pass for it.
5. **The `deleting` status.**
   - **Decision:** The row deletion and setting `businesses.status = 'deleting'` happen in the same transaction. Files are deleted after the commit. The `businesses` row is deleted only when every file is gone. While a business is `deleting`, the panel shows only a "retry file deletion" button.
   - **Cost if wrong:** The business id stays visible in the panel list while the file step is unfinished.

## Review Focus

1. **A typed name with a different case, extra inner spaces, or a bidi or zero-width character** must not match. Only exact equality after trimming the ends counts.
2. **A second business with the same id prefix**, for example `acme` and `acme-2`, must keep every row and file. The folder paths are joined segment-safely, with no `startsWith` on strings.
3. **A non-head staff member** posting the delete form directly, or a head admin whose `is_head` was removed between page load and post, is refused, and nothing is deleted.
4. **Deleting a business that is `active`** (never suspended) is refused, even with the correct name.
5. **A business re-created with the same id after deletion** starts empty: no rows, no files, and no leftover sessions that would let an old cookie in.

---

### Task 1: Migration 081 — deletion function, audit trigger, pass heartbeat, `deleting` status

**Files:**
- Create: `src/db/migrations/081_business_deletion.sql`, `src/tenancy/business-deletion-sql.test.ts`
- Modify: `src/test/db.ts` (only if the reset needs the new columns; it should not)

**Interfaces — produces:**
- **The function:** `delete_business_rows(p_business text) RETURNS TABLE(table_name text, deleted bigint)`.
  - `SECURITY DEFINER`, `SET search_path = public`, owned by the migrator.
  - `EXECUTE` is granted only to `assistant_platform_group` and revoked from `PUBLIC`.
  - It does `set_config('app.business_id', p_business, true)` so FORCE RLS policies match, and `set_config('app.deleting_business', p_business, true)`.
  - It loops over `information_schema.columns` where `column_name = 'business_id'` and `table_schema = 'public'`, excluding the `businesses` table, and deletes in rounds (Ruling 1).
  - It also deletes from `platform_activity_log WHERE business_id = p_business`.
  - It raises `'business deletion incomplete: %'` naming the tables that still hold rows.
- **The `businesses` table:**
  - `status` CHECK extended to `('active','suspended','deleting')`;
  - new columns `pass_started_at timestamptz`, `pass_finished_at timestamptz`.
- **`audit_log_is_append_only()`:** replaced per Ruling 2. UPDATE is still always refused.

**Steps:**

- [ ] **Step 1: Write failing tests** in `business-deletion-sql.test.ts`. Seed through `testDb()` and the existing fixtures: install a charter, a job with steps, an approval, a memory, a mail row, an external event and an `audit_log` chain. Do this for business A and for business B.
  - Call `delete_business_rows('a')` through a platform-role connection, using `withPlatform`, or a test helper that connects as `assistant_platform_test`.
  - Assert that every table discovered from `information_schema` with `business_id` has 0 rows for `a`, and the same counts as before for `b`.
  - Assert that the returned rows name at least 8 tables.
  - Call it as the app account (`withBusiness`) and expect a `permission denied` error.
  - As the app account, `SET app.deleting_business = 'a'` and then `DELETE FROM audit_log`. Expect it to be rejected by the trigger, or to fail permission. Either way the rows are still there.
  - `UPDATE audit_log` as the owner, outside the function, is still rejected.
  - `businesses.status = 'deleting'` is accepted, and `'gone'` is rejected.
  - **Inventory lock.** Every table in `public` that has **no** `business_id` column must be on a frozen list in the test, each with a one-line reason: the server tables (`businesses`, `platform_credentials`, `server_key_state`, `platform_staff*`, `platform_activity_log`, the unknown-login throttles, the migrations table). A new per-business table created without `business_id` would survive deletion silently, so the test fails on it by name. The test first asserts that it found more than 50 tables, so an empty scan cannot pass.
- [ ] **Step 2: Run.**
  ```bash
  TEST_DATABASE_URL="$SDD" npm run migrate:test
  TEST_DATABASE_URL="$SDD" npx vitest run src/tenancy/business-deletion-sql.test.ts --no-file-parallelism
  ```
  Expected: FAIL.
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run the same command, then `src/tenancy/rls.test.ts`, then the full suite once. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): migration 081 — whole-business row deletion function`

### Task 2: Tenancy module — guards, the row step, id reuse

**Files:**
- Create: `src/tenancy/business-deletion.ts`, `src/tenancy/business-deletion.test.ts`
- Modify:
  - `src/tenancy/businesses.ts`: `createBusiness` refuses an id that is `deleting` or whose folders hold files. `listActiveBusinesses` is unchanged, because `deleting` is not active.
  - `src/tenancy/paths.ts`: a helper `businessFolders(businessId)` that returns the three absolute folders, built with the existing segment-safe join.
  - `src/tenancy/platform-imports.test.ts`, or a new invariant: only `business-deletion.ts` names `delete_business_rows`.
  - The CLAUDE.md closed list: add the new named functions. That is one line; the full docs come in Task 5.

**Interfaces — produces:**
- `recordPassStart(businessId): Promise<void>` and `recordPassEnd(businessId): Promise<void>`. These use the platform pool and write `pass_started_at` / `pass_finished_at = now()`.
- `passInFlight(businessId): Promise<boolean>`, per Ruling 4.
- `DeletionRefusal = 'not_head' | 'not_suspended' | 'name_mismatch' | 'pass_in_flight' | 'unknown_business'`.
- `deleteBusinessRows({ businessId, staffId, typedName }): Promise<{ ok: true; tables: { table: string; deleted: number }[] } | { ok: false; refusal: DeletionRefusal }>`.
  - Inside one platform transaction it:
    1. locks the `businesses` row (`FOR UPDATE`);
    2. re-checks the staff member is active and `is_head`, the business is `suspended`, and the name matches;
    3. checks `passInFlight` is false;
    4. calls `delete_business_rows`;
    5. sets `status = 'deleting'`.
  - It writes no activity-log row and no audit row.
- `deleteBusinessFiles(businessId): Promise<{ removed: number; failed: string[] }>`. It runs `fs.rm(folder, { recursive: true, force: true })` on the document and inbox folders only, counts the files first, and returns the relative paths of failures.
- `finishDeletion(businessId): Promise<boolean>`. It deletes the `businesses` row only if the status is `deleting` and both folders no longer exist.
- `DELETION_REFUSAL_HE: Record<DeletionRefusal, string>`, the Hebrew messages.

**Steps:**

- [ ] **Step 1: Write failing tests.**
  - **Refusals.** Each refusal comes back with its own code, and nothing is deleted:
    - not head;
    - active, not suspended;
    - the name in upper case, with a double space inside, or with U+200F appended;
    - a pass in flight (`pass_started_at` = now, `pass_finished_at` null);
    - an unknown id.
  - **A stale pass.** With `pass_started_at` 31 minutes ago, the pass does not block.
  - **A successful run.** Rows for the business are gone. The status is `deleting`. Business `acme-2`'s rows and files are untouched.
  - **`deleteBusinessFiles`.**
    - It removes `<DOCUMENT_ROOT>/acme` and `<DOCUMENT_INBOX_ROOT>/acme`, and leaves `<DOCUMENT_ROOT>/acme-2` and `<DOCUMENT_SAVE_ROOT>/acme` in place.
    - A failure is reported. Simulate it with a read-only file or an injected `rm` seam.
  - **`finishDeletion`.** It refuses while a folder exists, and then removes the row.
  - **`createBusiness('acme')`:**
    - refused while the status is `deleting`;
    - refused while `<DOCUMENT_SAVE_ROOT>/acme` holds a file;
    - allowed once it is empty.

    Each refusal is a Hebrew message.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `src/tenancy`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenancy): whole-business deletion — guards, rows, files, id reuse`

### Task 3: Scheduler heartbeat and OAuth revocation at the provider

**Files:**
- Modify: `src/orchestrator/tenants.ts`, which calls `recordPassStart` before a business pass and `recordPassEnd` in `finally`, both at best effort, with a failure logged by error class only.
- Modify: `src/tenancy/business-deletion.ts`, adding `revokeBusinessGrants(businessId, deps): Promise<{ attempted: number; failed: number }>`. It runs before `deleteBusinessRows` and:
  1. reads the live grants inside `withBusiness`, using `listGrants` and the decrypting read the OAuth routes use;
  2. for each grant whose provider profile has a `revokeUrl`, POSTs the token there with a 10-second deadline;
  3. never throws, and never logs a token.

  Reuse the provider-revoke code from `src/dashboard/oauth-routes.ts`. If it lives inside the handler, extract it to `src/governance/oauth-provider-revoke.ts` and have both callers use it.
- Test: `src/orchestrator/tenants.test.ts` (heartbeat) and `src/tenancy/business-deletion.test.ts` (revocation, with an injected `fetchImpl`).

**Steps:**

- [ ] **Step 1: Write failing tests.**
  - **Heartbeat.**
    - A pass sets `pass_started_at`, then `pass_finished_at ≥ pass_started_at`.
    - A pass that throws still sets `pass_finished_at`.
    - While a pass is running (an injected slow stage), `passInFlight` is true.
  - **Revocation.**
    - Two Google grants give two POSTs, and the token appears only in the request body.
    - A Microsoft grant gives no POST.
    - A failing POST still results in `{ attempted: 2, failed: 1 }`.
    - No token in any log. Spy on `console.*`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `src/orchestrator/tenants.test.ts` and the OAuth route tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenancy): pass heartbeat; revoke OAuth at the provider before deletion`

### Task 4: Admin panel — the delete button, the confirmation page, the result, the retry

**Files:**
- Create: `src/admin/business-deletion-routes.ts`, `src/admin/business-deletion-routes.test.ts`
- Modify: `src/admin/server.ts` (routes), `src/admin/business-routes.ts` (the button on the business page), `src/admin/views.ts`

**Interfaces — produces these routes, all behind the staff session, with CSRF on every POST:**
- `GET /businesses/:id/delete`. Head only. The business must be `suspended` or `deleting`. The page shows:
  - a fixed Hebrew list of what is deleted;
  - a fixed Hebrew list of what is not deleted, copied from the spec: the provider-held mail, calendar and CRM; the save folder; external-system keys at the provider; backups; Microsoft app access;
  - a text field for the business name, with the `display_name` shown above it through `escLabel`.
- `POST /businesses/:id/delete`. In order it runs:
  1. `revokeBusinessGrants`;
  2. `deleteBusinessRows`;
  3. `deleteBusinessFiles`;
  4. `finishDeletion`.

  It renders one of two results:
  - "העסק נמחק" with the counts, without the business name;
  - "השורות נמחקו, אבל N קבצים לא נמחקו" with a retry button.
- `POST /businesses/:id/delete/files`. Retries the file step and `finishDeletion`. It is allowed only for a business in status `deleting`, and only for the head admin.
- **The business page.** It shows the "מחיקת העסק" link only when the viewer `is_head` and the status is `suspended`. When the status is `deleting`, it shows only the retry form.
- **No call to `recordStaffAction`** for any of these routes (owner ruling: no record).

**Steps:**

- [ ] **Step 1: Write failing tests.**
  - **Who sees the button.**
    - A non-head sees no link and gets 403 on GET and POST.
    - The link is hidden for an active business, and POST is refused.
  - **A wrong name** re-renders with `DELETION_REFUSAL_HE.name_mismatch` and deletes nothing.
  - **A successful delete:**
    - the result page shows counts;
    - `platform_activity_log` has 0 rows for the business;
    - `audit_log` has 0 rows;
    - the `businesses` row is gone;
    - the business no longer appears in the list.
  - **A file failure** (injected seam):
    - the result shows the retry form and the status is `deleting`;
    - a retry with the seam fixed finishes the deletion.
  - **No CSRF:** 403.
  - **An old owner cookie** for the deleted business, sent to the dashboard, reads as "not signed in". Use the existing dashboard test helper.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `src/admin` and the dashboard auth tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): delete a suspended business — confirm by name, retry files`

### Task 5: Documentation

**Files:**
- Modify:
  - `CLAUDE.md`: a new section "מחיקת עסק שלם (19/11)"; the closed list of cross-business operations; the `audit_log` paragraph (the one exception to append-only); the command and migration runbook (081); known issues.
  - `docs/10-user-settings.md`
  - `docs/11-pre-launch-checks.md`: these rows —
    - a live Google revoke;
    - deleting a large business on the production server;
    - confirming that backups expire on the stated schedule.
  - `docs/08-risks.md`: a head admin deleting the wrong business, and backups.
  - `docs/09-roadmap.md`
  - `docs/12-launch-plan.md`: the customer-offboarding procedure.
- [ ] **Step 1:** Write the docs. Every claim cites the file it describes.
- [ ] **Step 2:** Run `npm run typecheck`, then the full suite on the dedicated DB. Expected: green.
- [ ] **Step 3: Commit** `docs: whole-business deletion`
