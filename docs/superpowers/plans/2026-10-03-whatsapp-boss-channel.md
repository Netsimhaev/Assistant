# WhatsApp Boss Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The business owner instructs the assistant over WhatsApp, with the same authority as through the dashboard; she acknowledges immediately, executes, and reports what actually happened.

**Architecture:** A pull-based `WhatsAppGateway` polled from inside `schedulerPass` — no inbound HTTP port, because this machine holds the master key and listens only on loopback today. Inbound messages land in one store that is the source of truth for both surfaces. Messages from the signed charter's principal go to the existing `runInstruction`; everything else is recorded and never acted on. Outbound to the owner follows the notifier pattern (bypasses the gate, no recipient parameter), never the adapter pattern.

**Tech Stack:** TypeScript NodeNext ESM · PostgreSQL 17 via `pg` · zod · vitest against a real database · GREEN-API (unofficial WhatsApp bridge) · an injected speech-to-text provider

**Spec:** [docs/superpowers/specs/2026-10-01-whatsapp-boss-channel-design.md](../specs/2026-10-01-whatsapp-boss-channel-design.md) — read it first; it carries the seven owner decisions and the reservations they were made against.

## Global Constraints

- **`.js` on every relative import**, including from `.ts` files. Required by `NodeNext` + `"type": "module"`.
- **Three biting tsconfig flags:** `noUncheckedIndexedAccess` (forces `rows[0]?.x` in all DB code), `exactOptionalPropertyTypes` (forces conditional spread: `x ? { x } : {}`), `verbatimModuleSyntax` (forces `import type` to be exact).
- **Tests need a real Postgres.** No mocks, no in-memory DB. `resetDatabase()` uses TRUNCATE with a hand-written table list — a new table must be added to it or tests leak into each other.
- **Hebrew for humans, English for code.** Refusal messages and anything the owner reads: Hebrew. Identifiers, comments, internal errors: English.
- **Every module that reads DB rows:** a private `interface XRow` plus a `toX(row)` function. SQL in `snake_case`, TS in `camelCase`.
- **A zod schema and its inferred type share one name:** `export const Foo = z.object({…}); export type Foo = z.infer<typeof Foo>;`
- **Controls are written positively, never as a negation.** "Is the sender in the list" — never "is the sender not a stranger". `src/policy/positive-controls.test.ts` locks this class.
- **A value we failed to read is never a permissive value.** A missing or unparseable cap reads as the switch being OFF, never as "unlimited".
- **Every negative test must be mutation-verified**: remove the behaviour it names, watch the test fail, restore. A test that passes with and without the code it covers is not a test.
- **`provenance: 'boss'` is a literal in the call body**, never a parameter a caller can aim. Locked by `src/orchestrator/instruction-invariants.test.ts`.
- **No secret value in any log, error, audit row, returned summary, or rendered page.** GREEN-API credentials and the transcription key are resolved from the encrypted store at point of use.
- **`businessId` is mandatory with no default on every credential path.** `options.businessId ?? config.businessId` is forbidden there.
- **The project's completion ritual** after anything changes: `npm run typecheck` and `npm test`. `/security-review` additionally when the change touches `policy/engine.ts`, `charter/capabilities.ts`, `policy/classify.ts`, `util/canonical.ts`, `audit/log.ts`, or a migration file — **Task 2 touches a migration, so it needs one.**

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/036_whatsapp.sql` | `whatsapp_messages`, `jobs.whatsapp_message_id` |
| `src/whatsapp/gateway.ts` | The `WhatsAppGateway` interface and `NormalizedInboundMessage`. No implementation. |
| `src/whatsapp/fake-gateway.ts` | Test double every later task's tests drive |
| `src/whatsapp/green-api.ts` | The real pull-based implementation (Task 11) |
| `src/whatsapp/store.ts` | Source of truth: insert-with-dedupe, claim, settle, list |
| `src/whatsapp/transcribe.ts` | Audio → text, injected provider, two daily caps, length cap |
| `src/whatsapp/messenger.ts` | Outbound to the principal only. Never throws. No recipient parameter. |
| `src/governance/principal-number.ts` | Resolve a sender number against the signed charter. Deterministic. |
| `src/orchestrator/whatsapp-door.ts` | Poll → dedupe → store → transcribe → identify → `runInstruction` → ack |
| `src/orchestrator/whatsapp-report.ts` | After jobs close: report from what the steps *performed* |
| `src/dashboard/conversation-view.ts` | Renders the conversation screen |

---

## Task 1: The GREEN-API spike

**This is the only task that needs the owner, and it blocks Task 11 alone.** Tasks 2–10 run against `fake-gateway.ts` and do not wait for it. Start it, then proceed.

[docs/08b-whatsapp-bridge.md](../../08b-whatsapp-bridge.md) §7 calls the GREEN-API assumption "the most fragile assumption in the whole design". It is right, and nothing in this plan can verify it from documentation.

**Files:**
- Create: `docs/superpowers/2026-10-03-whatsapp-spike-findings.md`

- [ ] **Step 1: Link a TEST number, never a business number**

GREEN-API has a free Developer tier. Link a throwaway SIM. A ban during the spike must cost nothing.

- [ ] **Step 2: Measure these six, and write the answer beside each**

1. **Does the pull API behave like a queue?** Receive a notification, delete it, receive again — does the same message come back? Do messages arrive out of order? What happens to messages sent while the poller is stopped for ten minutes?
2. **What does `health()` actually report** when the session drops, and how long does reconnect take?
3. **How is audio delivered** — a URL, a base64 blob, which container and codec? This decides whether `transcribe.ts` needs a conversion step.
4. **What arrives for media, for groups, and for a forwarded message?**
5. **What happens when their own protection pauses sending**, and how is it reported?
6. **Exact field names and types** of the inbound payload. Task 11 maps these to `NormalizedInboundMessage`.

- [ ] **Step 3: Write findings, including what you could not determine**

A finding of "could not test this" is a real finding. Do not fill a gap with a guess from their documentation — that is the thing this spike exists to replace.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/2026-10-03-whatsapp-spike-findings.md
git commit -m "Spike: what GREEN-API actually does, measured on a test number"
```

---

## Task 2: Migration 036, the store, and the erasure wiring

