import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { canonicalHash } from '../util/canonical.js';
import type { ActionFacts } from '../domain/policy.js';
import type { RiskAssessment } from '../domain/risk.js';
import { enqueueApproval, getApproval, type ApprovalRequest } from './approvals.js';
import { createEmailNotifier, type ApprovalNotifier, type EmailNotifierOptions } from './notify.js';
import { createSmtpTransport } from '../mail/transport.js';
import type { MailMessage, MailTransport } from '../orchestrator/adapters/mail.js';
import { createCredentialHandle, type CredentialHandle } from '../orchestrator/adapters/types.js';
import type { CredentialSource } from '../orchestrator/credentials.js';

const BUSINESS = 'test-business';
const DEFAULT_REF = 'NOTIFY_MAIL';

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
    provenanceChainDerived: false,
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
  riskOverrides?: Partial<RiskAssessment>;
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
      risk: riskFixture(options.riskOverrides),
      proposedInput,
      summary: options.summary ?? 'הזמנה מספק א׳ טעונה אישור',
    },
    { businessId: BUSINESS },
  );
  const request = await getApproval(approvalId, { businessId: BUSINESS });
  if (request === null) throw new Error('approval was not written');
  return request;
}

/**
 * `credentialsUsed` records `context.credential.value` for every send — the
 * one thing this fake was missing once the notifier started resolving its
 * own credential per call instead of presenting a shared placeholder.
 */
function recordingTransport(): {
  transport: MailTransport;
  sent: MailMessage[];
  credentialsUsed: string[];
} {
  const sent: MailMessage[] = [];
  const credentialsUsed: string[] = [];
  const transport: MailTransport = {
    async send(message, context) {
      sent.push(message);
      credentialsUsed.push(context.credential.value);
      return { messageId: 'MSG-1' };
    },
  };
  return { transport, sent, credentialsUsed };
}

/**
 * `credentialsUsed`, populated before the throw, is what lets a test that
 * asserts a secret is *absent* from the failure result first prove the
 * secret was genuinely resolved and handed to the transport — otherwise
 * "the secret never appears" would be true for the trivial reason that it
 * was never in the path at all.
 */
function throwingTransport(error: unknown, credentialsUsed: string[] = []): MailTransport {
  return {
    async send(_message, context) {
      credentialsUsed.push(context.credential.value);
      throw error;
    },
  };
}

/**
 * A `CredentialSource` backed by an in-memory map, keyed by ref only — the
 * real store also partitions by business, but `credential-store.test.ts`
 * already covers that, and nothing here needs to re-prove it. `set` lets a
 * test simulate a rotation landing between two `notify` calls.
 */
function stubCredentialSource(secrets: Record<string, string>): CredentialSource & {
  set(ref: string, value: string): void;
} {
  const map = new Map(Object.entries(secrets));
  return {
    async resolve(ref: string, _businessId: string): Promise<CredentialHandle | null> {
      const value = map.get(ref);
      return value === undefined ? null : createCredentialHandle(ref, value);
    },
    set(ref: string, value: string): void {
      map.set(ref, value);
    },
  };
}

/**
 * Defaults for every field `createEmailNotifier` now requires, so each test
 * below only spells out the field it actually varies.
 */
function baseNotifierOptions(overrides: Partial<EmailNotifierOptions> = {}): EmailNotifierOptions {
  return {
    transport: recordingTransport().transport,
    to: 'owner@example.com',
    credentials: stubCredentialSource({ [DEFAULT_REF]: 'notify-secret' }),
    ref: DEFAULT_REF,
    businessId: BUSINESS,
    ...overrides,
  };
}

