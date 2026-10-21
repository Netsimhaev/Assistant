# Mailbox Connection (Gmail + Microsoft 365) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect one Gmail or Microsoft 365 mailbox per business, so the assistant can:
- read every new mail in quarantine and classify it;
- label it in the mailbox;
- ingest PDF attachments and record invoices;
- notify the owner;
- draft a reply for every open question, which goes out from the business's own mailbox only after the owner approves it.

**Architecture:** A `schedulerPass` step polls the mailbox through a provider-agnostic `MailboxClient` (Gmail REST / Microsoft Graph, both on HTTP that tests can inject).
- Every new message is recorded once and triaged by `intake.triage` in a `tools: []` model call.
- Deterministic code then applies a closed label set and audits it. It also feeds attachments to `ingestDocument`, writes invoice rows, notifies the owner, and for a question opens a dedicated reply job whose single `mail.send` step waits on an approval card.
- A narrow stage-8 exemption in `evaluateToolCall` lets an approved, unspent, hash-matching `email.reply` pass the ramp and provenance ceilings. Every other control still applies.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` imports), Postgres, zod, vitest (real DB), `@anthropic-ai/claude-agent-sdk`, plain `node:http` dashboard.

**Spec:** `docs/superpowers/specs/2026-10-20-mailbox-connection-design.md` (Hebrew). Read it before any task. Section references below (§N) point into it. Also read `CLAUDE.md`; its rules bind every task.

## Global Constraints

- New mailbox system name: `mailbox` (constant `MAILBOX_SYSTEM` in `src/mail/mailbox.ts`). Providers: `'google' | 'microsoft'`.
- OAuth scopes, verbatim:
  - Gmail: `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.send`, `openid`, `email`.
  - Microsoft: `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`.
- Closed label set, verbatim: `חשבוניות`, `ממתין לתשובה`. Nothing else is ever written as a label/category.
- Forbidden mailbox operations, never present in provider code: trash, delete, move, spam, mark-read/unread, block. (The constants `UNREAD`, `SPAM`, `TRASH` and the field `isRead` never appear in a write.)
- Read only mail that arrives after connection. The cursor is taken at connect time. No backfill.
- `MAIL_READS_PER_DAY` default **200**. `MAIL_CURATION_PER_DAY` default **100**. Both use `positiveInt` in `src/config.ts`.
- Body retention: **365 days**. After that, `body_text` becomes NULL; metadata, summary, documents and invoices remain.
- Every mail-derived job is `provenance: 'unknown_external'`, written as a literal in the `createJob` call body. No mail path ever creates a `boss` job.
- A reply's recipient is the original `From` address, always. A differing `Reply-To` is shown on the card and never used. No auto-CC.
- Invoice number and amount are model-read, displayed as "לא מאומת", and never read by anything in `src/policy/`.
- Hebrew for human-facing text; English for identifiers, comments and internal errors.
- Every new content table goes into `test/db.ts` TRUNCATE list, `erasure-plan.ts` `countItems`, `erasure.ts` executor and `erasure-invariants.test.ts` seeding.
- Model calls refuse under `NODE_ENV=test` (`config.isTest`), the same as `refuseUnderTest`. Tests inject a stub.
- Next migration number: `042`.

## Review Focus

1. **HTML-only mail** (no `text/plain` part) must still be triaged and searchable. The body is HTML with tags stripped, entities decoded, and `<script>`/`<style>` contents removed. Never render it as HTML. (Task 3 tests.)
2. **RFC 2047 encoded headers** (`=?UTF-8?B?...?=`) in subject or From name must appear as decoded Hebrew on screen and in WhatsApp. (Task 3 tests.)
3. **Crash between record and settle**: a re-poll must not re-notify, re-label or raise a second card for the same `provider_message_id`. (Task 9 tests.)
4. **A revoked grant or `needs_reauth`**: the poll reports `{ status: 'needs_reauth' }`, the dashboard shows "התיבה מנותקת — יש להתחבר מחדש", and nothing throws out of `schedulerPass`. (Task 9 and Task 12 tests.)
5. **A body of many megabytes**: store at most 1,000,000 chars, mark it truncated, and cap the triage brief at 24,000 chars. Neither the poll nor the dashboard may exhaust memory. (Task 3 and Task 8 tests.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/042_mailbox.sql` | `mailbox_cursor`, `mail_messages`, `mail_invoices` |
| `src/mail/mailbox.ts` | constants (`MAILBOX_SYSTEM`, labels, scopes per provider), shared types |
| `src/mail/inbox-store.ts` | record/claim/settle mail, cursor, invoices, search queries |
| `src/mail/mime.ts` | header decoding, HTML→text, body capping |
| `src/mail/automated.ts` | deterministic "is this an automated sender" |
| `src/mail/providers/types.ts` | `MailboxClient` interface |
| `src/mail/providers/gmail.ts`, `graph.ts` | the two clients over injectable HTTP |
| `src/orchestrator/adapters/microsoft-token-http.ts` | `TokenHttp` for Microsoft |
| `src/orchestrator/adapters/provider-token-http.ts` | dispatch `TokenHttp` by provider |
| `src/dashboard/oauth-profiles.ts` | per-system provider + scopes + consent endpoint |
| `src/charter/amend-mailbox.ts` | build the unsigned amendment that adds `mailbox` |
| `src/policy/approved-reply.ts` | the stage-8 exemption predicate |
| `src/orchestrator/adapters/mailbox-send.ts` | `ExternalAdapter` serving `mail.send` via `MailboxClient` |
| `src/domain/mail-triage.ts` | `MailTriage` zod schema + `mailTriageProblems` |
| `src/sdk/mail-triage.ts` | `runMailTriage` (model call, `tools: []`) |
| `src/sdk/mail-drafter.ts` | `runMailDrafter` (model call, `tools: []`) |
| `src/orchestrator/mail-poll.ts` | the poll pass |
| `src/orchestrator/mail-reply.ts` | reply job + card |
| `src/orchestrator/mail-retention.ts` | 365-day body scrub |
| `src/dashboard/mail-views.ts` | `/mail` and `/mail/invoices` pages |

