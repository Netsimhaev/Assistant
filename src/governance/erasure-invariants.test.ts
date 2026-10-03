import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { keepItem } from './kept-items.js';
import { buildErasurePlan } from './erasure-plan.js';
import { executeErasure } from './erasure.js';

const BUSINESS = 'test-business';

/**
 * Distinctive enough that a match anywhere is this test's doing and not a
 * coincidence, and shaped like an address so every place that stores one
 * accepts it.
 *
 * **The underscore is load-bearing** (fix round 2, F1). `_` is an ordinary
 * character in an email local part and a WILDCARD to `LIKE`, so an anchor
 * carrying one is only found if the escaping actually works end to end —
 * `likeLiteral` prefixing it AND the statement declaring an escape character.
 * The orphan-approval predicate declared `ESCAPE ''` (a single backslash
 * inside a template literal collapses), escape processing was off, and the
 * escaped pattern matched nothing. This sweep stayed green through all of it
 * for one reason only: the probe had no wildcard in it. One character makes
 * the control able to catch that class by itself, which is the whole point of
 * seeding all twelve stores.
 */
const PROBE = 'zz_erase-probe-7f3a@nowhere.example';

/**
 * The three tables an erasure deliberately leaves alone (spec §5.2). Named,
 * so the scan below is a positive control: everything not on this list must
 * come back clean, including a table added next year.
 */
const SURVIVES: readonly string[] = ['audit_log', 'spend_ledger', 'signatures'];