describe('createEmailNotifier', () => {
  it('sends to the configured owner address with a link containing the approval id', async () => {
    const { transport, sent } = recordingTransport();
    const notifier = createEmailNotifier(baseNotifierOptions({ transport }));
    const request = await makeApproval();

    const link = `https://dash.example.com/a/${request.approvalId}`;
    const result = await notifier.notify(request, link);

    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['owner@example.com']);
    expect(sent[0]?.body).toContain(link);
    expect(sent[0]?.body).toContain(request.approvalId);
  });

  it('does not leak the proposed payload — only the risk sentence and the label reach the mail', async () => {
    const { transport, sent } = recordingTransport();
    const notifier = createEmailNotifier(baseNotifierOptions({ transport }));
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
    // The risk sentence — the one piece of content the dashboard shows on the
    // pending list without a click — is expected to travel. Not
    // `request.summary`: as of fix round 1 (F3) that field can carry a
    // proposal's own headline, which this notifier deliberately never sees.
    expect(wholeMessage).toContain(request.risk.explanation);
    expect(wholeMessage).toContain(`${request.proposedTool} · ${request.actionClass} · רצועה ${request.risk.band}`);
  });

  it('never lets a proposal headline reach the mail, even when it differs from the risk sentence', async () => {
    const { transport, sent } = recordingTransport();
    const notifier = createEmailNotifier(baseNotifierOptions({ transport }));
    // A headline a model could have written from ingested content — distinct
    // from `summary` in every other fixture here on purpose.
    const request = await makeApproval({ summary: 'אשלח מייל לדנה עוד היום' });

    await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    const wholeMessage = `${sent[0]?.subject}\n${sent[0]?.body}`;
    expect(wholeMessage).not.toContain(request.summary);
    expect(wholeMessage).toContain(request.risk.explanation);
  });

  it('turns a throwing transport into a graceful { ok: false }, never a rejected promise', async () => {
    const notifier = createEmailNotifier(
      baseNotifierOptions({ transport: throwingTransport(new Error('smtp connection refused')) }),
    );
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('smtp connection refused');
  });

  it('turns a transport that throws a non-Error value into a graceful { ok: false } too', async () => {
    const notifier = createEmailNotifier(baseNotifierOptions({ transport: throwingTransport('boom') }));
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result).toEqual({ ok: false, error: 'boom' });
  });

  it('surfaces the real SMTP transport\'s CRLF rejection as { ok: false }, without ever dialing out', async () => {
    // A newline smuggled into the risk explanation (the field this notifier
    // now puts in the subject line, as of fix round 1 — F3 moved this off
    // `summary`, which can carry a proposal's own words) must not be able to
    // open a `Bcc:` header on the real transport. `createSmtpTransport`
    // rejects it before it ever calls out to a socket — see
    // src/mail/transport.ts — so this exercises the real implementation, not
    // a fake, with no network involved. `auth` is gone from `SmtpConfig` as
    // of the mail-credential work; only `user` stays.
    const transport = createSmtpTransport({
      host: 'smtp.invalid.example',
      port: 587,
      secure: false,
      from: 'assistant@example.com',
      user: 'assistant',
    });
    const notifier: ApprovalNotifier = createEmailNotifier(baseNotifierOptions({ transport }));
    const request = await makeApproval({
      riskOverrides: { explanation: 'שלום\r\nBcc: attacker@evil.com' },
    });

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    // The CRLF refusal fires inside the transport, before it ever asks for
    // the credential — so this passes unchanged once `SmtpConfig` compiles,
    // regardless of what `assertNoCrlf` runs against.
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
    const notifier = createEmailNotifier(baseNotifierOptions({ transport: hangingTransport }));
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
    const notifier = createEmailNotifier(baseNotifierOptions({ transport }));
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result).toEqual({ ok: true });
  });

  it('sends with the value the credential source holds for the ref', async () => {
    const { transport, credentialsUsed } = recordingTransport();
    const secret = 'סוד-המודיע';
    const notifier = createEmailNotifier(
      baseNotifierOptions({ transport, credentials: stubCredentialSource({ [DEFAULT_REF]: secret }) }),
    );
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result).toEqual({ ok: true });
    expect(credentialsUsed).toEqual([secret]);
  });

  it('resolves again on the second notification, so a rotation takes effect without a restart', async () => {
    const { transport, credentialsUsed } = recordingTransport();
    const source = stubCredentialSource({ [DEFAULT_REF]: 'לפני' });
    const notifier = createEmailNotifier(baseNotifierOptions({ transport, credentials: source }));

    const first = await makeApproval();
    await notifier.notify(first, `https://dash.example.com/a/${first.approvalId}`);
    source.set(DEFAULT_REF, 'אחרי');
    const second = await makeApproval();
    await notifier.notify(second, `https://dash.example.com/a/${second.approvalId}`);

    expect(credentialsUsed).toEqual(['לפני', 'אחרי']);
  });

  it('reports a failure without sending when the ref does not resolve', async () => {
    const { transport, sent } = recordingTransport();
    const notifier = createEmailNotifier(
      baseNotifierOptions({ transport, credentials: stubCredentialSource({}) }),
    );
    const request = await makeApproval();

    // `notify` never throws by contract — the approval row already exists
    // and the dashboard already shows it. An unresolved ref is the same
    // class of event as an unreachable relay.
    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('keeps the secret out of the failure it reports', async () => {
    const secret = 'סוד-המודיע-שאסור-להופיע';
    const credentialsUsed: string[] = [];
    const notifier = createEmailNotifier(
      baseNotifierOptions({
        transport: throwingTransport(new Error('535 Authentication credentials invalid'), credentialsUsed),
        credentials: stubCredentialSource({ [DEFAULT_REF]: secret }),
      }),
    );
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    // Positive assertion first: prove the secret really was resolved and
    // handed to the transport before the send failed, so the negative
    // assertion below is not vacuously true for having nothing to leak.
    expect(credentialsUsed).toEqual([secret]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('turns a rejecting credential source into a graceful { ok: false }, never a rejected promise', async () => {
    // The production CredentialSource (`storedCredentials`,
    // src/governance/credential-store.ts) awaits a db.query that can
    // reject — a lost connection, an exhausted pool. That rejection must
    // land inside notify's own try, not escape it.
    const { transport, sent } = recordingTransport();
    let resolveCalls = 0;
    const rejectingCredentials: CredentialSource = {
      async resolve() {
        resolveCalls += 1;
        throw new Error('connection terminated unexpectedly');
      },
    };
    const notifier = createEmailNotifier(
      baseNotifierOptions({ transport, credentials: rejectingCredentials }),
    );
    const request = await makeApproval();

    const result = await notifier.notify(request, `https://dash.example.com/a/${request.approvalId}`);

    // Positive first: prove the rejection actually happened on this call's
    // path — resolve was reached and is the thing that threw — so the
    // shape asserted below is not passing for some unrelated reason.
    expect(resolveCalls).toBe(1);
    expect(result).toEqual({ ok: false, error: 'connection terminated unexpectedly' });
    expect(sent).toHaveLength(0);
  });
});
