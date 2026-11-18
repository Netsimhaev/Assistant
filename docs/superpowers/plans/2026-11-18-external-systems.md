# Stage D — External Systems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician defines a generic HTTPS API connection for a business in the admin panel, the owner signs it into the charter, and from then on the assistant reads from and acts on that system **only on a confirmed boss command**, learns from its webhooks and daily scan, and reports back — without any new gate exemption.

**Architecture:** An external system is a signed charter object (`externalSystems[]`) plus one ordinary `CharterConnection` per system whose `target` is the system id, so channel resolution and bindings work unchanged. Two new tools, `ext.read` and `ext.call`, owned by `ops.systems`, both classified and outbound; the action class of a call is read from the **signed operation**, never from the payload or the model. Inbound data (webhooks, scans, reads) is reduced deterministically to the response fields the definition declares, stored as `unknown_external`, summarised without a model, and curated as chunks only.

**Tech Stack:** TypeScript (NodeNext, ESM), zod 4, pg + RLS, vitest on real Postgres, `node:https` (no new dependency).

**Spec:** [docs/superpowers/specs/2026-11-13-external-systems-design.md](../specs/2026-11-13-external-systems-design.md) — including the owner's answers of 13/11, which win over everything above them in that file.

## Global Constraints

- `src/policy/engine.ts` gets **no new exemption**. The only change there is the stage-3 resolution in Task 3, and it goes through `/security-review`.
- Every external action runs only under `confirmedCommandCovers` (boss command + one "כן"). No conductor, scan or webhook path ever creates a job with an `ext.*` step.
- Money operations: kind `money` → class `payment.make` or `refund.issue` only. Never runs without an explicit boss "כן", in any mode.
- Address, method, path and class come from the signed definition. The model fills only `params` (and `amountMinor` for money), and all of them appear in full in the confirmation question.
- HTTPS only. Refuse private, loopback, link-local, CGNAT, ULA, multicast, unspecified and cloud-metadata addresses **after DNS resolution**, on the socket that is actually used. Never follow redirects.
- Secrets live only in the business vault (`putSecret`) under `EXT_<ID>_KEY` and `EXT_<ID>_HOOK` (`<ID>` = system id upper-cased). They never appear in the definition, the charter, a prompt, a log, an audit row, the panel or the dashboard.
- Everything read from outside is `unknown_external`. Memory writes from it are `chunk` only, never retire.
- No row in `src/policy/` reads anything from an external response (amounts included) — same rule as `findings`.
- `CURRENT_SCHEMA_VERSION` → `'1.4'`; every signed charter must be re-signed. That is expected, not a bug.
- Hebrew for the owner and the technician, English for code; owner-facing class names only through `src/domain/labels.ts`.
- New tables: `business_id`, RLS `FORCE`, the standard `app_business_id()` policy, created in their migration.
- Every built-but-unrun live check goes into `docs/11-pre-launch-checks.md`.

## Rulings made while planning (⚙ — mine, not the owner's)

1. The technician pastes the definition as **JSON in a textarea**, validated by zod with Hebrew errors and a Hebrew preview. A dynamic form for N operations is a lot of UI for no extra safety; JSON is the flexibility the owner asked for. *Cost if wrong:* a form later; the schema stays.
2. A **read also asks one "כן"**. Under the default dial `off` the ramp holds `external.read` at `draft_only`, so the confirmed command is the only path that can run a read at all. *Cost:* one extra word per lookup.
3. **Responses are reduced deterministically:** each operation and event type declares up to 20 `fields` (JSON path + Hebrew label), and only those are stored, shown or curated. Nothing else from a response is kept. *Cost:* a technician must name fields; a missing field is invisible.
4. **The boss summary** of webhooks and scans is a section in the daily/weekly digest plus a `/systems` screen. No new message channel. *Cost:* an owner who leaves the digest `off` sees it only on the screen. This is stated on the screen and in docs/10.
5. **Write retries:** a write that got 429 or 503 back is retryable; any other 5xx, a socket error after the request was sent, or a timeout is `delivery_unknown`/`adapter_timeout`, final, and not re-sent blindly. Reads retry on any 429/5xx.
6. **Money units:** only ILS, USD, EUR and GBP (two decimals). The currency must equal the charter's. `unit: 'major'` sends `amountMinor / 100` as a JSON number.
7. **Signing without the secret is allowed.** The status shows "חסר סוד", and a call fails `credential_unavailable` until it is stored.
9. **The daily scan is a documented gate bypass** (it joins the short list: mail labelling, the curator, erasure, calendar holds). The spec wants a scan, and through the gate under `off` it would read nothing. What holds it instead: it can only run the one `read` operation the owner signed as `scan`, at the signed interval, through the same request builder, address guard and daily cap, and what it reads only teaches. *Cost if wrong:* a signed scan reads data the owner did not expect. Mitigation: the sign page says it in words.
10. **Three additions so more real systems fit (owner, 18/11):** a webhook signature with a prefix and/or a timestamp (Stripe, GitHub, Slack), a form-encoded request body, and the first-time verification handshake (Meta, Slack). None of them loosens anything: the signature is still over the raw bytes with a vault secret, a timestamp adds replay protection (±300 s), and a handshake answer is echoed only after the token or signature check, as plain text, at most 200 characters from `[A-Za-z0-9._-]`. *Still out:* OAuth, XML/SOAP, paginated scans, AWS-style request signing.
8. **The webhook endpoint** lives on the dashboard server (behind the proxy) at `POST /hooks/ext/<businessId>/<systemId>`, with no session and verification by secret. Unknown event types are counted and dropped.

## Review Focus

1. **A parameter value carrying `../`, `?`, `#` or `%2F`** must not change the path. Each value is encoded as a single path segment; a template placeholder with no matching param is a refusal, not an empty segment.
2. **A DNS name that resolves to `127.0.0.1`, `169.254.169.254`, `::ffff:10.0.0.1` or `fd00::1`**, or that rebinds between lookup and connect, must be refused. The check runs inside the socket's own `lookup`.
3. **A plan step naming an operation that the signed definition lists under the other tool** (a `money` op under `ext.read`, a `read` op under `ext.call`), an unknown system, or an unknown operation is denied at stage 3 and never classified as something gentler.
4. **A webhook whose body is valid JSON but whose signature was computed over different bytes** (re-serialised, whitespace changed) is refused. The HMAC is over the raw bytes.
5. **A money call whose `params` also carries the amount field** (two amounts: one shown, one sent) is refused, so the amount the owner saw is the only one that can reach the provider.

---

### Task 1: Charter schema 1.4 — external systems and two new classes

**Files:**
- Create: `src/domain/external-system.ts`, `src/domain/external-system.test.ts`
- Modify: `src/domain/action.ts` (enum, `NEVER_FULLY_AUTONOMOUS_TABLE`, addressee table), `src/domain/charter.ts` (field, pairing refine, version `'1.4'` with docblock line), `src/domain/labels.ts`, `src/charter/schema-version.test.ts`, `src/charter/interview/build.ts` (autonomy base for the two classes), `src/test/fixtures.ts`, `src/charter/compile.ts` + `src/domain/policy.ts` (carry `externalSystems` into the bundle)

**Interfaces:**
- Produces:
  - `ExternalSystem` (zod + type), `ExternalOperation`, `ExternalField`, `OperationKind = 'read'|'change'|'delete'|'money'`
  - `EXTERNAL_SYSTEM_ID = /^[a-z][a-z0-9_]{1,30}$/`
  - `externalSecretRefs(id) → { key: string; hook: string; verify: string }`, giving `EXT_<ID>_KEY`/`EXT_<ID>_HOOK`/`EXT_<ID>_VERIFY` (the last only for a `query_challenge` handshake, whose verify token is not the signing secret)
  - `CHANGE_CLASSES = ['crm.write','accounting.write','quote.issue','commitment.make','data.export'] as const`
  - `MONEY_CLASSES = ['payment.make','refund.issue'] as const`
  - `PolicyBundle.externalSystems: ExternalSystem[]`

`ExternalSystem` shape:
- `{ id, label (Hebrew), baseUrl, auth, idempotencyHeader, operations, webhook, scan }`
- `baseUrl`: `https:` only, no credentials, query or fragment.
- `auth`: `{ kind: 'header', header } | { kind: 'bearer' } | { kind: 'basic' }`.
- `idempotencyHeader`: a header name, or null.
- `operations`: 1–50 items. Each is `{ name, label, kind, actionClass, method, path, params, fields, idPath, amount }`, where:
  - `name`: `/^[a-z][a-z0-9_]{1,40}$/`.
  - `path`: starts with `/`, and placeholders are `{param}`.
  - `params`: a list of `{ name, in: 'path'|'query'|'body', required }`.
  - `bodyEncoding`: `'json'` (default) or `'form'`.
  - `fields`: ≤20 `{ path: dotted, label }`.
  - `idPath`: a field path, or null.
  - `amount`: `{ field, unit: 'minor'|'major', currency }` or null.