---

### Task 1: Schema and inbox store

**Files:**
- Create: `src/db/migrations/042_mailbox.sql`, `src/mail/mailbox.ts`, `src/mail/inbox-store.ts`, `src/mail/inbox-store.test.ts`
- Modify: `test/db.ts` (TRUNCATE list)

**Interfaces:**
- Produces, in `src/mail/mailbox.ts`:
  - `MAILBOX_SYSTEM = 'mailbox'`
  - `MailProvider = 'google' | 'microsoft'`
  - `MAIL_LABELS = { invoice: 'חשבוניות', question: 'ממתין לתשובה' } as const`
  - `MailCategory = 'invoice' | 'question' | 'document' | 'other'`
- Produces, in `src/mail/inbox-store.ts` (each function takes `options: { businessId?: string; db?: Queryable } = {}`):
  - `recordIncoming(input: IncomingMail, options): Promise<StoredMail | null>`. Returns null on a duplicate `(business_id, provider_message_id)`.
  - `claimMail(mailId, options): Promise<boolean>`. Moves `received|over_cap` to `claimed`.
  - `settleMail(mailId, patch: SettlePatch, options): Promise<void>`. Throws if no row matched.
  - `markOverCap(mailId, options): Promise<void>`
  - `mailAwaitingTriage(limit, options): Promise<StoredMail[]>`. Rows in `received` or `over_cap`, oldest first.
  - `mailReadsToday(options): Promise<number>`. Counts rows whose `triaged_at` falls in the current day.
  - `getCursor(options): Promise<MailCursor | null>`
  - `setCursor(c: MailCursor, options): Promise<void>`
  - `insertInvoice(i: NewInvoice, options): Promise<string>`
  - `searchMail(q: MailSearch, options): Promise<MailRow[]>`
  - `listInvoices(f: InvoiceFilter, options): Promise<InvoiceRow[]>`
- `IncomingMail`:
  - `providerMessageId`, `threadId`, `internetMessageId: string | null`, `references: string | null`
  - `fromAddress`, `fromName: string | null`, `replyTo: string | null`, `toAddresses: string[]`
  - `subject`, `receivedAt` (ISO)
  - `bodyText: string`, `bodyTruncated: boolean`
  - `headerFlags: { listUnsubscribe: boolean; autoSubmitted: boolean; bulkPrecedence: boolean }`
  - `attachments: { attachmentId: string; filename: string; mediaType: string; size: number }[]`
- `SettlePatch`:
  - `state: 'triaged' | 'failed'`, `categories?: MailCategory[]`, `summary?: string`, `isPerson?: boolean`
  - `jobId?`, `replyJobId?`, `labelsApplied?: string[]`, `notifiedAt?: string`, `error?: string`
- `MailSearch`: `{ text?: string; fromIso?: string; toIso?: string; sender?: string; category?: MailCategory; limit: number }`
- `InvoiceFilter`: `{ supplier?: string; invoiceNumber?: string; fromIso?: string; toIso?: string; fileName?: string }`

Migration tables (snake_case):
- **`mailbox_cursor`**: `business_id PK, provider, cursor TEXT, connected_at, last_poll_at, last_error`.
- **`mail_messages`**:
  - `mail_id PK 'M-<ulid>'`, `business_id`, `provider_message_id`, `thread_id`, `internet_message_id`, `references_header`
  - `from_address`, `from_name`, `reply_to`, `to_addresses TEXT[]`, `subject`, `received_at`
  - `body_text` (nullable), `body_truncated`, `body_scrubbed_at`, `header_flags JSONB`, `attachments JSONB`
  - `state` (CHECK `received|claimed|over_cap|triaged|failed`), `categories TEXT[]`, `summary`, `is_person`
  - `job_id`, `reply_job_id`, `labels_applied TEXT[]`, `notified_at`, `error`, `triaged_at`, `created_at`
  - `UNIQUE(business_id, provider_message_id)`
- **`mail_invoices`**: `invoice_id PK`, `business_id`, `mail_id REFERENCES mail_messages ON DELETE CASCADE`, `supplier_address`, `supplier_name`, `invoice_number`, `amount_text`, `document_id` (nullable), `file_name`, `received_at`, `created_at`.
- Search uses `ILIKE` with `likeLiteral` escaping (reuse the existing helper from `erasure-plan.ts`; export it if it is private). No `pg_trgm` (spec §5.6 allows this).

- [ ] **Step 1: Write failing tests** in `inbox-store.test.ts`:
  - `recordIncoming returns null for a second insert of the same provider id`
  - `claimMail claims once` (second call → `false`)
  - `searchMail finds a body substring within a date window and not outside it`
  - `searchMail treats % and _ in the query literally`: seed `"50%_off"` and `"50 off"`; querying `50%_off` returns one row.
  - `listInvoices filters by supplier, number and date range`
  - `mailReadsToday counts only rows triaged today`
- [ ] **Step 2:** Run `npx vitest run src/mail/inbox-store.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Write the migration, add the three tables to `test/db.ts`, and implement the store using the `XRow` + `toX(row)` convention.
- [ ] **Step 4:** Run `npm run migrate:test && npx vitest run src/mail/inbox-store.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `Mail: inbox store and schema (042)`.

### Task 2: Automated-sender rules and triage schema

**Files:**
- Create: `src/mail/automated.ts`, `src/mail/automated.test.ts`, `src/domain/mail-triage.ts`, `src/domain/mail-triage.test.ts`

**Interfaces:**
- `isAutomatedSender(flags: IncomingMail['headerFlags'], fromAddress: string): boolean`. True if any flag is set, or if the local part of the address matches `/^(no-?reply|do-?not-?reply|mailer-daemon|notifications?)$/i`.
- `MailTriage` (zod):
  - `categories: z.array(z.enum(['invoice','question','document','other'])).min(1)`
  - `summary: z.string().min(1).max(400)`
  - `isPerson: z.boolean()`
  - `invoice: z.object({ number: z.string().max(64).nullable(), amountText: z.string().max(64).nullable(), dateText: z.string().max(64).nullable() }).nullable()`
  - `replyGist: z.string().max(500).nullable()`
  - No field may carry an address.
