# WhatsApp Contacts — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A message from a client, supplier or unknown number on the business WhatsApp gets a fixed "בודקת ומעדכנת" holding reply and a card to the owner with a drafted answer; nothing informational leaves without the owner's "שלח". The owner can also order a (scheduled) WhatsApp message to a contact.

**Architecture:** The WhatsApp door's `senderKind === 'other'` branch stops being a dead end: the sender is resolved (owner-vouched managed contact / colleague / unknown), a `contact_conversations` row tracks the open question, a code-only holding reply goes out through a documented gate bypass, quarantined agents research (tier 2 sources filtered to the sender in code; tier 3 internal docs) and draft, and the draft becomes an `unknown_external` job with a one-step `wa.send_message` plan and an approval card — mirroring `raiseReplyCard` in `mail-reply.ts`. The approved send goes through the gate under `approvedReplyCovers`, extended to contact-conversation jobs. A new signed charter connection `whatsapp-contacts` serves `wa.send_message`; a new adapter sends through the existing `WhatsAppGateway`. Tier 1 (public documents) arrives with the public flag in phase 2; in phase 1 the drafter sees tier 2 and tier 3 only.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports), Postgres 17 with RLS, vitest against a real DB, zod, `@anthropic-ai/claude-agent-sdk`.

**Spec:** [docs/superpowers/specs/2026-11-21-whatsapp-contacts-design.md](../specs/2026-11-21-whatsapp-contacts-design.md) — phase 1 = §6.13. Owner rulings H1–H16; Claude's calls §9.2.

## Global Constraints