describe('what an erasure leaves behind', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * The test that matters, and it is the opposite of the obvious one.
   *
   * "Erase, then check the row is gone" only checks the places whoever wrote
   * it thought of. The dangerous gap is the place nobody thought of — and
   * this project has already been surprised twice by exactly that
   * (`job_plans` holds the message body; `job_authorizations` holds the typed
   * recipients).
   *
   * So: seed the probe everywhere, erase, then read the column list out of
   * `information_schema` — not out of a list written here — and demand zero
   * matches. A table added a year from now is scanned automatically, and
   * somebody who adds a store and forgets to wire erasure into it turns this
   * red without having to remember this file exists.
   *
   * **"Everywhere" means all twelve content stores of spec §5.1, and it did
   * not used to** (final review, N2). The seed covered five — `jobs.title`,
   * `job_authorizations.recipients`, `job_plans.plan`,
   * `boss_instructions.text` and `memories` — so the sweep could only detect
   * a missed store that would have received a copy of one of those five
   * values. N1 was the live demonstration: an orphan `approval_requests` card
   * carrying the probe survived a contact erasure entirely, and this scan
   * stayed green because no such row was ever seeded. The seven added below
   * are the rest of the table, and the orphan card is among them, so this
   * control now detects N1 by itself.
   *
   * **A thirteenth store, added later and outside spec §5.1: `autonomy_marks`
   * (migration 026).** Not part of the original table because it did not
   * exist yet, seeded below for the same reason as the other twelve — see
   * `erasure-plan.ts`'s header for why it is the one migration-026 table that
   * needed wiring at all.
   */
  it('leaves the probe in no text or JSON column of any table, anywhere', async () => {
    const bundle = await installCharter(buildCharter({ version: 'probe' }), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: `מייל אל ${PROBE}`,
    });
    const db = getPool();

    await db.query(
      `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
       VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
      [BUSINESS, job.jobId, PROBE],
    );
    await db.query(
      `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
       VALUES ($1, $2, 'hp', $3::jsonb)`,
      [BUSINESS, job.jobId, JSON.stringify({ steps: [{ input: { to: [PROBE], body: 'שלום' } }] })],
    );
    await db.query(
      `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text)
       VALUES ('INS-probe', $1, $2, $3)`,
      [BUSINESS, job.jobId, `תשלחי אל ${PROBE}`],
    );
    // Migration 036's table. Tied to the job (the `job_id` arm of
    // `WHATSAPP_MESSAGES_ERASED_PREDICATE`), with the probe in all three
    // content columns the contact arm also matches directly — so this row
    // alone cannot tell the two arms apart; the orphan row below does that.
    await db.query(
      `INSERT INTO whatsapp_messages
         (id, business_id, provider_message_id, direction, sender_number,
          sender_kind, body, transcript, provider_timestamp, state, job_id)
       VALUES ('WA-probe', $1, 'wamid-probe', 'inbound', $2, 'principal', $3, $4, now(), 'handled', $5)`,
      [BUSINESS, PROBE, `שלח אל ${PROBE}`, `תמלול: שלח אל ${PROBE}`, job.jobId],
    );
    // An ORPHAN message — no job at all, exactly the shape `job_id = ANY($2)`
    // alone cannot reach (the same gap `approval_requests`'s orphan card
    // closes for its own table). Only the contact arm's direct column match
    // finds this row.
    await db.query(
      `INSERT INTO whatsapp_messages
         (id, business_id, provider_message_id, direction, sender_number,
          sender_kind, body, provider_timestamp, state, job_id)
       VALUES ('WA-probe-orphan', $1, 'wamid-probe-orphan', 'inbound', $2, 'other', $3, now(), 'received', NULL)`,
      [BUSINESS, PROBE, `פנייה לא קשורה ממספר של ${PROBE}`],
    );
    await writeMemory(
      { jobId: job.jobId, kind: 'entity', subjectKey: PROBE, body: { email: PROBE } },
      { businessId: BUSINESS },
    );

    // --- The other seven stores of spec §5.1. ----------------------------
    //
    // The document chain first. It is reached from the job the way production
    // reaches it — document → reading → proposal → job — so the probe lands
    // in `documents`, `document_artifacts`, `document_readings` and
    // `proposals` through the plan's real closure and not through a shortcut
    // this test invented.
    const documentId = `DOC-probe-${Date.now()}`;
    await db.query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256,
          byte_size, stored_path, status, reason)
       VALUES ($1, $2, 'manual', $3, 'text/plain', repeat('c', 64), 12, $4, 'extracted', $5)`,
      [
        documentId,
        BUSINESS,
        `הצעת מחיר ל-${PROBE}.txt`,
        `${BUSINESS}/${documentId}/original.txt`,
        `נקלט מ-${PROBE}`,
      ],
    );
    await db.query(
      `INSERT INTO document_artifacts (business_id, document_id, ordinal, kind, content, part_name)
       VALUES ($1, $2, 0, 'text', $3::jsonb, $4)`,
      [BUSINESS, documentId, JSON.stringify({ text: `צור קשר עם ${PROBE}` }), `גיליון ${PROBE}`],
    );
    const readingId = `READ-probe-${Date.now()}`;
    await db.query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, content, provenance, model,
          prompt_version, brief_hash)
       VALUES ($1, $2, $3, 'read', $4::jsonb, 'boss', 'test-model', 'v1', 'hash-probe')`,
      [readingId, BUSINESS, documentId, JSON.stringify({ summary: `פנייה של ${PROBE}` })],
    );
    await db.query(
      `INSERT INTO proposals
         (proposal_id, business_id, reading_id, status, content, model, prompt_version, raw, job_id)
       VALUES ($1, $2, $3, 'proposed', $4::jsonb, 'test-model', 'v1', $5, $6)`,
      [
        `PROP-probe-${Date.now()}`,
        BUSINESS,
        readingId,
        JSON.stringify({ stance: 'act', to: PROBE }),
        `הצעה גולמית אל ${PROBE}`,
        job.jobId,
      ],
    );

    // Two approval cards: one behind the job, and one ORPHAN — `job_id` NULL,
    // the shape N1 found surviving. Both hold the address and the body.
    for (const [approvalId, jobIdOrNull] of [
      [`AP-probe-job-${Date.now()}`, job.jobId],
      [`AP-probe-orphan-${Date.now()}`, null],
    ] as Array<[string, string | null]>) {
      await db.query(
        `INSERT INTO approval_requests
           (approval_id, business_id, job_id, action_class, summary, detail, risk,
            proposed_tool, proposed_input, input_hash, expires_at, edited_input,
            decision_note, diff_vs_norm, artifacts)
         VALUES ($1, $2, $3, 'email.reply', $4, $5, $6::jsonb, 'mail.send', $7::jsonb, $8, $9,
                 $10::jsonb, $11, $12, $13::jsonb)`,
        [
          approvalId,
          BUSINESS,
          jobIdOrNull,
          `שליחת מייל אל ${PROBE}`,
          `הגוף המלא של ההודעה אל ${PROBE}`,
          JSON.stringify({ band: 'sensitive', note: PROBE }),
          JSON.stringify({ to: PROBE, body: `שלום ${PROBE}` }),
          `hash-${approvalId}`,
          new Date(Date.now() + 3600_000).toISOString(),
          JSON.stringify({ to: PROBE }),
          `הבעלים כתב על ${PROBE}`,
          `חריגה לעומת ${PROBE}`,
          JSON.stringify([{ name: PROBE }]),
        ],
      );
    }

    // The two scrubbed stores. Both survive the erasure as rows and must come
    // back holding nothing to read.
    await transition(job.jobId, {
      to: 'understand',
      actor: 'orchestrator',
      reason: `פתיחת משימה בעקבות ${PROBE}`,
      businessId: BUSINESS,
    });
    await db.query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id)
       VALUES ($1, $2, 'hp', 's1', $3)`,
      [BUSINESS, job.jobId, `msg-${PROBE}`],
    );

    // --- Migration 026's one erasable table. -----------------------------
    //
    // `autonomy_marks.note` is owner-written content about a corrected step
    // and can name the person it was addressed to; see `erasure-plan.ts`'s
    // header for why this is the only one of the three migration-026 tables
    // wired into erasure. Keyed by `job_id`, exactly like `boss_instructions`
    // above, so it is reached the same way: through the job the mark belongs
    // to, which the `job_plans` seed above already put in this sweep's
    // `jobIds`.
    await db.query(
      `INSERT INTO autonomy_marks (mark_id, business_id, job_id, step_id, action_class, note, marked_by)
       VALUES ('AM-probe', $1, $2, 's1', 'email.reply', $3, 'owner@example.com')`,
      [BUSINESS, job.jobId, `התיקון היה בעקבות פנייה של ${PROBE}`],
    );

    // --- Migration 028's two tables. --------------------------------------
    //
    // `agent_envelopes.payload` carries the content of one agent's request to
    // another and can name a counterparty exactly as `job_plans.plan` already
    // does — it is, in fact, the same plan-step input, byte for byte, for a
    // plan-issued delegation (`AGENT_ENVELOPES_ERASED_PREDICATE`'s docblock in
    // `erasure-plan.ts`). `.context_refs` is seeded too, but only to prove the
    // schema-derived sweep below also clears a column that CANNOT carry free
    // text: `ContextRef` (`domain/envelope.ts`) is a closed union of four
    // id-only pointers, so the probe is embedded here as a legal
    // `{kind:'document', documentId:…}` ref — a shape production could
    // actually write — never as prose no real writer could produce.
    // `verification_verdicts.verdict` quotes the draft it checked, exactly as
    // a proposal's `raw` field does. Both are job-scoped (`parent_job_id` /
    // `job_id`) and reached through the same `jobIds` this job already sits
    // in via `job_authorizations` above.
    await db.query(
      `INSERT INTO agent_envelopes
         (business_id, envelope_id, correlation_id, causal_chain, from_agent, to_agent,
          kind, intent, payload, context_refs, context_refs_hash, constraints, hops,
          idempotency_key, parent_job_id)
       VALUES ($1, 'ENV-probe', 'COR-probe', ARRAY['office.manager'], 'office.manager', 'ops.web',
               'help_request', 'lookup_contact', $2::jsonb, $3::jsonb, 'hash-probe-env',
               '{}'::jsonb, 1, 'idem-probe', $4)`,
      [
        BUSINESS,
        JSON.stringify({ lookFor: PROBE }),
        JSON.stringify([{ kind: 'document', documentId: PROBE }]),
        job.jobId,
      ],
    );
    await db.query(
      `INSERT INTO verification_verdicts (business_id, job_id, verdict)
       VALUES ($1, $2, $3::jsonb)`,
      [BUSINESS, job.jobId, JSON.stringify({ mismatch: `שני מספרים בטיוטה אינם במסמך אצל ${PROBE}` })],
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: PROBE }, { businessId: BUSINESS });
    await executeErasure(plan, { businessId: BUSINESS });

    const { rows: columns } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'jsonb', 'json', 'ARRAY')`,
    );

    // An empty result set would make the loop below vacuous — zero columns
    // scanned passes with the same `[]` as zero matches found. The schema
    // has 171 such columns today; this only has to stay comfortably above
    // zero to catch the scan itself silently finding nothing, the same
    // failure mode `reading-invariants.test.ts` locks for the policy sweep.
    expect(columns.length).toBeGreaterThan(100);

    const found: string[] = [];
    for (const column of columns) {
      if (SURVIVES.includes(column.table_name)) continue;
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${column.table_name}"
          WHERE "${column.column_name}"::text LIKE $1`,
        [`%${PROBE}%`],
      );
      if (Number(rows[0]?.n ?? '0') > 0) {
        found.push(`${column.table_name}.${column.column_name}`);
      }
    }

    expect(found).toEqual([]);
  });

  /**
   * The sweep above cannot catch a discovery-only gap: its seeded job is
   * independently findable through `job_plans`, `boss_instructions`,
   * `job_authorizations` AND `jobs.title`, so a mark riding along on any ONE
   * of those four says nothing about whether the mark's own `note` is ever
   * searched for its own sake. This test isolates exactly that: a job with
   * NOTHING else tying it to the contact — no plan, no instruction, no
   * authorization, a title that never mentions it — carrying only a
   * correction note that names the contact. `autonomy_marks.note` is
   * owner-typed free text and is not restricted to describing the
   * counterparty a step was addressed to (review finding 5): a note about
   * who was wrongly cc'd can name someone the job never otherwise mentions.
   * Without the `autonomy_marks` discovery query in `buildErasurePlan`
   * (beside `boss_instructions`'s), this job is never placed in `jobIds`, the
   * `job_id = ANY($2)` deletion never reaches it, and the name survives an
   * erasure of that very contact permanently.
   */
  it('reaches a correction note that names a counterparty the job otherwise never mentions', async () => {
    const bundle = await installCharter(buildCharter({ version: 'note-only' }), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      // Deliberately silent on the contact: no plan, no instruction, no
      // authorization and a title that never names it either.
      title: 'משימה רגילה שלא קשורה לאיש',
    });

    await getPool().query(
      `INSERT INTO autonomy_marks (mark_id, business_id, job_id, step_id, action_class, note, marked_by)
       VALUES ('AM-note-only', $1, $2, 's1', 'email.reply', $3, 'owner@example.com')`,
      [BUSINESS, job.jobId, `לא היה צריך להעתיק את ${PROBE} בטעות`],
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: PROBE }, { businessId: BUSINESS });
    await executeErasure(plan, { businessId: BUSINESS });

    const { rows } = await getPool().query(
      'SELECT 1 FROM autonomy_marks WHERE business_id = $1 AND mark_id = $2',
      [BUSINESS, 'AM-note-only'],
    );
    expect(rows).toHaveLength(0);
  });

  /**
   * The document anchor's own discovery-only gap, and the sweep above cannot
   * see it for a structural reason: that sweep is CONTACT-anchored and seeds
   * every job it checks into the anchor set through four independent routes,
   * so a store riding along on any one of them proves nothing about whether
   * its own job is ever found.
   *
   * This isolates the shape the verification loop introduced.
   * `conduct.ts`'s `beginVerification` opens a SECOND job beside the approval
   * card — `gov.verify`'s own — and binds it a one-step plan whose input
   * carries `documentId`, the question and `draftText`: the draft derived from
   * that document, verbatim. That job has no `proposals` row, no reading and
   * no title naming the document, and the document anchor's only job discovery
   * was a single query over `proposals`. So the erasure destroyed the
   * document, its reading, the subject job's plan — and left the draft in the
   * `gov.verify` job's `job_plans.plan`. Asserted below on the job that is
   * deliberately OUTSIDE the anchor's `proposals` set, which is the whole
   * point: the subject job's own plan row going away says nothing here.
   */
  it('reaches a gov.verify job whose bound plan names the document, on a document anchor', async () => {
    const bundle = await installCharter(buildCharter({ version: 'doc-anchor' }), { businessId: BUSINESS });
    const db = getPool();
    const documentId = `DOC-anchor-${Date.now()}`;

    await db.query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256,
          byte_size, stored_path, status)
       VALUES ($1, $2, 'manual', 'הצעת מחיר.txt', 'text/plain', repeat('d', 64), 12, $3, 'extracted')`,
      [documentId, BUSINESS, `${BUSINESS}/${documentId}/original.txt`],
    );

    // The SUBJECT job: the one the document anchor already found, through
    // reading → proposal. Seeded so the test proves a gap rather than an empty
    // anchor set, and so the assertion below can distinguish the two jobs.
    const subject = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'unknown_external',
      businessId: BUSINESS,
      title: 'משימת המסמך',
    });
    const readingId = `READ-anchor-${Date.now()}`;
    await db.query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, content, provenance, model,
          prompt_version, brief_hash)
       VALUES ($1, $2, $3, 'read', '{}'::jsonb, 'unknown_external', 'test-model', 'v1', 'hash-anchor')`,
      [readingId, BUSINESS, documentId],
    );
    await db.query(
      `INSERT INTO proposals
         (proposal_id, business_id, reading_id, status, content, model, prompt_version, raw, job_id)
       VALUES ($1, $2, $3, 'proposed', '{}'::jsonb, 'test-model', 'v1', 'גולמי', $4)`,
      [`PROP-anchor-${Date.now()}`, BUSINESS, readingId, subject.jobId],
    );

    // The `gov.verify` job, exactly as `beginVerification` opens it: its own
    // row, NO proposal, and a bound plan carrying the document id and the
    // draft. The title names only the subject job — nothing here mentions the
    // document except the plan itself.
    const verifier = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'unknown_external',
      businessId: BUSINESS,
      // The shape `beginVerification` writes: `אימות: <כותרת ההצעה>` — the
      // subject job id appears only in the plan's own `goal`, never here.
      title: 'אימות: אשיב לדנה',
    });
    await db.query(
      `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
       VALUES ($1, $2, 'hp-verify', $3::jsonb)`,
      [
        BUSINESS,
        verifier.jobId,
        JSON.stringify({
          steps: [
            {
              id: 'judge',
              toolName: 'assert.evaluate',
              input: {
                subjectJobId: subject.jobId,
                documentId,
                draftText: `שלום, בעקבות ההצעה שלך ${PROBE}`,
                question: 'מה מבקש המסמך הזה בפועל?',
              },
            },
          ],
        }),
      ],
    );

    const plan = await buildErasurePlan({ kind: 'document', documentId }, { businessId: BUSINESS });
    // The precondition the gap lived in: the `proposals` query reaches the
    // subject job only. If a future change makes the verifier job reachable
    // that way too, this assertion fails and the test below stops proving the
    // discovery it was written for.
    expect(plan.jobIds).toContain(subject.jobId);
    expect(plan.jobIds).toContain(verifier.jobId);

    await executeErasure(plan, { businessId: BUSINESS });

    const { rows } = await db.query(
      'SELECT 1 FROM job_plans WHERE business_id = $1 AND job_id = $2',
      [BUSINESS, verifier.jobId],
    );
    expect(rows).toHaveLength(0);

    // And the draft itself, by content: a row count going to zero for the
    // wrong reason would still pass the check above.
    const { rows: leftovers } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM job_plans
        WHERE business_id = $1 AND plan::text LIKE $2`,
      [BUSINESS, `%${PROBE}%`],
    );
    expect(leftovers[0]?.n).toBe('0');
  });

  /**
   * And the other direction, without which the scan above is satisfied
   * perfectly by an erasure that deletes the whole database. Each job also
   * gets its own job-tied `whatsapp_messages` row, so this doubles as the
   * mutation-check target for Important 2: a bare `business_id = $1` for
   * `WHATSAPP_MESSAGES_ERASED_PREDICATE` cannot even run (it stops consuming
   * `$2`–`$5`, and `whatsappMessageParams` still supplies all five), so the
   * query itself fails rather than deleting too much — see the fix round 1
   * report for the exact error text that mutation produces.
   *
   * This test's two jobs are two DIFFERENT contacts, neither one kept — it
   * is not the `kept_items` case. That case, where the SAME job the anchor
   * found is explicitly kept, is the next test below (Critical 1).
   */
  it('leaves a second contact entirely intact', async () => {
    const bundle = await installCharter(buildCharter({ version: 'two' }), { businessId: BUSINESS });
    const mk = async (identifier: string, title: string): Promise<string> => {
      const job = await createJob({
        charterVersion: bundle.charterVersion,
        provenance: 'boss',
        businessId: BUSINESS,
        title,
      });
      await getPool().query(
        `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
         VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
        [BUSINESS, job.jobId, identifier],
      );
      await writeMemory(
        { jobId: job.jobId, kind: 'entity', subjectKey: identifier, body: { email: identifier } },
        { businessId: BUSINESS },
      );
      await getPool().query(
        `INSERT INTO whatsapp_messages
           (id, business_id, provider_message_id, direction, sender_number,
            sender_kind, body, provider_timestamp, state, job_id)
         VALUES ($1, $2, $3, 'inbound', $4, 'principal', $5, now(), 'handled', $6)`,
        [`WA-${job.jobId}`, BUSINESS, `wamid-${job.jobId}`, identifier, `הודעה מ-${identifier}`, job.jobId],
      );
      return job.jobId;
    };

    const probeJob = await mk(PROBE, 'probe');
    const keptJob = await mk('keeper@nowhere.example', 'keeper');

    const plan = await buildErasurePlan({ kind: 'contact', identifier: PROBE }, { businessId: BUSINESS });
    await executeErasure(plan, { businessId: BUSINESS });

    const memories = await getPool().query<{ subject_key: string }>(
      'SELECT subject_key FROM memories WHERE business_id=$1',
      [BUSINESS],
    );
    expect(memories.rows.map((r) => r.subject_key)).toEqual(['keeper@nowhere.example']);

    const auth = await getPool().query('SELECT 1 FROM job_authorizations WHERE job_id=$1', [keptJob]);
    expect(auth.rows).toHaveLength(1);

    const probeMessage = await getPool().query('SELECT 1 FROM whatsapp_messages WHERE job_id=$1', [probeJob]);
    expect(probeMessage.rows).toHaveLength(0);

    const keptMessage = await getPool().query('SELECT 1 FROM whatsapp_messages WHERE job_id=$1', [keptJob]);
    expect(keptMessage.rows).toHaveLength(1);
  });

  /**
   * Fix round 1, Critical 1. The job the anchor itself finds — not a second,
   * unrelated contact — explicitly KEPT via `kept_items`. The job's own
   * `whatsapp_messages` row names the same identifier the anchor is erasing,
   * exactly the shape that defeats a keep if the content arm is not gated on
   * `job_id IS NULL`: `job_id = ANY($2)` correctly skips it once `jobList`
   * drops the kept job, but an UNGATED content arm would still match the
   * message directly by its own `sender_number`/`body`, deleting the kept
   * job's opening message while the preview reports it as kept.
   */
  it('leaves a kept job’s own WhatsApp message alone', async () => {
    const bundle = await installCharter(buildCharter({ version: 'wa-kept' }), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'kept-job-with-whatsapp',
    });
    await getPool().query(
      `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
       VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
      [BUSINESS, job.jobId, PROBE],
    );
    await getPool().query(
      `INSERT INTO whatsapp_messages
         (id, business_id, provider_message_id, direction, sender_number,
          sender_kind, body, provider_timestamp, state, job_id)
       VALUES ('WA-kept-job', $1, 'wamid-kept-job', 'inbound', $2, 'principal', $3, now(), 'handled', $4)`,
      [BUSINESS, PROBE, `הודעה מ-${PROBE}`, job.jobId],
    );
    await keepItem({ kind: 'job', itemId: job.jobId, note: 'לשימור' }, { businessId: BUSINESS });

    const plan = await buildErasurePlan({ kind: 'contact', identifier: PROBE }, { businessId: BUSINESS });
    expect(plan.jobIds).not.toContain(job.jobId);

    await executeErasure(plan, { businessId: BUSINESS });

    const rows = await getPool().query('SELECT 1 FROM whatsapp_messages WHERE job_id=$1', [job.jobId]);
    expect(rows.rows).toHaveLength(1);
  });

  /**
   * The window arm, which the sweep above never exercises (it is
   * contact-anchored): an orphan message — no job at all — created inside
   * the window is destroyed, and one created outside it, naming the exact
   * same identifier, survives untouched. Fix round 1, Important 2.
   */
  it('reaches an orphan whatsapp message by window, and leaves one outside the window alone', async () => {
    await installCharter(buildCharter({ version: 'wa-window' }), { businessId: BUSINESS });

    // The window arm matches `created_at` (when the row was WRITTEN), not
    // `provider_timestamp` (what GREEN-API says about when the message was
    // sent) — same as the `jobs` window search above it. `created_at` has a
    // `DEFAULT now()`, so both rows get it set explicitly here rather than
    // relying on insertion order to land one inside the window and one out.
    await getPool().query(
      `INSERT INTO whatsapp_messages
         (id, business_id, provider_message_id, direction, sender_number,
          sender_kind, body, provider_timestamp, state, job_id, created_at)
       VALUES ('WA-in-window', $1, 'wamid-in-window', 'inbound', $2, 'other', $3,
               '2026-01-01T12:00:00.000Z', 'received', NULL, '2026-01-01T12:00:00.000Z')`,
      [BUSINESS, PROBE, `הודעה מ-${PROBE} בחלון`],
    );
    await getPool().query(
      `INSERT INTO whatsapp_messages
         (id, business_id, provider_message_id, direction, sender_number,
          sender_kind, body, provider_timestamp, state, job_id, created_at)
       VALUES ('WA-outside-window', $1, 'wamid-outside-window', 'inbound', $2, 'other', $3,
               '2027-06-01T12:00:00.000Z', 'received', NULL, '2027-06-01T12:00:00.000Z')`,
      [BUSINESS, PROBE, `הודעה מ-${PROBE} מחוץ לחלון`],
    );

    const plan = await buildErasurePlan(
      { kind: 'window', fromIso: '2026-01-01T00:00:00.000Z', toIso: '2026-01-02T00:00:00.000Z' },
      { businessId: BUSINESS },
    );
    await executeErasure(plan, { businessId: BUSINESS });

    const remaining = await getPool().query<{ id: string }>(
      'SELECT id FROM whatsapp_messages WHERE business_id=$1',
      [BUSINESS],
    );
    expect(remaining.rows.map((r) => r.id)).toEqual(['WA-outside-window']);
  });

  /**
   * The erasure module's own two files, and the property is about who may
   * import them, not about what they do when called. Named as a positive
   * allow list rather than a set of excluded root directories: a
   * hand-maintained `roots` list here once covered
   * orchestrator/sdk/policy/documents/charter and silently skipped
   * src/cli, src/mail, src/memory, src/util, src/db, src/audit and
   * src/config.ts — exactly the "control that covers a subset of what it
   * claims" failure this project has been burned by before. Walking the
   * whole tree and excluding by name means a directory added next year is
   * scanned by default, not skipped by default.
   */
  const ERASURE_MODULE_FILES = new Set([
    join('src', 'governance', 'erasure.ts'),
    join('src', 'governance', 'erasure-plan.ts'),
  ]);

  /**
   * Erasure must never become something a plan can invoke: an injected
   * document would say "forget what you found out about me" and the evidence
   * would go (spec §3). Checked by reading the source, because the property
   * is about who may import it, not about what it does when called.
   */
  it('is imported by nothing outside erasure.ts itself and the dashboard', async () => {
    const offenders: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (ERASURE_MODULE_FILES.has(path)) continue;
        // The dashboard is the one production consumer spec §3 permits: a
        // preview built for the owner to confirm, and the confirmed
        // execution. Matched by path segment, not by root, so a file at any
        // depth under it is exempt.
        if (path.split(/[\\/]/).includes('dashboard')) continue;
        const source = await readFile(path, 'utf8');
        // Both import forms. Requiring the `from` keyword missed
        // `await import('../governance/erasure.js')` — and a dynamic import
        // is precisely how a future caller would reach a module it is not
        // supposed to name statically. No offender exists today; the
        // alternation was proved to bite by planting one in `src/util/
        // money.ts`, watching this test name the file, and restoring it.
        if (/(?:from|import\s*\()\s*['"].*erasure(-plan)?\.js['"]/.test(source)) {
          offenders.push(path);
        }
      }
    };

    await walk('src');
    expect(offenders).toEqual([]);
  });

  it('names erasure in no tool table and no agent allowlist', async () => {
    const classify = await readFile('src/policy/classify.ts', 'utf8');
    const capabilities = await readFile('src/charter/capabilities.ts', 'utf8');
    for (const forbidden of ['memory.forget', 'erase', 'erasure']) {
      expect(classify.includes(`'${forbidden}'`), `classify.ts names ${forbidden}`).toBe(false);
      expect(capabilities.includes(`'${forbidden}'`), `capabilities.ts names ${forbidden}`).toBe(false);
    }
  });
});