- `mailTriageProblems(t: MailTriage): string[]`. Returns:
  - `invoice_without_category` when `invoice` is set but `'invoice'` is not in `categories`;
  - `question_without_gist` when `'question'` is set but `replyGist` is null;
  - `other_mixed` when `'other'` appears alongside another category.
- `finalCategories(t: MailTriage, automated: boolean): { categories: MailCategory[]; isPerson: boolean }`. If `automated` is true, the result is `{ categories: ['other'], isPerson: false }` regardless of the model. The model can only lower a mail to `other`, never raise it (spec §5.1).

- [ ] **Step 1: Write failing tests**:
  - `automated: List-Unsubscribe alone is automated`
  - `automated: noreply@ local part is automated, noreply-team@ is not`
  - `finalCategories forces other for automated even when the model says question`
  - `MailTriage rejects an extra field "to"`: uses `.strict()` on the object.
  - one test per `mailTriageProblems` code.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Mail: automated-sender rule and triage schema`.

### Task 3: MIME helpers and the two provider clients

**Files:**
- Create: `src/mail/mime.ts`, `src/mail/mime.test.ts`, `src/mail/providers/types.ts`, `src/mail/providers/gmail.ts`, `src/mail/providers/graph.ts`, `src/mail/providers/gmail.test.ts`, `src/mail/providers/graph.test.ts`, `src/mail/providers/forbidden-ops.test.ts`

**Interfaces:**
- `mime.ts`:
  - `decodeHeader(v: string): string`, which handles RFC 2047 B and Q encodings.
  - `htmlToText(html: string): string`
  - `capBody(text: string): { text: string; truncated: boolean }`, cut at `MAX_BODY_CHARS = 1_000_000`.
- `providers/types.ts`:
```ts
export interface MailboxHttp {
  request(input: { method: 'GET' | 'POST' | 'PATCH'; url: string; accessToken: string; body?: unknown; signal: AbortSignal }): Promise<{ status: number; body: unknown; bytes?: Buffer }>;
}
export interface MailboxClient {
  initialCursor(token: string, signal: AbortSignal): Promise<string>;
  listSince(token: string, cursor: string, signal: AbortSignal): Promise<{ messages: IncomingMail[]; nextCursor: string } | MailboxFailure>;
  fetchAttachment(token: string, providerMessageId: string, attachmentId: string, signal: AbortSignal): Promise<Buffer | MailboxFailure>;
  ensureLabels(token: string, names: readonly string[], signal: AbortSignal): Promise<Record<string, string> | MailboxFailure>;
  addLabel(token: string, providerMessageId: string, labelName: string, labelId: string, signal: AbortSignal): Promise<true | MailboxFailure>;
  sendReply(token: string, reply: OutgoingReply, signal: AbortSignal): Promise<{ externalId: string | null } | MailboxFailure>;
}
export type MailboxFailure = { failure: 'auth' | 'transient' | 'rejected'; status: number; message: string };
export interface OutgoingReply { to: string[]; subject: string; body: string; inReplyTo: string; references: string | null; threadId: string; }
```
- Factories: `createGmailClient(http?: MailboxHttp): MailboxClient` and `createGraphClient(http?: MailboxHttp): MailboxClient`. The default HTTP uses global `fetch`. The status mapping copies `google-calendar.ts`: 401 → `auth`, 429/5xx/0 → `transient`, other → `rejected`.
- Gmail:
  - cursor: `historyId`. Initial cursor from `users/me/profile`; `history.list?historyTypes=messageAdded&labelId=INBOX`; then `messages.get?format=full`.
  - labels: `users.labels.create`; `messages.modify` with **`addLabelIds` only**.
  - send: `messages.send`, with a base64url RFC 822 message carrying `In-Reply-To`, `References`, `threadId` and a UTF-8 subject.
- Graph:
  - cursor: delta link of `me/mailFolders/inbox/messages/delta`. The initial delta is consumed to its `@odata.deltaLink` without returning messages, so there is no backfill.
  - Body: `body.contentType==='html'` goes through `htmlToText`.
  - labels: `me/outlook/masterCategories` (create if missing). Adding a category is a `PATCH` of message `categories` = existing ∪ {name}.
  - send: `createReply` then `send`, or `POST me/messages/{id}/reply` with `comment`. Builder's choice; it must thread.

- [ ] **Step 1: Write failing tests**:
  - `decodeHeader decodes =?UTF-8?B?...?= Hebrew and =?UTF-8?Q?...?=`
  - `htmlToText drops script/style content and decodes &amp;`
  - `capBody truncates at 1,000,000 chars and flags it`
  - Gmail, with a fake `MailboxHttp`:
    - `listSince maps a full message with an HTML-only body to text`
    - `listSince reads List-Unsubscribe and Auto-Submitted into headerFlags`
    - `addLabel sends addLabelIds and no removeLabelIds`
    - `sendReply carries In-Reply-To, References and threadId`
    - `401 maps to auth failure`
  - Graph: the same five cases, plus `addLabel preserves existing categories`, and `initialCursor returns a deltaLink and no messages`.
  - `forbidden-ops.test.ts`: read `gmail.ts` and `graph.ts` as text and assert no match for `/trash|\/delete|DELETE|\bmove\b|SPAM|UNREAD|isRead|removeLabelIds|junk|block/i`. Assert the scan read two non-empty files, because an empty scan that passes is not a control.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `mime.ts` and both clients. Clients return failures and never throw (same contract as adapters).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Mail: Gmail and Graph clients, add-only labels`.

### Task 4: Microsoft token exchange and per-system OAuth profiles