- `webhook`: `{ scheme, typePath, events: [{ type, label, fields }], handshake }` or null, where:
  - `scheme` is `{ kind: 'shared-secret', header }` or `{ kind: 'hmac-sha256', encoding: 'hex'|'base64', signature, signedPayload, timestamp }`:
    - `signature`: `{ from: 'header', header, prefix: string|null }` (GitHub: `X-Hub-Signature-256`, prefix `sha256=`) or `{ from: 'kv', header, key, separator }` (Stripe: `Stripe-Signature`, key `v1`, separator `,`; any one matching value is enough).
    - `signedPayload`: a template over `{timestamp}` and `{body}` only, containing `{body}` exactly once: `'{body}'` (default), `'{timestamp}.{body}'` (Stripe), `'v0:{timestamp}:{body}'` (Slack).
    - `timestamp`: null, `{ from: 'header', header }` (Slack) or `{ from: 'kv', key }` (Stripe `t`). It is required when the template uses `{timestamp}`, unix seconds, ±300 s from now.
  - `handshake`: null, `{ kind: 'query_challenge', modeParam, modeValue, tokenParam, challengeParam }` (Meta: `hub.mode`=`subscribe`, `hub.verify_token`, `hub.challenge`; GET; the token is compared with `EXT_<ID>_VERIFY`) or `{ kind: 'body_challenge', typeValue, challengePath }` (Slack `url_verification`; POST; after the signature check).
- `scan`: `{ operation, sinceParam: string|null, itemsPath: string|null, everyHours: 1..168 }` or null.

