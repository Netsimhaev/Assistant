# Admin Panel and Google Authenticator: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate panel server where the company's technicians open and set up businesses. Replace the dashboard's recovery codes with TOTP (Google Authenticator). Bring the technician-typed setup data (boss number, contacts, colleagues, address, logo) to the owner, who confirms it before it takes effect.

**Architecture:**
- **Panel server:** a new HTTP server under `src/admin/`, with its own cookie, port and staff tables.
- **Platform account reads:** every read the panel makes on the platform account is a named function in the closed list under `src/tenancy/`. The functions return only numbers and states. `src/admin/` never imports the platform pool.
- **Writes to business data:** go through `withBusiness`.
- **TOTP:** a shared primitive in `src/auth/`. Owner state sits on `dashboard_users`. Staff state sits on `platform_staff`.
- **Pending second factor:** a session waiting for its second factor carries a flag. Every other route redirects to the `/2fa` screen until the flag clears, the same way `mustChangePassword` works today.
- **Setup package:** the technician's data waits in `setup_packages`. The owner meets it in the interview. The boss number takes effect at signature. Contacts and colleagues take effect when the owner confirms them on step 8.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥22.15, PostgreSQL 17 with RLS, vitest against real Postgres, `node:crypto` for TOTP, and `qrcode` (new dependency) for the enrolment QR.

**Spec:** [docs/superpowers/specs/2026-11-14-admin-panel-design.md](../specs/2026-11-14-admin-panel-design.md)

## Global Constraints

**Code**
- Hebrew for owners and technicians; English for identifiers, comments and internal errors.
- `.js` on every relative import. `import type` stays separate (`verbatimModuleSyntax`).
- `businessId` is always a required parameter. Never write `?`, a default value, or `?? config…` for it (`src/tenancy/no-default-business.test.ts`).

**Database**
- Every new table with `business_id`:
  - `ENABLE` and `FORCE ROW LEVEL SECURITY`.
  - `CREATE POLICY tenant_isolation … USING/WITH CHECK (business_id = app_business_id())`.
  - Add it to the `TRUNCATE` list in `src/test/db.ts`.
- New platform tables (no `business_id`):
  - `REVOKE ALL … FROM assistant_app`.
  - `GRANT SELECT, INSERT, UPDATE, DELETE … TO assistant_platform_group`.
  - Add them to `src/db/roles.ts` if grants are applied there. Check how migration 064's `platform_credentials` is granted, and copy that.
- Migrations are new files starting at `070`. Never edit an existing migration.
- Tests run as the app account. Production code is called through `withBusiness(TEST_BUSINESS, …)`. Seeding and owner-only operations go through `testDb()`.
- Run tests on a dedicated database (`assistant_test_sdd`, URL derived from `TEST_DATABASE_URL`). **Never print a database URL or any secret value.**

**Platform pool and panel content**
- Only `src/tenancy/`, `src/cli/`, `src/db/` and `src/orchestrator/run-scheduler.ts` may import `src/db/platform-pool.ts`. **`src/admin/` is not added to that list.** It reaches platform data only through functions in `src/tenancy/`.
- The panel never displays business content: no mail, existing contacts, memory, jobs' text or instructions.
  - It may display states, counts, and data the technician typed.
  - Data a technician typed is shown only while the business has no active charter. After the first signature, the panel shows only "set/missing" and counts.
- The panel writes business data only through `withBusiness(businessId, …)` on the app pool.
- Every panel action writes two rows, neither carrying content:
  - a `platform_activity_log` row with the staff member's id;
  - an `audit_log` row in that business, with only the action kind and the staff display name.

**TOTP, links and devices**
- TOTP follows RFC 6238: HMAC-SHA1, 30-second step, 6 digits.
  - Accept the current step ±1.
  - Reject any step ≤ the last accepted step.
  - Lock out with the same attempt count and lock duration the password login uses.
- The TOTP secret is encrypted with the master key through `encryptSecret`, with AAD:
  - owners: `{ businessId, ref: 'totp:<username>' }`
  - staff: `{ businessId: '', ref: 'staff-totp:<staffId>' }`
  - Both refs are lowercase with a colon, so they never match `CREDENTIAL_REF_PATTERN`.
- Trusted device:
  - random 32-byte token in a cookie for 30 days (`TRUSTED_DEVICE_DAYS = 30`);
  - only its sha256 is stored;
  - revoked on password change, password reset and TOTP reset.
- Invite and reset links:
  - random 32-byte token, sha256 stored, one-time;
  - valid 72 hours (`LINK_HOURS = 72`);
  - the redeemer must retype the login email (case-insensitive, compared with `normaliseLogin`).

**Logo**
- PNG or JPEG only, judged by bytes, at most 1 MB (`LOGO_MAX_BYTES = 1_048_576`).
- SVG and everything else is rejected.
- Stored at `<DOCUMENT_ROOT>/<businessId>/profile/logo.png|jpg` (relative path in the database).

**Roles**
- Only a head staff member (`is_head`) adds or removes staff. All other staff have equal permissions.
- Colleagues never give instructions. A WhatsApp message from a colleague's number is recorded and not answered, exactly like a stranger's.

## Review Focus

1. **Existing owner with a live session from before the deploy.** They have not enrolled TOTP. Their next request must go to enrolment; the old session must not be grandfathered. (Task 3)
2. **Clock skew.** A code from step −1/+1 is accepted. A code from step −2/+2 is rejected. A replay of the code just used is rejected even inside its window. (Task 1, Task 2)
3. **Invite link misuse:**
   - an email typed in a different letter case is accepted;
   - a different email is rejected and the link stays unused;
   - a second use is rejected;
   - a use after 72 h is rejected. (Task 4)
4. **Stale panel tab.** A technician posts boss number, contacts or profile changes after the owner signed. The server refuses with a Hebrew message and writes nothing. (Task 10)
5. **Logo bytes that lie about their name:**
   - `logo.png` holding JPEG bytes is stored as JPEG;
   - an SVG renamed `.png` is rejected;
   - a truncated PNG header is rejected;
   - a file of 1 MB + 1 byte is rejected. (Task 6)

---

### Task 1: TOTP and QR primitives

**Files:**
- Create: `src/auth/totp.ts`, `src/auth/qr.ts`
- Test: `src/auth/totp.test.ts`, `src/auth/qr.test.ts`
- Modify: `package.json` (add `qrcode@^1.5.4`, and `@types/qrcode` in devDependencies)

**Interfaces:**
- Produces:
  - `generateTotpSecret(): string`: 20 random bytes, base32 (RFC 4648, no padding).
  - `totpCode(secretBase32: string, step: number): string`: 6 digits, zero-padded.
  - `currentStep(now: Date): number`: `Math.floor(now.getTime() / 30_000)`.
  - `matchTotp(secretBase32: string, code: string, now: Date, lastStep: number | null): number | null`: returns the matched step, or `null`.
    - It checks steps `current-1`, `current` and `current+1`, and only steps greater than `lastStep`.
    - The code must be exactly `/^\d{6}$/` after trimming spaces.
    - Comparison uses `timingSafeEqual`.
  - `otpauthUri(input: { issuer: string; account: string; secretBase32: string }): string`: the `otpauth://totp/<issuer>:<account>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30` form, URI-encoded.
  - `qrSvg(text: string): Promise<string>`: an SVG string from `qrcode.toString(text, { type: 'svg', margin: 1 })`.