- Every new table with `business_id`: `ENABLE` + `FORCE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation … USING/WITH CHECK (business_id = app_business_id())` in its own migration (`rls.test.ts` fails otherwise).
- `businessId` is never optional, never defaulted (`no-default-business.test.ts`). All DB access via `withBusiness`/`BusinessDb`.
- Every job born from a contact message: `provenance: 'unknown_external'` as a literal in the `createJob` call body.
- Every model call that reads contact text or documents: `tools: []` (researcher: read-only file tools only, cwd = business document folder), `env: { PATH }`, `settingSources: []`, `refuseUnderTest()`, every untrusted field inside `buildFence` with a per-call nonce.
- Hebrew for anything a person reads; English for identifiers/comments/internal errors.
- `src/policy/engine.ts` is not changed in phase 1 except through `approvedReplyCovers`'s own module. Run `/security-review` after Task 9 and Task 13 (both touch `src/policy/`).
- Holding-reply text (exact): `"שלום, כאן העוזרת הדיגיטלית של {businessName}. קיבלתי את הודעתך — בודקת ומעדכנת בהקדם."`
- Card reminder after **5 hours** unanswered, once (H10). Card/approval TTL **72 hours** (`ttlMinutes: 4320`).
- Holding reply: once per conversation, ≤ **3 per number per day**, only if the last inbound from that number is ≤ **60 min** old, never inside `bundle.quietHours` (deferred to its end), stopped by the `outbound` kill switch.
- Caps: business `contactWaReadsPerDay` (server default **100**, env `CONTACT_WA_READS_PER_DAY`); per contact **30** messages/day processed by a model (`CONTACT_MESSAGES_PER_CONTACT_PER_DAY`, constant).
- Conversation context: last **10** messages of that number, fenced.
- Scheduled boss-ordered messages: `sendAt` at most **30 days** ahead (Claude's call); confirmation valid until `sendAt + 24h` and only while the active charter version equals the job's (H15).
- Tests run on a dedicated DB (CLAUDE.md "הרצת מבחנים במקביל ל-hook"): `TEST_DATABASE_URL="$SDD" npx vitest run <files> --no-file-parallelism`.

## Review Focus

1. **A contact sends five messages in a burst** → one conversation, one holding reply, one live card (the newest draft; older pending card cancelled) — not five. Test in Task 11.
2. **Owner's "שלח" while a contact card AND another card/question are open** → `SEVERAL_OPEN_REFUSAL`, nothing sent. Test in Task 10.
3. **Sender number in an odd shape** (no `+`, `@c.us`, group id) → `authorityNumberKey` null → treated as `unknown`, never matched to a contact, never gets tier-2 data. Test in Task 2.
4. **"שלח" after the card expired, was replaced, or the conversation's number changed** → refused, nothing sent; adapter refuses a `to` that differs from the conversation's number. Tests in Tasks 8 and 10.
5. **Holding-reply gateway failure** → not marked sent, retried next pass within the daily limit, never sent twice after a success. Test in Task 4.

---

### Task 1: Migration 083 and store types

**Files:**
- Create: `src/db/migrations/083_whatsapp_contacts.sql`
- Modify: `src/whatsapp/store.ts` (`SenderKind`, `recordOutbound`), `src/tenancy/runtime-settings.ts` (`CAP_NAMES`, `CAP_COLUMNS`), `src/config.ts`, `src/cli/business-settings.ts` help text
- Test: `src/whatsapp/store.test.ts`, `src/tenancy/rls.test.ts` (runs as is)

**Interfaces:**
- Produces: `SenderKind = 'principal' | 'other' | 'contact' | 'colleague' | 'unknown'` (`'other'` kept for rows written before 083); `recordOutbound(db, { body; jobId; recipientNumber?: string | null })`; tables below; cap name `contactWaReadsPerDay`.

Migration contents (exact columns):
- `whatsapp_messages`: replace the `sender_kind` CHECK with the five values; `ADD COLUMN recipient_number text` (outbound to a contact; NULL = to the owner).
- `contact_conversations(business_id text NOT NULL, conversation_id text NOT NULL, contact_key text NOT NULL /* authorityNumberKey digits */, contact_subject_key text, contact_kind text NOT NULL CHECK (contact_kind IN ('client','supplier','unknown')), state text NOT NULL CHECK (state IN ('open','carded','answered','closed','expired')), opened_at timestamptz NOT NULL DEFAULT now(), last_inbound_at timestamptz NOT NULL, holding_sent_at timestamptz, holding_due_at timestamptz, card_job_id text, card_presented_at timestamptz, reminder_sent_at timestamptz, closed_at timestamptz, PRIMARY KEY (business_id, conversation_id))`; partial unique index one live row per number: `(business_id, contact_key) WHERE state IN ('open','carded')`.
- `contact_reply_decisions(business_id, decision_id, conversation_id, job_id, approval_id, verdict text CHECK (verdict IN ('right','wrong','not_counted')), wrong_reason text, source_tiers text[] NOT NULL, decided_at timestamptz NOT NULL, PRIMARY KEY (business_id, decision_id))`, unique `(business_id, approval_id)`.
- `contact_documents(business_id, document_id, contact_key, kind text CHECK (kind IN ('invoice')), assigned_by text CHECK (assigned_by IN ('owner_upload','sent_mail','accounting')), assigned_at timestamptz DEFAULT now(), PRIMARY KEY (business_id, document_id, contact_key))`.
- `contact_whatsapp_settings(business_id PRIMARY KEY, invoice_system_id text, invoice_operation text, invoice_customer_param text, invoice_customer_field text, updated_at)` — accounting lookup config (Task 5c).
- `business_runtime_settings ADD COLUMN contact_wa_reads_per_day integer`.
- RLS boilerplate on all four new tables.

- [ ] **Step 1: Write failing tests** — `store.test.ts`: `recordInbound` accepts `senderKind: 'contact'`; `recordOutbound(db, { body: 'x', jobId: null, recipientNumber: '+972501234567' })` stores `recipient_number`. Assert the four new tables exist and appear in the RLS sweep (`rls.test.ts` already enumerates).
- [ ] **Step 2: Run** `TEST_DATABASE_URL="$SDD" npm run migrate:test` then the tests → FAIL before migration exists.
- [ ] **Step 3: Write migration and type changes**; `config.contactWaReadsPerDay = positiveInt('CONTACT_WA_READS_PER_DAY', 100)`; add to `.env.example`.
- [ ] **Step 4: Run** migrate + `npx vitest run src/whatsapp/store.test.ts src/tenancy/rls.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): migration 083 — conversations, decisions, contact documents`.

### Task 2: Who wrote — contact kind/email and `resolveSender`

**Files:**
- Modify: `src/business/setup-package.ts` (`PersonEntry`), `src/business/settings-contacts.ts`, `src/dashboard/people-routes.ts` (+ its view)
- Create: `src/whatsapp/contact-identity.ts`
- Test: `src/whatsapp/contact-identity.test.ts`, `src/dashboard/people-routes.test.ts`

**Interfaces:**
- Produces: `PersonEntry` gains `kind: z.enum(['client','supplier']).optional()` and `email: z.string().email().max(254).optional()` (stored in the entity body); `ManagedContact` gains `kind: 'client'|'supplier'|null`, `email: string|null`.
- Produces: `resolveSender(db: BusinessDb, charter: BusinessCharter, senderNumber: string): Promise<ResolvedSender>` with `ResolvedSender = { kind: 'principal' } | { kind: 'colleague'; key: string } | { kind: 'contact'; key: string; contact: ManagedContact } | { kind: 'unknown'; key: string | null }`.

Rules: `principal` via `isPrincipalSender`; key = `authorityNumberKey(senderNumber)`; key null → `unknown` with `key: null`; colleague match (`listColleagues`, canonical phone) wins over contact; contact = `listManagedContacts` only (owner-vouched — §6.2; learned entities never count).

- [ ] **Step 1: Failing tests** — `resolves a managed contact by canonical number`; `a colleague is colleague even with a managed-contact row`; `an entity learned from a document with the same phone is unknown` (seed `memories` entity with `provenance='unknown_external'`, `source_ref=NULL`, body.phone = number → `kind: 'unknown'`); `malformed sender (no +, @c.us, 22-digit group id) is unknown with key null`; people route saves and re-renders `kind` and `email`, rejects an invalid email with a Hebrew message.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; the people form gets a select `kind` (לקוח / ספק / —) and an `email` input.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): resolve sender — owner-vouched contacts only`.

### Task 3: Conversation store

**Files:**
- Create: `src/whatsapp/contact-conversations.ts`
- Test: `src/whatsapp/contact-conversations.test.ts`

**Interfaces:**
- Produces:
  - `openOrAppend(db, input: { key: string; subjectKey: string | null; kind: 'client'|'supplier'|'unknown'; inboundAt: Date }): Promise<{ conversation: ContactConversation; created: boolean }>` — reuses the live (`open`/`carded`) row for the number, updating `last_inbound_at`; `INSERT … ON CONFLICT` on the partial unique index so two runners make one row.
  - `setCard(db, conversationId, jobId: string, presentedAt: Date | null): Promise<void>` (state → `carded`); `markHoldingSent(db, conversationId, at)`; `deferHolding(db, conversationId, dueAt)`; `closeConversation(db, conversationId, state: 'answered'|'closed'|'expired')`; `loadConversation(db, conversationId)`; `conversationByCardJob(db, jobId)`; `recentMessages(db, key: string, limit = 10): Promise<{ direction; body; at }[]>` (inbound by `sender_number` key, outbound by `recipient_number`).
  - `ContactConversation` interface mirroring the table (camelCase), with private `ContactConversationRow` + `toContactConversation`.
- [ ] **Step 1: Failing tests** — `two messages from one number share one live conversation`; `concurrent openOrAppend creates one row` (two `withBusiness` calls in `Promise.all`); `a closed conversation is not reused`; `recentMessages returns both directions, newest 10, oldest first`.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): conversation store`.