- [ ] **Step 1: Write failing tests** in `external-system.test.ts`:
  - **Kind and class (refused):**
    - `kind:'read'` with a class other than `external.read`
    - `kind:'delete'` with a class other than `external.delete`
    - `kind:'change'` with a class outside `CHANGE_CLASSES`
    - `kind:'money'` with `purchase.place`
  - **Money rules (refused):** a `money` op without `amount`; an `amount.currency` not in `['ILS','USD','EUR','GBP']`; an amount `field` that is also in `params`.
  - **Base URL (refused):** `http://…`, `https://u:p@h`, `https://h/?q=1`.
  - **Path and parameters:**
    - refused: a path placeholder with no `in:'path'` param; an `in:'path'` param with no placeholder; duplicate op names
    - refused: a `scan.operation` that is not a `read` op; a `webhook.events` type listed twice
    - accepted: the reference fixture `crmFixture()` (exported from the test file's sibling `src/test/external-fixtures.ts`)
  - **Webhook (refused):** a `signedPayload` without `{body}`, with `{body}` twice, or with any placeholder other than `{timestamp}`/`{body}`; a template using `{timestamp}` with `timestamp: null`; a `body_challenge` without `typePath`; a `bodyEncoding: 'form'` on a `GET` op.
  - **Charter pairing:** in `charter.test.ts`, every `externalSystems[i]` needs exactly one connection with `system === 'ext:'+id`, `serves` exactly `['ext.call','ext.read']`, `target === id` and `channel: 'api'`, and every connection whose system starts with `ext:` needs its definition. Each half is broken by one test.
  - **Charter currency:** a money op whose currency differs from `money.currency` is refused at parse, with a Hebrew message.
- [ ] **Step 2: Run** `npx vitest run src/domain/external-system.test.ts src/domain/charter.test.ts src/charter/schema-version.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `external.read` (addressee `internal`, never-fully `false`) and `external.delete` (`internal`, `true`).
  - Hebrew labels: "קריאה ממערכת חיצונית", "מחיקה במערכת חיצונית".
  - Interview defaults: `external.read` → `auto`, `external.delete` → `approve_required`.
  - Update the frozen enum list in `schema-version.test.ts`, bump to `'1.4'` with one docblock paragraph, and carry `externalSystems` (default `[]`) through `compileCharter`.
- [ ] **Step 4: Run** the same tests plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(charter): schema 1.4 — external systems and external.read/external.delete`

### Task 2: Migration 077 and stores

**Files:**
- Create: `src/db/migrations/077_external_systems.sql`, `src/external/store.ts`, `src/external/store.test.ts`
- Modify: `src/tenancy/rls.test.ts` (only if its expected-table count is pinned)

**Interfaces:**
- Produces, in `src/external/store.ts`:
  - `saveDraft(db, {systemId, definition, staffId}) → void` (upsert)
  - `loadDrafts(db) → DraftRow[]`
  - `deleteDraft(db, systemId)`
  - `recordExternalRead(db, {jobId, stepId, systemId, operation, fields}) → void`
  - `loadReadsForJob(db, jobId) → ReadRow[]`
  - `insertEvent(db, {systemId, source:'webhook'|'scan', eventType, itemHash, fields}) → boolean` (false on duplicate)
  - `newEventsSince(db, cursor) → EventRow[]`
  - `markEventsCurated(db, ids)`
  - `countCallsToday(db, systemId, timeZone) → number`
  - `recordCall(db, {systemId, outcome})`
  - `recordRejectedHook(db, systemId, reason)`
  - `lastScanAt(db, systemId)` / `setLastScanAt(db, systemId, at)`
  - Here `fields: {label: string; value: string}[]`.

Tables:
- `external_system_drafts (business_id, system_id, definition jsonb, updated_at, updated_by_staff text)`, PK `(business_id, system_id)`
- `external_reads (business_id, read_id, job_id, step_id, system_id, operation, fields jsonb, created_at)`
- `external_events (business_id, event_id, system_id, source, event_type, item_hash, fields jsonb, created_at, curated_at)`, UNIQUE `(business_id, system_id, item_hash)`
- `external_calls (business_id, system_id, at, outcome)` — content-free
- `external_system_state (business_id, system_id, last_scan_at, rejected_hooks int, last_rejected_at)`
- column `business_runtime_settings.external_curation_per_day int NULL`

All tables get RLS `FORCE` with the standard policy.

- [ ] **Step 1:** Failing tests in `store.test.ts`, through `withBusiness(TEST_BUSINESS, …)`:
  - `insertEvent` with a repeated `item_hash` returns false and keeps one row
  - `countCallsToday` counts from local midnight of the given zone, not UTC
  - a row written for business A is invisible to B
- [ ] **Step 2:** `npm run migrate:test` on the dedicated DB, then run the test. Expected: FAIL.
- [ ] **Step 3:** Write the migration and the store (`interface XRow` + `toX` convention).
- [ ] **Step 4:** Run `store.test.ts` and `src/tenancy/rls.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): migration 077 — drafts, reads, events, call log`

### Task 3: Classification — `ext.read`/`ext.call` and the signed class

**Files:**
- Create: `src/policy/external-class.ts`, `src/policy/external-class.test.ts`
- Modify:
  - `src/policy/classify.ts`: add `TOOL_ACTION_CLASS` entries `ext.read: 'external.read'` and `ext.call: 'external.delete'` (a placeholder, the strictest), add both to `OUTBOUND_TOOLS`, and set `ingestsExternalContent` to `ext.read: true` and `ext.call: false`
  - `src/domain/charter.ts` (`KNOWN_TOOL_NAMES`)
  - `src/charter/capabilities.ts` (`ops.systems` allowlist)
  - `src/policy/engine.ts` (stage 3)
  - `src/orchestrator/run-plan.ts` (`classifyStep`, `targetIdOf`)
  - `src/orchestrator/channels.ts` (target of `ext.*` = `input.system`)
  - `src/policy/positive-controls.test.ts`

**Interfaces:**
- Produces:
  - `resolveExternalCall(systems: readonly ExternalSystem[], toolName: string, input: Record<string, unknown>) → { ok: true; system: ExternalSystem; op: ExternalOperation; actionClass: ActionClass } | { ok: false; reason: string }`
  - It reads own keys `system` and `operation`. `ext.read` accepts only `kind:'read'`; `ext.call` accepts only `change|delete|money`.
  - New deny code `DENY_CODES.externalOperationUnknown = 'external_operation_unknown'`.

- [ ] **Step 1:** Failing tests:
  - **Resolution:**
    - `resolveExternalCall` for each kind returns the signed class
    - an unknown system, an unknown op, an op name `constructor` or `__proto__`, or a kind/tool mismatch → `ok:false`
  - **Gate** (`engine` test with a bundle holding `crmFixture()`):
    - an `ext.call` naming an unknown op is denied with `external_operation_unknown` and writes no `audit_log` row
    - an `ext.call` on a `change` op under dial `off`, with no confirmed command, is denied at stage 8 with an `intent_to_act` row and `facts.actionClass === 'crm.write'`
    - the same call under a confirmed boss command is allowed, with the `confirmed_command_exemption` marker
  - **Plan:** `classifyStep` and the gate agree on every op in the fixture (one loop asserting equality).
  - **Positive controls:** `ext.read`/`ext.call` are in `OUTBOUND_TOOLS`, not in `READ_ONLY_TOOLS`, and in `KNOWN_TOOL_NAMES`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In the engine, directly after the stage-3 allowlist checks and before `buildFacts`: for `ext.*`, call `resolveExternalCall(ctx.bundle.externalSystems, …)`, deny on `ok:false`, and otherwise overwrite `facts.actionClass` with the signed class right after `buildFacts`. Same comment style as the delegation check.
  - `classifyStep` uses the same function with the run's bundle.
- [ ] **Step 4:** Run the tests above plus `src/policy src/charter src/orchestrator/run-plan.test.ts`. Expected: PASS.
- [ ] **Step 5:** Run `/security-review` on the diff and fix findings with confidence ≥8.
- [ ] **Step 6: Commit** `feat(policy): ext.read/ext.call classified from the signed operation`

### Task 4: Request builder

**Files:**
- Create: `src/external/request.ts`, `src/external/request.test.ts`

**Interfaces:**
- Produces:
  - `buildExternalRequest(system, op, input: { params?: Record<string, unknown>; amountMinor?: number }, idempotencyKey: string) → { ok: true; method; url: URL; headers: Record<string,string>; body: string | null } | { ok: false; code: 'bad_params'; message: string }`
  - Headers exclude auth, which Task 6 adds.
  - `MAJOR_DIVISOR = 100`.

- [ ] **Step 1:** Failing tests:
  - **Path encoding:**
    - `{id}` with `'../admin?x=1#y'` yields the path `/customers/..%2Fadmin%3Fx%3D1%23y`
    - the URL's origin always equals `baseUrl`'s origin
  - **Required and unknown params:** a missing required param, a param not declared by the op, or a non-scalar path/query value → `bad_params`
  - **Money:**
    - `amountMinor: 12345`, unit `major` → body JSON has `amount: 123.45`
    - unit `minor` → `12345`
    - a money op without `amountMinor`, or with `params.amount` present → `bad_params`
  - **Other:**
    - `GET` puts `in:'body'` params nowhere and refuses them
    - `bodyEncoding: 'form'` sends `application/x-www-form-urlencoded`, the amount as a string (`123.45`), and refuses an object or array value
    - the idempotency header is set only when `idempotencyHeader` is non-null
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Each path value goes through `encodeURIComponent`. Query values use `URLSearchParams`. The body is `JSON.stringify` of the body params plus the amount field, or `URLSearchParams` of them when `bodyEncoding` is `'form'`, with the matching `Content-Type`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): request builder — encoded segments, declared params, one amount`

### Task 5: Guarded HTTPS client

**Files:**
- Create: `src/external/http.ts`, `src/external/address-guard.ts`, `src/external/address-guard.test.ts`, `src/external/http.test.ts`

**Interfaces:**
- Produces:
  - `isForbiddenAddress(ip: string) → boolean`
  - `ExternalHttp` interface: `send(req: { method; url: URL; headers; body: string|null; deadlineMs: number; maxBytes: number }) → Promise<{ kind: 'response'; status: number; body: string } | { kind: 'refused_address' } | { kind: 'too_large' } | { kind: 'network'; sent: boolean } | { kind: 'timeout'; sent: boolean }>`
  - `createGuardedHttps(): ExternalHttp`
  - Constants `EXTERNAL_DEADLINE_MS = 30_000`, `EXTERNAL_MAX_BYTES = 1_048_576`.

- [ ] **Step 1:** Failing tests.
  - **Forbidden addresses:** `isForbiddenAddress` is true for:
    - `127.0.0.1`, `10.1.2.3`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`
    - `::1`, `fe80::1`, `fd00::1`, `::ffff:10.0.0.1`, `ff02::1`
  - **Allowed addresses:** false for `8.8.8.8` and `2001:4860:4860::8888`.
  - **HTTP client:** run against a local `https.createServer` with a self-signed cert, injected through a test-only `tls` option.
    - Connecting to it through a hostname that resolves to 127.0.0.1 returns `refused_address`. This proves the guard runs inside `lookup`.
    - With the guard injected as permissive (test seam), it returns `response`.
    - A 302 is returned as a `response` with status 302 and is not followed.
    - A body over `maxBytes` returns `too_large`.
    - A server that never answers returns `timeout` with `sent: true`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** with `https.request(url, { lookup: guardedLookup, … })`.
  - `guardedLookup` calls `dns.lookup(host, { all: true })` and refuses if **any** address is forbidden.
  - The deadline is enforced by a race plus `req.destroy()`, not by `AbortSignal` alone.
  - `sent` becomes true once the request finishes writing.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): guarded https — post-DNS address check, no redirects, caps`

### Task 6: The external API adapter and its registration

**Files:**
- Create: `src/orchestrator/adapters/external.ts`, `src/orchestrator/adapters/external.test.ts`, `src/external/extract.ts`, `src/external/extract.test.ts`
- Modify:
  - `src/orchestrator/runtime.ts`: in `businessRuntime`, register one adapter per signed system from the active charter, and upsert nothing
  - `src/orchestrator/execute.ts`: on a successful `ext.read`, call `recordExternalRead` in the same transaction as the step completion
  - `src/config.ts` + `.env.example`: `EXTERNAL_CALLS_PER_DAY`, default 200

**Interfaces:**
- Consumes:
  - `buildExternalRequest` (Task 4)
  - `ExternalHttp` (Task 5)
  - `countCallsToday`/`recordCall`/`recordExternalRead` (Task 2)
  - `resolveExternalCall` (Task 3)
- Produces:
  - `extractFields(json: unknown, fields: readonly ExternalField[]) → {label: string; value: string}[]`. Each value goes through `stripBidiControls` and `toOneLine`, is cut at 500 characters, and is omitted when the path is missing.
  - `createExternalAdapter(system, deps: { http: ExternalHttp; callsToday: (systemId) => Promise<number>; recordCall: (...) => Promise<void>; capPerDay: number }) → ExternalAdapter`
  - The adapter has `system: 'ext:'+id`, `channel: 'api'`, and `serves: ['ext.call','ext.read']`.
  - A successful result is `output: { fields }` with `externalId` taken from `idPath`.

Outcome table (codes are mapped to Hebrew in `FAILURE_REASON_HE`):
- no credential → `credential_unavailable`, final
- cap reached → `external_daily_cap`, retryable
- `bad_params` → final
- `refused_address` → `external_address_refused`, final
- 2xx → ok
- 401/403 → `external_auth`, final
- read with 429/5xx → retryable
- write with 429/503 → retryable
- write with any other 5xx → `delivery_unknown`, final
- other 4xx → `external_rejected`, final
- timeout → `adapter_timeout`
- network error with `sent: false` → retryable
- network error with `sent: true` on a write → `delivery_unknown`

The adapter never puts provider text in `message`.

- [ ] **Step 1:** Failing tests with a stub `ExternalHttp`:
  - each row of the outcome table
  - the `Authorization` header is `Bearer <secret>`, `Basic base64(secret)` or the named header
  - the secret never appears in `message`, `output`, or `canonicalJson` of the result
  - `extractFields` on nested paths and arrays (`items.0.name`)
  - an `ext.read` step that completes writes one `external_reads` row whose `fields` equal the output
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `recordCall` runs for every attempt that reached `http.send`.
- [ ] **Step 4:** Run, plus `src/orchestrator`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): adapter — auth from vault, outcome table, declared fields only`

### Task 7: The confirmation echo and the planner catalogue

**Files:**
- Modify: `src/orchestrator/command-echo.ts` (`renderStepEcho` gains a required `systems: readonly ExternalSystem[]`, and both callers pass `bundle.externalSystems`), `src/orchestrator/catalogue.ts`, `src/sdk/planner.ts`, and their tests

**Interfaces:**
- Produces: `renderExternalCatalogue(systems) → string`. This is a sorted, timestamp-free section listing for each system its id and label, and for each op its name, label, kind, Hebrew class label, tool (`ext.read`/`ext.call`) and params with `required`. It is rendered in the planner prompt right after the capability catalogue.