- [ ] **Step 1: Write the failing tests.**
  - `totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)` equals `'287082'`. This is RFC 6238 Appendix B for T=59s with the SHA1 seed `12345678901234567890`, truncated to 6 digits.
  - `totpCode(sameSecret, 37037036)` equals `'081804'`. This is T=1111111109s.
  - `matchTotp`:
    - accepts the codes for `current-1`, `current` and `current+1`;
    - returns `null` for `current±2`;
    - returns `null` when `lastStep === current` and the code is for `current`;
    - returns `null` for `'12345'`, `'1234567'` and `'abcdef'`;
    - accepts `' 287 082 '` (spaces removed).
  - `generateTotpSecret()` matches `/^[A-Z2-7]{32}$/`.
  - `otpauthUri` round-trips through `new URL` with `secret`, `issuer`, `digits=6` and `period=30`.
  - `qrSvg('x')` starts with `<svg` and contains no `<script`.
- [ ] **Step 2: Run** `npx vitest run src/auth` and see it fail because the modules are missing.
- [ ] **Step 3: Implement.** Write base32 by hand; no dependency besides `qrcode`. Use dynamic truncation per RFC 4226 §5.3.
- [ ] **Step 4: Run** `npx vitest run src/auth` and see it pass, then run `npm run typecheck`.
- [ ] **Step 5: Commit** with message `feat(auth): TOTP and QR primitives`.

---

### Task 2: Owner second-factor store (migration 070)

**Files:**
- Create: `src/db/migrations/070_owner_second_factor.sql`, `src/dashboard/second-factor.ts`
- Test: `src/dashboard/second-factor.test.ts`
- Modify: `src/test/db.ts` (TRUNCATE list)

**Migration 070:**
- `dashboard_users` gains these columns:
  - `totp_ciphertext bytea`, `totp_nonce bytea` (both null until enrolled, with a CHECK that both are null or both are set);
  - `totp_enrolled_at timestamptz`;
  - `totp_last_step bigint`;
  - `totp_failed_attempts int NOT NULL DEFAULT 0`;
  - `totp_locked_until timestamptz`.
- `dashboard_sessions` gains `pending_factor text CHECK (pending_factor IN ('enroll','verify'))`, nullable.
- New table `dashboard_trusted_devices`:
  - columns: `business_id text NOT NULL`, `device_hash text NOT NULL`, `username text NOT NULL`, `created_at`, `expires_at timestamptz NOT NULL`, `revoked_at timestamptz`;
  - PK `(business_id, device_hash)`;
  - full RLS.
- `DROP TABLE dashboard_recovery_codes`.
  - **Ruling:** the mechanism is removed at deploy, not at each owner's next login. The redemption path disappears in Task 3, so the codes would be inert anyway. A technician reset link (Task 4) replaces them.
  - Remove the table from the TRUNCATE list too.

**Interfaces:**
- Consumes:
  - `encryptSecret`, `decryptSecret` from `src/governance/secret-cipher.ts`;
  - `matchTotp`, `generateTotpSecret` from Task 1;
  - `BusinessDb` from `src/db/pool.ts`.
- Produces (all in `src/dashboard/second-factor.ts`, all taking `db: BusinessDb` first):
  - `totpStatus(db, username): Promise<'enrolled' | 'not_enrolled'>`
  - `beginEnrolment(db, username, key: Buffer): Promise<{ secretBase32: string }>`
    - Writes a *pending* secret: it sets ciphertext and nonce, and leaves `totp_enrolled_at` null.
    - Calling it again replaces the pending secret.
    - It refuses (throws `TotpAlreadyEnrolledError`) when `totp_enrolled_at` is set.
  - `confirmEnrolment(db, username, code, key, now?): Promise<'ok' | 'bad_code' | 'locked'>`
    - On `ok` it sets `totp_enrolled_at` and `totp_last_step`.
  - `verifySecondFactor(db, username, code, key, now?): Promise<'ok' | 'bad_code' | 'locked' | 'not_enrolled'>`
    - On `ok` it updates `totp_last_step` with `UPDATE … WHERE totp_last_step IS NULL OR totp_last_step < $step`, so a concurrent replay loses.
    - On `bad_code` it increments the failure counter and locks with the password constants imported from `auth.ts`. Export them there if they are not exported.
  - `resetSecondFactor(db, username): Promise<void>`
    - Clears all `totp_*` columns.
    - Revokes all sessions (`revokeAllSessions`) and all trusted devices.
  - `issueTrustedDevice(db, username, now?): Promise<string>`: returns the raw token.
  - `isTrustedDevice(db, username, token, now?): Promise<boolean>`
  - `revokeTrustedDevices(db, username): Promise<number>`
  - `setPendingFactor(db, sessionToken, factor: 'enroll' | 'verify' | null): Promise<void>`
  - `TRUSTED_DEVICE_DAYS = 30`
- Also in this task:
  - `setPassword` in `src/dashboard/auth.ts` additionally calls `revokeTrustedDevices` inside its transaction.
  - `startSession` gains `pendingFactor?: 'enroll' | 'verify'`.
  - `verifySessionDetails` returns `pendingFactor: 'enroll' | 'verify' | null`.

- [ ] **Step 1: Write failing tests:**
  - **enrol and confirm:**
    1. `beginEnrolment` returns a secret.
    2. `confirmEnrolment` with `totpCode(secret, currentStep(now))` returns `'ok'`.
    3. `totpStatus` returns `'enrolled'`.
    4. A second `beginEnrolment` throws `TotpAlreadyEnrolledError`.
  - **replay:** the same code on `verifySecondFactor` right after a successful verify returns `'bad_code'`.
  - **lockout:** after the password-lock count of wrong codes, the result is `'locked'`, and a correct code is still `'locked'` until the lock expires.
  - **secret at rest:** `dashboard_users.totp_ciphertext` does not contain the base32 secret bytes (checked via `testDb()`). Decrypting it with the wrong `businessId` in the AAD returns `null`.
  - **trusted devices:**
    - `issueTrustedDevice` then `isTrustedDevice` returns true.
    - After `resetSecondFactor` it returns false.
    - After `setPassword` it returns false.
    - With `now` = 31 days later it returns false.
  - **reset:** `resetSecondFactor` revokes an open session (`verifySession` then returns `null`).
- [ ] **Step 2: Run** `TEST_DATABASE_URL="$SDD" npm run migrate:test`, then `TEST_DATABASE_URL="$SDD" npx vitest run src/dashboard/second-factor.test.ts --no-file-parallelism`. Expect the tests to fail.
- [ ] **Step 3: Implement.** The decrypt AAD is `{ businessId: db.businessId, ref: \`totp:${username}\` }`.
- [ ] **Step 4: Run the tests** and see them pass. Then run `src/dashboard/auth.test.ts` and update any assertion that referenced recovery codes.
- [ ] **Step 5: Commit** with message `feat(auth): owner TOTP store, trusted devices, drop recovery codes`.

---

### Task 3: Dashboard login with the second factor