### Task 4: The holding reply — the one documented gate bypass

**Files:**
- Create: `src/whatsapp/holding-reply.ts`, `src/whatsapp/holding-reply-invariants.test.ts`
- Test: `src/whatsapp/holding-reply.test.ts`

**Interfaces:**
- Consumes: Task 3, `WhatsAppGateway.sendMessage`, `inQuietHours` (`src/policy/redact.ts`), `checkKillSwitch`, `appendAudit`, `recordOutbound` (Task 1).
- Produces: `HOLDING_REPLY_TEXT(businessName: string): string`; `sendHoldingReply(db, deps: { gateway: WhatsAppGateway; bundle: PolicyBundle; businessName: string; now: Date }, conversationId: string): Promise<'sent'|'deferred'|'already'|'stale'|'capped'|'halted'|'failed'>`; `sendDueHoldingReplies(db, deps): Promise<{ sent; failed }>` (scheduler: rows with `holding_due_at <= now` and `holding_sent_at IS NULL`). Export `nextQuietEnd(bundle, now): Date` from `src/orchestrator/execute.ts` (currently private `nextTimeAt`) — move it to `src/util/local-time.ts` and import in both places.

Order inside `sendHoldingReply`: load conversation → `already` if `holding_sent_at` set → `halted` if kill switch `outbound` (agent `comms.whatsapp`) → `stale` if `last_inbound_at` older than 60 min → `capped` if ≥3 holding audit rows for this key today (business timezone) → quiet hours → `deferHolding(nextQuietEnd)` → `deferred` → send with `idempotencyKey = 'holding:' + conversationId` → on `state !== 'rejected'` `markHoldingSent` + `recordOutbound({recipientNumber})` + `appendAudit({ kind: 'tool_call', reason: 'contact_holding_reply', inputHash: canonicalHash({ key }) , actor: 'agent' …})`. Throw/reject → `failed`, nothing marked.

- [ ] **Step 1: Failing tests** — one per outcome; `failure is retried on the next pass and never sent twice after success` (fake gateway fails once then succeeds; call twice more → exactly one sent message); `audit row carries no number or text` (assert `reason`/`input_hash` lack the digits).
- [ ] **Step 2: Invariant test** — read `holding-reply.ts` as text: the sending function takes only `conversationId` (no `text`/`body` parameter in its signature); the only `sendMessage(` call site in the module uses `HOLDING_REPLY_TEXT(`; scanning `src/` (non-test), only `whatsapp-door.ts`, `scheduler.ts` and `contact-flow.ts` import `sendHoldingReply`/`sendDueHoldingReplies`. Verify the regexes catch a planted violation string first.
- [ ] **Step 3–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): holding reply — documented gate bypass`.

### Task 5a: Tier-2 source interface and owner-uploaded invoices

**Files:**
- Create: `src/whatsapp/sources/types.ts`, `src/whatsapp/sources/uploaded-invoices.ts`
- Modify: `src/dashboard/people-routes.ts` (upload-and-assign per contact, reuses `readBoundedMultipart` and `ingestDocument(db, { path, source: 'manual', originalName })`)
- Test: `src/whatsapp/sources/uploaded-invoices.test.ts`, `src/dashboard/people-routes.test.ts`

**Interfaces:**
- Produces:
```ts
export interface SenderIds { key: string; email: string | null; subjectKey: string }
export interface SourceItem { source: 'uploaded_invoices' | 'sent_invoices' | 'accounting_invoices'; label: string; text: string; documentId: string | null; at: string | null }
export type Tier2Source = (db: BusinessDb, ids: SenderIds, signal: AbortSignal) => Promise<SourceItem[]>;
```
- `uploadedInvoicesOfSender: Tier2Source` — `contact_documents` rows for `ids.key`, joined to `documents` in the same business, newest 10.
- [ ] **Step 1: Failing tests** — `returns only this contact's invoices` (seed two contacts); `an upload assigned in the dashboard appears for that contact`; `assigning requires CSRF and a managed contact key`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): tier-2 sources — owner-uploaded invoices`.