- [ ] **Step 1:** Failing tests.
  - An `ext.call` step is echoed with:
    - the op's Hebrew label and the Hebrew class label
    - the line `שיטה וכתובת: POST https://api.example.com/customers/42` (the exact URL `buildExternalRequest` would produce)
    - every param on its own line
    - `סכום` through `formatMinor` in the charter currency
  - A step whose request fails to build is refused at plan time with the builder's Hebrew message. It is not echoed partially.
  - `renderExternalCatalogue` is byte-identical across two calls.
  - The planner prompt places it before the intents or instruction section.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `planAndCheck` (`instruct.ts`) runs `buildExternalRequest` on every `ext.*` step and rejects the plan on `ok:false`, the same way ledger steps are pre-checked.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): echo shows the exact request; planner sees signed operations`

### Task 8: Reporting what a read returned

**Files:**
- Modify: `src/orchestrator/whatsapp-report.ts`, `src/dashboard/views.ts` (instruction result), and their tests

**Interfaces:**
- Consumes: `loadReadsForJob` (Task 2)
- Produces: `renderReadsForOwner(reads: ReadRow[]) → string`. This is Hebrew: one block per read, headed `מ<label המערכת> — <label הפעולה>:`, then `label: value` lines, with at most 40 lines in all and a final line saying how many were cut.

- [ ] **Step 1:** Failing tests:
  - A closed boss-command job with one `ext.read` reports `בוצע לפי אישורך.` followed by the rendered fields.
  - A value carrying U+202E is shown stripped.
  - A job with no reads is unchanged byte for byte.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(external): the owner sees what a read returned`

### Task 9: Admin panel — drafts and secrets

**Files:**
- Create: `src/admin/external-routes.ts`, `src/admin/external-routes.test.ts`
- Modify: `src/admin/server.ts` (routes), `src/admin/business-routes.ts` (replace the "ייבנה בשלב הבא" placeholder with a link and a status list), `src/tenancy/activity-log.ts` (`external_draft_saved`, `external_draft_deleted`, `external_secret_saved`), `src/tenancy/panel-reads.ts` (status per system: `טיוטה` / `ממתין לחתימה` / `חתום` / `שינויים לא חתומים`, plus `סוד ✓/חסר` and `חתימת התראות ✓/חסר`), `src/tenancy/panel-reads-invariants.test.ts`

**Interfaces:**
- Produces these routes:
  - `GET /businesses/:id/external`
  - `GET /businesses/:id/external/:system`, a textarea with the draft JSON or a blank template, plus a Hebrew preview
  - `POST …/save`, `POST …/delete`
  - `POST …/secret`, with fields `kind=key|hook|verify` and `value`. It writes `putSecret` under `externalSecretRefs(id)` and never echoes the value back.

- [ ] **Step 1:** Failing tests:
  - Invalid JSON, or JSON failing `ExternalSystem`, re-renders with the Hebrew zod path messages and writes nothing.
  - A valid save writes the draft and one `platform_activity_log` row whose `detail` holds only the op count and a flag. A test asserts the definition text is absent.
  - Saving the secret stores it, and the page shows `✓ שמור` and never the value.
  - The status for a definition equal to the signed one is `חתום`, and for a different one `שינויים לא חתומים`.
  - A probe string placed in an `external_events` row is never returned by any panel read (extend the existing PROBE sweep).
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(admin): external system drafts and secrets`

### Task 10: The owner signs, changes and removes a system

**Files:**
- Create: `src/charter/amend-external.ts`, `src/charter/amend-external.test.ts`, `src/dashboard/external-connect.ts`, `src/dashboard/external-connect.test.ts`
- Modify: `src/dashboard/server.ts` (routes under `/connections/external`), the connections page (link)

**Interfaces:**
- Produces:
  - `buildExternalAmendment(active, def, now) → UnsignedCharter`. It adds or replaces the system and its `ext:<id>` connection. Every other field is copied verbatim.
  - `buildExternalRemoval(active, systemId, now)`
  - `describeExternalSystem(def, currency) → string[]`: Hebrew sentences, one per op, of the form `העוזרת תוכל: <label> (<תווית סוג>)`, with money ops adding `— רק אחרי "כן" שלך` and webhook/scan lines appended.
  - Routes:
    - `GET /connections/external`
    - `GET /connections/external/:system/sign` (the shown definition hash in a hidden field)
    - `POST …/sign`, which rebuilds from the stored draft, compares the hash, then `installSigned` + `upsertBinding({ system: 'ext:'+id, status: 'live', credentialRef: EXT_<ID>_KEY, endpoint: null, provider: null })` in one transaction, then `deleteDraft`
    - `POST …/remove`

- [ ] **Step 1:** Failing tests:
  - **Amendment:** the amendment copies every non-connection field byte-for-byte.
  - **Signing:**
    - Signing with a stale `base` returns 409 and installs nothing.
    - A draft edited between showing and posting (hash mismatch) re-renders the new preview and signs nothing.
    - After signing, `resolveChannel(bundle, bindings, 'ext.call', id)` resolves.
  - **Removal:** the system can no longer be resolved, and its secrets are left in place (stated on the page).
  - **The gate before signing:** a definition that exists only as a draft makes the gate deny `ext.call` with `external_operation_unknown`.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(external): owner signs, changes and removes an external system`

### Task 11: Webhook receiver

**Files:**
- Create: `src/external/webhook.ts`, `src/external/webhook.test.ts`
- Modify: `src/dashboard/server.ts` (route before the session and no-charter gates)

