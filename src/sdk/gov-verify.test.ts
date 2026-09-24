import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { loadEnvelopeWithChild } from '../governance/envelope-store.js';
import { createJob, loadJob, transition, type Job } from '../orchestrator/jobs.js';
import {
  interpretJudgeResponse,
  JUDGE_SYSTEM_PROMPT,
  judgeWithModel,
  verifyDraft,
  type AwaitingDelegation,
  type Judge,
  type VerifyDraftInput,
  type VerifyDraftResult,
} from './gov-verify.js';

const BUSINESS = 'test-business';

/** `Verdict` carries no `status` field at all, so the two arms of
 * `VerifyDraftResult` are told apart by presence of the field, not by a
 * shared discriminant TS can narrow on directly. */
function isAwaitingDelegation(result: VerifyDraftResult): result is AwaitingDelegation {
  return 'status' in result && result.status === 'awaiting_delegation';
}

async function openVerifyJob(): Promise<{ job: Job; bundle: PolicyBundle }> {
  const bundle = await installCharter(buildCharter({ version: `verify-${ulid()}` }), {
    businessId: BUSINESS,
  });
  const created = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
    businessId: BUSINESS,
    title: 'verify a draft',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(created.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const job = await loadJob(created.jobId, { businessId: BUSINESS });
  if (job === null) throw new Error('verify job vanished');
  return { job, bundle };
}

function baseInput(job: Job, bundle: PolicyBundle, overrides: Partial<VerifyDraftInput> = {}): VerifyDraftInput {
  return {
    parentJobId: job.jobId,
    bundle,
    documentId: 'doc-quote-1',
    draftText: 'הסכום לתשלום הוא 11,988 ש"ח עד 15/10.',
    sources: ['סה"כ לתשלום: 11988 ש"ח, עד תאריך 15/10'],
    question: 'מה המסמך מבקש מאיתנו, ומהם הפרטים המרכזיים שתשובה צריכה לכלול?',
    answer: null,
    parentEnvelope: null,
    businessId: BUSINESS,
    ...overrides,
  };
}

const throwingJudge: Judge = async () => {
  throw new Error('judge must not be called when the delegation has not answered yet');
};

describe('verifyDraft — the cheap check runs alone', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * The numeric check is deterministic and free; it must run — and its
   * result must come back — even on the call that only ever delegates and
   * never reaches a judge. A judge that throws if invoked proves the second
   * half: nothing here calls it.
   */
  it('reports ungrounded numbers without any model call', async () => {
    const { job, bundle } = await openVerifyJob();
    const result = await verifyDraft(
      baseInput(job, bundle, {
        draftText: 'הסכום לתשלום הוא 12,500 ש"ח, וגם 11,988 ש"ח שכבר שולמו.',
        sources: ['סה"כ לתשלום: 11988 ש"ח'],
        judge: throwingJudge,
      }),
    );

    expect(isAwaitingDelegation(result)).toBe(true);
    if (!isAwaitingDelegation(result)) throw new Error('expected awaiting_delegation');
    expect(result.ungroundedNumbers).toEqual(['12500']);
  });

  /**
   * `gov.verify` cannot open the document — the quarantine boundary this
   * whole module exists to respect — so the only way to learn what it asks
   * is to delegate to `know.reader`. The call must end there rather than
   * wait: a real envelope and a real child job for `know.reader` must exist
   * afterward, and the call itself must return quickly rather than block
   * until the child answers (nothing in this test ever runs the child).
   */
  it('ends its own run and asks know.reader when it needs the document', async () => {
    const { job, bundle } = await openVerifyJob();

    const startedAt = Date.now();
    const result = await verifyDraft(baseInput(job, bundle, { judge: throwingJudge }));
    const elapsedMs = Date.now() - startedAt;

    expect(isAwaitingDelegation(result)).toBe(true);
    if (!isAwaitingDelegation(result)) throw new Error('expected awaiting_delegation');
    expect(result.childJobId).not.toBeNull();
    // Generous relative to a local Postgres round trip, and far below what a
    // model call or a poll loop waiting on the child would take — this is
    // the assertion the "wait instead of delegate" mutation is meant to trip.
    expect(elapsedMs).toBeLessThan(3000);

    const stored = await loadEnvelopeWithChild(result.envelopeId, { businessId: BUSINESS });
    expect(stored).not.toBeNull();
    expect(stored?.envelope.from).toBe('gov.verify');
    expect(stored?.envelope.to).toBe('know.reader');
    expect(stored?.envelope.intent).toBe('read_for_question');
    expect(stored?.childJobId).toBe(result.childJobId);

    const parent = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(parent?.phase).toBe('followup');

    // The child was opened, but nothing in this test ever ran it — proof
    // that verifyDraft itself did not wait for an answer.
    const child = result.childJobId === null ? null : await loadJob(result.childJobId, { businessId: BUSINESS });
    expect(child).not.toBeNull();
    expect(child?.phase).toBe('execute');
  });

  it('runs the judge once an answer is available, without touching the numbers check', async () => {
    const { job, bundle } = await openVerifyJob();
    let calls = 0;
    const stubJudge: Judge = async (request) => {
      calls += 1;
      expect(request.question).toContain('המסמך');
      expect(request.answer).toBe('המסמך מבקש אישור תשלום של 11988 ש"ח עד 15/10');
      return {
        status: 'judged',
        raw: '{}',
        criteria: [
          {
            id: 'answers_question',
            statement: 'הטיוטה עונה על הבקשה',
            severity: 'must',
            passed: true,
            detail: 'הטיוטה מאשרת את הסכום והתאריך',
          },
        ],
      };
    };

    const result = await verifyDraft(
      baseInput(job, bundle, {
        answer: 'המסמך מבקש אישור תשלום של 11988 ש"ח עד 15/10',
        judge: stubJudge,
      }),
    );

    expect(calls).toBe(1);
    if (!('criteria' in result)) throw new Error('expected a Verdict');
    expect(result.criteria).toHaveLength(1);
    expect(result.ungroundedNumbers).toEqual([]);
  });
});

