import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { insertOrGetDocument } from '../documents/store.js';
import { recordSignature } from './signatures.js';
import { keepItem } from './kept-items.js';
import { buildErasurePlan } from './erasure-plan.js';
import { ErasureRefusedError, executeErasure } from './erasure.js';
import { renderErasure } from '../dashboard/views.js';

const BUSINESS = 'test-business';
const RONIT = 'ronit@beta-log.example';

/** A job with a fresh charter, nothing else attached. */
async function bareJob(title: string): Promise<string> {
  const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: `er-${title}` }))); // TENANCY-TODO(task 6)
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
        `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text, text_origin)
         VALUES ($1, $2, $3, $4, 'typed')`,
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

    /**
     * Fix round 2, item 2. `_` is an ordinary character in an email local
     * part and a LIKE wildcard, and this project has already shipped a broken
     * `ESCAPE ''` once (the orphan `approval_requests` predicate) that stayed
     * green because the control probing it carried no wildcard at all.
     *
     * **The neighbouring `'via agent_envelopes.payload'` test's job is
     * reachable ONLY through the envelope too** (`bareJob` alone — a charter
     * and a title that never mentions `RONIT` — plus one envelope; `beforeEach`
     * calls `resetDatabase()`, so there is no shared fixture underneath it to
     * be reachable through). Fix round 3, item 6 corrected an earlier version
     * of this comment that claimed otherwise. The real and only reason that
     * test cannot catch broken escaping is that `RONIT` carries no LIKE
     * wildcard — a broken `ESCAPE ''` still matches a pattern with no `_`, `%`
     * or `\` in it, so that test would stay green either way. This test is
     * isolated the identical way and differs only in the identifier, which
     * does carry one.
     */
    it('discovers a contact through agent_envelopes.payload even when the identifier contains a LIKE wildcard', async () => {
      const jobId = await bareJob('via-envelope-wildcard');
      const identifier = 'zz_env-wild@nowhere.example';
      await getPool().query(
        `INSERT INTO agent_envelopes
           (business_id, envelope_id, correlation_id, causal_chain, from_agent, to_agent,
            kind, intent, payload, context_refs, context_refs_hash, constraints, hops,
            idempotency_key, parent_job_id)
         VALUES ($1, $2, $2, ARRAY['office.manager'], 'office.manager', 'ops.web',
                 'help_request', 'lookup_contact', $3::jsonb, '[]'::jsonb, 'hash-wild',
                 '{}'::jsonb, 1, $4, $5)`,
        [BUSINESS, `ENV-${ulid()}`, JSON.stringify({ lookFor: identifier }), `idem-${ulid()}`, jobId],
      );

      const plan = await buildErasurePlan({ kind: 'contact', identifier }, { businessId: BUSINESS });

      expect(plan.jobIds).toContain(jobId);
    });

    // Task 11: `gov.verify`'s job carries no bound plan (`conduct.ts`'s
    // `beginVerification`), so unlike a plan-issued delegation's
    // `agent_envelopes.payload`, this content is NOT already reachable
    // through `job_plans.plan` — the same shape the query above closes for a
    // directly-invoked delegation, one table over.
    it('via verification_verdicts.verdict', async () => {
      const jobId = await bareJob('via-verdict');
      await getPool().query(
        `INSERT INTO verification_verdicts (business_id, job_id, verdict) VALUES ($1, $2, $3::jsonb)`,
        [
          BUSINESS,
          jobId,
          JSON.stringify({
            criteria: [
              {
                id: 'answers_question',
                statement: 'x',
                severity: 'must',
                passed: true,
                detail: `מצטט: לפנות ל-${RONIT}`,
              },
            ],
            ungroundedNumbers: [],
            answerTruncated: false,
            draftTruncated: false,
          }),
        ],
      );

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).toContain(jobId);
    });

    // Fix round 2, item 2's lesson, repeated one table over: `_` is an
    // ordinary email character and a LIKE wildcard, and a broken `ESCAPE ''`
    // only shows up against an identifier that actually carries one.
    it('discovers a contact through verification_verdicts.verdict even when the identifier contains a LIKE wildcard', async () => {
      const jobId = await bareJob('via-verdict-wildcard');
      const identifier = 'zz_verdict-wild@nowhere.example';
      await getPool().query(
        `INSERT INTO verification_verdicts (business_id, job_id, verdict) VALUES ($1, $2, $3::jsonb)`,
        [
          BUSINESS,
          jobId,
          JSON.stringify({
            criteria: [
              {
                id: 'answers_question',
                statement: 'x',
                severity: 'must',
                passed: true,
                detail: `מצטט: לפנות ל-${identifier}`,
              },
            ],
            ungroundedNumbers: [],
            answerTruncated: false,
            draftTruncated: false,
          }),
        ],
      );

      const plan = await buildErasurePlan({ kind: 'contact', identifier }, { businessId: BUSINESS });

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

  /**
   * Spec §7: the stored digest NAMES failures, so a document name, a
   * recipient or a contact name can land in its body. Once stored it
   * survives, and "forget about Ronit" must reach it.
   *
   * `digests` has no `job_id` and no document reference at all (see
   * `erasure-plan.ts`'s header), so this is the whole discovery: a digest
   * whose body happens to name the contact must be both found AND counted
   * for deletion by the preview, with nothing else in the system tying it
   * to anything else that would have carried it in by accident.
   */
  it('finds a digest whose body mentions the contact, and counts it for deletion', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'digest-found' }))); // TENANCY-TODO(task 6)
    const digestId = `DG-${ulid()}`;
    await getPool().query(
      `INSERT INTO digests (digest_id, business_id, kind, window_start, window_end, body, had_content)
       VALUES ($1, $2, 'daily', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', $3, true)`,
      [digestId, BUSINESS, `תדריך יומי · ממתין לך: שליחה ל-${RONIT} נכשלה`],
    );
    // A decoy, naming a different contact: without it, a predicate that
    // matched every digest in the business (not just the one naming RONIT)
    // would still report count 1, because this would otherwise be the only
    // row in the table. With it, a selective match stays at 1 and an
    // unselective one reports 2.
    await getPool().query(
      `INSERT INTO digests (digest_id, business_id, kind, window_start, window_end, body, had_content)
       VALUES ($1, $2, 'daily', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', $3, true)`,
      [`DG-${ulid()}`, BUSINESS, 'תדריך יומי · הכל תקין, אין חריגות'],
    );

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    expect(plan.digestIds).toEqual([digestId]);
    const digestItem = plan.items.find((i) => i.table === 'digests' && i.action === 'delete');
    expect(digestItem).toEqual({ table: 'digests', action: 'delete', count: 1 });
  });

  /**
   * The discovery half, which is the one this repo has twice forgotten (see
   * `job_plans` and `job_authorizations` in CLAUDE.md): a search by the
   * person's name must FIND the digest, not merely delete it once it was
   * found through something else. No job, no document, no memory, no
   * authorization — nothing but the digest's own `body` names the contact.
   */
  it('discovers a digest by its body alone, with no job or document linking to it', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'digest-discovery' }))); // TENANCY-TODO(task 6)
    const digestId = `DG-${ulid()}`;
    await getPool().query(
      `INSERT INTO digests (digest_id, business_id, kind, window_start, window_end, body, had_content)
       VALUES ($1, $2, 'weekly', '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', $3, true)`,
      [digestId, BUSINESS, `תדריך שבועי · מסמך מ-${RONIT} נדחה`],
    );
    // A second digest naming an unrelated contact, so an unselective match
    // (every digest in the business, not just this one) would be caught by
    // the exact-array assertion below rather than passing by coincidence.
    await getPool().query(
      `INSERT INTO digests (digest_id, business_id, kind, window_start, window_end, body, had_content)
       VALUES ($1, $2, 'weekly', '2026-01-08T00:00:00Z', '2026-01-15T00:00:00Z', $3, true)`,
      [`DG-${ulid()}`, BUSINESS, 'תדריך שבועי · מסמך מ-avi@gamma-lift.example נדחה'],
    );

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS },
    );

    expect(plan.jobIds).toEqual([]);
    expect(plan.documentIds).toEqual([]);
    expect(plan.digestIds).toEqual([digestId]);
  });

  /**
   * Fix round 2, item 11: the WINDOW-anchor arm of digest discovery
   * (`erasure-plan.ts:875-882`) had no test at all — both digest tests above
   * use a `contact` anchor. A wrong column there (`window_start` for
   * `created_at`) or a wrong comparison (`>` for `>=`) would mean an owner
   * erasing a date range silently keeps the digests that summarise it.
   * Seeded with explicit `created_at` (the column the query actually filters
   * on, per `erasure-plan.ts`'s own header note — never `window_start`/
   * `window_end`) so this is a genuine probe of that column and that
   * comparison, not an accident of insertion order. The decoy sits one
   * second before `fromIso` — the edge a `>` vs `>=` mistake would flip.
   */
  it('discovers a digest by a window anchor on its created_at, with a decoy just outside the range', async () => {
    await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'digest-window' }))); // TENANCY-TODO(task 6)
    const insideId = `DG-${ulid()}`;
    const outsideId = `DG-${ulid()}`;
    await getPool().query(
      `INSERT INTO digests (digest_id, business_id, kind, window_start, window_end, body, had_content, created_at)
       VALUES ($1, $2, 'daily', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'תדריך יומי · הכל תקין', true, $3)`,
      [insideId, BUSINESS, '2026-03-10T12:00:00Z'],
    );
    // One second before the window's lower bound — the exact edge a `>`
    // mistake (instead of `>=`) would wrongly admit, and the exact edge a
    // decoy at some unrelated far-away date would not test at all.
    await getPool().query(
      `INSERT INTO digests (digest_id, business_id, kind, window_start, window_end, body, had_content, created_at)
       VALUES ($1, $2, 'daily', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'תדריך יומי · הכל תקין', true, $3)`,
      [outsideId, BUSINESS, '2026-03-10T11:59:59Z'],
    );

    const plan = await buildErasurePlan(
      { kind: 'window', fromIso: '2026-03-10T12:00:00Z', toIso: '2026-03-11T12:00:00Z' },
      { businessId: BUSINESS },
    );

    expect(plan.digestIds).toEqual([insideId]);
    const digestItem = plan.items.find((i) => i.table === 'digests' && i.action === 'delete');
    expect(digestItem).toEqual({ table: 'digests', action: 'delete', count: 1 });
  });

  /**
   * Migration 051: the interview draft holds names, domains and phones the
   * owner typed — a do-not-contact entry is a person by definition — and it
   * has no job and no document, so its own `answers` is the only way a
   * contact erasure reaches it. The label carries `"` (`בע"מ`) on purpose:
   * it is JSON-escaped in `answers::text`, so only the unescaped arm of
   * `jsonbContentMatches` finds it.
   */
  it('discovers an interview draft by a name in its answers, and counts it for deletion', async () => {
    const name = `${RONIT} בע"מ`;
    await getPool().query(
      `INSERT INTO charter_interview_drafts (draft_id, business_id, answers)
       VALUES ('DR-ronit', $1, $2::jsonb)`,
      [BUSINESS, JSON.stringify({ counterparties: { known: [], doNotContact: [{ label: name, phone: '+972541234567' }] } })],
    );
    await getPool().query(
      `INSERT INTO charter_interview_drafts (draft_id, business_id, answers)
       VALUES ('DR-other', 'other-business', $1::jsonb)`,
      [JSON.stringify({ counterparties: { known: [], doNotContact: [{ label: name, phone: '+972541234567' }] } })],
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: name }, { businessId: BUSINESS });

    expect(plan.draftIds).toEqual(['DR-ronit']);
    expect(plan.items.find((i) => i.table === 'charter_interview_drafts')).toEqual({
      table: 'charter_interview_drafts',
      action: 'delete',
      count: 1,
    });
  });

  /**
   * Window and document anchors reach no draft: the draft has no time a
   * real-world event happened at, and no document reference of any kind.
   */
  it('reaches no interview draft from a window or a document anchor', async () => {
    await getPool().query(
      `INSERT INTO charter_interview_drafts (draft_id, business_id, answers) VALUES ('DR-any', $1, '{}')`,
      [BUSINESS],
    );
    const window = await buildErasurePlan(
      { kind: 'window', fromIso: '2000-01-01T00:00:00Z', toIso: '2100-01-01T00:00:00Z' },
      { businessId: BUSINESS },
    );
    expect(window.draftIds).toEqual([]);
    const document = await buildErasurePlan({ kind: 'document', documentId: 'DOC-none' }, { businessId: BUSINESS });
    expect(document.draftIds).toEqual([]);
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

    // Keyed by table AND action, not table alone: `jobs` now reports both a
    // `scrub` (title/pointer cleared, unconditionally) and a `fail` (a
    // stranded parent, here always 0) — a map keyed by table alone would let
    // whichever is pushed last in `countItems` silently stand in for the
    // other, the same defect `approval_requests`'s `delete`+`scrub` pair
    // already forced onto `erasure.test.ts`'s `byStatement` map.
    const tables = new Map(plan.items.map((i) => [`${i.table}:${i.action}`, i]));
    expect(tables.get('memories:delete')?.action).toBe('delete');
    expect(tables.get('job_plans:delete')?.action).toBe('delete');
    expect(tables.get('job_authorizations:delete')?.action).toBe('delete');
    // A job row survives with its content emptied — audit rows point at it.
    expect(tables.get('jobs:scrub')?.action).toBe('scrub');
    // No job here is parked in `followup`, so the `fail` disposition exists
    // in the preview but counts zero.
    expect(tables.get('jobs:fail')).toEqual({ table: 'jobs', action: 'fail', count: 0 });
    expect(tables.get('agent_envelopes:delete')).toEqual({
      table: 'agent_envelopes',
      action: 'delete',
      count: 1,
    });
    expect(tables.get('verification_verdicts:delete')).toEqual({
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

  /**
   * A name with a `"` in it — `בע"מ` is ordinary Hebrew — is stored inside a
   * JSONB value as `\"`, and `jsonb::text` keeps the escape. So `plan::text
   * ILIKE '%אלפא בע"מ%'` matched nothing, the job was never discovered, and
   * the plan copy survived a contact erasure. Each JSONB arm must also match
   * the unescaped string values (`jsonbContentMatches`).
   */
  describe('finds a contact whose name only appears JSON-escaped', () => {
    const QUOTED = 'אלפא בע"מ';

    it('the premise holds: the escaped text form does not match', async () => {
      const { rows } = await getPool().query<{ m: boolean }>(
        `SELECT $1::jsonb::text ILIKE $2 AS m`,
        [JSON.stringify({ body: `לכבוד ${QUOTED}\nשלום` }), `%${QUOTED}%`],
      );
      expect(rows[0]?.m).toBe(false);
    });

    it('via job_plans.plan', async () => {
      const jobId = await bareJob('quoted-plan');
      await getPool().query(
        `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
         VALUES ($1, $2, 'h1', $3::jsonb)`,
        [BUSINESS, jobId, JSON.stringify({ goal: 'send', steps: [{ input: { body: `לכבוד ${QUOTED}\nשלום` } }] })],
      );

      const plan = await buildErasurePlan({ kind: 'contact', identifier: QUOTED }, { businessId: BUSINESS });

      expect(plan.jobIds).toContain(jobId);
    });

    it('via approval_requests.proposed_input', async () => {
      const jobId = await bareJob('quoted-approval');
      await getPool().query(
        `INSERT INTO approval_requests
           (approval_id, business_id, job_id, action_class, summary, detail, risk,
            proposed_tool, proposed_input, input_hash, expires_at)
         VALUES ($1, $2, $3, 'email.reply', 'שליחת מייל', 'אישור', '{}', 'mail.send', $4, 'hash-q', $5)`,
        [
          `AP-${ulid()}`,
          BUSINESS,
          jobId,
          JSON.stringify({ body: `שלום ${QUOTED}` }),
          new Date(Date.now() + 3600_000).toISOString(),
        ],
      );

      const plan = await buildErasurePlan({ kind: 'contact', identifier: QUOTED }, { businessId: BUSINESS });

      expect(plan.jobIds).toContain(jobId);
    });

    it('an orphan approval card (no job) is counted for deletion', async () => {
      await getPool().query(
        `INSERT INTO approval_requests
           (approval_id, business_id, job_id, action_class, summary, detail, risk,
            proposed_tool, proposed_input, input_hash, expires_at)
         VALUES ($1, $2, NULL, 'email.reply', 'שליחת מייל', 'אישור', '{}', 'mail.send', $3, 'hash-o', $4)`,
        [
          `AP-${ulid()}`,
          BUSINESS,
          JSON.stringify({ body: `שלום ${QUOTED}` }),
          new Date(Date.now() + 3600_000).toISOString(),
        ],
      );

      const plan = await buildErasurePlan({ kind: 'contact', identifier: QUOTED }, { businessId: BUSINESS });

      const item = plan.items.find((i) => i.table === 'approval_requests' && i.action === 'delete');
      expect(item?.count).toBe(1);
    });

    it('via agent_envelopes.payload', async () => {
      const jobId = await bareJob('quoted-envelope');
      await getPool().query(
        `INSERT INTO agent_envelopes
           (business_id, envelope_id, correlation_id, causal_chain, from_agent, to_agent,
            kind, intent, payload, context_refs, context_refs_hash, constraints, hops,
            idempotency_key, parent_job_id)
         VALUES ($1, $2, $2, ARRAY['office.manager'], 'office.manager', 'ops.web',
                 'help_request', 'lookup_contact', $3::jsonb, '[]'::jsonb, 'hash-env',
                 '{}'::jsonb, 1, $4, $5)`,
        [BUSINESS, `ENV-${ulid()}`, JSON.stringify({ lookFor: QUOTED }), `idem-${ulid()}`, jobId],
      );

      const plan = await buildErasurePlan({ kind: 'contact', identifier: QUOTED }, { businessId: BUSINESS });

      expect(plan.jobIds).toContain(jobId);
    });

    it('via verification_verdicts.verdict', async () => {
      const jobId = await bareJob('quoted-verdict');
      await getPool().query(
        `INSERT INTO verification_verdicts (business_id, job_id, verdict) VALUES ($1, $2, $3::jsonb)`,
        [BUSINESS, jobId, JSON.stringify({ note: `נבדק מול ${QUOTED}` })],
      );

      const plan = await buildErasurePlan({ kind: 'contact', identifier: QUOTED }, { businessId: BUSINESS });

      expect(plan.jobIds).toContain(jobId);
    });

    it('still treats a wildcard inside a JSON string value as a literal', async () => {
      const jobId = await bareJob('quoted-wild');
      await getPool().query(
        `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
         VALUES ($1, $2, 'h1', $3::jsonb)`,
        [BUSINESS, jobId, JSON.stringify({ steps: [{ input: { to: 'axb@nowhere.example' } }] })],
      );

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: 'a_b@nowhere.example' },
        { businessId: BUSINESS },
      );

      expect(plan.jobIds).not.toContain(jobId);
    });
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
      await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'memory', itemId: memory.memoryId, note: 'חשוב' })); // TENANCY-TODO(task 6)

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
      await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'document', itemId: documentId, note: 'לשימור' })); // TENANCY-TODO(task 6)

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
      await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'job', itemId: jobId, note: 'לשימור' })); // TENANCY-TODO(task 6)

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
    await withBusiness(BUSINESS, (bdb) => recordSignature( // TENANCY-TODO(task 6)
      bdb,
      {
        signatureId: `SIG-${ulid()}`,
        documentId,
        signedSha256: 'c'.repeat(64),
        approvalId: `AP-${ulid()}`,
        signedBy: 'owner',
      }
    ));

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