**Files:**
- Modify:
  - `src/dashboard/server.ts`: `handleLoginPost`, `handleRequest`, `route`, plus new handlers;
  - `src/dashboard/views.ts`: `renderLogin` loses the code field; add `renderTotpEnrol` and `renderTotpVerify`;
  - `src/dashboard/run-dashboard.ts`: load the master key once and pass it as `DashboardOptions.masterKey: Buffer`;
  - `src/cli/create-owner.ts`: stop issuing codes and print the enrolment note;
  - `src/cli/owner-password.ts`.
- Delete:
  - `src/dashboard/recovery.ts` and `src/dashboard/recovery.test.ts`;
  - the recovery branch in `src/dashboard/unknown-user-throttle.ts`. Keep its password counters. Remove functions that become unused, and check with typecheck.
- Test: `src/dashboard/server-2fa.test.ts`

**Behavior:**
- **`POST /login` with a correct password:**
  - Not enrolled: start the session with `pendingFactor: 'enroll'` and send 303 to `/2fa/enrol`.
  - Enrolled, with a valid `tdev` cookie (`isTrustedDevice`): full session, 303 to `/`.
  - Otherwise: `pendingFactor: 'verify'` and 303 to `/2fa`.
  - A `code` field is no longer read at all.
- **Gate in `handleRequest`, right after the session loads and before `route`:**
  - If `pendingFactor` is set, or the user's `totpStatus` is `'not_enrolled'`, only `GET|POST /2fa`, `GET|POST /2fa/enrol` and `/logout` are served. Everything else gets 303 to the matching screen.
  - This also catches sessions issued before the deploy, which have no `pending_factor` but whose owner is not enrolled (Review Focus 1).
- **`GET /2fa/enrol`:**
  - Calls `beginEnrolment`.
  - Renders the QR (`qrSvg(otpauthUri({ issuer: 'העוזרת', account: login, secretBase32 }))`), the secret split into groups of 4, and one code field.
  - Hebrew copy: `סרוק את הקוד באפליקציית Google Authenticator והקלד את הקוד בן שש הספרות שמופיע בה.`
- **`POST /2fa/enrol` (CSRF):** `confirmEnrolment`. On `ok`:
  - `setPendingFactor(null)`;
  - `issueTrustedDevice` and set the `tdev` cookie;
  - 303 to `/`.
- **`POST /2fa` (CSRF):** `verifySecondFactor`. On `ok`: same as above.
  - Error copy for `bad_code`: `הקוד שגוי או שפג תוקפו. נסה שוב עם הקוד שמופיע עכשיו באפליקציה.`
  - Error copy for `locked`: `יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.`