**Files:**
- Create: `src/db/migrations/036_whatsapp.sql`
- Create: `src/whatsapp/store.ts`
- Create: `src/whatsapp/store.test.ts`
- Modify: `src/test/db.ts` (add both tables to `resetDatabase`'s list)
- Modify: `src/governance/erasure-plan.ts` (count the new table)
- Modify: `src/governance/erasure.ts` (delete from the new table)
- Modify: `src/governance/erasure-invariants.test.ts` (seed the probe into the new table)

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export type MessageDirection = 'inbound' | 'outbound';
export type SenderKind = 'principal' | 'other';
export type MessageState = 'received' | 'claimed' | 'handled' | 'failed';

export interface StoredMessage {
  id: string;
  providerMessageId: string | null;
  direction: MessageDirection;
  senderNumber: string | null;
  senderKind: SenderKind | null;
  body: string | null;
  transcript: string | null;
  mediaKind: string | null;
  providerTimestamp: string;
  state: MessageState;
  jobId: string | null;
  createdAt: string;
}

/** Returns null when `providerMessageId` already exists — a real dedupe, not best-effort. */
export function recordInbound(
  input: {
    providerMessageId: string;
    senderNumber: string;
    senderKind: SenderKind;
    body: string | null;
    mediaKind: string | null;
    providerTimestamp: string;
  },
  options?: { businessId?: string },
): Promise<StoredMessage | null>;

export function recordOutbound(
  input: { body: string; jobId: string | null },
  options?: { businessId?: string },
): Promise<StoredMessage>;

/** Moves `received` → `claimed`. Returns false when it was not `received`. */
export function claimMessage(id: string, options?: { businessId?: string }): Promise<boolean>;

export function settleMessage(
  id: string,
  state: 'handled' | 'failed',
  patch?: { transcript?: string; jobId?: string },
  options?: { businessId?: string },
): Promise<void>;

/** Oldest first, by the provider's own timestamp. */
export function unclaimedInbound(options?: { businessId?: string; limit?: number }): Promise<StoredMessage[]>;

/** Newest last, for the conversation screen. */
export function conversation(options?: { businessId?: string; limit?: number }): Promise<StoredMessage[]>;
```

- [ ] **Step 1: Write the migration**

```sql
-- src/db/migrations/036_whatsapp.sql
--
-- The conversation between the owner and the assistant, and everything else
-- that arrives at the same number.
--
-- `provider_message_id` is UNIQUE per business and that is the whole dedupe
-- mechanism: GREEN-API may redeliver, and "we probably already saw this" is
-- not a control. It is NULL for outbound rows, which the assistant originates
-- and the provider has not named yet; a partial unique index covers only the
-- rows that have one.
--
-- `state` exists because the claim is written BEFORE `runInstruction` is
-- called. A crash between the two loses one instruction rather than sending a
-- second email — the safe direction, and the same choice
-- `markContentIngested` makes in `src/documents/read.ts`.
CREATE TABLE whatsapp_messages (
    id                   TEXT        PRIMARY KEY,
    business_id          TEXT        NOT NULL,
    provider_message_id  TEXT,
    direction            TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    sender_number        TEXT,
    sender_kind          TEXT        CHECK (sender_kind IN ('principal', 'other')),
    body                 TEXT,
    transcript           TEXT,
    media_kind           TEXT,
    provider_timestamp   TIMESTAMPTZ NOT NULL,
    state                TEXT        NOT NULL CHECK (state IN ('received', 'claimed', 'handled', 'failed')),
    job_id               TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX whatsapp_messages_provider_idx
    ON whatsapp_messages (business_id, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

CREATE INDEX whatsapp_messages_pending_idx
    ON whatsapp_messages (business_id, state, provider_timestamp)
    WHERE state = 'received';

CREATE INDEX whatsapp_messages_convo_idx
    ON whatsapp_messages (business_id, provider_timestamp DESC);

-- Which inbound message opened this job, so the report knows where to reply.
-- `job_id` on the message alone cannot answer that: several messages can carry
-- the same job, and only one of them opened it.
ALTER TABLE jobs ADD COLUMN whatsapp_message_id TEXT;
```

- [ ] **Step 2: Run the migration on both databases**

```bash
npm run migrate
npm run migrate:test
```

- [ ] **Step 3: Add both tables to `resetDatabase`**

In `src/test/db.ts`, add `whatsapp_messages` to the TRUNCATE list. `jobs` is already there, so the new column needs nothing.

- [ ] **Step 4: Write the failing tests**

```ts
// src/whatsapp/store.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import {
  claimMessage, conversation, recordInbound, recordOutbound, settleMessage, unclaimedInbound,
} from './store.js';

const BUSINESS = 'test-business';
const base = {
  senderNumber: '+972541234567',
  senderKind: 'principal' as const,
  body: 'שלח לדנה',
  mediaKind: null,
  providerTimestamp: '2026-10-03T09:00:00.000Z',
};

describe('whatsapp store', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closePool(); });

  /**
   * The dedupe is the unique index, not a prior read. GREEN-API redelivering a
   * message must not produce a second instruction, and "we probably saw this"
   * is not a control.
   */
  it('records an inbound message once, and returns null for a redelivery', async () => {
    const first = await recordInbound({ ...base, providerMessageId: 'wamid.1' }, { businessId: BUSINESS });
    expect(first).not.toBeNull();
    const second = await recordInbound({ ...base, providerMessageId: 'wamid.1' }, { businessId: BUSINESS });
    expect(second).toBeNull();
    expect(await conversation({ businessId: BUSINESS })).toHaveLength(1);
  });

  /**
   * The claim is what makes a crash lose one instruction instead of sending a
   * second email. Two concurrent claims on one row: exactly one wins.
   */
  it('lets exactly one caller claim a message', async () => {
    const msg = await recordInbound({ ...base, providerMessageId: 'wamid.2' }, { businessId: BUSINESS });
    if (msg === null) throw new Error('unreachable');
    const [a, b] = await Promise.all([
      claimMessage(msg.id, { businessId: BUSINESS }),
      claimMessage(msg.id, { businessId: BUSINESS }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('hands out unclaimed inbound oldest first, and stops offering a claimed one', async () => {
    await recordInbound({ ...base, providerMessageId: 'w.late', providerTimestamp: '2026-10-03T09:05:00.000Z' }, { businessId: BUSINESS });
    const early = await recordInbound({ ...base, providerMessageId: 'w.early', providerTimestamp: '2026-10-03T09:01:00.000Z' }, { businessId: BUSINESS });
    if (early === null) throw new Error('unreachable');

    const queue = await unclaimedInbound({ businessId: BUSINESS });
    expect(queue.map((m) => m.providerMessageId)).toEqual(['w.early', 'w.late']);

    await claimMessage(early.id, { businessId: BUSINESS });
    expect((await unclaimedInbound({ businessId: BUSINESS })).map((m) => m.providerMessageId)).toEqual(['w.late']);
  });

  it('settles a message with its transcript and job, and keeps outbound in the conversation', async () => {
    const msg = await recordInbound({ ...base, providerMessageId: 'w.3', body: null, mediaKind: 'audio' }, { businessId: BUSINESS });
    if (msg === null) throw new Error('unreachable');
    await claimMessage(msg.id, { businessId: BUSINESS });
    await settleMessage(msg.id, 'handled', { transcript: 'שלח לדנה', jobId: 'J-1' }, { businessId: BUSINESS });
    await recordOutbound({ body: 'קיבלתי.', jobId: 'J-1' }, { businessId: BUSINESS });

    const convo = await conversation({ businessId: BUSINESS });
    expect(convo).toHaveLength(2);
    expect(convo[0]?.transcript).toBe('שלח לדנה');
    expect(convo[0]?.state).toBe('handled');
    expect(convo[1]?.direction).toBe('outbound');
  });

  /** One business must never read another's conversation. */
  it('confines every read to its own business', async () => {
    await recordInbound({ ...base, providerMessageId: 'w.4' }, { businessId: BUSINESS });
    expect(await conversation({ businessId: 'other-business' })).toEqual([]);
    expect(await unclaimedInbound({ businessId: 'other-business' })).toEqual([]);
  });
});
```

- [ ] **Step 5: Run them and watch them fail**

Run: `npx vitest run src/whatsapp/store.test.ts`
Expected: FAIL — `Cannot find module './store.js'`

- [ ] **Step 6: Implement `src/whatsapp/store.ts`**

Follow the project's row convention: a private `interface MessageRow` with `snake_case` fields plus a `toStoredMessage(row)`. Use `ON CONFLICT (business_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING` with `RETURNING *`, and return `null` when nothing came back — that is what makes the dedupe the index rather than a read. `claimMessage` is a single `UPDATE … SET state='claimed' WHERE id=$1 AND business_id=$2 AND state='received'` returning `rowCount === 1`; a read-then-write would let two pollers both proceed. Generate ids with whatever the project already uses for `job_id` (see `src/orchestrator/jobs.ts`).

- [ ] **Step 7: Run them and watch them pass**

Run: `npx vitest run src/whatsapp/store.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 8: Wire the new table into erasure**

`whatsapp_messages.body`, `.transcript` and `.sender_number` are content about a person in exactly the sense `boss_instructions.text` already is. In `src/governance/erasure-plan.ts`, add it to `countItems` alongside the twelve existing tables; in `src/governance/erasure.ts`, add the matching delete. Both name their tables by hand on purpose — the schema-derived part is only the verification.

Scope it the way `boss_instructions` is scoped: by `job_id` for the job anchor, by `created_at` for the window anchor, and by matching `sender_number`/`body`/`transcript` for the contact anchor.

- [ ] **Step 9: Seed the probe into the new table**

In `src/governance/erasure-invariants.test.ts`, add the unique probe identifier to a `whatsapp_messages` row. **Keep the underscore in the probe value** — `_` is a literal in a phone-ish string and a wildcard to `LIKE`, so a probe carrying one only matches when the escaping works end to end. That is the trap the existing comment in that file describes.

- [ ] **Step 10: Run the erasure suite**

Run: `npx vitest run src/governance/erasure-invariants.test.ts src/governance/erasure.test.ts src/governance/erasure-plan.test.ts`
Expected: PASS

- [ ] **Step 11: Mutation-verify the erasure wiring**

Remove the `whatsapp_messages` delete from the executor, leaving it in `countItems`. Run the invariant test — it must FAIL, because the probe survives. Restore.

- [ ] **Step 12: Commit**

```bash
git add src/db/migrations/036_whatsapp.sql src/whatsapp/store.ts src/whatsapp/store.test.ts src/test/db.ts src/governance/erasure-plan.ts src/governance/erasure.ts src/governance/erasure-invariants.test.ts
git commit -m "The conversation store: dedupe by the provider's id, claim before acting, erasable"
```

- [ ] **Step 13: Security review (migration touched)**

Run `/security-review` on this task's diff, as the project's completion ritual requires for any change to a migration file.

---

## Task 3: Who the principal is

**Files:**
- Create: `src/governance/principal-number.ts`
- Create: `src/governance/principal-number.test.ts`
- Modify: `src/charter/sign.ts` (validate the number's shape at signing)

**Interfaces:**
- Consumes: `BusinessCharter` from `src/domain/charter.js`.
- Produces:
```ts
/** Digits only, full international form. Returns null when the value is not one. */
export function authorityNumberKey(value: string): string | null;

/** The principal's WhatsApp number as a comparable key, or null when the charter declares none. */
export function principalWhatsAppKey(charter: BusinessCharter): string | null;

/** Positive check: is this sender the principal? */
export function isPrincipalSender(charter: BusinessCharter, senderNumber: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/governance/principal-number.test.ts
import { describe, expect, it } from 'vitest';
import { buildCharter } from '../test/fixtures.js';
import { authorityNumberKey, isPrincipalSender, principalWhatsAppKey } from './principal-number.js';

function charterWithPrincipalNumber(number: string | undefined) {
  const base = buildCharter();
  const people = base.people.map((p, i) =>
    i === 0 ? { ...p, isPrincipal: true, channels: number === undefined ? {} : { whatsapp: number } } : p,
  );
  return { ...base, people };
}

describe('authorityNumberKey', () => {
  it('normalises the forms a real charter carries', () => {
    expect(authorityNumberKey('+972541234567')).toBe('972541234567');
    expect(authorityNumberKey('+972-54-123-4567')).toBe('972541234567');
    expect(authorityNumberKey(' +972 54 1234567 ')).toBe('972541234567');
  });

  /**
   * An authority list must not accept a national form. `054...` and
   * `+972 54...` are the same person to a human and different strings here,
   * and guessing a country code for an authority check is inventing authority.
   */
  it('refuses anything that is not a full international number', () => {
    expect(authorityNumberKey('0541234567')).toBeNull();
    expect(authorityNumberKey('541234567')).toBeNull();
    expect(authorityNumberKey('')).toBeNull();
    expect(authorityNumberKey('not a number')).toBeNull();
    expect(authorityNumberKey('+972')).toBeNull();
  });
});

describe('isPrincipalSender', () => {
  it('resolves the principal and nobody else', () => {
    const charter = charterWithPrincipalNumber('+972541234567');
    expect(isPrincipalSender(charter, '+972541234567')).toBe(true);
    expect(isPrincipalSender(charter, '+972549999999')).toBe(false);
  });

  /**
   * THE TRAP THIS MODULE EXISTS FOR. `phoneKey` in `src/charter/compile.ts`
   * compares the last NINE digits, and it is right where it sits: for a
   * do-not-contact list a coarse match errs safe, because it blocks more. For
   * an AUTHORITY list the same coarseness errs the other way — a different
   * number sharing nine trailing digits would be read as the owner.
   */
  it('does not resolve a different number that shares its last nine digits', () => {
    const charter = charterWithPrincipalNumber('+972541234567');
    // Israeli +972-54-123-4567 and a US number ending in the same nine digits.
    expect(isPrincipalSender(charter, '+1541234567')).toBe(false);
    expect(isPrincipalSender(charter, '+999541234567')).toBe(false);
  });

  it('treats a charter with no principal number as having no authorised sender', () => {
    const charter = charterWithPrincipalNumber(undefined);
    expect(principalWhatsAppKey(charter)).toBeNull();
    expect(isPrincipalSender(charter, '+972541234567')).toBe(false);
  });

  /** Positive check: an unparseable sender is not the principal. Never the reverse. */
  it('refuses a sender whose own number does not normalise', () => {
    const charter = charterWithPrincipalNumber('+972541234567');
    expect(isPrincipalSender(charter, '0541234567')).toBe(false);
    expect(isPrincipalSender(charter, '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/governance/principal-number.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/governance/principal-number.ts
/**
 * Who is allowed to instruct the assistant over WhatsApp.
 *
 * **The list is already in the signed charter.** `CharterPerson.isPrincipal`
 * ("the boss"; the charter already validates that exactly one person carries
 * it) plus `channels.whatsapp`, where `Channel` names `whatsapp` explicitly.
 * No schema change, no `CURRENT_SCHEMA_VERSION` bump, no re-signing — and
 * `isPrincipal`, whose only reader today merely validates its uniqueness,
 * finally has a real one.
 *
 * **Deterministic, never a model call.** Same reason stated at the top of
 * `src/memory/contact-resolver.ts`: whoever lets a model decide which "Ronit"
 * was meant, lets it decide who receives an email. Here it is sharper —
 * whoever lets a model decide who the boss is, lets it decide who operates
 * the business.
 *
 * **Exact match, and not the nine-digit key.** `phoneKey`
 * (`src/charter/compile.ts`) compares the last nine digits, which is correct
 * where it lives: on a do-not-contact list a coarse match errs safe because it
 * blocks more. On an authority list the identical coarseness errs the other
 * way — two different numbers sharing nine trailing digits would both read as
 * the owner. So this module keeps its own normaliser and compares in full.
 */
import type { BusinessCharter } from '../domain/charter.js';

/**
 * Digits only, full international form.
 *
 * A national form (`054…`) is refused rather than guessed at: inferring a
 * country code for an authority check is inventing authority. Minimum length
 * is a country code plus a subscriber number; below that nothing is a real
 * number and a short string must never match by accident.
 */
const MIN_INTERNATIONAL_DIGITS = 10;
const MAX_INTERNATIONAL_DIGITS = 15; // E.164

export function authorityNumberKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('+')) return null;
  const digits = trimmed.slice(1).replace(/[\s\-()./]/g, '');
  if (!/^[0-9]+$/.test(digits)) return null;
  if (digits.length < MIN_INTERNATIONAL_DIGITS || digits.length > MAX_INTERNATIONAL_DIGITS) return null;
  return digits;
}

export function principalWhatsAppKey(charter: BusinessCharter): string | null {
  const principal = charter.people.find((p) => p.isPrincipal);
  const declared = principal?.channels['whatsapp'];
  if (declared === undefined) return null;
  return authorityNumberKey(declared);
}

export function isPrincipalSender(charter: BusinessCharter, senderNumber: string): boolean {
  const authorised = principalWhatsAppKey(charter);
  if (authorised === null) return false;
  const sender = authorityNumberKey(senderNumber);
  if (sender === null) return false;
  return sender === authorised;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/governance/principal-number.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Reject a bad number at signing, after normalisation**

In `src/charter/sign.ts`, where the other charter-shape checks live, refuse a charter whose principal declares a `channels.whatsapp` that `authorityNumberKey` returns `null` for. Message in Hebrew, naming the field and the required form.

**Validate after normalising, against the string the compiler actually keeps.** This is the rule the project learned from the email-domain bug: `isValidEmailDomain` was `normaliseDomainString(domain) !== null`, so `*.rival.co.il` was signed, compiled into `doNotContact`, and blocked nothing. A number that merely "normalises to something" is the same defect.

- [ ] **Step 6: Write the signing test**

```ts
// append to src/charter/sign.test.ts
it('refuses to sign a principal WhatsApp number that is not a full international form', () => {
  const base = buildCharter();
  const people = base.people.map((p, i) =>
    i === 0 ? { ...p, isPrincipal: true, channels: { whatsapp: '0541234567' } } : p,
  );
  expect(() => signCharter({ ...base, people }, { signedByPersonId: 'owner', method: 'dashboard_click' }))
    .toThrow(/\+972/);
});
```

- [ ] **Step 7: Run the charter suite**

Run: `npx vitest run src/charter/`
Expected: PASS

- [ ] **Step 8: Mutation-verify the nine-digit trap**

Replace `authorityNumberKey`'s body with `const d = value.replace(/\D/g, ''); return d.length < 9 ? null : d.slice(-9);` — the charter-side rule. The test named `does not resolve a different number that shares its last nine digits` must FAIL. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/governance/principal-number.ts src/governance/principal-number.test.ts src/charter/sign.ts src/charter/sign.test.ts
git commit -m "The principal's number: an existing signed field gets a reader, and an exact one"
```

---

## Task 4: The gateway interface and a fake

**Files:**
- Create: `src/whatsapp/gateway.ts`
- Create: `src/whatsapp/fake-gateway.ts`
- Create: `src/whatsapp/fake-gateway.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export interface NormalizedInboundMessage {
  providerMessageId: string;
  senderNumber: string;
  body: string | null;
  /** `null` for a plain text message. `'audio'` is the only kind Task 6 acts on. */
  mediaKind: string | null;
  /** Resolves the audio bytes. Present only when `mediaKind === 'audio'`. */
  downloadAudio?: () => Promise<{ bytes: Buffer; mimeType: string; seconds: number }>;
  providerTimestamp: string;
}

export type GatewayHealth =
  | { state: 'connected'; since: string }
  | { state: 'reconnecting' | 'qr_required' | 'throttled' | 'banned'; since: string; detail?: string };

export interface WhatsAppGateway {
  /** Whether free text may be sent to this contact right now. Never assumes true. */
  canSendFreeform(contactId: string): Promise<boolean>;
  sendMessage(input: {
    contactId: string; body: string; idempotencyKey: string;
  }): Promise<{ messageId: string; state: 'sent' | 'queued' | 'rejected' }>;
  health(): Promise<GatewayHealth>;
  /** Registers the handler. Push and pull implementations both satisfy this. */
  onInbound(handler: (msg: NormalizedInboundMessage) => Promise<void>): void;
  /** Drains whatever is waiting. A push implementation may make this a no-op. */
  pollOnce(): Promise<number>;
}

export interface FakeGateway extends WhatsAppGateway {
  /** Queue a message for the next `pollOnce`. */
  enqueue(msg: NormalizedInboundMessage): void;
  /** Everything `sendMessage` was asked to send, in order. */
  readonly sent: Array<{ contactId: string; body: string; idempotencyKey: string }>;
  setHealth(health: GatewayHealth): void;
  /** Makes the next `sendMessage` reject, so callers can prove they survive it. */
  failNextSend(): void;
}
export function createFakeGateway(): FakeGateway;
```

- [ ] **Step 1: Write `gateway.ts`**

Interface only, with a docblock on `canSendFreeform` explaining what it buys: 08b §2 calls it "the detail that makes everything reversible". The unofficial implementation returns `true` always; the official Meta implementation returns `false` outside the 24-hour window. Without the function in the interface, swapping providers rewrites every caller instead of swapping one file.

`pollOnce` is on the interface for the same reason — a webhook implementation satisfies it as a no-op, so the push/pull choice stays below this line.

- [ ] **Step 2: Write the fake, and a test that the fake itself behaves**

A test double with a bug produces green tests about nothing. Prove the fake: `enqueue` then `pollOnce` delivers to the handler in order and returns the count; a second `pollOnce` delivers nothing; `sent` records in order; `failNextSend` makes exactly one call reject.

- [ ] **Step 3: Run**

Run: `npx vitest run src/whatsapp/fake-gateway.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/whatsapp/gateway.ts src/whatsapp/fake-gateway.ts src/whatsapp/fake-gateway.test.ts
git commit -m "The gateway interface, and a fake that is itself tested"
```

---

## Task 5: Speaking to the owner

**Files:**
- Create: `src/whatsapp/messenger.ts`
- Create: `src/whatsapp/messenger.test.ts`

**Interfaces:**
- Consumes: `WhatsAppGateway` (Task 4), `principalWhatsAppKey` (Task 3), `recordOutbound` (Task 2).
- Produces:
```ts
export interface BossMessenger {
  readonly channel: 'whatsapp';
  /** Never throws. Never takes a recipient. */
  send(input: { text: string; jobId: string | null }): Promise<{ ok: boolean; error?: string }>;
}

export function createBossMessenger(options: {
  gateway: WhatsAppGateway;
  /** The principal's number, already validated. From `principalWhatsAppKey`. */
  contactId: string;
  businessId: string;
  now?: () => Date;
}): BossMessenger;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/whatsapp/messenger.test.ts — key cases
it('sends to the configured principal and records the outbound row', async () => { /* … */ });

/**
 * Same contract as the approval notifier's: a failed notification never fails
 * the work. The instruction was received and recorded; the phone not hearing
 * about it is a separate fact.
 */
it('returns ok:false instead of throwing when the gateway rejects', async () => {
  const gateway = createFakeGateway();
  gateway.failNextSend();
  const messenger = createBossMessenger({ gateway, contactId: '972541234567', businessId: BUSINESS });
  await expect(messenger.send({ text: 'קיבלתי.', jobId: null })).resolves.toMatchObject({ ok: false });
});

/**
 * There is no recipient parameter, and that is the control, not a convenience.
 * The moment the assistant can be asked to send WhatsApp to an arbitrary
 * number, it is an agent action that must go through the gate with an action
 * class, charter rate ceilings and a doNotContact check — sub-project ג'.
 * A compile-time absence is the boundary.
 */
it('exposes no way to name a different recipient', () => {
  const messenger = createBossMessenger({ gateway: createFakeGateway(), contactId: '972541234567', businessId: BUSINESS });
  expect(Object.keys(messenger)).toEqual(['channel', 'send']);
});

it('still records the outbound row when the send failed, so the dashboard shows the attempt', async () => { /* … */ });
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/whatsapp/messenger.test.ts`

- [ ] **Step 3: Implement**

Follow `createEmailNotifier` (`src/governance/notify.ts`) closely: `send` never throws, and the whole body — including anything that resolves a credential — sits inside one `try`. Race a deadline with `withDeadline` from that same module rather than relying on an abort signal; the project has twice confused an unenforced signal with a deadline, and both `callWithDeadline` and `withDeadline` exist because of it.

`idempotencyKey` is `canonicalHash({ jobId, text, minute })` so a retry inside one minute does not double-send.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Mutation-verify the never-throws contract**

Make `send` rethrow instead of returning `{ ok: false }`. The rejection test must FAIL. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/whatsapp/messenger.ts src/whatsapp/messenger.test.ts
git commit -m "The messenger: notifier pattern, no recipient parameter, never throws"
```

---

## Task 6: Transcription

**Files:**
- Create: `src/whatsapp/transcribe.ts`
- Create: `src/whatsapp/transcribe.test.ts`
- Modify: `src/domain/audit.ts` (add the `whatsapp` audit kind)
- Modify: `src/config.ts` (the four caps)

**Interfaces:**
- Consumes: `appendAudit` from `src/audit/log.js`, `NormalizedInboundMessage` (Task 4).
- Produces:
```ts
export type TranscribeOutcome =
  | { status: 'transcribed'; text: string }
  | { status: 'too_long'; seconds: number }
  | { status: 'capped' }
  | { status: 'failed'; reason: string };

export type TranscriptionProvider = (input: {
  bytes: Buffer; mimeType: string;
}) => Promise<{ text: string }>;

export function transcribeInbound(
  msg: NormalizedInboundMessage,
  senderKind: 'principal' | 'other',
  options: { businessId: string; provider: TranscriptionProvider; maxSeconds?: number },
): Promise<TranscribeOutcome>;
```

- [ ] **Step 1: Add the audit kind**

Add `'whatsapp'` to `AuditKind` in `src/domain/audit.ts`, with a docblock in the style of the ones already there: it carries counts and the sender kind, never the message body or the transcript — the same ethic as the `erasure` and `delegation` kinds beside it, and the same reason: a row carrying the text would make the audit log the one place that text survives erasure.

**This needs no migration.** `audit_log.kind` is plain `TEXT NOT NULL` with no CHECK, and `AuditKind` is not an exhaustive `z.record` key anywhere — unlike `ActionClass`, where a new member invalidates every signed charter.

- [ ] **Step 2: Add the caps to `src/config.ts`**

`whatsappTranscribeBossPerDay` (default 40), `whatsappTranscribeOtherPerDay` (default 20), `whatsappMaxAudioSeconds` (default 180), `whatsappInstructionsPerDay` (default 50). Read with a positive check — a value that is not a non-negative integer reads as **0**, never as unlimited. That is the project's rule: a value we failed to read is not a permissive value.

- [ ] **Step 3: Write the failing tests**

```ts
// src/whatsapp/transcribe.test.ts — the cases that matter
/**
 * TWO BUDGETS, AND THIS IS WHY. Shared, a customer sending fifty voice notes
 * exhausts the budget and the OWNER'S OWN recording then goes untranscribed —
 * a stranger degrading the owner's channel. The owner's budget is reserved.
 */
it('does not let a flood of non-principal audio stop the principal being transcribed', async () => {
  // Exhaust the 'other' budget with audit rows, then transcribe a principal message.
  for (let i = 0; i < 20; i += 1) await seedWhatsappAuditRow(BUSINESS, 'other');
  const other = await transcribeInbound(audioMsg(), 'other', { businessId: BUSINESS, provider: ok });
  expect(other.status).toBe('capped');
  const boss = await transcribeInbound(audioMsg(), 'principal', { businessId: BUSINESS, provider: ok });
  expect(boss.status).toBe('transcribed');
});

it('counts the cap from audit rows, not from a maintained counter', async () => { /* … */ });

it('refuses audio longer than the cap, and says how long it was', async () => { /* … */ });

/** Never guesses. A failed transcription is a failure, not a best-effort string. */
it('reports failure rather than inventing text when the provider throws', async () => {
  const outcome = await transcribeInbound(audioMsg(), 'principal', {
    businessId: BUSINESS, provider: async () => { throw new Error('upstream 503'); },
  });
  expect(outcome.status).toBe('failed');
});

/** No secret, no audio, no transcript in the audit row. */
it('writes an audit row carrying counts and the sender kind only', async () => { /* … */ });
```

- [ ] **Step 4: Run and watch fail**

- [ ] **Step 5: Implement**

Order matters: length cap → daily cap → provider call → audit row. **Write the audit row on the failure path too** — a provider that charged and then failed still charged, which is exactly why `recordCurationFailure` writes its row in `src/memory/curate.ts`.

- [ ] **Step 6: Run and watch pass**

- [ ] **Step 7: Mutation-verify the two budgets**

Make both kinds share one cap. The flood test must FAIL. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/whatsapp/transcribe.ts src/whatsapp/transcribe.test.ts src/domain/audit.ts src/config.ts
git commit -m "Transcription: two budgets so a stranger cannot starve the owner's own"
```

---

## Task 7: The door

**Files:**
- Create: `src/orchestrator/whatsapp-door.ts`
- Create: `src/orchestrator/whatsapp-door.test.ts`
- Create: `src/orchestrator/whatsapp-invariants.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6, plus `runInstruction` and `InstructionOutcome` from `src/orchestrator/instruct.js`.
- Produces:
```ts
export interface DoorResult {
  polled: number;
  instructed: number;
  recordedOnly: number;
  refused: number;
}

export function runWhatsAppDoor(options: {
  gateway: WhatsAppGateway;
  messenger: BossMessenger;
  businessId?: string;
  provider?: TranscriptionProvider;
  /** Test seam only; production leaves it unset and `runInstruction` uses the real planner. */
  planner?: RunInstructionOptions['planner'];
  now?: Date;
}): Promise<DoorResult>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/orchestrator/whatsapp-door.test.ts — the load-bearing cases
it('turns a message from the principal into an instruction and acknowledges from the outcome', async () => {
  /* planned → ack contains what runInstruction already phrased; the job carries
     whatsapp_message_id; the message settles 'handled' */
});

/** Decision 4. The customer feels no change, and that is the point. */
it('records a message from anyone else and neither acts nor replies', async () => {
  const result = await runWhatsAppDoor({ gateway, messenger, businessId: BUSINESS, planner: neverCalled });
  expect(result.recordedOnly).toBe(1);
  expect(result.instructed).toBe(0);
  expect(messenger.sentTexts).toEqual([]);       // no auto-reply, ever
  expect(await openJobs(BUSINESS)).toHaveLength(0);
});

it('acknowledges a needs_answer outcome with the question itself', async () => { /* … */ });
it('acknowledges a refused outcome with the reason itself', async () => { /* … */ });

/**
 * The claim is written BEFORE runInstruction. A crash between them loses one
 * instruction rather than sending a second email — the safe direction, and the
 * same choice `markContentIngested` makes.
 */
it('claims the message before planning, so a crash cannot double-send', async () => {
  const seen: string[] = [];
  await runWhatsAppDoor({
    gateway, messenger, businessId: BUSINESS,
    planner: async () => { seen.push(await stateOf(messageId)); throw new Error('boom'); },
  }).catch(() => {});
  expect(seen).toEqual(['claimed']);             // not 'received'
  expect(await stateOf(messageId)).toBe('failed');
});

it('quotes the transcript back when the instruction arrived as audio', async () => {
  // §6.3 — a mistranscription is a mistaken instruction, and 500 against 5,000
  // must be visible before anything happens.
  expect(messenger.sentTexts[0]).toContain('שמעתי:');
  expect(messenger.sentTexts[0]).toContain('תשלחי למוטי');
});

it('tells the owner it could not read a recording rather than staying silent', async () => { /* … */ });
it('stops instructing once the daily instruction cap is reached, and says so', async () => { /* … */ });
it('processes a burst in provider-timestamp order, one instruction each', async () => { /* … */ });
```

```ts
// src/orchestrator/whatsapp-invariants.test.ts
/**
 * Sibling of `instruction-invariants.test.ts`. The door is a third caller of
 * `runInstruction`, and `provenance: 'boss'` must stay a literal in the call
 * body — a caller that can aim provenance is a caller that can forge
 * authority.
 */
it('never passes a provenance it computed', () => {
  const source = readFileSync('src/orchestrator/whatsapp-door.ts', 'utf8');
  expect(source).not.toMatch(/provenance\s*:/);   // the door does not mention it at all
});

/** The door must not be able to send to anyone but the principal. */
it('reaches WhatsApp only through the messenger', () => {
  const source = readFileSync('src/orchestrator/whatsapp-door.ts', 'utf8');
  expect(source).not.toContain('sendMessage');    // gateway.sendMessage is the messenger's alone
});
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Order per message, and each line is a decision:

1. `recordInbound` — returns `null` on a redelivery; skip it.
2. `isPrincipalSender` — **positive check**. Not the principal → leave `state: 'received'`, settle `handled`, count `recordedOnly`, **send nothing**.
3. Audio from the principal → `transcribeInbound`. `too_long` / `failed` → tell the owner, settle, next message.
4. **`claimMessage` — before the next line.**
5. Daily instruction cap → if reached, tell the owner and settle without planning.
6. `runInstruction({ text })` — **no provenance argument exists to pass.**
7. Ack from the outcome's own Hebrew. Link the job: `jobs.whatsapp_message_id`.
8. `settleMessage(id, 'handled' | 'failed', { jobId })`.

A throw anywhere after the claim settles `failed` and does not stop the loop — one poison message must not block the queue, the same isolation `runDueJobs` gives each job.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Mutation-verify, three times**

- Move the claim after `runInstruction` → the crash test must FAIL.
- Make the non-principal branch send a reply → the no-auto-reply test must FAIL.
- Swap `isPrincipalSender` for `!isStranger(...)` → the recorded-only test must FAIL.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/whatsapp-door.ts src/orchestrator/whatsapp-door.test.ts src/orchestrator/whatsapp-invariants.test.ts
git commit -m "The door: the principal instructs, everyone else is recorded and left alone"
```

---

## Task 8: The honest report

**This is the most important task in the plan.** §1.3 and §5.2 of the spec exist for it.

**Files:**
- Create: `src/orchestrator/whatsapp-report.ts`
- Create: `src/orchestrator/whatsapp-report.test.ts`

**Interfaces:**
- Consumes: `BossMessenger` (Task 5), the store (Task 2), `stepResults` from `src/orchestrator/plan-store.js`, `loadJob` from `src/orchestrator/jobs.js`.
- Produces:
```ts
export type ReportOutcome = 'performed' | 'not_implemented' | 'failed' | 'awaiting_approval';

export interface ReportResult { reported: number }

export function reportWhatsAppJobs(options: {
  messenger: BossMessenger;
  businessId?: string;
  dashboardBaseUrl?: string;
}): Promise<ReportResult>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/orchestrator/whatsapp-report.test.ts
/**
 * THE TEST THIS WHOLE SUB-PROJECT TURNS ON.
 *
 * A tool with no implementation returns `{ performed: false, reason:
 * 'not_implemented' }`; `performStep` returns that as a SUCCESSFUL step
 * outcome; the step is recorded `completed`; `closeVerifiedJobs` closes the
 * job. A report keyed on the phase would say "done" about a CRM order that
 * was never entered. Over the dashboard the owner can see the steps. Over
 * WhatsApp he gets one sentence.
 */
it('reports "not performed" for a job whose steps all returned not_implemented', async () => {
  const jobId = await seedWhatsAppJob(BUSINESS, { tool: 'crm.write' });
  await runPlanForJob(/* … */);          // real engine, real local-tool path
  await closeVerifiedJobs({ businessId: BUSINESS });
  expect(await phaseOf(jobId)).toBe('closed');          // the job really did close
  await reportWhatsAppJobs({ messenger, businessId: BUSINESS });
  expect(messenger.sentTexts[0]).toContain('לא בוצע');
  expect(messenger.sentTexts[0]).not.toContain('בוצע ');
});

it('reports what was performed for a job whose steps really performed', async () => { /* mail.send */ });
it('reports the recorded reason for a failed job', async () => { /* … */ });
it('reports awaiting approval with a dashboard link when the plan stopped at a card', async () => { /* … */ });
it('reports a job once and never again', async () => { /* second call sends nothing */ });
it('ignores jobs that did not come from WhatsApp', async () => { /* whatsapp_message_id is null */ });
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Read `stepResults` for the job and the plan's declared steps. Classify in this order — **the first branch is what makes the report honest**:

1. Any step output carrying `performed: false` → `not_implemented`.
2. Job phase `failed` → `failed`, with `job_steps.reason`.
3. Job phase `await_approval` → `awaiting_approval`, with the dashboard link.
4. Every declared step has a row and all are `completed` → `performed`.
5. Anything else → `failed`. **A job whose record cannot support a claim is never reported as done** — the same positive rule `closeVerifiedJobs` already applies.

Report-once: a column or a settled marker; reuse `whatsapp_messages.state` on the opening message by moving it to a terminal value, so "reported" is a fact about the exchange rather than a second ledger.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Mutation-verify the honest report**

Replace the classifier with `phase === 'closed' ? 'performed' : 'failed'`. The `not_implemented` test must FAIL with "בוצע" where "לא בוצע" belonged. Restore. **This mutation is the one to keep in the task report** — it is the regression the whole sub-project exists to prevent.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/whatsapp-report.ts src/orchestrator/whatsapp-report.test.ts
git commit -m "The report says what the steps performed, never what the phase implies"
```

---

## Task 9: The conversation screen

**Files:**
- Create: `src/dashboard/conversation-view.ts`
- Create: `src/dashboard/conversation-view.test.ts`
- Modify: `src/dashboard/views.ts` (export `escLabel`)
- Modify: `src/dashboard/server.ts` (route `GET /conversation`)
- Modify: `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: `conversation` (Task 2), `escLabel` (newly exported).
- Produces: `export function renderConversation(options: { messages: readonly StoredMessage[]; csrf: string }): string;`

- [ ] **Step 1: Export `escLabel` from `views.ts`**

Change `function escLabel` to `export function escLabel`. **Do not move or rewrite it.** It strips U+202A–U+202E, U+2066–U+2069, U+200E/F and U+061C, and its existing tests must keep passing unchanged. The renderer lives in its own module because `views.ts` is already 1,667 lines.

- [ ] **Step 2: Write the failing tests**

```ts
// src/dashboard/conversation-view.test.ts
/**
 * Stranger-authored text on the owner's screen. `escLabel` exists because a
 * filename chosen by a sender can rearrange what the owner reads; a message
 * body is the same class and wider.
 */
it('strips directionality characters from a message body', () => {
  const html = renderConversation({ messages: [msg({ body: 'שלום‮גרר' })], csrf: 'c' });
  expect(html).not.toContain('‮');
});

it('escapes HTML in a message body', () => {
  const html = renderConversation({ messages: [msg({ body: '<script>alert(1)</script>' })], csrf: 'c' });
  expect(html).not.toContain('<script>');
});

it('shows a transcript where there is one, and marks it as a transcript', () => { /* … */ });
it('shows messages from everyone, labelled by who sent them', () => { /* decision 5 */ });
it('marks a claimed-but-unsettled message as unfinished rather than hiding it', () => { /* §7.5 */ });
it('says so plainly when there is no conversation yet', () => { /* empty is an answer */ });
```

- [ ] **Step 3: Run and watch fail**

- [ ] **Step 4: Implement the renderer and the route**

Chronological, oldest first. Each row: who, when, body or transcript, and state when it is not terminal. The compose box posts to the **existing** `POST /instruct` — the dashboard gains a view, not a second door. Register `GET /conversation` behind the owner session exactly as `/connections` is, and add the link to the nav.

- [ ] **Step 5: Run and watch pass**

- [ ] **Step 6: Mutation-verify the directionality strip**

Swap `escLabel` for `esc` in the body cell. The directionality test must FAIL. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/conversation-view.ts src/dashboard/conversation-view.test.ts src/dashboard/views.ts src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "The conversation screen: the full record, with stranger text treated as stranger text"
```

---

## Task 10: Runtime and scheduler wiring

**Files:**
- Modify: `src/orchestrator/runtime.ts`
- Modify: `src/orchestrator/scheduler.ts`
- Modify: `src/orchestrator/runtime.test.ts`
- Create: `src/orchestrator/whatsapp-wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces: `Runtime` gains `whatsapp?: { gateway: WhatsAppGateway; messenger: BossMessenger }`; `SchedulerPassResult` gains `whatsappDoor: DoorResult | null` and `whatsappReport: ReportResult | null`.

- [ ] **Step 1: Write the failing tests**

```ts
/**
 * The switch, and the same pattern as DOCUMENT_INBOX and the five SMTP vars.
 * "No WhatsApp" is a real production state; it must be REPORTED, not look
 * identical to "there was nothing to send".
 */
it('builds no gateway and returns a warning when GREEN-API is not configured', async () => {
  const runtime = await buildRuntime();
  expect(runtime.whatsapp).toBeUndefined();
  expect(runtime.warnings.join(' ')).toContain('GREEN_API');
});

it('runs neither loop and returns nulls when WhatsApp is not configured', async () => {
  const pass = await schedulerPass({ businessId: BUSINESS });
  expect(pass.whatsappDoor).toBeNull();
  expect(pass.whatsappReport).toBeNull();
});

/**
 * Order is not arbitrary, and the reasoning already sits in this file for
 * `resumeDelegatedJobs`: an instruction received in this pass must also RUN in
 * this pass, and a job that closed in this pass must also be REPORTED in it.
 * Any other order costs a full scheduler interval per instruction.
 */
it('instructs and executes in one pass, and reports in the pass the job closes', async () => {
  gateway.enqueue(principalMessage('תשלחי לדנה'));
  const pass = await schedulerPass({ businessId: BUSINESS, runtime });
  expect(pass.whatsappDoor?.instructed).toBe(1);
  expect(pass.due.ran).toHaveLength(1);           // ran in the SAME pass
  expect(pass.whatsappReport?.reported).toBe(1);  // reported in the SAME pass
});

/** §7.4 — a bridge that was connected and is not must reach the owner by EMAIL. */
it('emails the owner when a previously connected gateway is no longer connected', async () => { /* … */ });
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

`buildRuntime` builds `whatsapp` only when the GREEN-API refs **and** the principal's number both resolve; otherwise push a warning naming what is missing and leave it undefined — it must not throw, because the scheduler still has approvals to expire.

In `schedulerPass`, insert `runWhatsAppDoor` after `resumeDelegatedJobs` and before the conductor loops, and `reportWhatsAppJobs` after `closeVerifiedJobs`. Both guarded on `runtime.whatsapp !== undefined`, returning `null` otherwise.

Health: compare `health()` against the last observed state; a transition out of `connected` sends **one** email through the existing notifier. Not WhatsApp — WhatsApp is the thing that is down.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Mutation-verify the order**

Move the report before `closeVerifiedJobs`. The same-pass test must FAIL. Restore.

- [ ] **Step 6: Full suite and typecheck**

Run: `npm run typecheck` then `npm test`
Expected: both clean; capture the real exit code by redirecting to a file rather than through a pipe.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/runtime.ts src/orchestrator/scheduler.ts src/orchestrator/runtime.test.ts src/orchestrator/whatsapp-wiring.test.ts
git commit -m "Wiring: the door before the plans, the report after the close, and a switch that reports itself"
```

---

## Task 11: The real GREEN-API gateway

**Depends on Task 1.** Do not start it from their documentation; use the measured findings.

**Files:**
- Create: `src/whatsapp/green-api.ts`
- Create: `src/whatsapp/green-api.test.ts`
- Modify: `.env.example`
- Modify: `docs/live-thread-runbook.md` (a new section: linking the number, and what the operator must verify)

**Interfaces:**
- Consumes: `WhatsAppGateway` (Task 4), `CredentialSource` from `src/orchestrator/credentials.js`.
- Produces: `export function createGreenApiGateway(options: { credentials: CredentialSource; businessId: string; http?: typeof fetch }): WhatsAppGateway;`

- [ ] **Step 1: Write the failing tests against an injected `fetch`**

Map a real payload from Task 1's findings to `NormalizedInboundMessage`. Cover: a text message; a voice note (including how the audio is reached); `pollOnce` deleting what it delivered so the next call does not redeliver; a malformed payload **skipped and counted, never crashing the loop**; and `health()` for each state the spike observed.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

`businessId` is a **mandatory** parameter with no default, like every credential path in this project — `options.businessId ?? config.businessId` is forbidden here, because an omission reading silently as "the configured business" is the mechanism by which one customer reads another's secret. Credentials resolve **per call**, not once at construction, so rotating them takes effect on the next poll without a restart — the same choice `createEmailNotifier` makes.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Document the operator steps**

In `docs/live-thread-runbook.md`: which secret refs to provision, how to link the number by QR, how to confirm from `/conversation` that a message arrived, and — stated plainly, not in a footnote — that this is an unofficial bridge, that it violates WhatsApp's terms, and that the number can be banned permanently. Spec §9.1 requires this to be agreed with each customer.

- [ ] **Step 6: Full suite, typecheck, and commit**

```bash
npm run typecheck && npm test
git add src/whatsapp/green-api.ts src/whatsapp/green-api.test.ts .env.example docs/live-thread-runbook.md
git commit -m "The GREEN-API gateway, built from what the spike measured"
```

- [ ] **Step 7: The live run**

Send a real instruction from the principal's phone. Confirm: the ack arrives; the job runs; the report matches what actually happened; `/conversation` shows all three. Then send one from a non-principal number and confirm it is recorded and **unanswered**.

Every live run in this project so far has revealed something the tests missed. Expect that, and write down what it was.

---

## Self-Review

**Spec coverage.** §3.1 modules → Tasks 2–11, one each. §3.2 order → Task 10. §4 identity → Task 3. §5.1 ack → Task 7. §5.2 honest report → Task 8. §5.3 one message one instruction → Task 7. §5.4 question window → Task 7 (`WHATSAPP_QUESTION_WINDOW_MINUTES` read in `config.ts`, Task 6 Step 2). §6 transcription → Task 6. §7.1–7.3 messenger → Task 5. §7.4 health → Task 10. §7.5 dedupe and states → Task 2. §7.6 quiet hours — no code: the messenger does not consult them, which is the behaviour, and Task 5's tests pass no clock. §7.7 cap → Tasks 6 and 7. §7.8 switch → Task 10. §8.1 migration and erasure → Task 2. §8.2 screen → Task 9. §9 risks → documented in Task 11 Step 5. §10.1 tests → each task. §10.2 spike → Task 1. §10.3 constants → Task 6 Step 2.

**One gap found and closed:** §5.4's question window had no task. It is now Task 7's step 3 (point 6) and Task 6's config step; the door passes `identityAsked: true` when a pending question is answered inside the window.

**Placeholder scan.** Tasks 5–9 abbreviate some test bodies with `/* … */`. These are cases whose shape is fully determined by the ones written out beside them in the same block, and each carries its name and assertion. Every load-bearing case — the nine-digit trap, the two budgets, claim-before-plan, `not_implemented`, the directionality strip, the same-pass order — is written in full, as is every mutation step.

**Type consistency.** `StoredMessage`, `MessageState`, `SenderKind`, `NormalizedInboundMessage`, `BossMessenger`, `TranscribeOutcome`, `DoorResult`, `ReportOutcome` are defined once in their producing task's Interfaces block and referenced by exactly those names later. `businessId` is `string` and mandatory on every credential path (Tasks 5, 6, 11).