**Files:**
- Create: `src/orchestrator/adapters/microsoft-token-http.ts` (+ test), `src/orchestrator/adapters/provider-token-http.ts` (+ test), `src/dashboard/oauth-profiles.ts` (+ test)
- Modify: `src/dashboard/oauth-routes.ts`, `src/dashboard/oauth-consent.ts`, `src/orchestrator/oauth-eligibility.ts`, `src/orchestrator/runtime.ts:265-271`, `src/orchestrator/runtime.ts:549-592`

**Interfaces:**
- Consumes: `TokenHttp`/`RefreshOutcome` (`oauth-token.ts:200-211`), `googleTokenHttp`, `storedCredentials`.
- Produces:
  - `MICROSOFT_CLIENT_ID_REF = 'MICROSOFT_OAUTH_CLIENT_ID'`, `MICROSOFT_CLIENT_SECRET_REF = 'MICROSOFT_OAUTH_CLIENT_SECRET'`
  - `microsoftTokenHttp(options: { credentials: CredentialSource; fetchImpl?: typeof fetch }): TokenHttp`. Calls `https://login.microsoftonline.com/common/oauth2/v2.0/token` and **returns the rotated `refresh_token` as `rotatedRefreshToken`**.
  - `providerTokenHttp(byProvider: Record<string, TokenHttp>): TokenHttp`. Dispatches on `input.provider`; an unknown provider returns `{ ok: false, kind: 'misconfigured' }`.
  - `oauthProfileFor(connection: CharterConnection): OAuthProfile | null`, where `OAuthProfile = { provider: MailProvider; scopes: readonly string[]; authorizeUrl: string; tokenUrl: string; revokeUrl: string | null }`.
    - `mailbox` serving `mail.send` gives the profile of the provider that the owner chose at start (query param `provider=google|microsoft`, validated against `MailProvider`).
    - A connection serving `calendar.read` gives today's Google calendar profile.
- `connectionAcceptsOAuthCeremony` becomes `oauthProfileFor(connection) !== null && connection.channel === 'api'`.
- **`runtime.ts` calendar registration must stop using `connectionAcceptsOAuthCeremony`.** It must check `connection.serves.includes('calendar.read')` explicitly. Otherwise a `mailbox` binding would get a calendar adapter.
- `buildConsentUrl` gains `authorizeUrl` and a provider switch: `access_type=offline` is Google-only; Microsoft uses `response_mode=query`.
- Account identity after the code exchange: Google `openid email` id-token claim; Microsoft `GET https://graph.microsoft.com/v1.0/me` → `mail ?? userPrincipalName`.

- [ ] **Step 1: Write failing tests**:
  - `microsoftTokenHttp returns rotatedRefreshToken from the response`
  - `microsoftTokenHttp maps invalid_grant to rejected`
  - `providerTokenHttp routes google and microsoft, unknown is misconfigured`
  - `oauthProfileFor(mailbox, microsoft) has Mail.ReadWrite and offline_access`
  - `oauthProfileFor(mailbox, google) has gmail.modify and gmail.send`
  - `oauthProfileFor(office-mail) is null`
  - `runtime does not register a calendar adapter for a mailbox binding`, extending the existing runtime test.
  - In `oauth-routes.test.ts`: `start for mailbox with provider=microsoft redirects to login.microsoftonline.com with the four scopes`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. `runtime.ts:265-271` passes `providerTokenHttp({ google: googleTokenHttp(...), microsoft: microsoftTokenHttp(...) })`.
- [ ] **Step 4:** Run `npx vitest run src/orchestrator/adapters src/dashboard/oauth-routes.test.ts src/orchestrator/runtime.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `OAuth: Microsoft token exchange and per-system profiles`.

### Task 5: Charter amendment that adds the mailbox, signed in the dashboard

There is no amendment flow today (`src/charter/` has only `signCharter`/`installCharter`). This task adds the smallest one, for this single change.

**Files:**
- Create: `src/charter/amend-mailbox.ts`, `src/charter/amend-mailbox.test.ts`
- Modify: `src/dashboard/server.ts` (routes), `src/dashboard/views.ts` or a new `src/dashboard/mailbox-connect-views.ts`

**Interfaces:**
- `buildMailboxAmendment(active: BusinessCharter, now: Date): UnsignedCharter`:
  - copies the active charter;
  - sets a new unique `charterVersion` (`${active.charterVersion}.mbx-${ulid}`, or the version format the schema requires);
  - adds `{ system: 'mailbox', label: 'תיבת המייל של העסק', channel: 'api', serves: ['mail.read','mail.label','mail.send'], target: null, subprocessor: <provider display name> }`;
  - removes `'mail.send'` from every other connection's `serves`, and drops a connection whose `serves` would become empty.
  - It throws if a `mailbox` connection already exists.
- Routes:
  - `GET /connections/mailbox` shows status: not connected / connected-unsigned / active / `needs_reauth`, with connect buttons for Google and Microsoft.
  - After the OAuth callback for `mailbox`, the callback redirects to `GET /connections/mailbox/sign`. That page shows the diff in Hebrew ("מייל יוצא יישלח מתיבת העסק במקום משרת השליחה").
  - `POST /connections/mailbox/sign` (CSRF): `signCharter(amendment, { signedByPersonId: session.username, method: 'dashboard_click' })`, then `installCharter`, then `upsertBinding({ system:'mailbox', status:'live', endpoint:null, credentialRef:'OAUTH_MAILBOX', provider, lastOkAt:null, lastError:null }, { by: session.username })`, then `setCursor({ provider, cursor: await client.initialCursor(...) })`.
- The page states that the scheduler must restart for sending to switch over, because `buildRuntime` reads the charter once at start.

- [ ] **Step 1: Write failing tests**:
  - `amendment parses as BusinessCharter`. **If the schema rejects `mail.read`/`mail.label` as unknown tools in `serves`, stop and report back. Do not add them to any tool table.**
  - `amendment removes mail.send from office-mail and drops it when empty`
  - `amendment refuses a second mailbox`
  - `amendment keeps every other field byte-identical`: compare after deleting `connections`, `charterVersion` and the signature.
  - A route test: `POST /connections/mailbox/sign installs a charter whose active version serves mail.send only via mailbox`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Charter: dashboard-signed amendment adding the mailbox`.