### Task 5b: Sent-mail invoices (new mailbox capability)

**Files:**
- Modify: `src/mail/providers/types.ts`, `gmail.ts`, `graph.ts`
- Create: `src/whatsapp/sources/sent-invoices.ts`
- Test: `src/mail/providers/gmail.test.ts`, `graph.test.ts`, `src/mail/providers/forbidden-ops.test.ts` (must stay green), `src/whatsapp/sources/sent-invoices.test.ts`

**Interfaces:**
- Produces: `MailboxClient.searchSent(token: string, query: { to: string; sinceDays: number; limit: number }, signal: AbortSignal): Promise<SentMail[] | MailboxFailure>`; `SentMail { providerMessageId; sentAt: string; subject: string; attachments: { attachmentId: string; filename: string; mediaType: string }[] }`. Gmail: `GET users/me/messages?q=in:sent to:{to} has:attachment newer_than:{n}d&maxResults={limit}` then metadata get; Graph: `GET /me/mailFolders/sentitems/messages?$filter=sentDateTime ge {iso}&$search="to:{to}"&$top={limit}&$expand=attachments($select=id,name,contentType)`. `to` must pass the same email-shape check as `emailDomainProblem`; refuse otherwise before any HTTP.
- `sentInvoicesOfSender: Tier2Source` — needs `ids.email`; filename or subject matches `/חשבונית|invoice|קבלה|receipt/i` and media type PDF; for each match `fetchAttachment` → `ingestDocument(source: 'mail')` → `INSERT contact_documents (assigned_by 'sent_mail') ON CONFLICT DO NOTHING`; returns items with `documentId`. Mailbox access via `resolveMailboxAccess`-style lookup (binding `mailbox` live + grant) — no mailbox → `[]`.
- [ ] **Step 1: Failing tests** — both providers build the exact URL above for `dana@x.co.il`; `refuses a malformed to without HTTP`; `only PDF attachments that look like invoices are ingested`; `no email on the contact → []`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`forbidden-ops.test.ts` still green).
- [ ] **Step 5: Commit** `feat(wa-contacts): sent-mail invoice search`.

### Task 5c: Accounting-system invoices with a row ownership check

**Files:**
- Create: `src/whatsapp/sources/accounting-invoices.ts`, `src/dashboard/contact-whatsapp-settings.ts` (route `GET/POST /settings/whatsapp-contacts`)
- Modify: `src/business/setup-package.ts` / settings-contacts: optional `externalIds: Record<string, string>` on `PersonEntry` (≤5 entries, keys = signed external system ids)
- Test: `src/whatsapp/sources/accounting-invoices.test.ts`

**Interfaces:**
- Consumes: `buildExternalRequest`, `sendExternal`, `countCallsToday`, `recordCall`, `extractFields` (`src/external/*`), credentials as in `scanExternalSystems`.
- Produces: `accountingInvoicesOfSender: Tier2Source`. Settings select a signed `read` operation of an active-charter system, the param name that carries the customer id, and the declared response field that carries the customer id per row (`contact_whatsapp_settings`).