/**
 * The task ledger (migration 052). Its rows hold names, addresses and free
 * descriptions — content about a person — so it is wired in BOTH roles, like
 * `boss_instructions`: a discovery source by its own content, and a deletion
 * target by job membership. And an item drags the jobs it produced (origin,
 * nudge, every event's job): a nudge job's plan carries the counterparty's
 * address, and erasing the item while leaving that plan would keep the very
 * thing the owner asked to forget.
 */
describe('the task ledger', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  interface ItemSeed {
    itemId: string;
    originJobId: string;
    description?: string;
    counterpartyName?: string | null;
    counterpartyEmail?: string | null;
    counterpartyDomain?: string | null;
    reference?: string | null;
    stages?: unknown;
    proposedStages?: unknown;
    nudgeJobId?: string | null;
    createdAt?: string;
  }

  async function anItem(seed: ItemSeed): Promise<string> {
    await getPool().query(
      `INSERT INTO ledger_items
         (item_id, business_id, family, description, counterparty_name, counterparty_email,
          counterparty_domain, reference, stages, proposed_stages, nudge_job_id, origin_job_id,
          created_at)
       VALUES ($1, $2, 'money_in', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11,
               coalesce($12::timestamptz, now()))`,
      [
        seed.itemId,
        BUSINESS,
        seed.description ?? 'שורה רגילה',
        seed.counterpartyName ?? null,
        seed.counterpartyEmail ?? null,
        seed.counterpartyDomain ?? null,
        seed.reference ?? null,
        JSON.stringify(seed.stages ?? []),
        seed.proposedStages === undefined ? null : JSON.stringify(seed.proposedStages),
        seed.nudgeJobId ?? null,
        seed.originJobId,
        seed.createdAt ?? null,
      ],
    );
    return seed.itemId;
  }

  async function anEvent(itemId: string, eventId: string, note: string | null, jobId: string | null = null): Promise<void> {
    await getPool().query(
      `INSERT INTO ledger_events (event_id, business_id, item_id, kind, job_id, note, by_whom)
       VALUES ($1, $2, $3, 'updated', $4, $5, 'owner')`,
      [eventId, BUSINESS, itemId, jobId, note],
    );
  }

  async function aReminder(itemId: string, reminderId: string, body: string): Promise<void> {
    await getPool().query(
      `INSERT INTO ledger_reminders (reminder_id, business_id, item_id, slot, kind, body)
       VALUES ($1, $2, $3, $4, 'due', $5)`,
      [reminderId, BUSINESS, itemId, `slot-${reminderId}`, body],
    );
  }

  const count = (
    plan: Awaited<ReturnType<typeof buildErasurePlan>>,
    table: string,
    action = 'delete',
  ): number | undefined => plan.items.find((i) => i.table === table && i.action === action)?.count;

  it.each([
    ['description', { description: `חשבונית של ${RONIT}` }],
    ['counterparty_name', { counterpartyName: RONIT }],
    ['counterparty_email', { counterpartyEmail: RONIT }],
    ['counterparty_domain', { counterpartyDomain: `x${RONIT}` }],
    ['reference', { reference: `הזמנה ${RONIT}` }],
    ['stages', { stages: [{ name: `שיחה עם ${RONIT}`, done: false }] }],
    ['proposed_stages', { proposedStages: [{ name: `פגישה עם ${RONIT}`, done: false }] }],
  ] as Array<[string, Partial<ItemSeed>]>)('finds an item by its own %s', async (_column, fields) => {
    const origin = await bareJob('ledger-origin');
    const decoyOrigin = await bareJob('ledger-decoy-origin');
    await anItem({ itemId: 'LI-match', originJobId: origin, ...fields });
    await anItem({ itemId: 'LI-decoy', originJobId: decoyOrigin, description: 'משהו אחר לגמרי' });

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.ledgerItemIds).toEqual(['LI-match']);
    expect(plan.jobIds).toContain(origin);
    expect(plan.jobIds).not.toContain(decoyOrigin);
    expect(count(plan, 'ledger_items')).toBe(1);
  });

  it('finds a name with a double quote inside stages (JSON-escaped in the text form)', async () => {
    const NAME = 'אלפא בע"מ';
    const origin = await bareJob('ledger-quote');
    await anItem({ itemId: 'LI-quote', originJobId: origin, stages: [{ name: `חוזה מול ${NAME}`, done: false }] });

    // The premise: the JSONB text form escapes the quote, so a plain text
    // match alone cannot find it.
    const premise = await getPool().query(`SELECT 1 FROM ledger_items WHERE stages::text ILIKE $1`, [`%${NAME}%`]);
    expect(premise.rows).toHaveLength(0);

    const plan = await buildErasurePlan({ kind: 'contact', identifier: NAME }, { businessId: BUSINESS });
    expect(plan.ledgerItemIds).toEqual(['LI-quote']);
  });

  it('finds an item through an event note or a reminder body alone, and takes its events and reminders', async () => {
    const originA = await bareJob('ledger-note');
    const originB = await bareJob('ledger-reminder');
    await anItem({ itemId: 'LI-note', originJobId: originA });
    await anEvent('LI-note', 'LE-note', `דיברתי עם ${RONIT}`);
    await anEvent('LI-note', 'LE-plain', 'עדכון כללי');
    await anItem({ itemId: 'LI-rem', originJobId: originB });
    await aReminder('LI-rem', 'LR-rem', `תזכורת: לחזור אל ${RONIT}`);
    await anItem({ itemId: 'LI-other', originJobId: await bareJob('ledger-other') });
    await anEvent('LI-other', 'LE-other', 'בלי שמות');

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect([...plan.ledgerItemIds].sort()).toEqual(['LI-note', 'LI-rem']);
    expect(count(plan, 'ledger_items')).toBe(2);
    expect(count(plan, 'ledger_events')).toBe(2);
    expect(count(plan, 'ledger_reminders')).toBe(1);
  });

  it('drags the nudge job and every event job of a found item into jobIds', async () => {
    const origin = await bareJob('ledger-with-nudge');
    const nudge = await bareJob('nudge job, no name in title');
    const eventJob = await bareJob('event job, no name in title');
    await anItem({ itemId: 'LI-n', originJobId: origin, counterpartyEmail: RONIT, nudgeJobId: nudge });
    await anEvent('LI-n', 'LE-n', null, eventJob);

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.jobIds).toEqual(expect.arrayContaining([origin, nudge, eventJob]));
  });

  it('takes an item whose origin job the anchor already reached, even with no name in it', async () => {
    const origin = await jobAbout(RONIT, 'instruction naming ronit');
    await anItem({ itemId: 'LI-member', originJobId: origin, description: 'לגבות תשלום' });

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.ledgerItemIds).toEqual(['LI-member']);
  });

  it('a window anchor takes items created inside it, not one just outside', async () => {
    const inside = await bareJob('w-in');
    const outside = await bareJob('w-out');
    await anItem({ itemId: 'LI-in', originJobId: inside, createdAt: '2020-03-10T12:00:00Z' });
    await anItem({ itemId: 'LI-out', originJobId: outside, createdAt: '2020-03-20T12:00:00Z' });

    const plan = await buildErasurePlan(
      { kind: 'window', fromIso: '2020-03-01T00:00:00Z', toIso: '2020-03-15T00:00:00Z' },
      { businessId: BUSINESS },
    );

    expect(plan.ledgerItemIds).toEqual(['LI-in']);
  });

  it('finds a counterparty critical rule by its match, and never a family rule', async () => {
    const db = getPool();
    await db.query(
      `INSERT INTO ledger_critical_rules (rule_id, business_id, kind, match, created_by)
       VALUES ('LC-ronit', $1, 'counterparty', $2, 'owner'),
              ('LC-dana', $1, 'counterparty', 'dana@gamma.example', 'owner')`,
      [BUSINESS, RONIT],
    );
    await db.query(
      `INSERT INTO ledger_critical_rules (rule_id, business_id, kind, family, created_by)
       VALUES ('LC-family', $1, 'family', 'money_in', 'owner')`,
      [BUSINESS],
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.ledgerRuleIds).toEqual(['LC-ronit']);
    expect(count(plan, 'ledger_critical_rules')).toBe(1);
  });

  it('the preview counts equal the rows the executor really touched, and batches keep every position', async () => {
    const origin = await bareJob('ledger-exec');
    const keepOrigin = await bareJob('ledger-keep');
    await anItem({ itemId: 'LI-x', originJobId: origin, counterpartyEmail: RONIT });
    await anEvent('LI-x', 'LE-x1', 'נוצר');
    await anEvent('LI-x', 'LE-x2', 'עודכן');
    await aReminder('LI-x', 'LR-x', 'תזכורת');
    await anItem({ itemId: 'LI-keep', originJobId: keepOrigin, description: 'שורה של מישהו אחר' });
    await anEvent('LI-keep', 'LE-keep', 'נוצר');
    const db = getPool();
    await db.query(
      `INSERT INTO ledger_whatsapp_batches (batch_id, business_id, items)
       VALUES ('LW-only', $1, ARRAY['LI-x']),
              ('LW-mixed', $1, ARRAY['LI-keep', 'LI-x', 'LI-z']),
              ('LW-untouched', $1, ARRAY['LI-keep'])`,
      [BUSINESS],
    );
    await db.query(
      `INSERT INTO ledger_critical_rules (rule_id, business_id, kind, match, created_by)
       VALUES ('LC-r', $1, 'counterparty', $2, 'owner')`,
      [BUSINESS, RONIT],
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });
    const outcome = await executeErasure(plan, { businessId: BUSINESS });

    const LEDGER = [
      'ledger_items:delete',
      'ledger_events:delete',
      'ledger_reminders:delete',
      'ledger_whatsapp_batches:scrub',
      'ledger_critical_rules:delete',
    ];
    const previewed = new Map(plan.items.map((i) => [`${i.table}:${i.action}`, i.count]));
    const executed = new Map(outcome.deleted.map((i) => [`${i.table}:${i.action}`, i.count]));
    for (const key of LEDGER) {
      expect(executed.get(key), key).toBe(previewed.get(key));
    }
    // And the numbers are the real ones, so the equality above is not 0 = 0.
    expect(previewed.get('ledger_items:delete')).toBe(1);
    expect(previewed.get('ledger_events:delete')).toBe(2);
    expect(previewed.get('ledger_reminders:delete')).toBe(1);
    // No batch is ever deleted: a deleted batch would make a reply resolve
    // against an older one.
    expect(previewed.has('ledger_whatsapp_batches:delete')).toBe(false);
    expect(executed.has('ledger_whatsapp_batches:delete')).toBe(false);
    expect(previewed.get('ledger_whatsapp_batches:scrub')).toBe(2);
    expect(previewed.get('ledger_critical_rules:delete')).toBe(1);

    const batches = await db.query<{ batch_id: string; items: string[] }>(
      'SELECT batch_id, items FROM ledger_whatsapp_batches ORDER BY batch_id',
    );
    // The erased id becomes '' in place: "3" still means LI-z.
    expect(batches.rows).toEqual([
      { batch_id: 'LW-mixed', items: ['LI-keep', '', 'LI-z'] },
      { batch_id: 'LW-only', items: [''] },
      { batch_id: 'LW-untouched', items: ['LI-keep'] },
    ]);
    const left = await db.query<{ item_id: string }>('SELECT item_id FROM ledger_items');
    expect(left.rows.map((r) => r.item_id)).toEqual(['LI-keep']);
    const leftEvents = await db.query<{ event_id: string }>('SELECT event_id FROM ledger_events');
    expect(leftEvents.rows.map((r) => r.event_id)).toEqual(['LE-keep']);
  });
});