**Interfaces:**
- Produces: `handleExternalWebhook(req, res, deps: { secrets; now })`. It reads the raw body with a 256 KB cap (`readBoundedBody`, 413 past it).
  - **Request checks:**
    1. The business must be registered and active (`resolveBusinessForHook`, a new **named** read in `src/tenancy/platform.ts`, added to the closed list in CLAUDE.md).
    2. In `withBusiness`, the system must be in the active charter with `webhook !== null`.
    3. `EXT_<ID>_HOOK` must resolve.
    4. Signature check: either an HMAC-SHA256 over the signed payload (the template filled with the timestamp and the raw body bytes), compared in constant time after stripping the prefix or reading the kv value, or a shared-secret header compared with `timingSafeEqual`. A timestamp outside ±300 s is a failure.
    5. Handshake: a `query_challenge` GET is answered (200, `text/plain`, `nosniff`) only when the mode matches and the token equals `EXT_<ID>_VERIFY` in constant time. A `body_challenge` POST is answered only after step 4 passed and `body[typePath] === typeValue`. Either way the challenge must match `^[A-Za-z0-9._-]{1,200}# Stage D — External Systems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician defines a generic HTTPS API connection for a business in the admin panel, the owner signs it into the charter, and from then on the assistant reads from and acts on that system **only on a confirmed boss command**, learns from its webhooks and daily scan, and reports back — without any new gate exemption.

**Architecture:** An external system is a signed charter object (`externalSystems[]`) plus one ordinary `CharterConnection` per system whose `target` is the system id, so channel resolution and bindings work unchanged. Two new tools, `ext.read` and `ext.call`, owned by `ops.systems`, both classified and outbound; the action class of a call is read from the **signed operation**, never from the payload or the model. Inbound data (webhooks, scans, reads) is reduced deterministically to the response fields the definition declares, stored as `unknown_external`, summarised without a model, and curated as chunks only.

**Tech Stack:** TypeScript (NodeNext, ESM), zod 4, pg + RLS, vitest on real Postgres, `node:https` (no new dependency).

**Spec:** [docs/superpowers/specs/2026-11-13-external-systems-design.md](../specs/2026-11-13-external-systems-design.md) — including the owner's answers of 13/11, which win over everything above them in that file.

## Global Constraints

- `src/policy/engine.ts` gets **no new exemption**. The only change there is the stage-3 resolution in Task 3, and it goes through `/security-review`.
- Every external action runs only under `confirmedCommandCovers` (boss command + one "כן"). No conductor, scan or webhook path ever creates a job with an `ext.*` step.
- Money operations: kind `money` → class `payment.make` or `refund.issue` only. Never runs without an explicit boss "כן", in any mode.
- Address, method, path and class come from the signed definition. The model fills only `params` (and `amountMinor` for money), and all of them appear in full in the confirmation question.
- HTTPS only. Refuse private, loopback, link-local, CGNAT, ULA, multicast, unspecified and cloud-metadata addresses **after DNS resolution**, on the socket that is actually used. Never follow redirects.
- Secrets live only in the business vault (`putSecret`) under `EXT_<ID>_KEY` and `EXT_<ID>_HOOK` (`<ID>` = system id upper-cased). They never appear in the definition, the charter, a prompt, a log, an audit row, the panel or the dashboard.
- Everything read from outside is `unknown_external`. Memory writes from it are `chunk` only, never retire.
- No row in `src/policy/` reads anything from an external response (amounts included) — same rule as `findings`.
- `CURRENT_SCHEMA_VERSION` → `'1.4'`; every signed charter must be re-signed. That is expected, not a bug.
- Hebrew for the owner and the technician, English for code; owner-facing class names only through `src/domain/labels.ts`.
- New tables: `business_id`, RLS `FORCE`, the standard `app_business_id()` policy, created in their migration.
- Every built-but-unrun live check goes into `docs/11-pre-launch-checks.md`.

## Rulings made while planning (⚙ — mine, not the owner's)

1. The technician pastes the definition as **JSON in a textarea**, validated by zod with Hebrew errors and a Hebrew preview. A dynamic form for N operations is a lot of UI for no extra safety; JSON is the flexibility the owner asked for. *Cost if wrong:* a form later; the schema stays.
2. A **read also asks one "כן"**. Under the default dial `off` the ramp holds `external.read` at `draft_only`, so the confirmed command is the only path that can run a read at all. *Cost:* one extra word per lookup.
3. **Responses are reduced deterministically:** each operation and event type declares up to 20 `fields` (JSON path + Hebrew label), and only those are stored, shown or curated. Nothing else from a response is kept. *Cost:* a technician must name fields; a missing field is invisible.
4. **The boss summary** of webhooks and scans is a section in the daily/weekly digest plus a `/systems` screen. No new message channel. *Cost:* an owner who leaves the digest `off` sees it only on the screen. This is stated on the screen and in docs/10.
5. **Write retries:** a write that got 429 or 503 back is retryable; any other 5xx, a socket error after the request was sent, or a timeout is `delivery_unknown`/`adapter_timeout`, final, and not re-sent blindly. Reads retry on any 429/5xx.
6. **Money units:** only ILS, USD, EUR and GBP (two decimals). The currency must equal the charter's. `unit: 'major'` sends `amountMinor / 100` as a JSON number.
7. **Signing without the secret is allowed.** The status shows "חסר סוד", and a call fails `credential_unavailable` until it is stored.
9. **The daily scan is a documented gate bypass** (it joins the short list: mail labelling, the curator, erasure, calendar holds). The spec wants a scan, and through the gate under `off` it would read nothing. What holds it instead: it can only run the one `read` operation the owner signed as `scan`, at the signed interval, through the same request builder, address guard and daily cap, and what it reads only teaches. *Cost if wrong:* a signed scan reads data the owner did not expect. Mitigation: the sign page says it in words.
10. **Three additions so more real systems fit (owner, 18/11):** a webhook signature with a prefix and/or a timestamp (Stripe, GitHub, Slack), a form-encoded request body, and the first-time verification handshake (Meta, Slack). None of them loosens anything: the signature is still over the raw bytes with a vault secret, a timestamp adds replay protection (±300 s), and a handshake answer is echoed only after the token or signature check, as plain text, at most 200 characters from `[A-Za-z0-9._-]`. *Still out:* OAuth, XML/SOAP, paginated scans, AWS-style request signing.
8. **The webhook endpoint** lives on the dashboard server (behind the proxy) at `POST /hooks/ext/<businessId>/<systemId>`, with no session and verification by secret. Unknown event types are counted and dropped.

## Review Focus

1. **A parameter value carrying `../`, `?`, `#` or `%2F`** must not change the path. Each value is encoded as a single path segment; a template placeholder with no matching param is a refusal, not an empty segment.
2. **A DNS name that resolves to `127.0.0.1`, `169.254.169.254`, `::ffff:10.0.0.1` or `fd00::1`**, or that rebinds between lookup and connect, must be refused. The check runs inside the socket's own `lookup`.
3. **A plan step naming an operation that the signed definition lists under the other tool** (a `money` op under `ext.read`, a `read` op under `ext.call`), an unknown system, or an unknown operation is denied at stage 3 and never classified as something gentler.
4. **A webhook whose body is valid JSON but whose signature was computed over different bytes** (re-serialised, whitespace changed) is refused. The HMAC is over the raw bytes.
5. **A money call whose `params` also carries the amount field** (two amounts: one shown, one sent) is refused, so the amount the owner saw is the only one that can reach the provider.

---

### Task 1: Charter schema 1.4 — external systems and two new classes

**Files:**
- Create: `src/domain/external-system.ts`, `src/domain/external-system.test.ts`
- Modify: `src/domain/action.ts` (enum, `NEVER_FULLY_AUTONOMOUS_TABLE`, addressee table), `src/domain/charter.ts` (field, pairing refine, version `'1.4'` with docblock line), `src/domain/labels.ts`, `src/charter/schema-version.test.ts`, `src/charter/interview/build.ts` (autonomy base for the two classes), `src/test/fixtures.ts`, `src/charter/compile.ts` + `src/domain/policy.ts` (carry `externalSystems` into the bundle)

**Interfaces:**
- Produces:
  - `ExternalSystem` (zod + type), `ExternalOperation`, `ExternalField`, `OperationKind = 'read'|'change'|'delete'|'money'`
  - `EXTERNAL_SYSTEM_ID = /^[a-z][a-z0-9_]{1,30}$/`
  - `externalSecretRefs(id) → { key: string; hook: string; verify: string }`, giving `EXT_<ID>_KEY`/`EXT_<ID>_HOOK`/`EXT_<ID>_VERIFY` (the last only for a `query_challenge` handshake, whose verify token is not the signing secret)
  - `CHANGE_CLASSES = ['crm.write','accounting.write','quote.issue','commitment.make','data.export'] as const`
  - `MONEY_CLASSES = ['payment.make','refund.issue'] as const`
  - `PolicyBundle.externalSystems: ExternalSystem[]`

`ExternalSystem` shape:
- `{ id, label (Hebrew), baseUrl, auth, idempotencyHeader, operations, webhook, scan }`
- `baseUrl`: `https:` only, no credentials, query or fragment.
- `auth`: `{ kind: 'header', header } | { kind: 'bearer' } | { kind: 'basic' }`.
- `idempotencyHeader`: a header name, or null.
- `operations`: 1–50 items. Each is `{ name, label, kind, actionClass, method, path, params, fields, idPath, amount }`, where:
  - `name`: `/^[a-z][a-z0-9_]{1,40}$/`.
  - `path`: starts with `/`, and placeholders are `{param}`.
  - `params`: a list of `{ name, in: 'path'|'query'|'body', required }`.
  - `bodyEncoding`: `'json'` (default) or `'form'`.
  - `fields`: ≤20 `{ path: dotted, label }`.
  - `idPath`: a field path, or null.
  - `amount`: `{ field, unit: 'minor'|'major', currency }` or null.
- `webhook`: `{ scheme, typePath, events: [{ type, label, fields }], handshake }` or null, where:
  - `scheme` is `{ kind: 'shared-secret', header }` or `{ kind: 'hmac-sha256', encoding: 'hex'|'base64', signature, signedPayload, timestamp }`:
    - `signature`: `{ from: 'header', header, prefix: string|null }` (GitHub: `X-Hub-Signature-256`, prefix `sha256=`) or `{ from: 'kv', header, key, separator }` (Stripe: `Stripe-Signature`, key `v1`, separator `,`; any one matching value is enough).
    - `signedPayload`: a template over `{timestamp}` and `{body}` only, containing `{body}` exactly once: `'{body}'` (default), `'{timestamp}.{body}'` (Stripe), `'v0:{timestamp}:{body}'` (Slack).
    - `timestamp`: null, `{ from: 'header', header }` (Slack) or `{ from: 'kv', key }` (Stripe `t`). It is required when the template uses `{timestamp}`, unix seconds, ±300 s from now.
  - `handshake`: null, `{ kind: 'query_challenge', modeParam, modeValue, tokenParam, challengeParam }` (Meta: `hub.mode`=`subscribe`, `hub.verify_token`, `hub.challenge`; GET; the token is compared with `EXT_<ID>_VERIFY`) or `{ kind: 'body_challenge', typeValue, challengePath }` (Slack `url_verification`; POST; after the signature check).
- `scan`: `{ operation, sinceParam: string|null, itemsPath: string|null, everyHours: 1..168 }` or null.

