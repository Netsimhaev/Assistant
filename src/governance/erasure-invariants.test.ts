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
   *
   * **A fourteenth, also outside spec §5.1: `digests` (migration 040).**
   * Seeded in its own block below (it carries no `job_id`, so it cannot ride
   * along on the job's seeding the way every job-scoped store above does) —
   * see `erasure-plan.ts`'s header for why it is discovered by content alone.
   *
   * **A fifteenth and sixteenth, also outside spec §5.1: `mail_messages` and
   * `mail_invoices` (migrations 042/044)** — seeded in their own block, not
   * tied to the job, because a mail is discovered by its own columns.
   *
   * **A seventeenth, also outside spec §5.1: `action_updates` (migration
   * 047)** — the record of what the owner was told about a step the
   * assistant performed on her own. Job-scoped, seeded beside
   * `autonomy_marks` and reached the same way.
   *
   * **This "twelve, then thirteen, then fourteen, then sixteen, then seventeen" count is spec §5.1's own
   * original content-store enumeration, growing as new content-bearing
   * tables were added to it — it is a DIFFERENT number from "how many
   * tables `countItems`/the executor each name today" (19; CLAUDE.md states
   * that figure, because it is the one a reader can grep `erasure-plan.ts`
   * and count directly). The two will not generally match: this file's
   * count tracks a design document's own enumeration of content-bearing
   * stores, while the 17 also includes tables scrubbed as a consequence of
   * a kept-vs-erased JOB rather than discovered as a content store in their
   * own right (`jobs`, `job_steps`, `job_step_results`), and counts a table
   * once per table name regardless of how many `action`s `countItems` runs
   * against it. Neither number is wrong; they answer different questions,
   * and conflating them is exactly the inconsistency a prior round of this
   * project's own documentation fell into.
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
      // `text_origin` is NOT NULL with no default (migration 039), so every
      // writer states it. 'typed' is what this fixture means: an owner who
      // typed the probe into the instruction box.
      `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text, text_origin)
       VALUES ('INS-probe', $1, $2, $3, 'typed')`,
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
    // Fix round 2, Finding 2. A second orphan — `job_id` NULL, same as
    // `WA-probe-orphan` above — but with NO trace of the probe anywhere in
    // `sender_number`/`body`/`transcript`. Under a CONTACT anchor,
    // `whatsappMessageParams` sets `$3` to the probe's LIKE pattern, so this
    // row is the one thing in this sweep that can tell "the content arm
    // actually checks the content" apart from "the content arm is true
    // whenever `$3` is non-null" — a widening that would still pass every
    // other assertion in this file, because every other orphan or job-tied
    // row here either carries the probe or is protected by the job arm
    // instead. Asserted to survive, below, after the erasure runs.
    await db.query(
      `INSERT INTO whatsapp_messages
         (id, business_id, provider_message_id, direction, sender_number,
          sender_kind, body, transcript, provider_timestamp, state, job_id)
       VALUES ('WA-unrelated-orphan', $1, 'wamid-unrelated-orphan', 'inbound', $2, 'other', $3, $4, now(), 'received', NULL)`,
      [BUSINESS, '+972500000000', 'מתי אפשר לקבוע תור לספר?', 'תמלול: מתי אפשר לקבוע תור לספר?'],
    );
    await writeMemory(
      { jobId: job.jobId, kind: 'entity', subjectKey: PROBE, body: { email: PROBE } },
      { businessId: BUSINESS },
    );

    // --- Migration 040's table. -------------------------------------------
    //
    // `digests` has no `job_id` at all — a digest is a periodic rollup across
    // many jobs, not a record belonging to this one — so it cannot ride along
    // on the job's own seeding above the way every job-scoped table in this
    // sweep does. It is seeded here as its own, independent probe site: the
    // only thing that can ever catch a missing `digests` wiring is the probe
    // sitting in `body` itself. See `erasure-plan.ts`'s header for why this
    // table is discovered by content alone, with no job-membership half.
    await db.query(
      `INSERT INTO digests (digest_id, business_id, kind, window_start, window_end, body, had_content)
       VALUES ('DG-probe', $1, 'daily', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', $2, true)`,
      [BUSINESS, `תדריך יומי · פנייה שנכשלה אל ${PROBE}`],
    );
    // An unrelated digest, naming nothing that matches the probe — the same
    // role `WA-unrelated-orphan` plays for `whatsapp_messages` below: without
    // it, a `digests` predicate that matched every row in the business
    // (rather than only rows whose `body` names the probe) would still leave
    // this sweep green, because `DG-probe` above would be the only row
    // either way.
    await db.query(
      `INSERT INTO digests (digest_id, business_id, kind, window_start, window_end, body, had_content)
       VALUES ('DG-unrelated', $1, 'daily', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'תדריך יומי · הכל תקין', true)`,
      [BUSINESS],
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

    // --- Migration 047's record of what the owner was told. ---------------
    //
    // `action_updates.recipient`/`subject`/`body` describe one performed step
    // to the owner and name the person it was addressed to. Keyed by
    // `job_id`, exactly like `autonomy_marks` above, and reached the same way.
    await db.query(
      `INSERT INTO action_updates (update_id, business_id, job_id, step_id, action_class, recipient, subject, body)
       VALUES ('AU-probe', $1, $2, 's1', 'email.reply', $3, $4, $5)`,
      [BUSINESS, job.jobId, PROBE, `תשובה אל ${PROBE}`, `שלחתי מייל אל ${PROBE}`],
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

    // --- Migrations 042/044: the mailbox. ---------------------------------
    //
    // `mail_messages` and `mail_invoices` are content stores with no job of
    // their own to ride in on — a mail is discovered by its own columns
    // (`MAIL_MESSAGES_ERASED_PREDICATE`'s docblock). The mail here is NOT
    // tied to `job`, deliberately: the probe sits in the mail's own body and
    // sender, and its invoice's `supplier_address`, and only the mail
    // discovery reaches them. Its attachment links a document whose name
    // carries the probe and which nothing else in this sweep references — so
    // the document surviving would mean the mail→document closure is missing.
    const mailDocumentId = `DOC-mail-probe-${Date.now()}`;
    await db.query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256,
          byte_size, stored_path, status)
       VALUES ($1, $2, 'manual', $3, 'application/pdf', repeat('e', 64), 12, $4, 'stored')`,
      [mailDocumentId, BUSINESS, `חשבונית של ${PROBE}.pdf`, `${BUSINESS}/${mailDocumentId}/original.pdf`],
    );
    await db.query(
      `INSERT INTO mail_messages
         (mail_id, business_id, provider_message_id, thread_id, from_address, from_name,
          reply_to, to_addresses, subject, received_at, body_text, summary, attachments, state)
       VALUES ('M-probe', $1, 'pm-probe', 'th-probe', $2, 'Probe Sender', $2, ARRAY[$2], $3, now(),
               $4, $5, $6::jsonb, 'triaged')`,
      [
        BUSINESS,
        PROBE,
        `חשבונית מ-${PROBE}`,
        `שלום, כאן ${PROBE}, מצורפת חשבונית`,
        `${PROBE} שלח חשבונית`,
        JSON.stringify([
          { attachmentId: 'att-1', filename: `${PROBE}.pdf`, mediaType: 'application/pdf', size: 12, documentId: mailDocumentId },
        ]),
      ],
    );
    await db.query(
      `INSERT INTO mail_invoices
         (invoice_id, business_id, mail_id, supplier_address, supplier_name, document_id, file_name, received_at)
       VALUES ('INV-probe', $1, 'M-probe', $2, $3, $4, $5, now())`,
      [BUSINESS, PROBE, `ספק ${PROBE}`, mailDocumentId, `${PROBE}.pdf`],
    );
    // An unrelated mail, the narrowness control — the role `WA-unrelated-orphan`
    // and `DG-unrelated` play for their own tables.
    await db.query(
      `INSERT INTO mail_messages
         (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
          received_at, body_text, state)
       VALUES ('M-unrelated', $1, 'pm-unrelated', 'th-unrelated', 'barber@shop.example',
               'תור לספר', now(), 'מתי אפשר לקבוע תור?', 'triaged')`,
      [BUSINESS],
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: PROBE }, { businessId: BUSINESS });
    // The sweep below proves the executor deleted the row; this proves the
    // preview the owner confirms LISTED it — `countItems` and the executor
    // are two hand-written lists, and the sweep alone cannot catch the first
    // one missing a table the second one has.
    expect(
      plan.items.find((item) => item.table === 'action_updates' && item.action === 'delete')?.count,
    ).toBe(1);
    await executeErasure(plan, { businessId: BUSINESS });

    // The row the content arm's narrowness is for (fix round 2, Finding 2):
    // job-less, under the same contact anchor as everything else in this
    // sweep, naming nothing that matches the probe. A content arm widened to
    // "true whenever $3 is non-null" deletes this row; the real one does not.
    const unrelated = await db.query('SELECT 1 FROM whatsapp_messages WHERE id = $1', ['WA-unrelated-orphan']);
    expect(unrelated.rows).toHaveLength(1);

    // The same role for `digests`: a predicate matching every row in the
    // business rather than only the one naming the probe would delete this
    // too.
    const unrelatedDigest = await db.query('SELECT 1 FROM digests WHERE digest_id = $1', ['DG-unrelated']);
    expect(unrelatedDigest.rows).toHaveLength(1);

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

    // The mailbox's narrowness control, and the mail→document closure: the
    // attachment's document carried the probe only in its own name, which the
    // sweep above covers — asserted directly as well so a failure names it.
    const unrelatedMail = await db.query('SELECT 1 FROM mail_messages WHERE mail_id = $1', ['M-unrelated']);
    expect(unrelatedMail.rows).toHaveLength(1);
    const mailDocument = await db.query('SELECT 1 FROM documents WHERE document_id = $1', [mailDocumentId]);
    expect(mailDocument.rows).toHaveLength(0);
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
   * Fix round 3, the HIGH security-review finding. A job whose ONLY trace of
   * the probe, anywhere, is a job-tied `whatsapp_messages` row — title,
   * `job_plans`, `job_authorizations` and `boss_instructions` all silent on
   * it. Models the two production shapes that produce exactly this: a
   * non-opening message on an existing job (only the message that OPENED a
   * job is mirrored into `boss_instructions.text`; this one is a SECOND
   * message tied to the same job, with its own distinct `provider_message_id`
   * so the unique index does not collide with it), and a `recordOutbound`
   * body, stored in no other table at all.
   *
   * Without the discovery query this round adds, `job_id = ANY($2)` never
   * reaches this row (nothing else discovers the job) and the content arm
   * is switched off by the `job_id IS NULL` gate (needed to keep a kept or
   * live job safe, per round 1) — so the row survives a contact erasure
   * permanently, reported as a clean 0 by `countItems`, with nothing in the
   * audit trail saying otherwise. The main sweep's own `WA-probe` row cannot
   * catch this: that job's title/plan/authorizations/instructions ALSO name
   * the probe, so it is already in `jobIds` through four other routes and
   * the message rides along for the wrong reason.
   */
  it('reaches a job whose only trace of the contact is its own WhatsApp message', async () => {
    const bundle = await installCharter(buildCharter({ version: 'wa-discovery' }), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      // Deliberately silent on the contact — no plan, no authorization, no
      // boss_instructions row at all, and a title that never names it.
      title: 'שיחה עם לקוח',
    });

    // The "opening" message: unrelated content, so `boss_instructions.text`
    // (if there were one) would be silent too — but there is no
    // `boss_instructions` row here at all, matching a job whose WhatsApp
    // thread was never run through the instruction door.
    await getPool().query(
      `INSERT INTO whatsapp_messages
         (id, business_id, provider_message_id, direction, sender_number,
          sender_kind, body, provider_timestamp, state, job_id)
       VALUES ('WA-discovery-open', $1, 'wamid-discovery-open', 'inbound', '+972500000001',
               'principal', 'אפשר הצעת מחיר?', now(), 'handled', $2)`,
      [BUSINESS, job.jobId],
    );
    // The SECOND message on the same job — the one that actually names the
    // contact, and the only place it is named anywhere in this job.
    await getPool().query(
      `INSERT INTO whatsapp_messages
         (id, business_id, provider_message_id, direction, sender_number,
          sender_kind, body, transcript, provider_timestamp, state, job_id)
       VALUES ('WA-discovery-second', $1, 'wamid-discovery-second', 'inbound', '+972500000001',
               'principal', $2, $3, now(), 'handled', $4)`,
      [BUSINESS, `כן, תשלחי את זה ל${PROBE}`, `תמלול: כן, תשלחי את זה ל${PROBE}`, job.jobId],
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: PROBE }, { businessId: BUSINESS });
    expect(plan.jobIds).toContain(job.jobId);

    await executeErasure(plan, { businessId: BUSINESS });

    const rows = await getPool().query('SELECT 1 FROM whatsapp_messages WHERE job_id=$1', [job.jobId]);
    expect(rows.rows).toHaveLength(0);
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
   * A mail closes over to every job it produced, and the anchor here is
   * deliberately a NAME that appears only in the mail's own body — not the
   * sender's address, which every reply job's plan also carries. So nothing
   * below can be reached by its own content: the triage job (`job_id`), the
   * live reply job (`reply_job_id`), the failed predecessor a re-raise
   * unlinked from the mail (found only by its plan naming the mail's
   * `providerMessageId`), their cards, the WhatsApp copy of the reply card,
   * the curated memory and the attachment's document all go because the
   * mail went.
   */
  it('contact erasure deletes the mail and its reply job', async () => {
    const bundle = await installCharter(buildCharter({ version: 'mail' }), { businessId: BUSINESS });
    const db = getPool();
    const NAME = 'רונית_כהן';
    const SENDER = 'ronit@client.example';
    const mk = async (title: string): Promise<string> =>
      (
        await createJob({
          charterVersion: bundle.charterVersion,
          provenance: 'unknown_external',
          businessId: BUSINESS,
          title,
        })
      ).jobId;

    const triageJob = await mk('מייל: שאלה על המחיר');
    const replyJob = await mk('תשובה: שאלה על המחיר');
    const failedReplyJob = await mk('תשובה: שאלה על המחיר');

    const documentId = `DOC-mail-${Date.now()}`;
    await db.query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256,
          byte_size, stored_path, status)
       VALUES ($1, $2, 'manual', 'quote.pdf', 'application/pdf', repeat('f', 64), 12, $3, 'stored')`,
      [documentId, BUSINESS, `${BUSINESS}/${documentId}/original.pdf`],
    );
    await db.query(
      `INSERT INTO mail_messages
         (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
          received_at, body_text, attachments, state, job_id, reply_job_id)
       VALUES ('M-ronit', $1, 'pm-ronit', 'th-ronit', $2, 'שאלה על המחיר', now(), $3, $4::jsonb,
               'triaged', $5, $6)`,
      [
        BUSINESS,
        SENDER,
        `שלום, כאן ${NAME}. כמה עולה?`,
        JSON.stringify([{ attachmentId: 'a1', filename: 'quote.pdf', mediaType: 'application/pdf', size: 12, documentId }]),
        triageJob,
        replyJob,
      ],
    );
    await db.query(
      `INSERT INTO mail_invoices (invoice_id, business_id, mail_id, supplier_address, received_at)
       VALUES ('INV-ronit', $1, 'M-ronit', $2, now())`,
      [BUSINESS, SENDER],
    );

    const replyPlan = (body: string) =>
      JSON.stringify({
        goal: 'תשובה לשולח: שאלה על המחיר',
        steps: [
          {
            id: 'reply',
            agent: 'comms.email',
            intent: 'reply_to_sender',
            toolName: 'mail.send',
            input: { to: [SENDER], subject: 'Re: שאלה על המחיר', body, inReplyTo: '<m@x>', references: null, threadId: 'th-ronit', providerMessageId: 'pm-ronit' },
            expectedActionClass: 'email.reply',
          },
        ],
      });
    for (const [jobId, hash] of [[replyJob, 'hp-r'], [failedReplyJob, 'hp-f']] as const) {
      await db.query(
        `INSERT INTO job_plans (business_id, job_id, plan_hash, plan) VALUES ($1, $2, $3, $4::jsonb)`,
        [BUSINESS, jobId, hash, replyPlan('המחיר הוא 500 ש"ח')],
      );
      await db.query(
        `INSERT INTO approval_requests
           (approval_id, business_id, job_id, action_class, summary, detail, risk,
            proposed_tool, proposed_input, input_hash, expires_at)
         VALUES ($1, $2, $3, 'email.reply', 'תשובה', 'המחיר הוא 500', '{}'::jsonb, 'mail.send',
                 $4::jsonb, $5, now() + interval '1 hour')`,
        [`AP-${jobId}`, BUSINESS, jobId, JSON.stringify({ to: [SENDER] }), `h-${jobId}`],
      );
    }
    await db.query(
      `INSERT INTO whatsapp_messages (id, business_id, direction, body, provider_timestamp, state, job_id)
       VALUES ('WA-mail-card', $1, 'outbound', 'תשובה מוצעת: המחיר הוא 500', now(), 'handled', $2)`,
      [BUSINESS, replyJob],
    );
    await writeMemory(
      { jobId: triageJob, kind: 'chunk', subjectKey: SENDER, body: { claim: 'שאלה על מחיר' } },
      { businessId: BUSINESS },
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: NAME }, { businessId: BUSINESS });
    expect([...plan.jobIds].sort()).toEqual([triageJob, replyJob, failedReplyJob].sort());
    expect(plan.documentIds).toEqual([documentId]);
    expect(plan.mailIds).toEqual(['M-ronit']);

    await executeErasure(plan, { businessId: BUSINESS });

    const count = async (sql: string, params: unknown[]): Promise<number> =>
      (await db.query(sql, params)).rows.length;
    expect(await count('SELECT 1 FROM mail_messages WHERE mail_id = $1', ['M-ronit'])).toBe(0);
    expect(await count('SELECT 1 FROM mail_invoices WHERE invoice_id = $1', ['INV-ronit'])).toBe(0);
    expect(await count('SELECT 1 FROM job_plans WHERE job_id = ANY ($1)', [[replyJob, failedReplyJob]])).toBe(0);
    expect(await count('SELECT 1 FROM approval_requests WHERE job_id = ANY ($1)', [[replyJob, failedReplyJob]])).toBe(0);
    expect(await count('SELECT 1 FROM whatsapp_messages WHERE id = $1', ['WA-mail-card'])).toBe(0);
    expect(await count('SELECT 1 FROM memories WHERE business_id = $1', [BUSINESS])).toBe(0);
    expect(await count('SELECT 1 FROM documents WHERE document_id = $1', [documentId])).toBe(0);
    expect(await count('SELECT 1 FROM jobs WHERE job_id = ANY ($1) AND title IS NOT NULL', [[triageJob, replyJob, failedReplyJob]])).toBe(0);
  });

  /** The window arm: `received_at`, inside the window gone, outside kept. */
  it('reaches mail by received_at on a window anchor', async () => {
    await installCharter(buildCharter({ version: 'mail-window' }), { businessId: BUSINESS });
    for (const [mailId, at] of [
      ['M-in', '2026-01-01T12:00:00.000Z'],
      ['M-out', '2026-03-01T12:00:00.000Z'],
    ] as const) {
      await getPool().query(
        `INSERT INTO mail_messages
           (mail_id, business_id, provider_message_id, thread_id, from_address, subject, received_at, body_text)
         VALUES ($1, $2, $3, 't', 'a@b.example', 's', $4, 'גוף')`,
        [mailId, BUSINESS, `pm-${mailId}`, at],
      );
      await getPool().query(
        `INSERT INTO mail_invoices (invoice_id, business_id, mail_id, supplier_address, received_at)
         VALUES ($1, $2, $3, 'a@b.example', $4)`,
        [`INV-${mailId}`, BUSINESS, mailId, at],
      );
    }
    const plan = await buildErasurePlan(
      { kind: 'window', fromIso: '2026-01-01T00:00:00.000Z', toIso: '2026-01-02T00:00:00.000Z' },
      { businessId: BUSINESS },
    );
    const outcome = await executeErasure(plan, { businessId: BUSINESS });
    // The explicit invoice delete is credited, not pre-empted by the cascade.
    expect(outcome.deleted.find((i) => i.table === 'mail_invoices')?.count).toBe(1);
    expect(outcome.deleted.find((i) => i.table === 'mail_messages')?.count).toBe(1);

    const mails = await getPool().query<{ mail_id: string }>('SELECT mail_id FROM mail_messages');
    expect(mails.rows.map((r) => r.mail_id)).toEqual(['M-out']);
    const invoices = await getPool().query<{ invoice_id: string }>('SELECT invoice_id FROM mail_invoices');
    expect(invoices.rows.map((r) => r.invoice_id)).toEqual(['INV-M-out']);
  });

  /**
   * The document arm: an invoice row pointing at the erased document goes;
   * the mail that delivered it is not the document and stays.
   */
  it('removes the invoice of an erased document and keeps the mail', async () => {
    await installCharter(buildCharter({ version: 'mail-doc' }), { businessId: BUSINESS });
    const db = getPool();
    const documentId = `DOC-inv-${Date.now()}`;
    await db.query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
       VALUES ($1, $2, 'manual', 'inv.pdf', 'application/pdf', repeat('a', 64), 12, $3, 'stored')`,
      [documentId, BUSINESS, `${BUSINESS}/${documentId}/original.pdf`],
    );
    await db.query(
      `INSERT INTO mail_messages
         (mail_id, business_id, provider_message_id, thread_id, from_address, subject, received_at, body_text)
       VALUES ('M-doc', $1, 'pm-doc', 't', 'a@b.example', 's', now(), 'גוף')`,
      [BUSINESS],
    );
    await db.query(
      `INSERT INTO mail_invoices (invoice_id, business_id, mail_id, supplier_address, document_id, received_at)
       VALUES ('INV-doc', $1, 'M-doc', 'a@b.example', $2, now()),
              ('INV-other', $1, 'M-doc', 'a@b.example', NULL, now())`,
      [BUSINESS, documentId],
    );
    const plan = await buildErasurePlan({ kind: 'document', documentId }, { businessId: BUSINESS });
    await executeErasure(plan, { businessId: BUSINESS });

    const invoices = await db.query<{ invoice_id: string }>('SELECT invoice_id FROM mail_invoices');
    expect(invoices.rows.map((r) => r.invoice_id)).toEqual(['INV-other']);
    expect((await db.query('SELECT 1 FROM mail_messages WHERE mail_id = $1', ['M-doc'])).rows).toHaveLength(1);
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