Rule (§9.2): every returned row is kept only if its declared customer-id field equals the contact's `externalIds[systemId]` exactly; any dropped row marks the whole result `ownershipViolation: true` (add optional field to the returned array via a wrapper type `{ items; ownershipViolation }` — make `Tier2Source` return `Promise<{ items: SourceItem[]; ownershipViolation: boolean }>` and update 5a/5b accordingly in this task).
- [ ] **Step 1: Failing tests** — `keeps only rows carrying the contact's id`; `a foreign row sets ownershipViolation`; `no config or no externalId → empty, no HTTP`; `settings refuse an operation that is not kind read in the active charter`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): accounting invoices with ownership check`.

### Task 6: Tier-3 researcher (quarantined)

**Files:**
- Create: `src/sdk/contact-researcher.ts`
- Test: `src/sdk/contact-researcher.test.ts`

**Interfaces:**
- Produces: `type ContactResearcher = (req: { bundle: PolicyBundle; question: string; businessId: string; signal: AbortSignal }) => Promise<{ status: 'found'; findings: { text: string; documentId: string | null }[] } | { status: 'none' } | { status: 'failed'; reason: string }>`; `runContactResearcher: ContactResearcher`; pure helpers `buildResearchCall(req, nonce)` and `interpretResearch(raw)`.

Pattern: `know.reader` (`src/sdk/know-reader.ts`) — `cwd` = `businessDocumentFolder(businessId)` (`src/tenancy/paths.ts`), tools `Read`, `Glob`, `Grep` only, gated by the existing `createGateHook`; question fenced; ≤5 findings, each ≤500 chars; `maxTurns: 8`; model `sonnet`. Output is advisory text for the drafter, never a decision.
- [ ] **Step 1: Failing tests** — `call options carry only Read/Glob/Grep, env PATH, cwd under the business folder`; `fence nonce appears in system and user prompt`; `interpretResearch drops findings over 500 chars and more than 5`; `refuses under test`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): quarantined tier-3 researcher`.

### Task 7: Contact drafter (quarantined)

**Files:**
- Create: `src/sdk/contact-drafter.ts`
- Test: `src/sdk/contact-drafter.test.ts`

**Interfaces:**
- Produces: `type ContactDrafter = (req: ContactDraftRequest) => Promise<{ status: 'drafted'; body: string; usedTier3: boolean; attachDocumentId: string | null } | { status: 'failed'; reason: string }>`; `ContactDraftRequest { bundle; businessName: string; contactKind: 'client'|'supplier'|'unknown'; conversation: { direction: 'inbound'|'outbound'; body: string }[]; tier2: SourceItem[]; tier3: { text: string }[]; businessDescription?; businessProfile? }`; `runContactDrafter`.

Pattern: `src/sdk/mail-drafter.ts` (`tools: []`, `maxTurns: 1`, system prompt = `bundle.promptFragments['comms.whatsapp']` + `renderDescriptionSection` + `renderProfileSection` + contract). Contract text states: you are the business's digital assistant (H9); never state cost prices, profit, or anything about another person; answer only from the fenced sources; if the sources do not answer, write a proposal for the owner and say so. Each conversation message, tier-2 item and tier-3 finding fenced separately with its source label. `attachDocumentId` must be one of the `tier2[].documentId` values — `interpretContactDraft` nulls any other. Max body 1500 chars (WhatsApp).
- [ ] **Step 1: Failing tests** — `attachDocumentId outside tier2 is dropped`; `usedTier3 is true whenever tier3 is non-empty` (set in code, not by the model); `body over 1500 chars fails`; `prompt contains the H9 self-introduction rule and the confidentiality rule`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): quarantined contact drafter`.

### Task 8: Signed connection, adapter, runtime registration

**Files:**
- Create: `src/charter/amend-whatsapp-contacts.ts`, `src/dashboard/whatsapp-contacts-connect.ts`, `src/orchestrator/adapters/whatsapp-contacts.ts`
- Modify: `src/orchestrator/runtime.ts`, `src/dashboard/server.ts` (routes), connections page link
- Test: `src/charter/amend-whatsapp-contacts.test.ts`, `src/orchestrator/adapters/whatsapp-contacts.test.ts`, `src/dashboard/whatsapp-contacts-connect.test.ts`

**Interfaces:**
- Produces: `WHATSAPP_CONTACTS_SYSTEM = 'whatsapp-contacts'`; `buildWhatsAppContactsAmendment(active: BusinessCharter, now: Date): UnsignedCharter` (adds connection `{ name: 'whatsapp-contacts', target: 'whatsapp-contacts', channel: 'api', serves: ['wa.send_message'] }`, adds `'green-api'` to `subprocessorsAllowed`, copies the rest; throws `WhatsAppContactsAlreadyDeclaredError`); `buildWhatsAppContactsRevert(active, now): UnsignedCharter`.
- Routes `GET /connections/whatsapp-contacts`, `POST …/sign`, `POST …/revert` — the calendar-connect pattern (`base` = active version, `installSigned`, then a live `connection_bindings` row via `upsertBinding`). Sign page Hebrew copy states phase-1 scope only: "העוזרת תוכל לשלוח הודעות וואטסאפ ללקוחות ולספקים רק אחרי שאישרת כל הודעה, או בהוראה ישירה שלך." (Second switch is phase 2.)
- `createWhatsAppContactsAdapter(opts: { gateway: WhatsAppGateway; conversationNumber: (businessId: string, conversationId: string) => Promise<string | null>; recordOutbound: (businessId, input) => Promise<void> }): ExternalAdapter` serving `['wa.send_message']`. Input `{ to: string; body: string; conversationId?: string; sendAt?: string; attachDocumentId?: string }`. Refusals (all `ok: false`, Hebrew `message`): `to` fails `authorityNumberKey` → `bad_recipient`; `conversationId` given and its number ≠ `to` → `reply_recipient_mismatch`; attachment present but not in `call.attachments` → `attachment_missing`. Send: `gateway.sendMessage({ contactId: key, body, idempotencyKey: call.idempotencyKey })` (file via `sendFile` when attached, caption = body). `rejected` → non-retryable `whatsapp_rejected`; thrown error → `delivery_unknown` non-retryable (never blind retry).
- Runtime: register only when the active charter declares the connection **and** a live binding exists **and** `runtime.whatsapp?.gateway` exists; otherwise push a Hebrew-free warning string like the other adapters.
- [ ] **Step 1: Failing tests** — amendment copies every other field byte-for-byte (canonicalHash of the rest); adapter refusals each; `thrown gateway error is delivery_unknown and not retryable`; sign POST with a stale `base` re-renders and installs nothing.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): signed connection and adapter`.

