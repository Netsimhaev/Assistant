import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { canonicalHash } from '../util/canonical.js';
import type { ActionFacts } from '../domain/policy.js';
import type { RiskAssessment } from '../domain/risk.js';
import { enqueueApproval, getApproval, type ApprovalRequest } from './approvals.js';
import { createEmailNotifier, type ApprovalNotifier } from './notify.js';
import { createSmtpTransport } from '../mail/transport.js';
import type { MailMessage, MailTransport } from '../orchestrator/adapters/mail.js';

const BUSINESS = 'test-business';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

function factsFixture(proposedInput: unknown, overrides: Partial<ActionFacts> = {}): ActionFacts {
  return {
    toolName: 'browser.submit_order',
    actionClass: 'purchase.place',
    amountMinor: 210_000,
    amountDeclared: true,
    counterpartyId: null,
    counterpartyEmails: [],
    counterpartyPhones: [],
    counterpartyTags: [],
    provenance: 'boss',
    chainDepth: 0,
    dataClasses: [],
    leavesInstance: true,
    supplierId: 'supplier_a',
    discountPercent: 0,
    inputHash: canonicalHash(proposedInput),
    ...overrides,
  };
}

function riskFixture(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    actionId: 'A-test',
    actionClass: 'purchase.place',
    dimensions: {
      money: { amountMinor: 210_000, pctOfDailyCeiling: 40, score: 30 },
      reversibility: { class: 'reversible', score: 10 },
      externalVisibility: { audience: 'one_known', score: 10 },
      dataSensitivity: { classes: [], leavesInstance: false, score: 0 },
      novelty: { metric: null, z: 0, precedentIds: [], score: 0 },
      provenance: { level: 'boss', chainDepth: 0, score: 0 },
      charterFit: { verdict: 'within', citedRuleIds: [], score: 0 },
    },
    total: 42,
    band: 'sensitive',
    decidedBy: 'rules',
    explanation: 'הזמנה מספק א׳ בסכום גבוה מהרגיל',
    suggestedApprovers: [],
    ...overrides,
  };
}

/**
 * A real approval, written through `enqueueApproval` and read back through
 * `getApproval` — the same round trip the gate makes — rather than a
 * hand-built `ApprovalRequest` literal, so the object the notifier receives
 * in these tests is exactly the shape the real call site hands it.
 */
async function makeApproval(options: {
  proposedInput?: unknown;
  summary?: string;
  secretMarker?: string;
} = {}): Promise<ApprovalRequest> {
  const secret = options.secretMarker ?? 'SECRET-CARD-4111-1111-1111-1111';
  const proposedInput = options.proposedInput ?? {
    supplierId: 'supplier_a',
    amountMinor: 210_000,
    note: secret,
  };
  const approvalId = await enqueueApproval(
    {
      facts: factsFixture(proposedInput),
      risk: riskFixture(),
      proposedInput,
      summary: options.summary ?? 'הזמנה מספק א׳ טעונה אישור',
    },
    { businessId: BUSINESS },
  );
  const request = await getApproval(approvalId, { businessId: BUSINESS });
  if (request === null) throw new Error('approval was not written');
  return request;
}

function recordingTransport(): { transport: MailTransport; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const transport: MailTransport = {
    async send(message) {
      sent.push(message);
      return { messageId: 'MSG-1' };
    },
  };
  return { transport, sent };
}

function throwingTransport(error: unknown): MailTransport {
  return {
    async send() {
      throw error;
    },
  };
}

describe('createEmailNotifier', () => {
  it('sends to the configured owner address with a link containing the approval id', async () => {
    const { transport, sent } = recordingTransport();
    const notifier = createEmailNotifier(transport, 'owner@example.com');
    const request = await makeApproval();

    const link = `https://dash.example.com/a/${request.approvalId}`;
    const result = await notifier.notify(request, link);

    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['owner@example.com']);
    expect(sent[0]?.body).toContain(link);
    expect(sent[0]?.body).toContain(request.approvalId);
  });

  it('does not leak the proposed payload — only the summary and the label reach the mail', async () => {
    const { transport, sent } = recordingTransport();
    const notifier = createEmailNotifier(transport, 'owner@example.com');
    const secret = 'SECRET-CARD-4111-1111-1111-1111';
    const request = await makeApproval({ secretMarker: secret });

    await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(sent).toHaveLength(1);
    const wholeMessage = `${sent[0]?.subject}\n${sent[0]?.body}`;
    // The secret only ever lived inside `proposedInput` — it must never reach
    // the mailbox, which this project treats as less trusted than the
    // dashboard behind a login.
    expect(wholeMessage).not.toContain(secret);
    expect(wholeMessage).not.toContain(JSON.stringify(request.proposedInput));
    // The summary — the one piece of content the dashboard shows on the
    // pending list without a click — is expected to travel.
    expect(wholeMessage).toContain(request.summary);
  });

  it('turns a throwing transport into a graceful { ok: false }, never a rejected promise', async () => {
    const notifier = createEmailNotifier(
      throwingTransport(new Error('smtp connection refused')),
      'owner@example.com',
    );
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('smtp connection refused');
  });

  it('turns a transport that throws a non-Error value into a graceful { ok: false } too', async () => {
    const notifier = createEmailNotifier(throwingTransport('boom'), 'owner@example.com');
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result).toEqual({ ok: false, error: 'boom' });
  });

  it('surfaces the real SMTP transport\'s CRLF rejection as { ok: false }, without ever dialing out', async () => {
    // A newline smuggled into the summary (the one field this notifier does
    // put in the subject line) must not be able to open a `Bcc:` header on
    // the real transport. `createSmtpTransport` rejects it before it ever
    // calls out to a socket — see src/mail/transport.ts — so this exercises
    // the real implementation, not a fake, with no network involved.
    const transport = createSmtpTransport({
      host: 'smtp.invalid.example',
      port: 587,
      secure: false,
      from: 'assistant@example.com',
      auth: { user: 'assistant', pass: 'test-pass' },
    });
    const notifier: ApprovalNotifier = createEmailNotifier(transport, 'owner@example.com');
    const request = await makeApproval({
      summary: 'שלום\r\nBcc: attacker@evil.com',
    });

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/CR\/LF|שורה חדשה/);
  });

  // Round 1 finding: nothing bounded the wait when a transport simply never
  // settled. `evaluateToolCall` (tested directly in `src/policy/engine.test.ts`)
  // awaits this call inline, so a hang here was a hang there. This is the
  // same property, exercised at the unit that actually owns the deadline.
  it('gives up on a transport that never resolves, within the deadline, instead of hanging forever', async () => {
    const hangingTransport: MailTransport = {
      send() {
        return new Promise(() => {
          // Deliberately never settles — the point of this test.
        });
      },
    };
    const notifier = createEmailNotifier(hangingTransport, 'owner@example.com');
    const request = await makeApproval();

    const started = Date.now();
    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/לא הסתיימה/);
    // Generous margin over the 5s deadline (NOTIFY_TIMEOUT_MS) — this only
    // needs to prove the wait is bounded, not pin the exact number.
    expect(elapsedMs).toBeLessThan(9_000);
  }, 15_000);

  it('turns a transport that resolves quickly with no throw at all into { ok: true }', async () => {
    // The mirror image of the hang above: a transport that behaves exactly
    // as MailTransport's contract promises (resolve fast, or throw) must
    // not be slowed down or altered by the deadline machinery wrapping it.
    const { transport } = recordingTransport();
    const notifier = createEmailNotifier(transport, 'owner@example.com');
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result).toEqual({ ok: true });
  });
});