- [ ] **Step 1: Write failing tests** in `external-system.test.ts`:
  - **Kind and class (refused):**
    - `kind:'read'` with a class other than `external.read`
    - `kind:'delete'` with a class other than `external.delete`
    - `kind:'change'` with a class outside `CHANGE_CLASSES`
    - `kind:'money'` with `purchase.place`
  - **Money rules (refused):** a `money` op without `amount`; an `amount.currency` not in `['ILS','USD','EUR','GBP']`; an amount `field` that is also in `params`.
  - **Base URL (refused):** `http://…`, `https://u:p@h`, `https://h/?q=1`.
  - **Path and parameters:**
    - refused: a path placeholder with no `in:'path'` param; an `in:'path'` param with no placeholder; duplicate op names
    - refused: a `scan.operation` that is not a `read` op; a `webhook.events` type listed twice
    - accepted: the reference fixture `crmFixture()` (exported from the test file's sibling `src/test/external-fixtures.ts`)
  - **Charter pairing:** in `charter.test.ts`, every `externalSystems[i]` needs exactly one connection with `system === 'ext:'+id`, `serves` exactly `['ext.call','ext.read']`, `target === id` and `channel: 'api'`, and every connection whose system starts with `ext:` needs its definition. Each half is broken by one test.
  - **Charter currency:** a money op whose currency differs from `money.currency` is refused at parse, with a Hebrew message.
- [ ] **Step 2: Run** `npx vitest run src/domain/external-system.test.ts src/domain/charter.test.ts src/charter/schema-version.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `external.read` (addressee `internal`, never-fully `false`) and `external.delete` (`internal`, `true`).
  - Hebrew labels: "קריאה ממערכת חיצונית", "מחיקה במערכת חיצונית".
  - Interview defaults: `external.read` → `auto`, `external.delete` → `approve_required`.
  - Update the frozen enum list in `schema-version.test.ts`, bump to `'1.4'` with one docblock paragraph, and carry `externalSystems` (default `[]`) through `compileCharter`.
- [ ] **Step 4: Run** the same tests plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(charter): schema 1.4 — external systems and external.read/external.delete`

### Task 2: Migration 077 and stores

**Files:**
- Create: `src/db/migrations/077_external_systems.sql`, `src/external/store.ts`, `src/external/store.test.ts`
- Modify: `src/tenancy/rls.test.ts` (only if its expected-table count is pinned)

**Interfaces:**
- Produces, in `src/external/store.ts`:
  - `saveDraft(db, {systemId, definition, staffId}) → void` (upsert)
  - `loadDrafts(db) → DraftRow[]`
  - `deleteDraft(db, systemId)`
  - `recordExternalRead(db, {jobId, stepId, systemId, operation, fields}) → void`
  - `loadReadsForJob(db, jobId) → ReadRow[]`
  - `insertEvent(db, {systemId, source:'webhook'|'scan', eventType, itemHash, fields}) → boolean` (false on duplicate)
  - `newEventsSince(db, cursor) → EventRow[]`
  - `markEventsCurated(db, ids)`
  - `countCallsToday(db, systemId, timeZone) → number`
  - `recordCall(db, {systemId, outcome})`
  - `recordRejectedHook(db, systemId, reason)`
  - `lastScanAt(db, systemId)` / `setLastScanAt(db, systemId, at)`
  - Here `fields: {label: string; value: string}[]`.

Tables:
- `external_system_drafts (business_id, system_id, definition jsonb, updated_at, updated_by_staff text)`, PK `(business_id, system_id)`
- `external_reads (business_id, read_id, job_id, step_id, system_id, operation, fields jsonb, created_at)`
- `external_events (business_id, event_id, system_id, source, event_type, item_hash, fields jsonb, created_at, curated_at)`, UNIQUE `(business_id, system_id, item_hash)`
- `external_calls (business_id, system_id, at, outcome)` — content-free
- `external_system_state (business_id, system_id, last_scan_at, rejected_hooks int, last_rejected_at)`
- column `business_runtime_settings.external_curation_per_day int NULL`

All tables get RLS `FORCE` with the standard policy.

- [ ] **Step 1:** Failing tests in `store.test.ts`, through `withBusiness(TEST_BUSINESS, …)`:
  - `insertEvent` with a repeated `item_hash` returns false and keeps one row
  - `countCallsToday` counts from local midnight of the given zone, not UTC
  - a row written for business A is invisible to B
- [ ] **Step 2:** `npm run migrate:test` on the dedicated DB, then run the test. Expected: FAIL.
- [ ] **Step 3:** Write the migration and the store (`interface XRow` + `toX` convention).
- [ ] **Step 4:** Run `store.test.ts` and `src/tenancy/rls.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): migration 077 — drafts, reads, events, call log`

### Task 3: Classification — `ext.read`/`ext.call` and the signed class

**Files:**
- Create: `src/policy/external-class.ts`, `src/policy/external-class.test.ts`
- Modify:
  - `src/policy/classify.ts`: add `TOOL_ACTION_CLASS` entries `ext.read: 'external.read'` and `ext.call: 'external.delete'` (a placeholder, the strictest), add both to `OUTBOUND_TOOLS`, and set `ingestsExternalContent` to `ext.read: true` and `ext.call: false`
  - `src/domain/charter.ts` (`KNOWN_TOOL_NAMES`)
  - `src/charter/capabilities.ts` (`ops.systems` allowlist)
  - `src/policy/engine.ts` (stage 3)
  - `src/orchestrator/run-plan.ts` (`classifyStep`, `targetIdOf`)
  - `src/orchestrator/channels.ts` (target of `ext.*` = `input.system`)
  - `src/policy/positive-controls.test.ts`

**Interfaces:**
- Produces:
  - `resolveExternalCall(systems: readonly ExternalSystem[], toolName: string, input: Record<string, unknown>) → { ok: true; system: ExternalSystem; op: ExternalOperation; actionClass: ActionClass } | { ok: false; reason: string }`
  - It reads own keys `system` and `operation`. `ext.read` accepts only `kind:'read'`; `ext.call` accepts only `change|delete|money`.
  - New deny code `DENY_CODES.externalOperationUnknown = 'external_operation_unknown'`.

- [ ] **Step 1:** Failing tests:
  - **Resolution:**
    - `resolveExternalCall` for each kind returns the signed class
    - an unknown system, an unknown op, an op name `constructor` or `__proto__`, or a kind/tool mismatch → `ok:false`
  - **Gate** (`engine` test with a bundle holding `crmFixture()`):
    - an `ext.call` naming an unknown op is denied with `external_operation_unknown` and writes no `audit_log` row
    - an `ext.call` on a `change` op under dial `off`, with no confirmed command, is denied at stage 8 with an `intent_to_act` row and `facts.actionClass === 'crm.write'`
    - the same call under a confirmed boss command is allowed, with the `confirmed_command_exemption` marker
  - **Plan:** `classifyStep` and the gate agree on every op in the fixture (one loop asserting equality).
  - **Positive controls:** `ext.read`/`ext.call` are in `OUTBOUND_TOOLS`, not in `READ_ONLY_TOOLS`, and in `KNOWN_TOOL_NAMES`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In the engine, directly after the stage-3 allowlist checks and before `buildFacts`: for `ext.*`, call `resolveExternalCall(ctx.bundle.externalSystems, …)`, deny on `ok:false`, and otherwise overwrite `facts.actionClass` with the signed class right after `buildFacts`. Same comment style as the delegation check.
  - `classifyStep` uses the same function with the run's bundle.
- [ ] **Step 4:** Run the tests above plus `src/policy src/charter src/orchestrator/run-plan.test.ts`. Expected: PASS.
- [ ] **Step 5:** Run `/security-review` on the diff and fix findings with confidence ≥8.
- [ ] **Step 6: Commit** `feat(policy): ext.read/ext.call classified from the signed operation`

### Task 4: Request builder

**Files:**
- Create: `src/external/request.ts`, `src/external/request.test.ts`

**Interfaces:**
- Produces:
  - `buildExternalRequest(system, op, input: { params?: Record<string, unknown>; amountMinor?: number }, idempotencyKey: string) → { ok: true; method; url: URL; headers: Record<string,string>; body: string | null } | { ok: false; code: 'bad_params'; message: string }`
  - Headers exclude auth, which Task 6 adds.
  - `MAJOR_DIVISOR = 100`.

- [ ] **Step 1:** Failing tests:
  - **Path encoding:**
    - `{id}` with `'../admin?x=1#y'` yields the path `/customers/..%2Fadmin%3Fx%3D1%23y`
    - the URL's origin always equals `baseUrl`'s origin
  - **Required and unknown params:** a missing required param, a param not declared by the op, or a non-scalar path/query value → `bad_params`
  - **Money:**
    - `amountMinor: 12345`, unit `major` → body JSON has `amount: 123.45`
    - unit `minor` → `12345`
    - a money op without `amountMinor`, or with `params.amount` present → `bad_params`
  - **Other:**
    - `GET` puts `in:'body'` params nowhere and refuses them
    - `bodyEncoding: 'form'` sends `application/x-www-form-urlencoded`, the amount as a string (`123.45`), and refuses an object or array value
    - the idempotency header is set only when `idempotencyHeader` is non-null
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Each path value goes through `encodeURIComponent`. Query values use `URLSearchParams`. The body is `JSON.stringify` of the body params plus the amount field, or `URLSearchParams` of them when `bodyEncoding` is `'form'`, with the matching `Content-Type`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): request builder — encoded segments, declared params, one amount`

### Task 5: Guarded HTTPS client

**Files:**
- Create: `src/external/http.ts`, `src/external/address-guard.ts`, `src/external/address-guard.test.ts`, `src/external/http.test.ts`

**Interfaces:**
- Produces:
  - `isForbiddenAddress(ip: string) → boolean`
  - `ExternalHttp` interface: `send(req: { method; url: URL; headers; body: string|null; deadlineMs: number; maxBytes: number }) → Promise<{ kind: 'response'; status: number; body: string } | { kind: 'refused_address' } | { kind: 'too_large' } | { kind: 'network'; sent: boolean } | { kind: 'timeout'; sent: boolean }>`
  - `createGuardedHttps(): ExternalHttp`
  - Constants `EXTERNAL_DEADLINE_MS = 30_000`, `EXTERNAL_MAX_BYTES = 1_048_576`.

- [ ] **Step 1:** Failing tests.
  - **Forbidden addresses:** `isForbiddenAddress` is true for:
    - `127.0.0.1`, `10.1.2.3`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`
    - `::1`, `fe80::1`, `fd00::1`, `::ffff:10.0.0.1`, `ff02::1`
  - **Allowed addresses:** false for `8.8.8.8` and `2001:4860:4860::8888`.
  - **HTTP client:** run against a local `https.createServer` with a self-signed cert, injected through a test-only `tls` option.
    - Connecting to it through a hostname that resolves to 127.0.0.1 returns `refused_address`. This proves the guard runs inside `lookup`.
    - With the guard injected as permissive (test seam), it returns `response`.
    - A 302 is returned as a `response` with status 302 and is not followed.
    - A body over `maxBytes` returns `too_large`.
    - A server that never answers returns `timeout` with `sent: true`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** with `https.request(url, { lookup: guardedLookup, … })`.
  - `guardedLookup` calls `dns.lookup(host, { all: true })` and refuses if **any** address is forbidden.
  - The deadline is enforced by a race plus `req.destroy()`, not by `AbortSignal` alone.
  - `sent` becomes true once the request finishes writing.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): guarded https — post-DNS address check, no redirects, caps`

### Task 6: The external API adapter and its registration

**Files:**
- Create: `src/orchestrator/adapters/external.ts`, `src/orchestrator/adapters/external.test.ts`, `src/external/extract.ts`, `src/external/extract.test.ts`
- Modify:
  - `src/orchestrator/runtime.ts`: in `businessRuntime`, register one adapter per signed system from the active charter, and upsert nothing
  - `src/orchestrator/execute.ts`: on a successful `ext.read`, call `recordExternalRead` in the same transaction as the step completion
  - `src/config.ts` + `.env.example`: `EXTERNAL_CALLS_PER_DAY`, default 200

**Interfaces:**
- Consumes:
  - `buildExternalRequest` (Task 4)
  - `ExternalHttp` (Task 5)
  - `countCallsToday`/`recordCall`/`recordExternalRead` (Task 2)
  - `resolveExternalCall` (Task 3)
- Produces:
  - `extractFields(json: unknown, fields: readonly ExternalField[]) → {label: string; value: string}[]`. Each value goes through `stripBidiControls` and `toOneLine`, is cut at 500 characters, and is omitted when the path is missing.
  - `createExternalAdapter(system, deps: { http: ExternalHttp; callsToday: (systemId) => Promise<number>; recordCall: (...) => Promise<void>; capPerDay: number }) → ExternalAdapter`
  - The adapter has `system: 'ext:'+id`, `channel: 'api'`, and `serves: ['ext.call','ext.read']`.
  - A successful result is `output: { fields }` with `externalId` taken from `idPath`.

Outcome table (codes are mapped to Hebrew in `FAILURE_REASON_HE`):
- no credential → `credential_unavailable`, final
- cap reached → `external_daily_cap`, retryable
- `bad_params` → final
- `refused_address` → `external_address_refused`, final
- 2xx → ok
- 401/403 → `external_auth`, final
- read with 429/5xx → retryable
- write with 429/503 → retryable
- write with any other 5xx → `delivery_unknown`, final
- other 4xx → `external_rejected`, final
- timeout → `adapter_timeout`
- network error with `sent: false` → retryable
- network error with `sent: true` on a write → `delivery_unknown`

The adapter never puts provider text in `message`.

- [ ] **Step 1:** Failing tests with a stub `ExternalHttp`:
  - each row of the outcome table
  - the `Authorization` header is `Bearer <secret>`, `Basic base64(secret)` or the named header
  - the secret never appears in `message`, `output`, or `canonicalJson` of the result
  - `extractFields` on nested paths and arrays (`items.0.name`)
  - an `ext.read` step that completes writes one `external_reads` row whose `fields` equal the output
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `recordCall` runs for every attempt that reached `http.send`.
- [ ] **Step 4:** Run, plus `src/orchestrator`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): adapter — auth from vault, outcome table, declared fields only`