- **`tdev` cookie:**
  - Value: `sessionCookieValue(businessId, token)`.
  - Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`.
  - It is a separate name from `sid`.
- **`create-owner` CLI:** stops calling `issueRecoveryCodes`. Prints `בכניסה הראשונה תתבקש לחבר את Google Authenticator.`
- **`owner-password` CLI:** also revokes trusted devices. This comes through `setPassword`.

- [ ] **Step 1: Write the failing tests** (HTTP against `createServer`, following the existing `server.test.ts` setup):
  - **first login:** a not-enrolled owner logs in, gets redirected to `/2fa/enrol`, and `GET /` redirects to `/2fa/enrol`. Enrolling with a valid code sets the `tdev` cookie and `GET /` returns 200.
  - **second login on the same device:** `tdev` present means no `/2fa`. Without `tdev`, `GET /` redirects to `/2fa`, and a valid code returns 200.
  - **old session:** a session inserted with `pending_factor` NULL for a not-enrolled owner gets 303 to `/2fa/enrol` from `GET /`.
  - **recovery codes gone:** `POST /login` with `code=<anything>` and no password returns the generic login error. The string `קוד שחזור` no longer appears in `renderLogin()`.
  - **replay:** the code just used on `/2fa` is rejected on a second `/2fa` attempt from another browser (no `tdev`).
- [ ] **Step 2: Run** the new test file and the existing `src/dashboard/server.test.ts`. Expect failures.
- [ ] **Step 3: Implement.** Existing server tests that log in must now pass the second factor. Add a helper to `src/test/owner.ts`: `loginWithSecondFactor(server, businessId, …)`. It enrols through the store directly, then logs in carrying a valid `tdev`. Use it in the existing tests instead of weakening the gate.
- [ ] **Step 4: Run** the full dashboard test directory and `npm run typecheck`, and see both pass.
- [ ] **Step 5: Commit** with message `feat(dashboard): Google Authenticator at sign-in, recovery codes removed`.

---

### Task 4: Owner invite and password-reset links

**Files:**
- Create: `src/db/migrations/071_owner_links.sql`, `src/dashboard/owner-links.ts`
- Modify: `src/dashboard/server.ts` (pre-session routes), `src/dashboard/views.ts`, `src/test/db.ts`
- Test: `src/dashboard/owner-links.test.ts`, plus HTTP cases in `src/dashboard/server-2fa.test.ts`

**Migration 071:** table `owner_links`:
- columns:
  - `business_id text NOT NULL`, `link_hash text NOT NULL`;
  - `kind text NOT NULL CHECK (kind IN ('invite','password_reset'))`;
  - `login text NOT NULL` (normalised);
  - `created_at timestamptz NOT NULL DEFAULT now()`, `expires_at timestamptz NOT NULL`, `used_at timestamptz`;
  - `issued_by text NOT NULL` (staff id);
- PK `(business_id, link_hash)`;
- full RLS.

**Interfaces:**
- Produces:
  - `issueOwnerLink(db: BusinessDb, input: { kind: 'invite' | 'password_reset'; login: string; issuedBy: string }, now?): Promise<string>`
    - Returns the URL path token `<businessId>.<rawToken>`.
    - Issuing a new link of the same kind for the same login marks the older unused ones as used.
  - `redeemOwnerLink(db: BusinessDb, input: { rawToken: string; typedLogin: string; password: string }, now?): Promise<{ ok: true; kind: 'invite' | 'password_reset'; username: string } | { ok: false; code: 'invalid' | 'login_mismatch' | 'expired' | 'used' | 'weak_password' }>`
    - It runs in one transaction and claims with `UPDATE … SET used_at = now() WHERE used_at IS NULL AND expires_at > now() RETURNING`.
    - `login_mismatch` does **not** consume the link.
    - `invite`: calls `createOwner(db, { username: 'owner', login, password })`. If an owner already exists for that login, the result is `invalid`.
    - `password_reset`: calls `setPassword`, which also revokes sessions and trusted devices.
    - The password minimum length is `MIN_PASSWORD_LENGTH`, imported from where the dashboard defines it.
  - `LINK_HOURS = 72`
- Routes (served before the session check, no CSRF on first GET; the POST carries a CSRF token bound to the link token):
  - `GET|POST /invite/<token>` and `GET|POST /reset/<token>`.
  - The form has an email field, a password field and a repeat field.
  - On success: start the session with `pendingFactor` (`'enroll'` if not enrolled, else `'verify'`) and 303 to the matching `/2fa` screen.
  - Hebrew errors:
    - `invalid` / `used` / `expired`: `הקישור אינו תקף. בקש קישור חדש מאיש התמיכה.`
    - `login_mismatch`: `כתובת המייל אינה תואמת את הקישור.`

- [ ] **Step 1: Write the failing tests:**
  - an invite redeemed with the login typed in upper case succeeds and creates `owner`;
  - a different email returns `login_mismatch` and the link still redeems afterwards;
  - a second redemption returns `used`;
  - `now` = 73 h later returns `expired`;
  - `link_hash` in the table differs from the raw token (seen via `testDb()`);
  - a reset link sets the new password, the old session is revoked, and the trusted device is revoked;
  - HTTP: a full invite leads to `/2fa/enrol`.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and see them pass.
- [ ] **Step 5: Commit** with message `feat(dashboard): one-time invite and password-reset links`.

---

### Task 5: Platform staff store (migration 072) and the head-staff CLI

**Files:**
- Create:
  - `src/db/migrations/072_platform_staff.sql`;
  - `src/tenancy/staff.ts`, `src/tenancy/activity-log.ts`;
  - `src/cli/staff.ts`, and the `"staff"` script in `package.json`.
- Modify: `src/test/db.ts` (TRUNCATE), `src/db/roles.ts` (if grants live there)
- Test: `src/tenancy/staff.test.ts`, `src/cli/staff.test.ts`

**Migration 072:** platform tables, with no `business_id` and no RLS. Grant them as described in Global Constraints.
- `platform_staff`:
  - `staff_id text PK` (ulid), `login text NOT NULL` with a unique index on `lower(login)`, `display_name text NOT NULL`;
  - `password_hash text`, `password_salt text` (both null until the invite is redeemed);
  - `is_head boolean NOT NULL DEFAULT false`;
  - `totp_ciphertext bytea`, `totp_nonce bytea`, `totp_enrolled_at`, `totp_last_step bigint`;
  - `failed_attempts int NOT NULL DEFAULT 0`, `locked_until`, `totp_failed_attempts int NOT NULL DEFAULT 0`, `totp_locked_until`;
  - `created_at`, `removed_at`.
- `platform_staff_sessions`: `session_hash text PK`, `staff_id`, `created_at`, `expires_at`, `revoked_at`, `pending_factor` (same CHECK as Task 2).
- `platform_staff_devices`: `device_hash text PK`, `staff_id`, `created_at`, `expires_at`, `revoked_at`.
- `platform_staff_links`: `link_hash text PK`, `staff_id`, `created_at`, `expires_at`, `used_at`, `issued_by`.
- `platform_activity_log`:
  - `seq bigserial PK`, `at timestamptz NOT NULL DEFAULT now()`, `staff_id text NOT NULL`;
  - `action text NOT NULL`, `business_id text` (nullable);
  - `detail jsonb NOT NULL DEFAULT '{}'`;
  - `REVOKE UPDATE, DELETE … FROM assistant_platform_group` (append-only).

**Interfaces** (`src/tenancy/staff.ts`; every function uses `withPlatform` internally and takes no db):
- Mirrors of Task 2 and `auth.ts` for staff, with a `staffId` instead of `(db, username)`:
  - `createHeadStaff({ login, displayName, password }): Promise<string>`
  - `inviteStaff({ login, displayName, issuedBy }): Promise<{ staffId: string; token: string }>`
  - `redeemStaffLink({ rawToken, typedLogin, password }): Promise<{ ok: true; staffId: string } | { ok: false; code: 'invalid' | 'login_mismatch' | 'expired' | 'used' | 'weak_password' }>`
  - `staffLogin({ login, password }): Promise<{ ok: true; staffId: string } | { ok: false; code: 'bad_credentials' | 'locked' }>`
    - A removed staff member gets `bad_credentials`.
    - An unknown login spends a decoy scrypt, as `loginUnknown` does.
  - `startStaffSession(staffId, { pendingFactor? }): Promise<string>`
  - `verifyStaffSession(token): Promise<{ staffId; displayName; isHead; pendingFactor } | null>`
  - `revokeStaffSession(token)`
  - Second factor and devices: `staffBeginEnrolment`, `staffConfirmEnrolment`, `staffVerifySecondFactor`, `staffResetSecondFactor`, `issueStaffDevice`, `isStaffDevice`, `setStaffPendingFactor`.
    - Same result unions as Task 2.
    - AAD is `{ businessId: '', ref: \`staff-totp:${staffId}\` }`.
  - `removeStaff(staffId, { by }): Promise<void>`
    - Sets `removed_at`, and revokes sessions and devices.
    - Refuses to remove the last head (`StaffError`).
  - `listStaff(): Promise<Array<{ staffId; displayName; login; isHead; enrolled: boolean; removed: boolean }>>`
- `src/tenancy/activity-log.ts`:
  - `logStaffAction(input: { staffId: string; action: StaffAction; businessId: string | null; detail?: Record<string, number | boolean | string> }): Promise<void>`
  - `StaffAction` is a closed union:
    - `'business_open'`, `'business_suspend'`, `'business_resume'`;
    - `'whatsapp_saved'`, `'setup_package_saved'`, `'profile_saved'`, `'logo_saved'`;
    - `'invite_issued'`, `'reset_issued'`, `'totp_reset'`;
    - `'staff_invited'`, `'staff_removed'`.
  - `recentStaffActions(limit: number): Promise<Array<{ at: Date; staffDisplayName: string; action: StaffAction; businessId: string | null }>>`
- `npm run staff -- create-head --email <x> --name "<n>"`:
  - prompts for the password twice;
  - refuses if any head already exists;
  - prints `בכניסה הראשונה לפאנל תתבקש לחבר את Google Authenticator.`

- [ ] **Step 1: Write the failing tests:**
  - head creation;
  - a second `create-head` is refused;
  - an invite is redeemed;
  - a wrong login returns `login_mismatch`;
  - a removed staff member cannot log in and their session is dead;
  - removing the last head throws;
  - a TOTP replay is rejected;
  - `platform_activity_log` refuses UPDATE when run through the platform pool;
  - the app account (`withBusiness(TEST_BUSINESS, db => db.query('SELECT 1 FROM platform_staff'))`) is refused.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.** Reuse `hashPassword`/`verifyPassword` from `auth.ts`.
- [ ] **Step 4: Run the tests** and see them pass. Then run `src/tenancy/platform-imports.test.ts`; it must stay unchanged and green.
- [ ] **Step 5: Commit** with message `feat(tenancy): platform staff, staff second factor, activity log`.

---

### Task 6: Setup data stores (migration 073), logo, and erasure wiring

**Files:**
- Create:
  - `src/db/migrations/073_setup_data.sql`;
  - `src/business/setup-package.ts`, `src/business/profile.ts`, `src/business/colleagues.ts`, `src/business/logo.ts`.
- Modify:
  - `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`;
  - `src/dashboard/views.ts` (`TABLE_LABELS`);
  - `src/governance/erasure-invariants.test.ts` (seed the new content tables);
  - `src/test/db.ts`.
- Test: `src/business/setup-package.test.ts`, `src/business/profile.test.ts`, `src/business/colleagues.test.ts`, `src/business/logo.test.ts`, plus cases in `src/governance/erasure-plan.test.ts`

**Migration 073** (each table has full RLS):
- `setup_packages`:
  - `business_id PK`, `boss_whatsapp text` (null);
  - `contacts jsonb NOT NULL DEFAULT '[]'`, `colleagues jsonb NOT NULL DEFAULT '[]'`;
  - `updated_at`, `updated_by text NOT NULL`.
- `business_profiles`:
  - `business_id PK`, `address text`;
  - `logo_path text`, `logo_media_type text CHECK (logo_media_type IN ('image/png','image/jpeg'))`, `logo_sha256 text`;
  - `updated_at`, `updated_by text NOT NULL`.
- `business_colleagues`:
  - `business_id`, `colleague_id text` (ulid), `name text NOT NULL`, `role text NOT NULL`, `phone text NOT NULL`;
  - `created_at`, `updated_at`;
  - PK `(business_id, colleague_id)`.

**Interfaces:**
- `src/business/setup-package.ts`:
  - `PersonEntry = { name: string; role: string; phone: string }`, validated with zod:
    - each field trimmed and non-empty;
    - `name`/`role` ≤ 120 chars;
    - `phone` must pass `authorityNumberKey` (international `+` form).
  - `loadSetupPackage(db): Promise<SetupPackage | null>`, where `SetupPackage = { bossWhatsapp: string | null; contacts: PersonEntry[]; colleagues: PersonEntry[] }`.
  - `saveSetupPackage(db, pkg: SetupPackage, updatedBy: string): Promise<void>`
    - Throws `SetupLockedError` when `activeCharterVersion(db) !== null`.
    - Allows at most 200 contacts and 50 colleagues.
  - `clearSetupPeople(db): Promise<void>`
  - `clearSetupBoss(db): Promise<void>`
  - Both delete the row once all three fields are empty.
- `src/business/profile.ts`:
  - `loadProfile(db): Promise<{ address: string | null; logo: { path: string; mediaType: 'image/png' | 'image/jpeg'; sha256: string } | null }>`
  - `saveAddress(db, address: string | null, updatedBy): Promise<void>`: ≤ 300 chars.
  - `saveLogo(db, bytes: Buffer, documentRoot: string, updatedBy): Promise<'ok' | 'not_image' | 'too_large'>`
    - Writes to `<documentRoot>/<businessId>/profile/logo.<png|jpg>`, replacing the old file.
  - `readLogo(db, documentRoot): Promise<{ bytes: Buffer; mediaType } | null>`
    - Re-hashes the file and returns `null` on a mismatch.
  - The panel enforces the charter lock itself (Task 10). The owner's settings call the same functions with no lock.
- `src/business/logo.ts`: `sniffImage(bytes: Buffer): 'image/png' | 'image/jpeg' | null`
  - PNG: the 8-byte signature and an `IHDR` chunk at offset 12.
  - JPEG: `FF D8 FF` at the start and `FF D9` at the end.
- `src/business/colleagues.ts`:
  - `listColleagues(db)`
  - `addColleague(db, PersonEntry): Promise<string>`
  - `updateColleague(db, colleagueId, PersonEntry)`
  - `removeColleague(db, colleagueId)`
- Erasure (contact anchor only):
  - A colleague row whose `name` or `phone` matches is **deleted**.
  - A `setup_packages` row whose `contacts`/`colleagues`/`boss_whatsapp` matches (`jsonbContentMatches`, or `ILIKE` with the shared escape) is **deleted whole**. Ruling: it is pre-confirmation data, and partial scrubbing of JSON arrays buys nothing.
  - Export the two predicates as constants, shared by `countItems` and the executor, following the existing `…_ERASED_PREDICATE` pattern.
  - Add Hebrew labels in `TABLE_LABELS`: `business_colleagues: 'קולגות'`, `setup_packages: 'נתוני הקמה ממתינים'`.
  - `business_profiles` is not wired: it holds the business's own address, not a counterparty.

- [ ] **Step 1: Write the failing tests:**
  - `saveSetupPackage` throws `SetupLockedError` after `installCharter` (use `buildCharter()`);
  - an invalid phone (`'050-1234567'`) is rejected;
  - `sniffImage` covers Review Focus 5:
    - PNG bytes are `image/png`;
    - JPEG bytes named `.png` are `image/jpeg`;
    - `<svg …>` is `null`;
    - the first 8 bytes of a PNG alone are `null`;
  - `saveLogo` with 1 MB + 1 byte returns `'too_large'`;
  - `readLogo` after the file was overwritten on disk returns `null`;
  - the erasure invariant seeds `PROBE` in `business_colleagues.name` and `setup_packages.contacts`, and after erasure the scan finds zero occurrences.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new tests and `src/governance` (erasure suite), and see them pass.
- [ ] **Step 5: Commit** with message `feat(business): setup package, profile and logo, colleagues; erasure wiring`.

---

### Task 7: Panel reads in the closed list

**Files:**
- Create: `src/tenancy/panel-reads.ts`
- Test: `src/tenancy/panel-reads.test.ts`, `src/tenancy/panel-reads-invariants.test.ts`

**Interfaces** (`withPlatform` internally):
- `PanelBusinessRow = { businessId: string; displayName: string; status: 'active' | 'suspended'; setupState: 'setting_up' | 'live'; basicDone: number; basicTotal: 4; systems: string[] }`
  - `setupState` is `'setting_up'` exactly when there is no `charter_active` row.
  - `basicDone` counts four booleans:
    - WhatsApp secrets `GREEN_API_INSTANCE_ID` and `GREEN_API_TOKEN` both present in `credentials`;
    - a boss number in `setup_packages.boss_whatsapp` or in the active charter's principal;
    - a live `mailbox` grant in `oauth_grants` (not revoked);
    - at least one contact or colleague, pending or confirmed (`setup_packages` arrays, or `business_colleagues`).
  - `systems` holds the names of live connections in the active charter other than `mailbox`. For now that is always `[]`; it is a Stage D placeholder.
- `listBusinessesForPanel(): Promise<PanelBusinessRow[]>`
- `businessDetailForPanel(businessId: string): Promise<PanelBusinessDetail | null>`
  - `PanelBusinessDetail = PanelBusinessRow & { whatsappSaved; bossNumberSet; mailboxConnected; ownerEnrolled; ownerExists: boolean; contactsPending: number; colleaguesPending: number; contactsConfirmed: number; colleaguesConfirmed: number; addressSet: boolean; logoSet: boolean; snapshot: PanelSnapshot }`
  - `PanelSnapshot = { jobsLast7Days: number; pendingApprovals: number; spendTodayMinor: number; lastActivityAt: Date | null; failedLast7Days: number }`
  - `lastActivityAt` is `max(job_steps.at)`. **Ruling:** nothing records a scheduler pass per business, so "last pass" becomes last job activity.
- `setupDataForPanel(businessId): Promise<{ bossWhatsapp: string | null; contacts: PersonEntry[]; colleagues: PersonEntry[]; address: string | null } | 'locked'>`
  - Returns `'locked'` when an active charter exists. This is the only read that returns typed text, and only data the technician typed before handover.

**Invariant test** (`panel-reads-invariants.test.ts`):
- It calls every exported function on a seeded business that has an active charter, memories, a job with a title, a mail and a do-not-contact label, all carrying a `PROBE` string.
- `JSON.stringify` of every result must not contain `PROBE`.
- It also asserts that the exported names of the module equal an exact frozen list, so a new read is a deliberate change:
  ```
  ['listBusinessesForPanel', 'businessDetailForPanel', 'setupDataForPanel']
  ```
- Seeding uses `testDb()`.

- [ ] **Step 1: Write the failing tests:**
  - `basicDone` moves from 0 to 4 as each of the four facts is seeded;
  - `setupState` flips to `'live'` after `installCharter`;
  - `setupDataForPanel` returns `'locked'` after install;
  - the invariant above.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and see them pass.
- [ ] **Step 5: Commit** with message `feat(tenancy): panel reads — states and counts only`.

---

### Task 8: Panel server skeleton (auth, binding, layout)

**Files:**
- Create:
  - `src/admin/server.ts`, `src/admin/views.ts`, `src/admin/run-admin.ts`;
  - `src/util/bind.ts`: move `assertBindableHost` here from `src/dashboard/server.ts`, and re-export it from there so existing imports keep working.
- Modify: `package.json` (`"admin": "tsx src/admin/run-admin.ts"`), `.env.example` (`ADMIN_HOST=127.0.0.1`, `ADMIN_PORT=8788`, `ADMIN_TRUST_PROXY`, `ADMIN_ALLOW_PUBLIC_BIND`, `ADMIN_DASHBOARD_BASE_URL`)
- Test: `src/admin/server-auth.test.ts`, `src/admin/isolation.test.ts`

**Interfaces:**
- `createAdminServer(options: AdminOptions): Server`
  - `AdminOptions = { host?; port?; trustProxy?; allowNonLoopbackBind?; masterKey: Buffer; documentRoot: string; dashboardBaseUrl: string }`
- Cookies:
  - session cookie `asid` (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
  - trusted-device cookie `adev` (same attributes, `Max-Age=2592000`).
- Routes:
  - `GET|POST /login`, `GET|POST /2fa`, `GET|POST /2fa/enrol`, `POST /logout`;
  - `GET|POST /join/<token>` (staff invite redemption).
  - The flow is the same as Task 3: the pending-factor gate, plus a not-enrolled check that uses `verifyStaffSession`'s data.
- CSRF reuses `issueCsrfToken`/`verifyCsrfToken` from `src/dashboard/csrf.ts`, keyed by the `asid` value.
- `page(title, body)` in `src/admin/views.ts`:
  - RTL Hebrew, with the nav `עסקים · צוות · יומן פעולות` (the head also sees `צוות` actions);
  - a header line `פאנל המנהל`;
  - escaping uses `escapeHtml` from `src/util/html.ts`.
- Every response carries `X-Frame-Options: DENY` and a `Content-Security-Policy` of `default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'`.
- `run-admin.ts`:
  - loads the master key (`loadMasterKey(config path)`);
  - refuses to start if `verifyServerKeyState` fails;
  - prints the URL only.

- [ ] **Step 1: Write the failing tests:**
  - staff sign-in through enrolment works end to end;
  - a removed staff member's `asid` gets 303 to `/login`;
  - binding to `0.0.0.0` without `allowNonLoopbackBind` throws;
  - **isolation pair** (`isolation.test.ts`):
    - (a) A valid owner `sid` value sent to the panel, as `asid` and as `sid`, gets 303 to `/login` from `GET /`.
    - (b) A valid staff `asid` value sent to the dashboard, as `sid` and as `asid`, gets 303 to `/login` from `GET /`.
    - Each half also asserts that the matching legitimate cookie gets 200, so the test proves the server was reachable.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the admin tests, `src/dashboard/server.test.ts` (bind move) and `npm run typecheck`, and see them pass.
- [ ] **Step 5: Commit** with message `feat(admin): panel server with staff sign-in and Authenticator`.

---

### Task 9: Business list, open business, business page and snapshot

**Files:**
- Create: `src/admin/business-routes.ts`
- Modify: `src/admin/server.ts`, `src/admin/views.ts`
- Test: `src/admin/business-routes.test.ts`

**Behavior:**
- **`GET /`:** the business table from `listBusinessesForPanel`.
  - Columns: `עסק | מצב | חיבורים בסיסיים | מערכות`.
  - The state shows as `🟢 פעיל`, `🟡 בהקמה` or `⏸ מושעה`. Suspended wins over setting up.
  - `חיבורים בסיסיים` shows `n/4`.
  - There is a `+ פתיחת עסק חדש` button.
- **`GET|POST /businesses/new`:** fields `מזהה` (validated with `isValidBusinessId`, Hebrew error on failure), `שם העסק`, `מייל הכניסה של בעל העסק`, `כתובת` (optional).
  - It calls `createBusiness(id, name)` and `saveAddress` (through `withBusiness`).
  - It issues an invite (`issueOwnerLink(kind 'invite')`) and shows the full link, `${dashboardBaseUrl}/invite/<token>`, **once**, with copy: `העתק את הקישור ושלח אותו לבעל העסק. הקישור תקף ל-72 שעות ולשימוש אחד.`
  - It refuses a login already held anywhere (`resolveLogin`).
  - Logs `business_open`.
- **`GET /businesses/<id>`:** three sections in order.
  - `1 · פתיחת עסק`: name, address and logo state, plus whether the owner has signed in and enrolled.
  - `2 · חיבורים בסיסיים (נדרשים כדי להתחיל לעבוד)`: four rows with ✓/—.
  - `3 · חיבור למערכות (פותח עבודה מלאה)`: `ייבנה בשלב הבא` and the `systems` list.
  - `תמונת מצב`: the five snapshot numbers, labelled `משימות ב-7 ימים`, `אישורים ממתינים`, `עלות היום` (via `formatMinor` and the charter currency, or `—` without a charter), `פעילות אחרונה`, `כשלים ב-7 ימים`.
- **`POST /businesses/<id>/suspend|resume`:** `setBusinessStatus`. Logs, and writes the business `audit_log` row.
- **Per-business audit:** add a closed `AuditKind` member `'staff_action'`.
  - Check `src/audit/log.ts` and any `CHECK` on `audit_log.kind` in migrations. If one exists, add migration `074_audit_staff_action.sql` extending it.
  - Write one helper, `recordStaffAction(staff, action, businessId | null)` in `src/admin/record.ts`. It calls `logStaffAction`, and when `businessId` is set also calls `appendAudit` in that business, with `reason` = `` `${action} · ${staff.displayName}` `` and `inputHash` = `canonicalHash({ action })`.
  - Every later panel action calls only this helper.

- [ ] **Step 1: Write the failing tests:**
  - opening a business creates the `businesses` row and a pending invite, and the link appears exactly once (reloading the page does not show it);
  - a duplicate owner email is refused in Hebrew;
  - the list shows `🟡 בהקמה` and `0/4`;
  - suspend writes `platform_activity_log` and `audit_log` rows, neither containing the business name;
  - the business page HTML of a business seeded with `PROBE` content (a memory, a job title, a mail) does not contain `PROBE`.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and see them pass.
- [ ] **Step 5: Commit** with message `feat(admin): business list, opening a business, business page, snapshot`.

---

### Task 10: Basic setup actions on the business page

**Files:**
- Modify: `src/admin/business-routes.ts`, `src/admin/views.ts`
- Test: `src/admin/setup-actions.test.ts`

**Behavior (all POST with CSRF, all through `recordStaffAction`):**
- **`/businesses/<id>/whatsapp`:** fields `מזהה החשבון` and `אסימון`.
  - `putSecret(db, { ref: 'GREEN_API_INSTANCE_ID', … }, key)` and the same for `'GREEN_API_TOKEN'`, with `updatedBy` = `staff:<staffId>`.
  - Then `saveRuntimeSettings(db, { whatsappEnabled: true })`.
  - The page afterwards shows only `שמור`; the values are never echoed.
  - Allowed after handover too: it is a connection, not authority.
- **`/businesses/<id>/setup`:** a boss number field, plus two repeatable row groups (contacts, colleagues) of `שם | תפקיד | טלפון`.
  - Calls `saveSetupPackage`.
  - On `SetupLockedError` it sends 409 with `העסק כבר נחתם על ידי בעל העסק. מעכשיו רק הוא מעדכן את הפרטים האלה.`
- **`/businesses/<id>/profile`:** address.
  - **`/businesses/<id>/logo`** is a multipart upload. Reuse the multipart reader the dashboard's `/instruct` upload uses, capped at `LOGO_MAX_BYTES + 64 KiB`.
  - Both are refused with the same 409 once a charter is active (check `setupDataForPanel(...) === 'locked'` before writing).
  - Errors:
    - `not_image`: `הקובץ אינו תמונת PNG או JPEG.`
    - `too_large`: `הקובץ גדול מ-1MB.`
- **`/businesses/<id>/reset-link`:** `issueOwnerLink(kind 'password_reset')` for the owner's login. Shows the link once.
- **`/businesses/<id>/totp-reset`:** `resetSecondFactor(db, 'owner')`.
- **Mailbox row:** shows `מחובר`/`לא מחובר` and the text `שלח לבעל העסק את הקישור: ${dashboardBaseUrl}/connections`. No action.
- **Before handover:** the setup section renders the saved package values, from `setupDataForPanel`.
  - **After handover:** only counts are shown (`contactsConfirmed`, `colleaguesConfirmed`, `bossNumberSet`).

- [ ] **Step 1: Write the failing tests:**
  - WhatsApp save stores both secrets (`listSecretRefs`), sets `whatsappEnabled`, and the response body contains neither value;
  - Review Focus 4: after `installCharter`, posting setup/profile/logo returns 409 and the tables are unchanged;
  - a logo upload of an SVG returns `not_image`;
  - the reset link redeems on the dashboard (reusing Task 4);
  - TOTP reset forces enrolment at the owner's next request;
  - after install, the setup section HTML contains no contact name from the old package.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and see them pass.
- [ ] **Step 5: Commit** with message `feat(admin): basic setup actions — WhatsApp, setup package, profile, links, Authenticator reset`.

---

### Task 11: Staff management and activity log screens

**Files:**
- Create: `src/admin/staff-routes.ts`
- Modify: `src/admin/server.ts`, `src/admin/views.ts`
- Test: `src/admin/staff-routes.test.ts`

**Behavior:**
- **`GET /staff`:** `listStaff()` with name, login, head flag, `Authenticator ✓/—`, removed.
  - Head only: an add form (name, email) that calls `inviteStaff` and shows the link `${adminBaseUrl}/join/<token>` once. `adminBaseUrl` comes from the request host, or from the `ADMIN_BASE_URL` env var. Add it to `.env.example`.
  - Head only: a remove button that calls `removeStaff`, and a `איפוס Authenticator` button that calls `staffResetSecondFactor`.
- **Non-head:** `POST` to these returns 403 with `רק מנהל ראשי יכול לנהל את הצוות.`
- **`GET /log`:** `recentStaffActions(200)` showing time, staff name, a Hebrew action label from a `Record<StaffAction, string>` (exhaustive), and the business id.

- [ ] **Step 1: Write the failing tests:**
  - a non-head add or remove returns 403 and writes nothing;
  - a head invites, the invitee joins through `/join/<token>`, enrols and signs in;
  - removing the last head is refused in Hebrew;
  - the log lists the actions from Tasks 9–10;
  - the action-label record covers every `StaffAction` (compile-time `Record`, plus a runtime length check).
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and see them pass.
- [ ] **Step 5: Commit** with message `feat(admin): staff management and activity log`.

---

### Task 12: Interview integration

**Files:**
- Modify:
  - `src/dashboard/setup-routes.ts`;
  - `src/charter/interview/install.ts`;
  - the interview views (the file that renders steps 1, 2 and 8; find it from `setup-routes.ts`).
- Create: `src/business/confirm-people.ts`
- Test: `src/business/confirm-people.test.ts`, `src/dashboard/setup-prefill.test.ts`, `src/orchestrator/whatsapp-colleague.test.ts`

**Behavior:**
- **Step 1 (`business`):** shows the address and logo from `loadProfile` with `אפשר לשנות בהגדרות ← פרטי העסק`. This is read-only here.
- **Step 2 (`principal`):** when the draft has no `principal.whatsapp` and the package has `bossWhatsapp`, the field is prefilled.
  - The owner still saves the step as today.
  - Note under the field: `המספר הוזן בהקמה. העוזרת תקבל הוראות רק מהמספר הזה, ורק אחרי שתחתום.`
- **Step 8 (`counterparties`):** when the package has contacts or colleagues, a section `אנשי קשר וקולגות מההקמה` lists them.
  - Each contact has a checkbox `מוכר (הוסף לרשימת המוכרים)`, unchecked by default. Colleagues have no checkbox: they are never charter counterparties.
  - A button `אשר את הרשימה` posts to `POST /setup/people`, which calls `confirmSetupPeople`.
- **`confirmSetupPeople(db: BusinessDb, input: { knownIndices: number[] }): Promise<{ contacts: number; colleagues: number; known: number }>`:**
  - Reads the package and opens one job with `createJob({ provenance: 'boss', title: 'אישור אנשי קשר מההקמה' })`. The provenance is a literal, as `recordCorrection` does.
  - For each contact, writes `writeMemory({ jobId, kind: 'entity', subjectKey: <stable key from phone, the same key derivation contact entities use — follow listContacts/contact-resolver>, body: { name, role, phone }, sourceRef: 'setup_package' })`.
  - Inserts each colleague with `addColleague`.
  - Saves each known contact into the draft through `saveSection(db, 'counterparties', …)`, appending `{ label: \`${name} — ${role}\`, phone }` to `known` and skipping duplicates by phone.
  - Calls `clearSetupPeople`.
  - Closes the job (`plan → closed`, through the legal transitions).
  - All in one transaction except the job transitions. The function is idempotent: a second call with an empty package returns zeros.
- **`signAndInstallInterview`:** after a successful commit, calls `clearSetupBoss(db)`. Failure is reported, not thrown, as the dial is handled today.
- **Colleague WhatsApp (test only, no production change expected):** add a pair test in `whatsapp-colleague.test.ts`.
  - The same text `תשלחי לדנה את ההצעה` from the charter principal's number is handled as an instruction.
  - From a number in `business_colleagues` it returns `'recordedOnly'`, writes no `boss_instructions` row and sends no reply.
  - A third case: a number present only in `setup_packages.boss_whatsapp`, with no active charter, returns `'recordedOnly'`.
  - If any case fails, fix production so colleague numbers never reach the principal path.

- [ ] **Step 1: Write the failing tests:**
  - the prefill appears in step 2 HTML;
  - confirming with `knownIndices: [0]` writes two memory entities with provenance `boss`, one colleague row, one `known` entry in the draft, and empties the package;
  - the panel's `setupDataForPanel` still returns data before install (nothing is locked yet) but with empty people;
  - after `signAndInstallInterview` the package boss number is cleared and `isPrincipalSender(charter, bossNumber)` is true;
  - an unchecked contact is in memory but not in `charter.counterparties` after signing;
  - the WhatsApp pair above.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the whole `src/charter/interview` + `src/dashboard/setup*` suites, and see them pass.
- [ ] **Step 5: Commit** with message `feat(setup): technician setup data meets the owner in the interview`.

---

### Task 13: Owner settings for profile and people

**Files:**
- Create: `src/dashboard/profile-routes.ts`, `src/dashboard/people-routes.ts`
- Modify: `src/dashboard/server.ts` (routes plus the settings nav), `src/dashboard/views.ts`
- Test: `src/dashboard/profile-routes.test.ts`, `src/dashboard/people-routes.test.ts`

**Behavior (behind session and CSRF):**
- **`GET|POST /settings/profile`:** address, and logo upload through `saveAddress`/`saveLogo`.
  - `GET /settings/profile/logo` serves `readLogo`'s bytes with the stored media type, `Content-Disposition: inline`, and `X-Content-Type-Options: nosniff`.
- **`GET /settings/people`:** two lists.
  - Colleagues come from `listColleagues`, and can be added, edited and removed.
  - Contacts are memory entities written with `sourceRef = 'setup_package'` or added here. Use the existing `listContacts`, and show only rows this screen or the setup wrote (`sourceRef` in `('setup_package','settings_people')`).
  - Contacts can be added and edited (`writeMemory` under a `boss` job, as in Task 12, with `sourceRef 'settings_people'`) and removed. Removal uses the same store function the `memory.retire` local tool handler calls in `src/orchestrator/local-tools.ts`, run under a `boss` job.
  - Copy at the top: `העוזרת מכירה את האנשים כאן ויודעת מה התפקיד שלהם. הוראות היא מקבלת רק ממך. כדי שאיש קשר ייחשב "מוכר" (מענה בלי כרטיס אישור), הוסף אותו ב"ערוך את הכללים".`

- [ ] **Step 1: Write the failing tests:**
  - adding a colleague via POST, then editing it, then removing it;
  - an invalid phone is refused in Hebrew;
  - a contact add creates an entity with provenance `boss`;
  - a contact removal retires it (a later `recallMemories` excludes it, and the row still exists);
  - a logo GET carries `nosniff` and the right content type;
  - a CSRF-less POST is refused.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and see them pass.
- [ ] **Step 5: Commit** with message `feat(dashboard): owner settings for business profile and people`.

---

### Task 14: Business name and address in outbound content, plus letterhead

**Files:**
- Create: `src/business/profile-prompt.ts`
- Modify:
  - drafters and their callers: `src/sdk/mail-drafter.ts` + `src/orchestrator/mail-reply.ts`; `src/sdk/nudge-drafter.ts` + `src/ledger/nudge.ts`; `src/sdk/doc-drafter.ts` + `src/production/loop.ts`; `src/sdk/planner.ts` + `src/orchestrator/instruct.ts`;
  - document spec: `src/domain/document-spec.ts` (optional `letterhead: boolean`);
  - renderers: `src/production/render-docx.ts`, `src/production/render-html.ts`, `src/production/render-pdf.ts`;
  - `src/production/check1.ts` (allowlist the docx header part).
- Test: `src/business/profile-prompt.test.ts`, letterhead cases in `src/production/render-docx.test.ts` and `src/production/render-html.test.ts`, `check1` cases

**Interfaces:**
- `profileFragment(db: BusinessDb): Promise<{ businessProfile?: { name: string; address: string | null } }>`
  - The name comes from `businesses.display_name`. Read it through `getBusiness`, because that runs through tenancy, not the platform pool from a drafter. If `getBusiness` uses the platform pool, read `display_name` with a plain `SELECT` under `withBusiness` instead: `businesses` has no RLS, so first check that `assistant_app` may SELECT it. If it may not, add the name to `business_profiles` in migration 073 instead. That is a ruling for the implementer, to be recorded.
  - It swallows errors and returns `{}`, like `descriptionFragment`.
- `renderProfileSection(p: { name; address } | undefined): string`
  - Header: `# פרטי העסק (לשימוש בהודעות ובמסמכים רשמיים)`.
  - Sentence: `כשההודעה או המסמך רשמיים, אפשר לציין את שם העסק ואת הכתובת — רק כשזה נחוץ, לא בכל הודעה.`
  - Then the name and address lines.
  - It returns `''` when undefined.
  - It is placed right after the description section, in the same five prompts minus the meeting extractor.
- `DocumentSpec.letterhead?: boolean`. The doc drafter's prompt tells it to set `letterhead: true` for formal letters, quotes and contracts.
- **docx:** when `letterhead`, add `headers: { default: new Header({ children: [logo image if any, name, address] }) }` next to the existing `footers` entry. The logo comes from a new `RenderDocxOptions.letterhead?: { name; address: string | null; logo: { bytes; mediaType } | null }`. `production/loop.ts` fills it from `readLogo` + `profileFragment`.
- **PDF:** the same data goes into `renderHtml` as a top block (`<header>` with an `<img src="data:…">`, name and address) and is not added to Chromium's header template, so check1's structural comparison sees it.
- **check1:** allowlist `word/header1.xml` and its `_rels` part only when `spec.letterhead === true`. A header part without the flag is still a finding. xlsx and pptx ignore `letterhead`.

- [ ] **Step 1: Write the failing tests:**
  - `renderProfileSection` output contains the header and address, and returns `''` for undefined;
  - the mail drafter prompt (`renderDraftPrompt`) includes the section when given `businessProfile`;
  - a docx rendered with `letterhead: true` contains `word/header1.xml` with the business name;
  - without the flag there is no header part;
  - check1 passes the first and flags a header part injected into a no-letterhead docx;
  - the PDF HTML contains `<header` with the address when `letterhead`.
- [ ] **Step 2: Run the tests** and see them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `src/production` and `src/sdk`, and see them pass.
- [ ] **Step 5: Commit** with message `feat(production): business name, address and logo in official messages and letterhead`.

---

### Task 15: Documentation and the full suite

**Files:**
- Modify:
  - `CLAUDE.md`:
    - commands: `npm run admin`, `npm run staff -- create-head`;
    - in "ריבוי עסקים", add the three panel reads to the closed list;
    - a new subsection `### פאנל המנהל ו-Google Authenticator`, covering the separate server, technicians never seeing content, the setup package and the lock after signature, the pending factor, recovery codes removed, links, `staff_action`, and the logo rules;
    - remove every statement that recovery codes exist (search `קוד שחזור`/`recovery`).
  - `docs/10-user-settings.md`: business details (address, logo) and people (colleagues, contacts).
  - `docs/11-pre-launch-checks.md`, new rows:
    - TOTP with the real Google Authenticator app on iOS and Android;
    - the panel behind the real proxy on its own subdomain;
    - an invite link on mobile;
    - the letterhead render with a real logo through `doc:render-check`;
    - the first `staff create-head` on the server.
  - `docs/dashboard-deployment.md`: the panel's port and host rules.
  - `docs/12-launch-plan.md`: the technician onboarding step.
- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the whole suite** on the dedicated database:
  ```
  TEST_DATABASE_URL="$SDD" npm run migrate:test
  TEST_DATABASE_URL="$SDD" npx vitest run --no-file-parallelism
  ```
  Then run `npm run typecheck`. Every test must pass.
- [ ] **Step 3: Commit** with message `docs: admin panel and Google Authenticator`.