/**
 * Document production (migrations 053–058). A production's request text,
 * destination, working record and findings, every version's spec and check
 * results, and every card's delivery plans are content about a person — and
 * the produced files themselves are the person's document. Discovered by
 * their own content, by window, by the jobs that made or delivered them, and
 * on a document anchor by the sources they were built from. The copies the
 * owner saved into his base folder are listed and never deleted (C7).
 */
describe('document production', () => {
  let root: string;

  beforeEach(async () => {
    await resetDatabase();
    root = await mkdtemp(join(tmpdir(), 'erase-produced-'));
  });

  afterAll(async () => {
    await closePool();
  });

  interface ProductionSeed {
    productionId: string;
    originJobId: string;
    instructionText?: string;
    destination?: unknown;
    work?: unknown;
    findings?: unknown;
    sourceDocumentIds?: string[];
    stage?: string;
    createdAt?: string;
  }

  async function aProduction(seed: ProductionSeed): Promise<void> {
    await getPool().query(
      `INSERT INTO document_productions
         (production_id, business_id, origin_job_id, instruction_text, text_origin, format, language,
          kind, destination, source_document_ids, stage, findings, work, created_at)
       VALUES ($1, $2, $3, $4, 'typed', 'docx', 'he', 'quote', $5::jsonb, $6, $7, $8::jsonb, $9::jsonb,
               coalesce($10::timestamptz, now()))`,
      [
        seed.productionId,
        BUSINESS,
        seed.originJobId,
        seed.instructionText ?? 'תכיני הצעת מחיר',
        JSON.stringify(seed.destination ?? { mode: 'save', folder: null }),
        seed.sourceDocumentIds ?? [],
        seed.stage ?? 'ready',
        seed.findings === undefined ? null : JSON.stringify(seed.findings),
        JSON.stringify(seed.work ?? { finished: true }),
        seed.createdAt ?? null,
      ],
    );
  }

  /** A version with its file and preview written under `root`, and its card. */
  async function aVersion(
    productionId: string,
    versionId: string,
    opts: { spec?: unknown; deliveryPlans?: unknown; check1?: unknown; check2?: unknown; storedPath?: string } = {},
  ): Promise<{ file: string; preview: string; cardId: string }> {
    const storedPath = opts.storedPath ?? join('produced', BUSINESS, productionId, `${versionId}.docx`);
    const previewPath = join('produced', BUSINESS, productionId, `${versionId}.preview.png`);
    await mkdir(join(root, 'produced', BUSINESS, productionId), { recursive: true });
    if (opts.storedPath === undefined) await writeFile(join(root, storedPath), 'docx-bytes');
    await writeFile(join(root, previewPath), 'png-bytes');
    await getPool().query(
      `INSERT INTO document_versions (version_id, production_id, business_id, version_no, spec, stored_path, sha256, size_bytes, check1, check2)
       VALUES ($1, $2, (SELECT business_id FROM document_productions WHERE production_id = $2), 1, $3::jsonb, $4, repeat('a', 64), 10, $5::jsonb, $6::jsonb)`,
      [
        versionId,
        productionId,
        JSON.stringify(opts.spec ?? { title: 'הצעת מחיר' }),
        storedPath,
        opts.check1 === undefined ? null : JSON.stringify(opts.check1),
        JSON.stringify({ previewPath, ...(opts.check2 === undefined ? {} : { extra: opts.check2 }) }),
      ],
    );
    const cardId = `CARD-${versionId}`;
    await getPool().query(
      `INSERT INTO document_cards (card_id, business_id, version_id, delivery_plans)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [cardId, BUSINESS, versionId, JSON.stringify(opts.deliveryPlans ?? [])],
    );
    return { file: join(root, storedPath), preview: join(root, previewPath), cardId };
  }

  async function aDelivery(cardId: string, versionId: string, jobId: string, savedPaths: string[] = []): Promise<void> {
    await getPool().query(
      `INSERT INTO document_deliveries (job_id, business_id, card_id, version_id, saved_paths)
       VALUES ($1, $2, $3, $4, $5::text[])`,
      [jobId, BUSINESS, cardId, versionId, savedPaths],
    );
  }

  const count = (
    plan: Awaited<ReturnType<typeof buildErasurePlan>>,
    table: string,
    action = 'delete',
  ): number | undefined => plan.items.find((i) => i.table === table && i.action === action)?.count;

  it('erasing a contact named only in a production instruction removes the production, versions, card and produced files', async () => {
    const origin = await bareJob('production-origin');
    const delivery = await bareJob('production-delivery');
    const decoyOrigin = await bareJob('production-decoy');
    await aProduction({
      productionId: 'PR-match',
      originJobId: origin,
      instructionText: `תכיני הצעת מחיר ושלחי ל-${RONIT}`,
    });
    const v = await aVersion('PR-match', 'VER-match');
    await aDelivery(v.cardId, 'VER-match', delivery);
    await aProduction({ productionId: 'PR-decoy', originJobId: decoyOrigin, instructionText: 'דוח רווח והפסד' });
    const decoy = await aVersion('PR-decoy', 'VER-decoy');

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS, documentRoot: root },
    );

    expect(plan.productionIds).toEqual(['PR-match']);
    expect(plan.jobIds).toEqual(expect.arrayContaining([origin, delivery]));
    expect(plan.jobIds).not.toContain(decoyOrigin);
    expect(plan.filePaths).toEqual(expect.arrayContaining([v.file, v.preview]));
    expect(plan.filePaths).not.toContain(decoy.file);
    expect(count(plan, 'document_productions')).toBe(1);
    expect(count(plan, 'document_versions')).toBe(1);
    expect(count(plan, 'document_cards')).toBe(1);
    expect(count(plan, 'document_deliveries')).toBe(1);

    const outcome = await executeErasure(plan, { businessId: BUSINESS });

    // The executor's own row counts agree with the preview — the explicit
    // deletes ran before the cascades that could have pre-empted them.
    const executed = new Map(outcome.deleted.map((i) => [`${i.table}:${i.action}`, i.count]));
    for (const table of ['document_productions', 'document_versions', 'document_cards', 'document_deliveries']) {
      expect(executed.get(`${table}:delete`), table).toBe(1);
    }
    expect(outcome.filesRemoved).toBe(2);
    const db = getPool();
    const left = await db.query<{ production_id: string }>('SELECT production_id FROM document_productions');
    expect(left.rows.map((r) => r.production_id)).toEqual(['PR-decoy']);
    const versions = await db.query<{ version_id: string }>('SELECT version_id FROM document_versions');
    expect(versions.rows.map((r) => r.version_id)).toEqual(['VER-decoy']);
    const cards = await db.query<{ card_id: string }>('SELECT card_id FROM document_cards');
    expect(cards.rows.map((r) => r.card_id)).toEqual([decoy.cardId]);
    expect((await db.query('SELECT 1 FROM document_deliveries')).rows).toHaveLength(0);
    await expect(stat(v.file)).rejects.toThrow();
    await expect(stat(v.preview)).rejects.toThrow();
    expect((await stat(decoy.file)).isFile()).toBe(true);
  });

  it.each([
    ['destination', { destination: { mode: 'send', to: [RONIT], subject: 'הצעה' } }, {}],
    ['work (the drafted spec)', { work: { finished: true, draft: { title: `הצעה ל-${RONIT}` } } }, {}],
    ['work.notes', { work: { finished: true, notes: [`הכתובת ${RONIT} לא אושרה`] } }, {}],
    ['findings', { findings: [{ check: 'check2', code: 'x', where: 'document', he: 'בעיה', detail: RONIT }] }, {}],
    ['a version spec', {}, { spec: { title: `הצעת מחיר ל"אלפא" ${RONIT}` } }],
    ['a card delivery plan', {}, { deliveryPlans: [{ option: 'send', plan: { steps: [{ input: { to: [RONIT] } }] } }] }],
    ['a version check1', {}, { check1: { findings: [{ detail: `לא נמצא "${RONIT}"` }] } }],
    ['a version check2', {}, { check2: [{ detail: RONIT }] }],
  ] as Array<[string, Partial<ProductionSeed>, { spec?: unknown; deliveryPlans?: unknown; check1?: unknown; check2?: unknown }]>)(
    'finds a production by %s alone',
    async (_where, seed, versionOpts) => {
      const origin = await bareJob('production-by-column');
      await aProduction({ productionId: 'PR-col', originJobId: origin, ...seed });
      await aVersion('PR-col', 'VER-col', versionOpts);
      await aProduction({ productionId: 'PR-other', originJobId: await bareJob('other'), instructionText: 'משהו אחר' });

      const plan = await buildErasurePlan(
        { kind: 'contact', identifier: RONIT },
        { businessId: BUSINESS, documentRoot: root },
      );

      expect(plan.productionIds).toEqual(['PR-col']);
      expect(plan.jobIds).toContain(origin);
    },
  );

  it('reaches a production on a window anchor and, on a document anchor, by its source', async () => {
    await aProduction({ productionId: 'PR-in', originJobId: await bareJob('in'), createdAt: '2026-03-01T10:00:00Z' });
    await aProduction({ productionId: 'PR-out', originJobId: await bareJob('out'), createdAt: '2026-04-01T10:00:00Z' });
    const window = await buildErasurePlan(
      { kind: 'window', fromIso: '2026-03-01T00:00:00Z', toIso: '2026-03-02T00:00:00Z' },
      { businessId: BUSINESS, documentRoot: root },
    );
    expect(window.productionIds).toContain('PR-in');
    expect(window.productionIds).not.toContain('PR-out');

    const source = await aDocument();
    await aProduction({ productionId: 'PR-src', originJobId: await bareJob('src'), sourceDocumentIds: [source] });
    const byDocument = await buildErasurePlan(
      { kind: 'document', documentId: source },
      { businessId: BUSINESS, documentRoot: root },
    );
    expect(byDocument.productionIds).toEqual(['PR-src']);
  });

  it('refuses while a production it would erase is still being worked on', async () => {
    const origin = await bareJob('live-production');
    await aProduction({
      productionId: 'PR-live',
      originJobId: origin,
      instructionText: `מסמך ל-${RONIT}`,
      stage: 'check1',
      work: { finished: false },
    });
    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS, documentRoot: root },
    );
    expect(plan.productionIds).toEqual(['PR-live']);
    expect(plan.refusals.map((r) => r.kind)).toEqual(['live_job']);
    await expect(executeErasure(plan, { businessId: BUSINESS })).rejects.toThrow();
    expect((await getPool().query('SELECT 1 FROM document_productions')).rows).toHaveLength(1);
  });

  it('the preview lists a saved base-folder copy and erasure leaves it', async () => {
    const origin = await bareJob('saved-origin');
    const delivery = await bareJob('saved-delivery');
    await aProduction({ productionId: 'PR-saved', originJobId: origin, instructionText: `חוזה עם ${RONIT}` });
    const v = await aVersion('PR-saved', 'VER-saved');
    const base = await mkdtemp(join(tmpdir(), 'erase-base-'));
    const saved = join(base, 'הצעות מחיר', 'הצעה לרונית (2).docx');
    await mkdir(join(base, 'הצעות מחיר'), { recursive: true });
    await writeFile(saved, 'docx-bytes');
    // Two copies of one delivery: both are listed, neither is deleted.
    const second = join(base, 'הצעות מחיר', 'הצעה לרונית (3).docx');
    await writeFile(second, 'docx-bytes');
    await aDelivery(v.cardId, 'VER-saved', delivery, [saved, second]);

    const plan = await buildErasurePlan(
      { kind: 'contact', identifier: RONIT },
      { businessId: BUSINESS, documentRoot: root },
    );

    expect(plan.savedCopies).toEqual([saved, second].sort());
    // Listed, never queued for deletion.
    expect(plan.filePaths).not.toContain(saved);
    const html = renderErasure({ csrf: 't', anchorLabel: RONIT, plan, planHash: 'h' });
    expect(html).toContain('נשארים בתיקייה שלך');
    expect(html).toContain('הצעה לרונית (2).docx');

    await executeErasure(plan, { businessId: BUSINESS });
    expect((await stat(saved)).isFile()).toBe(true);
    expect((await stat(second)).isFile()).toBe(true);
    // The row that recorded the path went with its job.
    expect((await getPool().query('SELECT 1 FROM document_deliveries')).rows).toHaveLength(0);
  });

  it('finds a production by a saved copy path alone', async () => {
    const origin = await bareJob('saved-alone');
    const delivery = await bareJob('saved-alone-delivery');
    await aProduction({ productionId: 'PR-path', originJobId: origin });
    const v = await aVersion('PR-path', 'VER-path');
    await aDelivery(v.cardId, 'VER-path', delivery, [`/home/owner/${RONIT}.docx`]);
    await aProduction({ productionId: 'PR-other', originJobId: await bareJob('other') });

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS, documentRoot: root });

    expect(plan.productionIds).toEqual(['PR-path']);
    expect(plan.jobIds).toEqual(expect.arrayContaining([origin, delivery]));
  });

  it('refuses at execution when a production went back to work after the preview, and keeps everything', async () => {
    const origin = await bareJob('flip-origin');
    await aProduction({ productionId: 'PR-flip', originJobId: origin, instructionText: `מסמך ל-${RONIT}` });
    const v = await aVersion('PR-flip', 'VER-flip');
    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS, documentRoot: root });
    // Finished when the preview was built: no refusal in the plan.
    expect(plan.refusals).toEqual([]);
    expect(plan.productionIds).toEqual(['PR-flip']);

    await getPool().query(
      `UPDATE document_productions SET stage = 'fixing', work = jsonb_set(work, '{finished}', 'false') WHERE production_id = 'PR-flip'`,
    );

    await expect(executeErasure(plan, { businessId: BUSINESS })).rejects.toBeInstanceOf(ErasureRefusedError);
    const db = getPool();
    expect((await db.query('SELECT 1 FROM document_productions')).rows).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM document_versions')).rows).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM document_cards')).rows).toHaveLength(1);
    expect((await stat(v.file)).isFile()).toBe(true);
    expect((await stat(v.preview)).isFile()).toBe(true);
  });

  it('refuses at execution when a card was approved after the preview, a delivery job the plan never listed', async () => {
    const origin = await bareJob('race-origin');
    await aProduction({ productionId: 'PR-race', originJobId: origin, instructionText: `מסמך ל-${RONIT}` });
    const v = await aVersion('PR-race', 'VER-race');
    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS, documentRoot: root });
    expect(plan.refusals).toEqual([]);

    // The owner approves the card between the preview and the confirm.
    const delivery = await bareJob('race-delivery');
    await getPool().query(`UPDATE document_cards SET state = 'approved', delivery_job_id = $1 WHERE card_id = $2`, [
      delivery,
      v.cardId,
    ]);

    await expect(executeErasure(plan, { businessId: BUSINESS })).rejects.toBeInstanceOf(ErasureRefusedError);
    expect((await getPool().query('SELECT 1 FROM document_cards')).rows).toHaveLength(1);
    expect((await stat(v.file)).isFile()).toBe(true);
  });

  it('a card whose delivery job the plan already holds does not refuse', async () => {
    const origin = await bareJob('held-origin');
    const delivery = await bareJob('held-delivery');
    await aProduction({ productionId: 'PR-held', originJobId: origin, instructionText: `מסמך ל-${RONIT}` });
    const v = await aVersion('PR-held', 'VER-held');
    await getPool().query(`UPDATE document_cards SET state = 'approved', delivery_job_id = $1 WHERE card_id = $2`, [
      delivery,
      v.cardId,
    ]);
    await aDelivery(v.cardId, 'VER-held', delivery);
    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS, documentRoot: root });
    expect(plan.jobIds).toContain(delivery);
    await executeErasure(plan, { businessId: BUSINESS });
    expect((await getPool().query('SELECT 1 FROM document_cards')).rows).toHaveLength(0);
  });

  it('never queues a produced path outside produced/<business>/<production>/ for unlinking', async () => {
    const origin = await bareJob('escape-origin');
    await aProduction({ productionId: 'PR-esc', originJobId: origin, instructionText: `מסמך ל-${RONIT}` });
    const outside = join('..', 'outside.docx');
    const other = join('produced', BUSINESS, 'PR-someone-else', 'x.docx');
    await aVersion('PR-esc', 'VER-esc1', { storedPath: outside });
    const badPreview = join('produced', BUSINESS, 'PR-esc', '..', '..', 'p.png');
    await getPool().query(
      `INSERT INTO document_versions (version_id, production_id, business_id, version_no, spec, stored_path, sha256, size_bytes, check2)
       VALUES ('VER-esc2', 'PR-esc', (SELECT business_id FROM document_productions WHERE production_id = 'PR-esc'), 2, '{}'::jsonb, $1, repeat('a', 64), 10, $2::jsonb)`,
      [other, JSON.stringify({ previewPath: badPreview })],
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS, documentRoot: root });

    expect(plan.filePaths).not.toContain(join(root, outside));
    expect(plan.filePaths).not.toContain(join(root, other));
    expect(plan.filePaths).not.toContain(join(root, badPreview));
    expect(plan.filesNotDeleted).toEqual(
      expect.arrayContaining([join(root, outside), join(root, other), join(root, badPreview)]),
    );
    // The well-formed preview of the first version is still queued.
    expect(plan.filePaths).toContain(join(root, 'produced', BUSINESS, 'PR-esc', 'VER-esc1.preview.png'));
  });
});

/**
 * Calendar scheduling (migration 061): `meetings` is a delete target by job
 * (its own or its reminder job) AND a discovery source of its own;
 * `meeting_holds` is deleted by job; the calendar events are never deleted
 * and are listed instead.
 */
describe('calendar scheduling', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  async function aMeeting(
    meetingId: string,
    jobId: string,
    fields: {
      stepId?: string;
      clientName?: string;
      internalNote?: string | null;
      eventId?: string | null;
      calendarId?: string;
      startAt?: string | null;
      reminderJobId?: string | null;
      createdAt?: string;
    },
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO meetings
         (meeting_id, business_id, job_id, step_id, calendar_id, event_id, operation,
          client_name, internal_note, start_at, reminder_job_id, created_at)
       VALUES ($1, $2, $3, $11, $4, $5, 'create', $6, $7, $8, $9, coalesce($10::timestamptz, now()))`,
      [
        meetingId,
        BUSINESS,
        jobId,
        fields.calendarId ?? 'cal-1',
        fields.eventId ?? null,
        fields.clientName ?? 'לקוח אחר',
        fields.internalNote ?? null,
        fields.startAt ?? null,
        fields.reminderJobId ?? null,
        fields.createdAt ?? null,
        fields.stepId ?? 's1',
      ],
    );
  }

  async function aHold(holdId: string, jobId: string, eventId: string, state = 'held'): Promise<void> {
    await getPool().query(
      `INSERT INTO meeting_holds (hold_id, business_id, job_id, calendar_id, event_id, start_at, end_at, state)
       VALUES ($1, $2, $3, 'cal-1', $4, '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z', $5)`,
      [holdId, BUSINESS, jobId, eventId, state],
    );
  }

  it('discovers a contact only named in a meeting internal note, with its job and reminder job', async () => {
    const job = await bareJob('meeting-job');
    const reminder = await bareJob('reminder-job');
    const unrelated = await bareJob('unrelated-job');
    await aMeeting('MT-1', job, { internalNote: `לזכור: ${RONIT} מעדיפה בבוקר`, reminderJobId: reminder });
    await aMeeting('MT-2', unrelated, { internalNote: 'שום קשר' });

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.jobIds).toEqual(expect.arrayContaining([job, reminder]));
    expect(plan.jobIds).not.toContain(unrelated);
    expect(plan.items.find((i) => i.table === 'meetings')?.count).toBe(1);

    await executeErasure(plan, { businessId: BUSINESS });
    const left = await getPool().query('SELECT meeting_id FROM meetings');
    expect(left.rows).toEqual([{ meeting_id: 'MT-2' }]);
  });

  it('reaches the meeting and its reminder job from a job found some other way', async () => {
    const job = await jobAbout(RONIT, 'via-plan');
    const reminder = await bareJob('reminder-of-via-plan');
    await aMeeting('MT-3', job, { reminderJobId: reminder });

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.jobIds).toEqual(expect.arrayContaining([job, reminder]));
    expect(plan.items.find((i) => i.table === 'meetings')?.count).toBe(1);
  });

  it('closes meetings by created_at for a window anchor', async () => {
    const inside = await bareJob('win-inside');
    const outside = await bareJob('win-outside');
    await aMeeting('MT-in', inside, { createdAt: '2026-03-10T10:00:00Z' });
    await aMeeting('MT-out', outside, { createdAt: '2026-05-10T10:00:00Z' });

    const plan = await buildErasurePlan(
      { kind: 'window', fromIso: '2026-03-01T00:00:00Z', toIso: '2026-04-01T00:00:00Z' },
      { businessId: BUSINESS },
    );

    expect(plan.items.find((i) => i.table === 'meetings')?.count).toBe(1);
  });

  it('deletes meeting_holds with the job', async () => {
    const job = await jobAbout(RONIT, 'hold-job');
    const other = await bareJob('hold-other');
    await aHold('H-1', job, 'ev-hold-1');
    await aHold('H-2', other, 'ev-hold-2');

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });
    expect(plan.items.find((i) => i.table === 'meeting_holds')?.count).toBe(1);

    await executeErasure(plan, { businessId: BUSINESS });
    const left = await getPool().query('SELECT hold_id FROM meeting_holds');
    expect(left.rows).toEqual([{ hold_id: 'H-2' }]);
  });

  it('lists calendar events kept, sorted, from erased meetings and held holds only', async () => {
    const job = await jobAbout(RONIT, 'kept-events');
    const other = await bareJob('kept-other');
    await aMeeting('MT-b', job, { stepId: 's1', eventId: 'ev-b', calendarId: 'cal-2', startAt: '2026-12-02T09:00:00Z' });
    await aMeeting('MT-a', job, { stepId: 's2', eventId: 'ev-a', calendarId: 'cal-1', startAt: null });
    await aMeeting('MT-none', job, { stepId: 's3', eventId: null });
    await aHold('H-held', job, 'ev-held');
    await aHold('H-released', job, 'ev-released', 'released');
    await aMeeting('MT-other', other, { eventId: 'ev-other' });

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.calendarEventsKept).toEqual([
      { calendarId: 'cal-1', eventId: 'ev-a', start: null, kind: 'meeting' },
      { calendarId: 'cal-1', eventId: 'ev-held', start: '2026-12-01T09:00:00.000Z', kind: 'hold' },
      { calendarId: 'cal-2', eventId: 'ev-b', start: '2026-12-02T09:00:00.000Z', kind: 'meeting' },
    ]);

    // The preview names them under "נשארים ביומן שלך"; neither module has a
    // calendar client, so nothing there can be deleted.
    const html = renderErasure({
      plan,
      csrf: 'c',
      planHash: 'h',
      anchorLabel: RONIT,
    } as unknown as Parameters<typeof renderErasure>[0]);
    expect(html).toContain('נשארים ביומן שלך');
    expect(html).toContain('ev-b');
    expect(html).not.toContain('ev-other');
  });

  it('does not delete a meeting whose own job the owner kept when only its reminder job is erased', async () => {
    const meetingJob = await bareJob('kept-meeting-job');
    const reminder = await bareJob(`תזכורת ל-${RONIT}`);
    await aMeeting('MT-kept', meetingJob, { eventId: 'ev-kept', reminderJobId: reminder });
    await withBusiness(BUSINESS, (bdb) => keepItem(bdb, { kind: 'job', itemId: meetingJob, note: 'לשמור' })); // TENANCY-TODO(task 6)

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.jobIds).toContain(reminder);
    expect(plan.jobIds).not.toContain(meetingJob);
    expect(plan.items.find((i) => i.table === 'meetings')?.count).toBe(0);
    expect(plan.calendarEventsKept).toEqual([]);

    await executeErasure(plan, { businessId: BUSINESS });
    const left = await getPool().query('SELECT meeting_id FROM meetings');
    expect(left.rows).toEqual([{ meeting_id: 'MT-kept' }]);
  });

  it('lists a converted hold once (the meeting wins) and marks a still-held one as a hold', async () => {
    const job = await jobAbout(RONIT, 'hold-kinds');
    await aMeeting('MT-conv', job, { eventId: 'ev-conv', startAt: '2026-12-03T09:00:00Z' });
    await aHold('H-conv', job, 'ev-conv', 'converted');
    await aHold('H-conv-only', job, 'ev-conv-only', 'converted');
    await aHold('H-live', job, 'ev-live');

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.calendarEventsKept.map((e) => [e.eventId, e.kind])).toEqual([
      ['ev-conv', 'meeting'],
      ['ev-conv-only', 'hold'],
      ['ev-live', 'hold'],
    ]);
    const html = renderErasure({
      plan,
      csrf: 'c',
      planHash: 'h',
      anchorLabel: RONIT,
      timeZone: 'Asia/Jerusalem',
    } as unknown as Parameters<typeof renderErasure>[0]);
    expect(html).toContain('שמירת מקום — לא תנוקה עוד אוטומטית');
    // 2026-12-03T09:00Z is 11:00 in Jerusalem (winter).
    expect(html).toContain('2026-12-03 11:00');
    const utc = renderErasure({
      plan,
      csrf: 'c',
      planHash: 'h',
      anchorLabel: RONIT,
      timeZone: null,
    } as unknown as Parameters<typeof renderErasure>[0]);
    expect(utc).toContain('2026-12-03 09:00 UTC');
  });

  it('adds the reminder job of a meeting whose job joins only through the ledger closure', async () => {
    // The item's origin job is found by name; the item's NUDGE job is the
    // meeting's job, added only by the ledger closure — so only the final
    // meetings pass can bring in that meeting's reminder job.
    const origin = await jobAbout(RONIT, 'ledger-origin');
    const nudge = await bareJob('nudge-job');
    const reminder = await bareJob('late-reminder');
    await getPool().query(
      `INSERT INTO ledger_items (item_id, business_id, family, description, origin_job_id, nudge_job_id)
       VALUES ('LI-late', $1, 'money_in', $2, $3, $4)`,
      [BUSINESS, `לגבות מ-${RONIT}`, origin, nudge],
    );
    await aMeeting('MT-late', nudge, { reminderJobId: reminder });

    const plan = await buildErasurePlan({ kind: 'contact', identifier: RONIT }, { businessId: BUSINESS });

    expect(plan.jobIds).toEqual(expect.arrayContaining([nudge, reminder]));
  });
});