### Task 7: The confirmation echo and the planner catalogue

**Files:**
- Modify: `src/orchestrator/command-echo.ts` (`renderStepEcho` gains a required `systems: readonly ExternalSystem[]`, and both callers pass `bundle.externalSystems`), `src/orchestrator/catalogue.ts`, `src/sdk/planner.ts`, and their tests

**Interfaces:**
- Produces: `renderExternalCatalogue(systems) → string`. This is a sorted, timestamp-free section listing for each system its id and label, and for each op its name, label, kind, Hebrew class label, tool (`ext.read`/`ext.call`) and params with `required`. It is rendered in the planner prompt right after the capability catalogue.

- [ ] **Step 1:** Failing tests.
  - An `ext.call` step is echoed with:
    - the op's Hebrew label and the Hebrew class label
    - the line `שיטה וכתובת: POST https://api.example.com/customers/42` (the exact URL `buildExternalRequest` would produce)
    - every param on its own line
    - `סכום` through `formatMinor` in the charter currency
  - A step whose request fails to build is refused at plan time with the builder's Hebrew message. It is not echoed partially.
  - `renderExternalCatalogue` is byte-identical across two calls.
  - The planner prompt places it before the intents or instruction section.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `planAndCheck` (`instruct.ts`) runs `buildExternalRequest` on every `ext.*` step and rejects the plan on `ok:false`, the same way ledger steps are pre-checked.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(external): echo shows the exact request; planner sees signed operations`

### Task 8: Reporting what a read returned

**Files:**
- Modify: `src/orchestrator/whatsapp-report.ts`, `src/dashboard/views.ts` (instruction result), and their tests

**Interfaces:**
- Consumes: `loadReadsForJob` (Task 2)
- Produces: `renderReadsForOwner(reads: ReadRow[]) → string`. This is Hebrew: one block per read, headed `מ<label המערכת> — <label הפעולה>:`, then `label: value` lines, with at most 40 lines in all and a final line saying how many were cut.

- [ ] **Step 1:** Failing tests:
  - A closed boss-command job with one `ext.read` reports `בוצע לפי אישורך.` followed by the rendered fields.
  - A value carrying U+202E is shown stripped.
  - A job with no reads is unchanged byte for byte.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(external): the owner sees what a read returned`

### Task 9: Admin panel — drafts and secrets

**Files:**
- Create: `src/admin/external-routes.ts`, `src/admin/external-routes.test.ts`
- Modify: `src/admin/server.ts` (routes), `src/admin/business-routes.ts` (replace the "ייבנה בשלב הבא" placeholder with a link and a status list), `src/tenancy/activity-log.ts` (`external_draft_saved`, `external_draft_deleted`, `external_secret_saved`), `src/tenancy/panel-reads.ts` (status per system: `טיוטה` / `ממתין לחתימה` / `חתום` / `שינויים לא חתומים`, plus `סוד ✓/חסר` and `חתימת התראות ✓/חסר`), `src/tenancy/panel-reads-invariants.test.ts`

**Interfaces:**
- Produces these routes:
  - `GET /businesses/:id/external`
  - `GET /businesses/:id/external/:system`, a textarea with the draft JSON or a blank template, plus a Hebrew preview
  - `POST …/save`, `POST …/delete`
  - `POST …/secret`, with fields `kind=key|hook` and `value`. It writes `putSecret` under `externalSecretRefs(id)` and never echoes the value back.

