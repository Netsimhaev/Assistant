import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { insertOrGetDocument } from '../documents/store.js';
import { recordSignature } from './signatures.js';
import { keepItem } from './kept-items.js';
import { buildErasurePlan } from './erasure-plan.js';

const BUSINESS = 'test-business';
const RONIT = 'ronit@beta-log.example';

/** A job with a fresh charter, nothing else attached. */
async function bareJob(title: string): Promise<string> {
  const bundle = await installCharter(buildCharter({ version: `er-${title}` }), {
    businessId: BUSINESS,
  });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title,
  });
  return job.jobId;
}

/** A job that mentions the anchor in its authorisation and its plan. */
async function jobAbout(identifier: string, title: string): Promise<string> {
  const jobId = await bareJob(title);
  await getPool().query(
    `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
     VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
    [BUSINESS, jobId, identifier],
  );
  await getPool().query(
    `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
     VALUES ($1, $2, 'h1', $3::jsonb)`,
    [BUSINESS, jobId, JSON.stringify({ goal: 'send', steps: [{ input: { to: [identifier] } }] })],
  );
  return jobId;
}

async function aDocument(): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'חוזה.docx',
      mediaType: 'text/plain',
      sha256: `${documentId}-hash`.padEnd(64, '0').slice(0, 64),
      byteSize: 10,
      storedPath: `${BUSINESS}/${documentId}/original.txt`,
    },
    { businessId: BUSINESS },
  );
  return documentId;
}

describe('buildErasurePlan', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  describe('finds a contact through every place the anchor can appear', () => {
    it('via job_authorizations.recipients', async () => {
      const jobId = await bareJob('via-authorization');
      await getPool().query(
        `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
         VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
        [BUSINESS, jobId, RONIT],
      );

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).toContain(jobId);
    });

    it('via job_plans.plan', async () => {
      const jobId = await bareJob('via-plan');
      await getPool().query(
        `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
         VALUES ($1, $2, 'h1', $3::jsonb)`,
        [BUSINESS, jobId, JSON.stringify({ goal: 'send', steps: [{ input: { to: [RONIT] } }] })],
      );

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).toContain(jobId);
    });

    it('via boss_instructions.text', async () => {
      const jobId = await bareJob('via-instruction');
      await getPool().query(
        `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text)
         VALUES ($1, $2, $3, $4)`,
        [`INS-${ulid()}`, BUSINESS, jobId, `תשלחי תזכורת ל-${RONIT}`],
      );

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).toContain(jobId);
    });

    it('via approval_requests (proposed input, summary and detail)', async () => {
      const jobId = await bareJob('via-approval');
      await getPool().query(
        `INSERT INTO approval_requests
           (approval_id, business_id, job_id, action_class, summary, detail, risk,
            proposed_tool, proposed_input, input_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          `AP-${ulid()}`,
          BUSINESS,
          jobId,
          'email.reply',
          'שליחת מייל',
          `אישור לשליחה אל ${RONIT}`,
          '{}',
          'mail.send',
          JSON.stringify({ to: RONIT }),
          'hash-1',
          new Date(Date.now() + 3600_000).toISOString(),
        ],
      );

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).toContain(jobId);
    });

    it('via agent_envelopes.payload', async () => {
      // Standing in for `requestHelp` called directly, with no plan step
      // behind it (Task 10) — the one shape `job_plans.plan` cannot discover
      // by itself, per `AGENT_ENVELOPES_ERASED_PREDICATE`'s docblock.
      const jobId = await bareJob('via-envelope');
      await getPool().query(
        `INSERT INTO agent_envelopes
           (business_id, envelope_id, correlation_id, causal_chain, from_agent, to_agent,
            kind, intent, payload, context_refs, context_refs_hash, constraints, hops,
            idempotency_key, parent_job_id)
         VALUES ($1, $2, $2, ARRAY['office.manager'], 'office.manager', 'ops.web',
                 'help_request', 'lookup_contact', $3::jsonb, '[]'::jsonb, 'hash-env',
                 '{}'::jsonb, 1, $4, $5)`,
        [BUSINESS, `ENV-${ulid()}`, JSON.stringify({ lookFor: RONIT }), `idem-${ulid()}`, jobId],
      );

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).toContain(jobId);
    });

    it('via jobs.title', async () => {
      const jobId = await bareJob(`פנייה בנוגע ל-${RONIT}`);

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).toContain(jobId);
    });
  });

  it('classifies items as delete or scrub correctly', async () => {
    const jobId = await jobAbout(RONIT, 'action-classification');
    await writeMemory(
      { jobId, kind: 'entity', subjectKey: RONIT, body: { name: 'רונית' } },
      { businessId: BUSINESS },
    );
    await getPool().query(
      `INSERT INTO agent_envelopes
         (business_id, envelope_id, correlation_id, causal_chain, from_agent, to_agent,
          kind, intent, payload, context_refs, context_refs_hash, constraints, hops,
          idempotency_key, parent_job_id)
       VALUES ($1, $2, $2, ARRAY['office.manager'], 'office.manager', 'ops.web',
               'help_request', 'lookup_contact', $3::jsonb, '[]'::jsonb, 'hash-cls',
               '{}'::jsonb, 1, $4, $5)`,
      [BUSINESS, `ENV-${ulid()}`, JSON.stringify({ lookFor: RONIT }), `idem-${ulid()}`, jobId],
    );
    await getPool().query(
      `INSERT INTO verification_verdicts (business_id, job_id, verdict) VALUES ($1, $2, '{}'::jsonb)`,
      [BUSINESS, jobId],
    );

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    const tables = new Map(plan.items.map((i) => [i.table, i]));
    expect(tables.get('memories')?.action).toBe('delete');
    expect(tables.get('job_plans')?.action).toBe('delete');
    expect(tables.get('job_authorizations')?.action).toBe('delete');
    // A job row survives with its content emptied — audit rows point at it.
    expect(tables.get('jobs')?.action).toBe('scrub');
    expect(tables.get('agent_envelopes')).toEqual({ table: 'agent_envelopes', action: 'delete', count: 1 });
    expect(tables.get('verification_verdicts')).toEqual({
      table: 'verification_verdicts',
      action: 'delete',
      count: 1,
    });
  });

  /**
   * The other direction, and the one that makes the tests above mean
   * something: an erasure that swept everything would satisfy them perfectly.
   */
  it('leaves a second contact completely untouched', async () => {
    const mine = await jobAbout(RONIT, 'ronit');
    const theirs = await jobAbout('avi@gamma-lift.example', 'avi');
    await writeMemory({ jobId: mine, kind: 'entity', subjectKey: RONIT, body: {} }, { businessId: BUSINESS });
    await writeMemory(
      { jobId: theirs, kind: 'entity', subjectKey: 'avi@gamma-lift.example', body: {} },
      { businessId: BUSINESS },
    );

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    expect(plan.jobIds).toContain(mine);
    expect(plan.jobIds).not.toContain(theirs);
    expect(plan.memoryIds).toHaveLength(1);
  });

  it('treats a wildcard character in the anchor as a literal', async () => {
    const jobId = await jobAbout(RONIT, 'ronit');
    await writeMemory({ jobId, kind: 'chunk', subjectKey: 'c_1', body: { t: 'x' } }, { businessId: BUSINESS });

    // `%` would match every row if it reached LIKE unescaped.
    const plan = await buildErasurePlan({ kind: 'contact', identifier: '%' }, { businessId: BUSINESS });
    expect(plan.jobIds).toEqual([]);
    expect(plan.memoryIds).toEqual([]);
  });

  describe('kept items are excluded and explained, never skipped silently', () => {
    it('excludes a kept memory and says why', async () => {
      const jobId = await jobAbout(RONIT, 'ronit');
      const memory = await writeMemory(
        { jobId, kind: 'entity', subjectKey: RONIT, body: {} },
        { businessId: BUSINESS },
      );
      await keepItem({ kind: 'memory', itemId: memory.memoryId, note: 'חשוב' }, { businessId: BUSINESS });

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.memoryIds).not.toContain(memory.memoryId);
      expect(plan.excluded).toHaveLength(1);
      expect(plan.excluded[0]?.itemKind).toBe('memory');
      expect(plan.excluded[0]?.itemId).toBe(memory.memoryId);
      expect(plan.excluded[0]?.note).toBe('חשוב');
      expect(typeof plan.excluded[0]?.keptAt).toBe('string');
    });

    it('excludes a kept document and says why', async () => {
      const documentId = await aDocument();
      await keepItem({ kind: 'document', itemId: documentId, note: 'לשימור' }, { businessId: BUSINESS });

      const plan = await buildErasurePlan({ kind: 'document', documentId }, { businessId: BUSINESS });

      expect(plan.documentIds).not.toContain(documentId);
      expect(plan.excluded).toHaveLength(1);
      expect(plan.excluded[0]?.itemKind).toBe('document');
      expect(plan.excluded[0]?.itemId).toBe(documentId);
      expect(plan.excluded[0]?.note).toBe('לשימור');
      expect(typeof plan.excluded[0]?.keptAt).toBe('string');
    });

    it('excludes a kept job and says why', async () => {
      const jobId = await jobAbout(RONIT, 'kept-job');
      await keepItem({ kind: 'job', itemId: jobId, note: 'לשימור' }, { businessId: BUSINESS });

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).not.toContain(jobId);
      expect(plan.excluded).toHaveLength(1);
      expect(plan.excluded[0]?.itemKind).toBe('job');
      expect(plan.excluded[0]?.itemId).toBe(jobId);
      expect(plan.excluded[0]?.note).toBe('לשימור');
      expect(typeof plan.excluded[0]?.keptAt).toBe('string');
    });
  });

  it('refuses while a job it would touch is still waiting on the owner', async () => {
    const jobId = await jobAbout(RONIT, 'ronit');
    for (const to of ['understand', 'plan', 'execute', 'await_approval'] as const) {
      await transition(jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
    }

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]?.kind).toBe('live_job');
    expect(plan.refusals[0]?.detail).toContain(jobId);
  });

  it('refuses to erase a document that carries a signature', async () => {
    const documentId = await aDocument();
    await recordSignature(
      {
        signatureId: `SIG-${ulid()}`,
        documentId,
        signedSha256: 'c'.repeat(64),
        approvalId: `AP-${ulid()}`,
        signedBy: 'owner',
      },
      { businessId: BUSINESS },
    );

    const plan = await buildErasurePlan({ kind: 'document', documentId }, { businessId: BUSINESS });

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]?.kind).toBe('signed_document');
    expect(plan.refusals[0]?.detail).toContain(documentId);
  });

  it('builds nothing at all for an anchor nothing matches', async () => {
    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: 'nobody@nowhere.example' },
      { businessId: BUSINESS },
    );
    expect(plan.jobIds).toEqual([]);
    expect(plan.items.every((i) => i.count === 0)).toBe(true);
  });
  /**
   * `documents.stored_path` is relative — `ingest.ts` writes
   * `<businessId>/<documentId>/original.<ext>` and joins `config.documentRoot`
   * separately. The executor `unlink`s what this plan lists and resolves
   * nothing of its own (spec §8), so the join has to happen here: a relative
   * path handed to `unlink` resolves against whatever the process's working
   * directory happens to be, misses, and is tolerated as "already gone".
   * Every row destroyed, every byte retained, and the screen says done.
   *
   * `verify.ts` is the house convention for this exact column.
   */
  it('resolves every file path against the document root, never leaving it relative', async () => {
    const documentId = await aDocument();

    const plan = await buildErasurePlan({ kind: 'document', documentId }, { businessId: BUSINESS });

    expect(plan.filePaths).toHaveLength(1);
    expect(plan.filePaths.every((path) => isAbsolute(path))).toBe(true);
    expect(plan.filePaths[0]).toBe(join(config.documentRoot, `${BUSINESS}/${documentId}/original.txt`));
  });

  it('joins against an injected document root when one is given', async () => {
    const documentId = await aDocument();
    const root = join(tmpdir(), 'erase-plan-root');

    const plan = await buildErasurePlan(
      { kind: 'document', documentId },
      { businessId: BUSINESS, documentRoot: root },
    );

    expect(plan.filePaths[0]).toBe(join(root, `${BUSINESS}/${documentId}/original.txt`));
  });
});
