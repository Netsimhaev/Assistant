import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, loadJob, transition, type Job } from './jobs.js';
import { requestHelp, type RequestHelpInput } from './delegate.js';
import { resumeDelegatedJobs } from './resume-delegated.js';

const BUSINESS = 'test-business';

async function openParentJob(): Promise<{ job: Job; bundle: PolicyBundle }> {
  const bundle = await installCharter(buildCharter({ version: `parent-${ulid()}` }), {
    businessId: BUSINESS,
  });
  const created = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'delegating job',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(created.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const job = await loadJob(created.jobId, { businessId: BUSINESS });
  if (job === null) throw new Error('parent job vanished');
  return { job, bundle };
}

function baseRequest(
  job: Job,
  bundle: PolicyBundle,
  overrides: Partial<RequestHelpInput> = {},
): RequestHelpInput {
  return {
    parentJobId: job.jobId,
    from: 'comms.email',
    to: 'know.reader',
    intent: 'read_for_question',
    payload: { question: 'מה המסמך הזה מבקש?' },
    contextRefs: [{ kind: 'document', documentId: `doc-${ulid()}` }],
    bundle,
    parentEnvelope: null,
    businessId: BUSINESS,
    ...overrides,
  };
}

/** A real parent → child delegation, opened through `requestHelp` itself. */
async function openDelegation(): Promise<{
  parentJobId: string;
  childJobId: string;
  envelopeId: string;
}> {
  const { job, bundle } = await openParentJob();
  const result = await requestHelp(baseRequest(job, bundle));
  if (result.status !== 'opened') throw new Error(`expected opened, got ${result.status}`);
  return { parentJobId: job.jobId, childJobId: result.childJobId, envelopeId: result.envelopeId };
}

/** Walk a child all the way to `closed`, the only legal route from `verify`. */
async function closeChild(jobId: string): Promise<void> {
  for (const to of ['verify', 'remember', 'closed'] as const) {
    await transition(jobId, { to, actor: 'orchestrator', reason: 'test setup', businessId: BUSINESS });
  }
}

async function failChild(jobId: string): Promise<void> {
  await transition(jobId, { to: 'failed', actor: 'orchestrator', reason: 'test setup', businessId: BUSINESS });
}

async function latestResultPayload(): Promise<{ outcome: string; note: string }> {
  const { rows } = await getPool().query<{ payload: { outcome: string; note: string } }>(
    `SELECT payload FROM agent_envelopes
      WHERE business_id = $1 AND kind = 'result'
      ORDER BY created_at DESC LIMIT 1`,
    [BUSINESS],
  );
  const payload = rows[0]?.payload;
  if (payload === undefined) throw new Error('expected a result envelope');
  return payload;
}

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

describe('resumeDelegatedJobs', () => {
  it('wakes the parent when the child closes, and writes a result envelope', async () => {
    const { parentJobId, childJobId } = await openDelegation();
    await closeChild(childJobId);

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([parentJobId]);
    expect(result.timedOut).toEqual([]);
    expect(result.errored).toEqual([]);

    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(parent?.phase).toBe('execute');
    expect(parent?.awaitingEnvelopeId).toBeNull();

    const payload = await latestResultPayload();
    expect(payload.outcome).toBe('succeeded');
  });

  it('wakes the parent and says so plainly when the child failed', async () => {
    const { parentJobId, childJobId } = await openDelegation();
    await failChild(childJobId);

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([parentJobId]);

    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    // The parent does not fail on its own account of its helper failing —
    // that is a decision for its own plan to make on the next pass.
    expect(parent?.phase).toBe('execute');

    const payload = await latestResultPayload();
    expect(payload.outcome).toBe('failed');
  });

  it("wakes the parent when the envelope's deadline passed and the child is still running", async () => {
    const { parentJobId, childJobId } = await openDelegation();
    // The child is deliberately left running — never closed, never failed.
    const wellPastTheDefaultWindow = new Date(Date.now() + 25 * 60 * 60 * 1000);

    const result = await resumeDelegatedJobs({ businessId: BUSINESS, now: wellPastTheDefaultWindow });
    expect(result.timedOut).toEqual([parentJobId]);
    expect(result.resumed).toEqual([]);
    expect(result.errored).toEqual([]);

    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(parent?.phase).toBe('execute');
    expect(parent?.awaitingEnvelopeId).toBeNull();

    // The stuck child itself is untouched — only the parent is freed.
    const child = await loadJob(childJobId, { businessId: BUSINESS });
    expect(child?.phase).toBe('execute');

    const payload = await latestResultPayload();
    expect(payload.outcome).toBe('timeout');
  });

  it('leaves a parent alone while its child is still inside the deadline', async () => {
    const { parentJobId } = await openDelegation();

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([]);
    expect(result.timedOut).toEqual([]);
    expect(result.errored).toEqual([]);

    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(parent?.phase).toBe('followup');
  });

  it('isolates a failure on one parent from the rest of the round', async () => {
    const good = await openDelegation();
    await closeChild(good.childJobId);

    const bad = await openDelegation();
    // Corrupt the bad parent's own row: point it at an envelope id nothing
    // ever wrote. `followup` has no self-transition, so the row is walked
    // back to `execute` first and re-parked with the bogus id — the same
    // shape a real crash between `writeEnvelope` and `attachChildJob` could
    // leave behind, engineered directly rather than raced for.
    await transition(bad.parentJobId, {
      to: 'execute',
      actor: 'orchestrator',
      reason: 'test corruption',
      businessId: BUSINESS,
    });
    await transition(bad.parentJobId, {
      to: 'followup',
      actor: 'orchestrator',
      reason: 'test corruption',
      awaitingEnvelopeId: 'ENV-does-not-exist',
      businessId: BUSINESS,
    });

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([good.parentJobId]);
    expect(result.errored).toEqual([{ jobId: bad.parentJobId, error: expect.any(String) }]);
    expect(result.errored[0]?.error).toContain('does not exist');

    // The good parent actually woke, despite running in the same pass as the
    // corrupted one.
    const goodParent = await loadJob(good.parentJobId, { businessId: BUSINESS });
    expect(goodParent?.phase).toBe('execute');

    // The bad parent is not left parked forever: `wakeDueJobs` never looks at
    // `awaiting_envelope_id`, so this function is its only possible mover —
    // left merely `errored`, it would sort first under `ORDER BY updated_at
    // ASC` on every subsequent pass and eventually starve the whole window
    // (the same fix `run-due.ts` already makes for an unbound job).
    const badParent = await loadJob(bad.parentJobId, { businessId: BUSINESS });
    expect(badParent?.phase).toBe('failed');
  });

  /**
   * A value that cannot be read is never a permitting value — the same rule
   * `amount_unreadable` enforces for money. `Date.parse` on a mangled
   * `deadlineAt` returns `NaN`, and `NaN <= now.getTime()` is always `false`;
   * left unchecked, an unreadable deadline reads as "still inside the
   * window" and the parent is skipped silently, with no timeout and no
   * `errored` line, forever.
   */
  it('fails a parent outright rather than treating an unreadable deadline as still inside the window', async () => {
    const { parentJobId } = await openDelegation();
    // The child is left running — the branch this bug hides in only matters
    // when there is no terminal phase to decide the outcome outright.
    const parent = await loadJob(parentJobId, { businessId: BUSINESS });
    if (parent?.awaitingEnvelopeId == null) throw new Error('expected an awaiting envelope id');
    await getPool().query(
      `UPDATE agent_envelopes SET constraints = jsonb_set(constraints, '{deadlineAt}', '"not-a-date"')
        WHERE business_id = $1 AND envelope_id = $2`,
      [BUSINESS, parent.awaitingEnvelopeId],
    );

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.errored).toEqual([{ jobId: parentJobId, error: expect.any(String) }]);
    expect(result.errored[0]?.error).toContain('unreadable deadline');
    expect(result.timedOut).toEqual([]);
    expect(result.resumed).toEqual([]);

    const failedParent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(failedParent?.phase).toBe('failed');
  });

  /**
   * `failCorruptedParent`'s second arm: the envelope exists but no child was
   * ever attached — the crash window `requestHelp`'s own docblock names,
   * between `writeEnvelope` committing and `attachChildJob` running.
   *
   * The assertion is on the RECORDED REASON, not on "the parent did not
   * resume". A parent that is merely skipped also fails to resume, so an
   * absence-only assertion would pass with this arm deleted — the arm's whole
   * point is that a parent parked on a promise nothing can keep is moved to a
   * terminal phase loudly rather than left to starve the scheduler's window.
   */
  it('fails a parent whose envelope has no child attached, rather than skipping it', async () => {
    const { parentJobId, envelopeId } = await openDelegation();
    // Undo the attach, leaving exactly what a crash between `writeEnvelope`
    // and `attachChildJob` leaves: an envelope with no child.
    await getPool().query(
      'UPDATE agent_envelopes SET child_job_id = NULL WHERE business_id = $1 AND envelope_id = $2',
      [BUSINESS, envelopeId],
    );

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([]);
    expect(result.timedOut).toEqual([]);
    expect(result.errored).toEqual([{ jobId: parentJobId, error: expect.any(String) }]);
    expect(result.errored[0]?.error).toContain('no child job attached');
    expect(result.errored[0]?.error).toContain(envelopeId);

    const failedParent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(failedParent?.phase).toBe('failed');
  });

  /**
   * `failCorruptedParent`'s third arm: the envelope names a child job row that
   * does not exist. Distinguished from the missing-ENVELOPE arm on purpose —
   * both reasons end in "does not exist", so this asserts the child-shaped
   * wording and the bogus child id, which the missing-envelope arm's message
   * never carries.
   *
   * Again asserted on the recorded reason and the terminal phase: with the arm
   * deleted, `child === null` would fall through to `child.phase` and throw,
   * landing in the generic `catch` that reports `errored` WITHOUT failing the
   * parent — so "not resumed" alone cannot tell the two apart.
   */
  it("fails a parent whose envelope points at a child job row that does not exist", async () => {
    const { parentJobId, childJobId, envelopeId } = await openDelegation();
    await getPool().query(
      'UPDATE agent_envelopes SET child_job_id = $3 WHERE business_id = $1 AND envelope_id = $2',
      [BUSINESS, envelopeId, 'JOB-never-created'],
    );

    const result = await resumeDelegatedJobs({ businessId: BUSINESS });
    expect(result.resumed).toEqual([]);
    expect(result.timedOut).toEqual([]);
    expect(result.errored).toEqual([{ jobId: parentJobId, error: expect.any(String) }]);
    expect(result.errored[0]?.error).toContain("child JOB-never-created does not exist");

    const failedParent = await loadJob(parentJobId, { businessId: BUSINESS });
    expect(failedParent?.phase).toBe('failed');

    // The real child is untouched — only the envelope's pointer was corrupted.
    const child = await loadJob(childJobId, { businessId: BUSINESS });
    expect(child?.phase).toBe('execute');
  });
});