- [ ] **Step 1:** Failing tests:
  - Invalid JSON, or JSON failing `ExternalSystem`, re-renders with the Hebrew zod path messages and writes nothing.
  - A valid save writes the draft and one `platform_activity_log` row whose `detail` holds only the op count and a flag. A test asserts the definition text is absent.
  - Saving the secret stores it, and the page shows `✓ שמור` and never the value.
  - The status for a definition equal to the signed one is `חתום`, and for a different one `שינויים לא חתומים`.
  - A probe string placed in an `external_events` row is never returned by any panel read (extend the existing PROBE sweep).
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(admin): external system drafts and secrets`

### Task 10: The owner signs, changes and removes a system

**Files:**
- Create: `src/charter/amend-external.ts`, `src/charter/amend-external.test.ts`, `src/dashboard/external-connect.ts`, `src/dashboard/external-connect.test.ts`
- Modify: `src/dashboard/server.ts` (routes under `/connections/external`), the connections page (link)

**Interfaces:**
- Produces:
  - `buildExternalAmendment(active, def, now) → UnsignedCharter`. It adds or replaces the system and its `ext:<id>` connection. Every other field is copied verbatim.
  - `buildExternalRemoval(active, systemId, now)`
  - `describeExternalSystem(def, currency) → string[]`: Hebrew sentences, one per op, of the form `העוזרת תוכל: <label> (<תווית סוג>)`, with money ops adding `— רק אחרי "כן" שלך` and webhook/scan lines appended.
  - Routes:
    - `GET /connections/external`
    - `GET /connections/external/:system/sign` (the shown definition hash in a hidden field)
    - `POST …/sign`, which rebuilds from the stored draft, compares the hash, then `installSigned` + `upsertBinding({ system: 'ext:'+id, status: 'live', credentialRef: EXT_<ID>_KEY, endpoint: null, provider: null })` in one transaction, then `deleteDraft`
    - `POST …/remove`

- [ ] **Step 1:** Failing tests:
  - **Amendment:** the amendment copies every non-connection field byte-for-byte.
  - **Signing:**
    - Signing with a stale `base` returns 409 and installs nothing.
    - A draft edited between showing and posting (hash mismatch) re-renders the new preview and signs nothing.
    - After signing, `resolveChannel(bundle, bindings, 'ext.call', id)` resolves.
  - **Removal:** the system can no longer be resolved, and its secrets are left in place (stated on the page).
  - **The gate before signing:** a definition that exists only as a draft makes the gate deny `ext.call` with `external_operation_unknown`.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(external): owner signs, changes and removes an external system`

### Task 11: Webhook receiver

**Files:**
- Create: `src/external/webhook.ts`, `src/external/webhook.test.ts`
- Modify: `src/dashboard/server.ts` (route before the session and no-charter gates)

**Interfaces:**
- Produces: `handleExternalWebhook(req, res, deps: { secrets; now })`. It reads the raw body with a 256 KB cap (`readBoundedBody`, 413 past it).
  - **Request checks:**
    1. The business must be registered and active (`resolveBusinessForHook`, a new **named** read in `src/tenancy/platform.ts`, added to the closed list in CLAUDE.md).
    2. In `withBusiness`, the system must be in the active charter with `webhook !== null`.
    3. `EXT_<ID>_HOOK` must resolve.
 or the answer is 401, and a handshake stores nothing.
  - **Responses:**
    - Any failure → 401 with an empty body, plus `recordRejectedHook`.
    - On success, the event type is read at `typePath`. An unknown type → 202 and counted.
    - A known type → `insertEvent(source:'webhook', fields: extractFields(...), itemHash: sha256 of canonical fields)`, then 202.
  - Nothing in the body ever chooses the business or the system.

- [ ] **Step 1:** Failing tests:
  - A valid HMAC returns 202 and stores one row with only the declared fields.
  - A Stripe-style header `t=…,v1=…` over `{timestamp}.{body}` passes; the same with `t` 301 s old → 401; two `v1` values of which one matches → passes.
  - A GitHub-style `sha256=<hex>` passes; the same hex without the prefix → 401.
  - A Meta GET with the right verify token returns exactly the challenge as `text/plain`; a wrong token, a challenge with `<`, or a challenge longer than 200 → 401; no row is written.
  - A Slack `url_verification` POST with a valid signature returns the challenge; without a valid signature → 401.
  - The same JSON re-serialised with the old signature → 401 (Review Focus 4).
  - A missing or short header → 401 without throwing.
  - A suspended business, an unknown business, or a system not in the charter → 401, and no row in any business.
  - A body over 256 KB → 413.
  - A repeated delivery stores one row.
  - The route needs no session and is reachable before a charter exists only for a business that has one (otherwise 401).
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5:** Run `/security-review` on the diff.
- [ ] **Step 6: Commit** `feat(external): signed webhook receiver`

### Task 12: Daily scan, curation and the owner summary

**Files:**
- Create: `src/external/scan.ts`, `src/external/scan.test.ts`, `src/external/learn.ts`, `src/external/learn.test.ts`, `src/dashboard/systems-view.ts`
- Modify:
  - `src/orchestrator/scheduler.ts`: add `scanExternalSystems`, then `learnFromExternalEvents`, after `pollMailbox`
  - `src/memory/curate.ts` + `src/memory/curation-brief.ts`: a new scope `'external'`, chunk-only like mail, with cap `externalCurationPerDay` (config `EXTERNAL_CURATION_PER_DAY`, default 20, overridable by the runtime column)
  - `src/orchestrator/digest-facts.ts` + `digest-render.ts`: a section "ממערכות חיצוניות"
  - `src/dashboard/server.ts`: `/systems`

**Interfaces:**
- Produces:
  - `scanExternalSystems(db, { http, now }) → { scanned: number; newItems: number; skipped: number }`
    - The scan runs the signed scan op through `createExternalAdapter`'s request path (same builder, same guard, same cap).
    - It is called directly, not as a job. It is a read with no boss command, so ⚙ it is authorised by the owner's signature on the `scan` block itself, and this is stated in docs/10 and on the sign page.
    - `sinceParam` = ISO `last_scan_at`. `itemsPath` splits a list into items. Each item becomes `insertEvent(source:'scan')`.
  - `learnFromExternalEvents(db, { curator }) → { jobs: number; curated: number }`
    - It takes uncurated events in groups of up to 20 per system.
    - It creates a job with `provenance: 'unknown_external'` as a literal.
    - It calls `curateJob(db, job, { scope: 'external' })` and marks the events curated.
  - The digest section is deterministic: counts per system and event type, and the last 5 items' first field. It is in the digest's BFS import walk, so it imports nothing under `src/sdk/`.

- [ ] **Step 1:** Failing tests:
  - **Scan:**
    - A scan runs only when `everyHours` have passed.
    - A scan whose response is unchanged inserts nothing.
    - A scan blocked by the address guard inserts nothing and records the call.
  - **Learning:** a curation job is `unknown_external` and writes only `chunk` rows. A test seeds an entity and asserts it is not retired.
  - **Policy isolation:** `src/policy/` imports nothing under `src/external/`, checked with a BFS walk in the style of `description-invariants.test.ts`.
  - **Summary:** the digest renders the section and `hadContent` turns on with new events.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(external): daily scan, chunk-only learning, owner summary`

### Task 13: Erasure

**Files:**
- Modify: `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `src/governance/erasure-plan.test.ts`, `src/dashboard/erasure views` (preview line)

**Interfaces:**
- Produces:
  - `EXTERNAL_READS_ERASED_PREDICATE` and `EXTERNAL_EVENTS_ERASED_PREDICATE`, exported once and shared by `countItems` and the executor.
  - Both tables are discovery sources through `jsonbContentMatches` on `fields`. `external_reads` also deletes by `job_id`.
  - `ErasurePlan.externalSystemsKept: string[]`: the labels of systems with a matched row. It is shown as "נשארים במערכת <label>" and included in `planFingerprint`, sorted.
  - The deletion list grows from 36 to 38 tables. `external_system_drafts`, `external_calls` and `external_system_state` hold no person and are not wired.

- [ ] **Step 1:** Failing tests:
  - Seed PROBE (with `_`) into an `external_reads` and an `external_events` `fields` value, erase by contact, and expect zero hits in the schema-wide sweep.
  - The preview lists the system label.
  - The fingerprint changes when `externalSystemsKept` changes.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(erasure): external reads and events`

### Task 14: Documentation

**Files:**
- Modify:
  - `CLAUDE.md`: a new section "מערכות חיצוניות", the commands list, "36 → 38 tables", the closed cross-business list gains `resolveBusinessForHook`, known issues, and the migration runbook step "re-sign after 1.4"
  - `docs/10-user-settings.md`: what the owner signs, the scan authority, the summary channel
  - `docs/11-pre-launch-checks.md`: these rows —
    - a live call against a public test API
    - a real provider webhook through the proxy
    - a DNS-rebinding probe on the production host
    - a money op against a provider's sandbox
    - a scan on a real list endpoint
  - `docs/08-risks.md`: a signed system the provider later repoints, and a compromised provider response
  - `docs/12-launch-plan.md`
- [ ] **Step 1:** Write the docs. Every claim cites the file it describes.
- [ ] **Step 2:** Run `npm run typecheck` and `npm test` on the dedicated DB. Expected: green.
- [ ] **Step 3: Commit** `docs: stage D — external systems`