### Task 6: Stage-8 exemption for an owner-approved reply

Core gate change. `/security-review` is mandatory after this task.

**Files:**
- Create: `src/policy/approved-reply.ts`, `src/policy/approved-reply.test.ts`
- Modify: `src/policy/engine.ts:276-299` and `effectiveAutonomy` (`:589-630`)

**Interfaces:**
- `approvedReplyCovers(facts: ActionFacts, toolName: string, liveInputHash: string, ctx: GateContext): Promise<boolean>`. True only when all of these hold:
  - `ctx.approval` is set and `ctx.jobId` is a string;
  - `facts.actionClass === 'email.reply'`;
  - the approval row (same business) has `state IN ('approved','approved_with_edit')`, `consumed_at IS NULL`, `expires_at > now()`, `job_id = ctx.jobId`, `proposed_tool = toolName` and `input_hash_at_decision = liveInputHash`.
  - It is a read only. Consumption stays in stage 10.
- `effectiveAutonomy(facts, ctx, options: { skipRampAndProvenance?: boolean } = {})`. When the option is set, it omits `ctx.rampLevel` and `bundle.provenanceCeiling[...]`. It keeps `autonomyBase`, counterparty overrides and `ctx.autonomyCeiling`.
- Stage 8 calls `approvedReplyCovers` before computing `effective` and passes the flag. The live input hash is the same hash `consumeApproval` receives at `:354-397`; reuse that computation and move it up rather than computing a second, different one.

- [ ] **Step 1: Write failing tests**, through real `evaluateToolCall` with `buildCharter()`, mode `off` and an `unknown_external` job:
  - `approved reply under mode off is allowed and consumes the approval`: assert `decision.kind === 'allow'` **and** that `consumed_at` is set.
  - `same call without ctx.approval is denied draft_only`
  - `approval for a different input hash is denied draft_only`
  - `approval for whatsapp.send tool is denied draft_only`
  - `approval of another job is denied draft_only`
  - `expired approved approval is denied draft_only`
  - `email.initiate (no inReplyTo) with an approval is denied`: the class must be `email.reply`.
  - `kill switch still denies an approved reply`
  - `quiet hours still defer an approved reply`
  - `doNotContact still denies an approved reply`
  - `autonomyBase forbidden for email.reply still denies`: use `buildCharter` with that override.
- [ ] **Step 2:** Run `npx vitest run src/policy/approved-reply.test.ts`. Expected: FAIL. The first test is denied `draft_only`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/policy`. Expected: PASS. Every existing gate test must stay green.
- [ ] **Step 5:** Commit: `Gate: an owner-approved reply passes ramp and provenance ceilings`.
- [ ] **Step 6:** Run `/security-review` on the diff and fix every confirmed finding before Task 7.

### Task 7: Mailbox send adapter and runtime registration

**Files:**
- Create: `src/orchestrator/adapters/mailbox-send.ts`, `src/orchestrator/adapters/mailbox-send.test.ts`
- Modify: `src/orchestrator/runtime.ts` (registration), `src/orchestrator/runtime.test.ts`

**Interfaces:**
- `createMailboxSendAdapter(options: { system: string; provider: MailProvider; client?: MailboxClient }): ExternalAdapter`:
  - `channel: 'api'`, `serves: ['mail.send']`;
  - reads own keys `to`, `subject`, `body`, `inReplyTo`, `references`, `threadId` from `call.input`. It reuses `readRecipients`/`readString` from `adapters/mail.ts`, exported if they are private.
  - Missing `inReplyTo` or `threadId` gives `{ ok:false, retryable:false, code:'not_a_reply' }`. This adapter only ever replies.
  - The access token is `call.credential.value`; a null credential gives `credential_unavailable`.
  - Failure mapping: `auth` → retryable `auth_failed`; `transient` → retryable; `rejected` → terminal `send_rejected`.
  - `externalId` comes from the client.
- Runtime: for a binding with `system === MAILBOX_SYSTEM` and `provider ∈ {google, microsoft}`, whose charter connection serves `mail.send`, push `createMailboxSendAdapter`. The SMTP mail adapter is still registered under `office-mail` for notifications. The charter (Task 5) no longer routes `mail.send` there.

- [ ] **Step 1: Write failing tests**:
  - `sends a reply with threading fields through the fake client`
  - `refuses a payload without inReplyTo as not_a_reply`
  - `null credential is credential_unavailable`
  - `runtime registers mailbox-send for a microsoft mailbox binding`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Mail: mailbox send adapter (replies only)`.

### Task 8: `intake.triage` and `comms.email` model calls

**Files:**
- Create: `src/sdk/mail-triage.ts`, `src/sdk/mail-triage.test.ts`, `src/sdk/mail-drafter.ts`, `src/sdk/mail-drafter.test.ts`, `src/mail/triage-brief.ts`, `src/mail/triage-brief.test.ts`

**Interfaces:**
- `renderTriageBrief(mail: StoredMail, nonce: string): string`:
  - fences `subject`, `fromName` and the body between `=== <label> :: <nonce> ===` lines, using the same `stripUntilStable` rule as `gov-verify.ts`;
  - strips bidi controls;
  - caps the body at `TRIAGE_BRIEF_MAX_CHARS = 24_000`;
  - **never includes the from/reply-to/to addresses**. The sender is described as "השולח".
- `runMailTriage(request: { bundle: PolicyBundle; mail: StoredMail }): Promise<{ status:'read'; triage: MailTriage } | { status:'unreadable'; reason: string }>`:
  - `refuseUnderTest`; `tools: []`; `env: { PATH }`; `settingSources: []`; model `'haiku'`.
  - Parses with `extractJsonObjects` (`src/util/json-extract.ts`), then `MailTriage.safeParse`, then `mailTriageProblems`.