describe('gov.verify never opens the document itself', () => {
  /**
   * The quarantine boundary is the entire reason this agent has to delegate
   * rather than read. Structural, in the style of
   * `erasure-invariants.test.ts`'s import scan: this reads the module's own
   * source as text and demands that no forbidden module — anything that
   * reads document content — is ever imported from it.
   */
  it('imports no module that reads document content', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'sdk', 'gov-verify.ts'), 'utf8');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));

    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      // No import from anywhere under `documents/` at all — not just
      // `read.ts` — and no NAMED import of `loadArtifacts` or `readDocument`
      // from anywhere else either (a re-export under a different path would
      // otherwise slip past the path check alone). Scoped to import lines,
      // not the whole file: this module's own docblock and comments discuss
      // both names in prose, which must not trip the check.
      expect(line).not.toMatch(/from\s+['"]\.\.\/documents\//);
      expect(line).not.toMatch(/\bloadArtifacts\b/);
      expect(line).not.toMatch(/\breadDocument\b/);
    }
  });
});

describe('the judge call', () => {
  /**
   * The suite runs with NODE_ENV=test and this machine carries a real
   * ANTHROPIC_API_KEY. A test that reached the real call would bill the
   * owner silently — the same reasoning `curator.test.ts` and
   * `proposer.test.ts` state for their own guards.
   */
  it('refuses under NODE_ENV=test without an injected judge', async () => {
    await expect(
      judgeWithModel({ question: 'x', answer: 'y', draftText: 'z' }),
    ).rejects.toThrow(/NODE_ENV=test/);
  });

  it('states the envelope: a single object with a criteria array', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('criteria');
    expect(JUDGE_SYSTEM_PROMPT).toContain('אובייקט');
  });

  it('states the two severities', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('must');
    expect(JUDGE_SYSTEM_PROMPT).toContain('should');
  });
});

describe('interpretJudgeResponse', () => {
  it('parses a well-formed criteria object', () => {
    const raw = JSON.stringify({
      criteria: [
        {
          id: 'answers_question',
          statement: 'עונה על הבקשה',
          severity: 'must',
          passed: true,
          detail: 'הכל תואם',
        },
      ],
    });
    const outcome = interpretJudgeResponse(raw);
    expect(outcome.status).toBe('judged');
    if (outcome.status !== 'judged') throw new Error('expected judged');
    expect(outcome.criteria).toHaveLength(1);
  });

  it('tolerates prose around the JSON object', () => {
    const raw = `הנה התשובה:\n${JSON.stringify({
      criteria: [
        { id: 'x', statement: 'y', severity: 'should', passed: false, detail: 'z' },
      ],
    })}\nתודה.`;
    const outcome = interpretJudgeResponse(raw);
    expect(outcome.status).toBe('judged');
  });

  it('reports unjudged when nothing parses as a criteria object', () => {
    const outcome = interpretJudgeResponse('not json at all');
    expect(outcome.status).toBe('unjudged');
  });

  it('reports unjudged when criteria is an empty array', () => {
    const outcome = interpretJudgeResponse(JSON.stringify({ criteria: [] }));
    expect(outcome.status).toBe('unjudged');
  });
});