### Task 9: `approvedReplyCovers` for contact-card jobs

**Files:**
- Modify: `src/policy/approved-reply.ts`
- Test: `src/policy/approved-reply.test.ts`

**Interfaces:**
- Changes the job condition from "mail reply job" to: (`facts.actionClass === 'email.reply'` AND `EXISTS mail_messages.reply_job_id = job`) OR (`facts.actionClass === 'whatsapp.reply'` AND `EXISTS contact_conversations.card_job_id = job` in the same business). Everything else unchanged (approved/approved_with_edit, unconsumed, unexpired, same tool, `input_hash_at_decision = facts.inputHash`). The approval-consumed audit marker stays `approved_reply_exemption`.
- [ ] **Step 1: Failing tests** — paired: the same approved `wa.send_message` payload on a job **with** a `contact_conversations.card_job_id` link passes stage 8 under dial `off`; **without** the link it is refused at stage 8 (`draft_only` AND no `intent_to_act` row — the project's rule for negative tests); `whatsapp.initiate` (no `conversationId`) never covered; edited bytes ≠ `input_hash_at_decision` refused.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Run `/security-review`** on the diff; fix findings.
- [ ] **Step 6: Commit** `feat(wa-contacts): approved reply exemption covers contact cards`.

### Task 10: The contact card — raise, present, answer on WhatsApp

**Files:**
- Create: `src/whatsapp/contact-card.ts`
- Modify: `src/orchestrator/whatsapp-open.ts` (`OpenOnWhatsApp.contactCards`), `src/orchestrator/whatsapp-mail-card.ts` and `whatsapp-document-card.ts` and `src/orchestrator/whatsapp-door.ts` confirmation reader — every collision count includes `contactCards`
- Test: `src/whatsapp/contact-card.test.ts`, `src/orchestrator/whatsapp-open.test.ts`

**Interfaces:**
- Produces:
  - `raiseContactCard(db, input: { conversation: ContactConversation; draft: { body: string; attachDocumentId: string | null }; reasonHe: string; sourcesHe: string[]; bundle: PolicyBundle; contactLabel: string }, options: { notify?: NotifyTarget }): Promise<{ jobId: string; approvalId: string }>` — mirrors private `raiseReplyCard` in `mail-reply.ts`: plan `{ agent: 'comms.whatsapp', toolName: 'wa.send_message', input: { to: '+'+key, body, conversationId, attachDocumentId? }, expectedActionClass: 'whatsapp.reply' }`, `createJob({ provenance: 'unknown_external' /* literal */ })`, `understand → plan`, `bindPlanToJob`, `enqueueApproval({ ttlMinutes: 4320, … })`, `await_approval`, `setCard`. Before raising: cancel the conversation's previous pending card (`cancelPendingApproval` + job `failed` with reason `'replaced by newer draft'`, `expectFrom: 'await_approval'`). On error: cancel + `failed`.
  - `CONTACT_CARD_INSTRUCTION = 'לאשר: "שלח". לתקן: "נוסח: <הטקסט>".'`; `presentContactCard(db, approvalId, send): Promise<boolean>` — text: who (name/number, לקוח/ספק/לא מוכר), what they asked (last inbound, `stripBidiControls` + `toOneLine`), what was found (sourcesHe), why not alone (reasonHe), proposed reply, instruction line. Sets `card_presented_at` only after `ok`.
  - `openContactCards(db, { excludeMessageId; inboundAt; windowMinutes? }): Promise<OpenContactCard[]>` — same shape/rules as `openMailCards`, keyed on `contact_conversations.card_job_id` and the outbound row ending with `CONTACT_CARD_INSTRUCTION`.
  - `handleContactCardMessage(db, { msg; storedId; cards; messenger; othersOpen: number }): Promise<'decided'|'replaced'|'refused'|'passthrough'|'skipped'>` — reuses `isApproveWord`/`replacementBody`; typed text only; one open thing total or `SEVERAL_OPEN_REFUSAL`; `contactReplyEditAllowed(original, edited)` = only `body` differs.
- [ ] **Step 1: Failing tests** — Review Focus 2 (`"שלח" with a contact card and a mail card open is refused, nothing decided`); Review Focus 4 (`"שלח" after the card was replaced or expired decides nothing`); `audio or caption never decides`; `"נוסח:" raises a new card with only the body changed`; `a new draft cancels the previous pending card`; `presentation not recorded when send fails`.
- [ ] **Step 2–4:** FAIL → implement → PASS (existing whatsapp-door, mail-card and document-card suites still green).
- [ ] **Step 5: Commit** `feat(wa-contacts): contact card`.

### Task 11: Door integration — the contact flow

**Files:**
- Create: `src/whatsapp/contact-flow.ts`
- Modify: `src/orchestrator/whatsapp-door.ts` (`processOne` `'other'` branch; `DoorResult` gains `contactHandled`, `contactCapped`), `src/orchestrator/scheduler.ts` (pass `contactFlow` deps into `runWhatsAppDoor`)
- Test: `src/whatsapp/contact-flow.test.ts`, `src/orchestrator/whatsapp-door.test.ts`, `src/orchestrator/whatsapp-colleague.test.ts` (must stay green)

**Interfaces:**
- Consumes: Tasks 2–8, 10.
- Produces: `handleContactMessage(db, deps: ContactFlowDeps, input: { msg: NormalizedInboundMessage; storedId: string; sender: Exclude<ResolvedSender, { kind: 'principal' }> }): Promise<'recordedOnly'|'carded'|'capped'>`; `ContactFlowDeps { gateway; messenger: BossMessenger; bundle; charter; businessName; researcher: ContactResearcher; drafter: ContactDrafter; sources: Tier2Source[]; transcribe?; notify?; now: () => Date }`.

Flow: colleague, or `key === null`, or group → `settleMessage('handled')` with `sender_kind` set → `recordedOnly`. Otherwise `openOrAppend` → `sendHoldingReply` (fire once) → caps: business `contactWaReadsPerDay` (count today's `contact_conversations` drafts via audit `contact_draft` rows) and per contact 30 → over cap: card without draft (`reasonHe: 'הגיעה התקרה היומית — לא נוסחה הצעה'`) → `capped`. Audio from a contact transcribed under `whatsappTranscribeOtherPerDay`; image/document from a contact ingested `source: 'api'` (tier 3 only). Unknown sender: no tier-2 calls at all. Gather tier 2 (contact only) with a 30 s deadline each, tier 3 researcher (60 s), draft (60 s), write audit `contact_draft` (kind `tool_call`, counts only), raise + present card. Any ownershipViolation or researcher/drafter failure still raises a card with the reason in Hebrew. Message settles `handled` with `jobId` of the card.
- [ ] **Step 1: Failing tests** — Review Focus 1 (`five messages in a burst: one conversation, one holding reply, one live card`); `unknown number: holding + card, no tier-2 source called` (spy sources); `colleague: recorded only, no holding`; `over cap: card without model calls`; `principal path unchanged` (existing door tests).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): door routes contacts to holding reply and card`.

### Task 12: Scheduler — reminders, expiry, decisions, due holdings

**Files:**
- Create: `src/whatsapp/contact-housekeeping.ts`
- Modify: `src/orchestrator/scheduler.ts` (after `runWhatsAppDoor`: `sendDueHoldingReplies`; after `closeVerifiedJobs`: `contactHousekeeping`)
- Test: `src/whatsapp/contact-housekeeping.test.ts`

**Interfaces:**
- Produces: `contactHousekeeping(db, deps: { messenger: BossMessenger; now: Date }): Promise<{ reminded; expired; answered; decisionsRecorded }>`:
  - card `carded`, `card_presented_at <= now - 5h`, `reminder_sent_at IS NULL`, approval still pending → re-present with lead `'תזכורת: עדיין ממתין לאישורך'`, set `reminder_sent_at` only on `ok`.
  - approval `expired`/`cancelled`/`denied` → conversation `expired`/`closed`; job closed (`denied`) or followup handling per existing `resume.ts` — do not duplicate, only close the conversation.
  - card job reached `closed` with a performed step → conversation `answered`.
  - every decided approval of a card job without a `contact_reply_decisions` row → insert with `agreementVerdict({ state, proposed, edited })` and `source_tiers` from the plan step (`['tier2']`, `['tier3']`, `['tier2','tier3']`, or `[]` for unknown senders) — `ON CONFLICT (business_id, approval_id) DO NOTHING`.
- [ ] **Step 1: Failing tests** — `reminder after 5 h, exactly once`; `no reminder at 4h59m`; `decision recorded once with verdict right for approved and wrong for denied`; `expired approval closes the conversation`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): reminders, expiry and decision log`.

### Task 13: Owner-ordered WhatsApp to a contact (scheduled, H2 + H15)

**Files:**
- Modify: `src/orchestrator/instruct.ts` (`planAndCheck`), `src/orchestrator/command-echo.ts` (`sendAt` field label), `src/orchestrator/execute.ts` (defer before send), `src/policy/confirmed-command.ts`, `src/orchestrator/command-reask.ts`, `src/orchestrator/local-tools.ts` (`LOCAL_TOOL_CONTRACTS` entry rendering the `wa.send_message` payload contract to the planner)
- Test: `src/orchestrator/instruct-whatsapp.test.ts`, `src/policy/confirmed-command.test.ts`, `src/orchestrator/execute.test.ts`, `src/orchestrator/command-reask.test.ts`

**Interfaces:**
- `planAndCheck` refuses a `wa.send_message` step whose `to` is neither a managed contact's phone (`listManagedContacts`) nor typed verbatim in a typed instruction (`appearsVerbatimIn`, phone key), Hebrew reason `'אפשר לשלוח בוואטסאפ רק לאיש קשר ששמרת או למספר שהקלדת בהוראה.'`; refuses `sendAt` that is not ISO, in the past, or more than 30 days ahead.
- Echo: `sendAt` shown as `"בשעה"` in the charter timezone; `to` shown with the source: `"(איש קשר ששמרת: <שם>)"` or `"(הוקלד בהוראה)"`.
- `executeStep`: a `wa.send_message` step with future `sendAt` → job `followup` with `wakeAt = sendAt`, reason `'scheduled send'`, before the gate is consulted.
- `confirmedCommandCovers`: replace the SQL `decided_at > now() - interval '24 hours'` with a JS check after the row is read: allowed if `now - decided_at < 24h`, OR the matched step has `sendAt` with `decided_at < sendAt` and `now < sendAt + 24h` **and** the job's `charter_version` equals the active charter version.
- `reaskFailedCommands` arm (c) skips a followup job whose woken step has a `sendAt` still in the future.
- [ ] **Step 1: Failing tests** — `confirmed tonight, sendAt in 3 days: covered at sendAt` (paired with `same but charter re-signed in between: not covered and reasked`); `no sendAt: 25 h after decision not covered` (existing behaviour kept); `recipient learned from a document is refused at plan time`; `typed number accepted`; `sendAt 31 days ahead refused`; `executeStep parks a future sendAt without calling the adapter`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Run `/security-review`**; fix findings.
- [ ] **Step 6: Commit** `feat(wa-contacts): owner-ordered scheduled WhatsApp to a contact`.

### Task 14: Erasure wiring

**Files:**
- Modify: `src/governance/erasure-plan.ts`, `src/governance/erasure.ts`, `src/governance/erasure-invariants.test.ts`, `src/governance/erasure-plan.test.ts`

**Interfaces:**
- `CONTACT_CONVERSATIONS_ERASED_PREDICATE` — contact arm: `contact_key` equals the anchor's phone key, or job arm `card_job_id = ANY($2)`, window arm on `opened_at`; discovery adds `card_job_id` to `jobIds`.
- `CONTACT_REPLY_DECISIONS_ERASED_PREDICATE = 'business_id = $1 AND job_id = ANY ($2)'`.
- `CONTACT_DOCUMENTS_ERASED_PREDICATE` — by `contact_key` (contact anchor) or `document_id = ANY(documentIds)`; contact anchor also adds those `document_id`s to `documentIds`.
- `WHATSAPP_MESSAGES_ERASED_PREDICATE` contact arm also matches `recipient_number`.
- Each predicate shared verbatim by `countItems` and the executor; deletion order: decisions, documents, conversations before jobs.
- [ ] **Step 1: Failing tests** — invariant seeds `PROBE` in `contact_conversations` (via a contact-key column is digits — seed the probe phone), `whatsapp_messages.recipient_number`, and asserts zero rows after erasure; `contact_reply_decisions` and `contact_documents` checked deleted directly (no text columns).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(wa-contacts): erasure covers contact conversations`.

### Task 15: Docs and pre-launch checklist

**Files:**
- Modify: `CLAUDE.md` (new subsection "וואטסאפ ללקוחות ולספקים — שלב 1"; the table count "39 טבלאות" → 42; holding reply added to the documented gate-bypass list; `approvedReplyCovers` paragraph mentions contact cards), `docs/08-risks.md` (holding bypass; sent-mail search scope), `docs/10-user-settings.md` (contact kind/email/externalIds, invoice lookup settings, connection sign page), `docs/11-pre-launch-checks.md` (live GREEN-API contact send; sent-mail search on real Gmail/Graph; accounting ownership check on a real system; researcher and drafter live runs)
- [ ] **Step 1:** write the sections; each claim must point to a file that exists after Tasks 1–14.
- [ ] **Step 2: Run** `npm run typecheck` and `npm test` on the dedicated DB → all green.
- [ ] **Step 3: Commit** `docs(wa-contacts): phase 1`.