- `runMailDrafter(request: { bundle: PolicyBundle; summary: string; replyGist: string; subject: string }): Promise<{ status:'drafted'; body: string } | { status:'failed'; reason: string }>`:
  - `tools: []`;
  - uses `bundle.promptFragments['comms.email']` if present;
  - **never receives the raw body** (spec §5.1);
  - the body is capped at 4,000 chars.
- Both expose a `Triage`/`Drafter` function type so callers inject stubs.

- [ ] **Step 1: Write failing tests**:
  - `brief contains no email address even when the body quotes one in From:`. Only the address in the From header is removed; addresses inside the body text stay as text.
  - `brief caps the body at 24,000 chars`
  - `brief fence uses the per-call nonce`
  - `runMailTriage refuses under test`
  - `parseTriageResponse rejects a response carrying "to"`: test the pure parse function and export it.
  - `runMailDrafter refuses under test`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Mail: quarantined triage and drafter calls`.

### Task 9: The poll pass

**Files:**
- Create: `src/orchestrator/mail-poll.ts`, `src/orchestrator/mail-poll.test.ts`, `src/mail/whatsapp-notice.ts`
- Modify: `src/orchestrator/scheduler.ts` (call + result fields), `src/config.ts` (`mailReadsPerDay`), `src/documents/store.ts:339-353` (`AND d.source <> 'mail'`), `.env.example`

**Interfaces:**
- `pollMailbox(options: { businessId?: string; runtime: Runtime; client?: MailboxClient; triage?: Triage; drafter?: Drafter; readsPerDay?: number; documentRoot?: string; notifyBoss?: (text: string, jobId: string | null) => Promise<void>; now?: Date }): Promise<MailPollResult | null>`.
  - Returns `null` when there is no active `mailbox` connection with a live binding and a cursor.
- `MailPollResult = { status: 'ok' | 'needs_reauth' | 'error'; recorded: number; triaged: number; overCap: number; labelled: number; notified: number; drafts: number; failed: number; error?: string }`
- Order per pass:
  1. Resolve the credential through `runtime.credentials` for `OAUTH_MAILBOX`. `OAuthRefreshRejectedError` or a revoked grant gives `{ status:'needs_reauth' }`, plus `markNeedsReauth` and `last_error` on the cursor.
  2. Run `listSince`, then `recordIncoming` each message. Save `nextCursor` **after** recording.
  3. For each row from `mailAwaitingTriage`, while `mailReadsToday < readsPerDay`:
     - `claimMail`;
     - `createJob({ charterVersion, provenance: 'unknown_external', businessId, title: \`מייל: ${subject}\` })`;
     - `triage`;
     - `finalCategories(triage, isAutomatedSender(...))`.
  4. Labels: `ensureLabels(Object.values(MAIL_LABELS))` once per pass. For `invoice`/`question`, call `addLabel`, then `appendAudit({ actor: 'intake.triage', kind: 'tool_call', reason: \`mail_label:${label}\`, inputHash: canonicalHash({ providerMessageId, label }), provenance: 'unknown_external', ... })`. No subject and no address in the audit row.
  5. Attachments with media type PDF (or any type `ingestDocument` supports): `fetchAttachment`, write to a `mkdtemp` temp file, `ingestDocument({ path, source:'mail', originalName: filename })`, then remove the temp file.
  6. For `invoice`, `insertInvoice` with supplier = from address / decoded from name, the triage invoice fields, and the first PDF's `documentId` or null.
  7. If `isPerson` and the mail is invoice or question, call `notifyBoss` with `renderMailNotice(mail, categories)`, created in this task in `src/mail/whatsapp-notice.ts`: `📧 ${name} <${fromAddress}>`, then a newline, the category word (`חשבונית` / `שאלה שמחכה לתשובה`) and the summary, all through `stripBidiControls`.
  8. For `question`: `raiseMailReply` (Task 10).
  9. `settleMail(...)`, then close the triage job through the same legal transition path `conduct.ts` uses for a job that raises no card. Read `LEGAL_TRANSITIONS` and copy that path.
  10. Over cap: `markOverCap`, count it, and never call the model.
- A failure in one mail settles that mail as `failed` and continues. It never aborts the pass.
- `schedulerPass` calls `pollMailbox` after `resumeDelegatedJobs` and before `runDueJobs`, so a reply job approved earlier and a card raised now are both visible to this pass. It adds `mail: MailPollResult | null; mailError: string | null` to `SchedulerPassResult`, catching exceptions into `mailError` like `scanError`.

- [ ] **Step 1: Write failing tests**, with a fake `MailboxClient`, stub triage and drafter, `buildCharter` plus the Task 5 amendment installed, and a binding plus cursor seeded:
  - `no mailbox connection returns null`
  - `records, triages, labels an invoice and audits the label without subject or address`
  - `automated newsletter: triaged other, no label, no notify`
  - `PDF attachment is ingested with source mail and linked on the invoice row`
  - `conductPendingDocuments skips a mail-sourced document`
  - `over cap: 3 mails, cap 2 → 2 triaged, 1 over_cap, triage stub called exactly twice`
  - `re-poll after a crash between record and settle does not notify or label twice`: run the pass, reset one row to `received` without clearing `notified_at`/`labels_applied`, and run again. Implementation: skip notify/label when already set.
  - `revoked grant gives needs_reauth and does not throw`
  - `cursor advances only after recording`: the client throws on the third message's mapping.
- [ ] **Step 2:** Run `npx vitest run src/orchestrator/mail-poll.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/orchestrator/mail-poll.test.ts src/orchestrator/scheduler.test.ts src/orchestrator/conduct.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `Mail: poll pass — triage, label, ingest, invoices, cap`.

### Task 10: Reply job and approval card

**Files:**
- Create: `src/orchestrator/mail-reply.ts`, `src/orchestrator/mail-reply.test.ts`
- Modify: `src/dashboard/views.ts` (`renderApprovalCard`: recipient line + Reply-To warning when the payload is a mailbox reply)

**Interfaces:**
- `raiseMailReply(input: { mail: StoredMail; triage: MailTriage; bundle: PolicyBundle; drafter: Drafter }, options: { businessId?: string; notify?: NotifyTarget }): Promise<{ replyJobId: string; approvalId: string } | null>`
  - Calls the drafter, which is the only model call. A failed draft returns null and the mail still shows on screen as a question.
  - `createJob({ ..., provenance: 'unknown_external', title: \`תשובה: ${subject}\` })`
  - `bindPlanToJob(replyJobId, plan)`, where `plan` has a single step:
    - `{ id: 'reply', agent: 'comms.email', intent: 'reply_to_sender', toolName: 'mail.send', expectedActionClass: 'email.reply' }`
    - `input: { to: [mail.fromAddress], subject: replySubject(mail.subject), body, inReplyTo: mail.internetMessageId, references: mail.referencesHeader, threadId: mail.threadId }`
  - Card: `buildFacts` + `assessRisk` + `enqueueApproval` directly, the same pattern as `raiseProposalApproval` (`proposal-approval.ts:135-160`), including the `notifyOwner` contract.
    - `summary`: `תשובה ל-${fromName ?? fromAddress}: ${subject}`
    - `detail` includes the recipient address verbatim, the full body, and, when `replyTo` is set and differs from `fromAddress` (case-insensitive), the line `שים לב: המייל ביקש שהתשובה תישלח ל-${replyTo}. התשובה תישלח ל-${fromAddress}.`
  - No `RAMP_HONESTY` sentence on these cards: approval does send (Task 6).
  - Moves the reply job to the phase from which `resumeAfterDecision` takes it to `execute` on approve, the same as `conduct.ts:574-581`.
- `replySubject(s: string): string` prefixes `Re: ` unless the subject already starts with `re:` (case-insensitive).
- A mail without `internetMessageId` gets no card (it cannot be threaded). It records `error: 'no_message_id'` on the mail row.

- [ ] **Step 1: Write failing tests**:
  - `raises a card on a reply job whose plan step carries the exact payload`
  - `card detail shows the from address and the Reply-To warning when they differ`
  - **End-to-end, mode `off`:** raise, then `decide(approved)`, then `resumeAfterDecision`, then `runDueJobs` with a runtime whose registry holds `createMailboxSendAdapter` over a fake client. Assert the fake client's `sendReply` received `to === [fromAddress]` and `inReplyTo`, **and** the reply job reached `verify`.
  - `same flow without approval sends nothing`: the client's `sendReply` call count is 0. Assert the job ran through the gate, i.e. a `policy_denial` audit row with `draft_only` exists for it, so the negative test proves the gate was reached.
  - `edited approval sends the edited body`
  - `mail without Message-ID raises no card`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Mail: reply job and approval card; approve sends`.

### Task 11: Curation from mail

**Files:**
- Modify: `src/memory/curation-brief.ts`, `src/memory/curate.ts`, `src/orchestrator/mail-poll.ts`, `src/config.ts`
- Test: `src/memory/mail-curation.test.ts`

**Interfaces:**
- `buildCurationBrief` gains a branch: a job that owns a `mail_messages` row (`job_id`) and no plan yields a brief from `summary` + categories, with `touched = [fromAddress]`. The address comes from the stored header, not from the model.
- `curateJob(jobId, { ..., runsPerDay, scope: 'mail' | 'default' })`. The `curation` audit row's `reason` is prefixed `mail:` for scope `mail`, and `curationRunsToday` counts by scope. Default-scope behaviour is unchanged.
- `pollMailbox` calls `curateJob(jobId, { scope: 'mail', runsPerDay: config.mailCurationPerDay })` after settling, and only for invoice/question.

- [ ] **Step 1: Write failing tests**:
  - `mail job brief touches exactly the sender address`
  - `candidate about another address is rejected by siftCandidates`
  - `mail curation cap is counted apart from document curation`: 20 default-scope rows today do not block a mail run.
  - `other-category mail is never curated`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/memory`. Expected: PASS.
- [ ] **Step 5:** Commit: `Memory: curate invoice and question mail, own daily cap`.

### Task 12: Dashboard screens

**Files:**
- Create: `src/dashboard/mail-views.ts`, `src/dashboard/mail-routes.test.ts`
- Modify: `src/dashboard/server.ts` (routes after the session gate), nav links in `views.ts`

**Interfaces:**
- `GET /mail?q=&from=&to=&sender=&category=` → `renderMailList(rows, filters, mailboxStatus, csrf)`.
  - Columns: מתי, ממי, תקציר / הקטע שנמצא, סיווג, מה העוזרת עשתה. Matches the approved sketch.
  - The highlighted snippet is built **after** escaping: escape the snippet first, then wrap the escaped query occurrences in `<mark>`.
  - Status banners:
    - over-cap rows show "לא נקרא — התקרה היומית נגמרה";
    - `needs_reauth` shows "התיבה מנותקת — יש להתחבר מחדש" with a link to `/connections/mailbox`;
    - no mailbox shows "תיבת מייל לא מחוברת".
- `GET /mail/invoices?supplier=&number=&from=&to=&file=` → `renderInvoices(groups, filters, csrf)`.
  - Grouped by supplier address, with the last seen name. Each group is sorted by date descending.
  - Amount and number are marked "לא מאומת".
  - "הורד" links to the existing document download route if one exists; otherwise add `GET /documents/:id/file`, which streams `stored_path` under `config.documentRoot` with `Content-Disposition: attachment` (filename RFC 5987 encoded) and is business-scoped.
  - "מייל מקורי" links to `/mail/:mailId`.
- `GET /mail/:mailId` shows one mail: headers (decoded), the body as **escaped text in `<pre>`**, the categories, and links to its card and documents.
- Every name and subject goes through `escLabel`. Dates are formatted in the charter time zone, never by slicing `timestamptz::text`.

- [ ] **Step 1: Write failing tests**, with a real `http.createServer` like `server.test.ts`:
  - `/mail requires a session`
  - `/mail?q=משלוח returns the matching row with <mark> and escapes a <script> in the body`
  - `/mail shows the over-cap banner`
  - `/mail/invoices filters by number and groups by supplier`
  - `/mail/:id renders an HTML body as text`
  - `invoice download is business-scoped`: another business's document gives 404.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Dashboard: mail list with search, invoices by supplier`.

### Task 13: WhatsApp notice and approve-by-WhatsApp

**Files:**
- Create: `src/mail/whatsapp-notice.test.ts`
- Modify: `src/orchestrator/scheduler.ts` (pass `notifyBoss` built from `whatsappMessenger` when present), `src/orchestrator/whatsapp-door.ts` and its routing (mail-card replies), and the tests of the files you touch

**Interfaces:**
- `renderMailNotice(mail: StoredMail, categories: MailCategory[]): string`:
  - `📧 ${escName} <${fromAddress}>` then a newline;
  - a category word: `חשבונית` or `שאלה שמחכה לתשובה`;
  - the summary;
  - everything passes through `stripBidiControls`.
- `renderMailCardWhatsApp(approval: ApprovalRequest, payload): string`:
  - recipient address, subject and **full body**;
  - then `השב "שלח" כדי לשלוח, או כתוב נוסח חדש במקומה.`
- An open mail card on WhatsApp is an open question for 30 minutes (`WHATSAPP_QUESTION_WINDOW_MINUTES`), using the same mechanism as `pendingQuestions`. Within it:
  - a principal message that equals `שלח` (trimmed, after `stripBidiControls`) calls the same `decide(approved)` + `resumeAfterDecision` as the dashboard;
  - any other text is a replacement body. It is stored as `editedInput` on a **new** pending approval for the same reply job, with a fresh hash, re-presented, and needs a second `שלח` (spec §5.2 point 7);
  - closure verbs close the window without deciding.
- If more than one mail card is open, `שלח` is refused with `יש כמה טיוטות פתוחות — אשרי בדשבורד.` and nothing is decided.
- When the WhatsApp bridge is absent, `notifyBoss` is undefined and the poll counts `notified: 0`. The dashboard stays the only channel; this is already reported as `whatsappDoor: null`.

- [ ] **Step 1: Write failing tests**, with the existing fake gateway in the WhatsApp tests:
  - `notice strips bidi controls from the from name and summary`
  - `"שלח" within the window approves and the reply job reaches execute`
  - `replacement text creates a new pending approval with the edited body and does not send`
  - `"שלח" with two open mail cards decides nothing`
  - `"שלח" from a non-principal sender does nothing`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/whatsapp src/orchestrator/whatsapp-door.test.ts src/mail`. Expected: PASS.
- [ ] **Step 5:** Commit: `WhatsApp: mail notices and approve-by-reply`.

### Task 14: Retention and erasure wiring

**Files:**
- Create: `src/orchestrator/mail-retention.ts` (+ test)
- Modify: `src/orchestrator/scheduler.ts`, `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`

**Interfaces:**
- `scrubOldMailBodies(options: { businessId?: string; now?: Date }): Promise<{ scrubbed: number }>`:
  - sets `body_text = NULL, body_scrubbed_at = now()` where `received_at < now - 365 days AND body_text IS NOT NULL`;
  - writes one `appendAudit` row with `reason: \`mail_retention:${n}\``, numbers only.
  - `schedulerPass` calls it every pass, after `closeVerifiedJobs`.
- Erasure:
  - **contact anchor** finds `mail_messages` by `from_address`/`reply_to`/`to_addresses`/`subject`/`body_text`/`summary` `ILIKE` with `LIKE_ESCAPE`, and adds their `job_id`/`reply_job_id` to `jobIds`;
  - **window anchor** uses `received_at`;
  - **document anchor** uses `mail_invoices.document_id`.
  - `countItems` and the executor delete `mail_invoices`, then `mail_messages`, through shared exported predicate constants, the same as `WHATSAPP_MESSAGES_ERASED_PREDICATE`.
  - `mailbox_cursor` holds no counterparty content and is excluded, like `autonomy_mode`. Write this in a comment.
- Invariants: seed one `mail_messages` row whose body carries `PROBE` and one `mail_invoices` row whose `supplier_address` is `PROBE`. The schema scan must then find zero.

- [ ] **Step 1: Write failing tests**:
  - `scrubs bodies older than 365 days and keeps summary and invoices`
  - `retention audit row carries only a count`
  - In the invariants test: add both seeds. It must go red before the erasure wiring.
  - `contact erasure deletes the mail and its reply job`
- [ ] **Step 2:** Run `npx vitest run src/governance/erasure-invariants.test.ts src/orchestrator/mail-retention.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/governance src/orchestrator/mail-retention.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `Mail: 365-day body retention and erasure wiring`.

### Task 15: Live script, docs, full verification

**Files:**
- Create: `src/sdk/run-mail-triage.ts` (`npm run sdk:mail-triage -- <mailId>`, live, needs a key)
- Modify: `package.json`, `CLAUDE.md`, `docs/09-roadmap.md`, `docs/10-user-settings.md`, `.env.example`

- [ ] **Step 1:** Add the live script: it loads one stored mail, runs `runMailTriage` and `runMailDrafter`, and prints both. It is not a test.
- [ ] **Step 2:** CLAUDE.md: add paragraphs, in the file's style, for:
  - the mailbox system and why `mail.send` moved off SMTP;
  - the stage-8 approved-reply exemption and its exact conditions;
  - the add-only label bypass as a documented gate-bypass;
  - the closed label set;
  - the external Google-verification constraint;
  - the two new caps;
  - retention.
  Update the command list and the test count.
- [ ] **Step 3:** Run `npm run typecheck && npm test`. Expected: both green. Report the real test count.
- [ ] **Step 4:** Run `/security-review` on the whole branch, because it touched `engine.ts`, `classify.ts`-adjacent tables, migrations and a new send path. Fix confirmed findings.
- [ ] **Step 5:** Commit: `Docs: mailbox connection`.
