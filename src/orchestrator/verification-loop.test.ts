/**
 * The whole verification loop, driven through the real `schedulerPass`.
 *
 * Every other test in this branch proves one joint: `verifyDraft` delegates,
 * `resumeDelegatedJobs` wakes a parked parent, `assert.evaluate` finds the
 * answer and judges it, the card renders three states. None of them proves the
 * joints are connected — and that is exactly the class of fault this project
 * keeps paying for (a compiled charter field with no reader; `dueJobs` with no
 * production caller; `conduct.ts` raising a card for a plan it never bound).
 * So this file starts at the production entry point and asserts nothing but
 * durable state.
 *
 * **What is stubbed, and why only this much.** Three seams, and each one is a
 * call to a model that costs money:
 *
 * - `reader` — the conductor's own document read.
 * - `proposer` — the conductor's own proposal.
 * - `judge` — and this one is NOT a replacement for `verifyDraft`. It replaces
 *   only `judgeWithModel`, the seam inside it that costs money. That matters:
 *   the delegation, the numeric grounding, the nonce-fenced prompt, the
 *   truncation flags and `saveVerdict` are all real here. Replacing
 *   `verifyDraft` outright — which `schedulerPass`'s other seam, `verifier`,
 *   still does for the conductor's own call — would have stubbed out the
 *   delegation too, and the delegation is half of what this file exists to
 *   prove. The second test below is that hazard, pinned.
 *
 * Everything else — the phase machine, the gate, `runDueJobs`, the envelope
 * store, `resumeDelegatedJobs`, `closeVerifiedJobs` — is production code.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { ingestDocument } from '../documents/ingest.js';
import type { Proposal } from '../domain/proposal.js';
import type { Reading } from '../domain/reading.js';
import { loadVerificationOutcome } from '../governance/verdict-store.js';
import type { Judge } from '../sdk/gov-verify.js';
import { AdapterRegistry } from './adapters/registry.js';
import { envCredentials } from './credentials.js';
import { loadJob } from './jobs.js';
import { schedulerPass } from './scheduler.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'biz-verification-loop';

/** Same shape the conductor's own tests use — a reading with one finding. */
const READING: Reading = {
  summary: 'הצעת מחיר שמבקשת אישור בכתב',
  findings: [
    { label: 'מחיר', value: 'הסכום 11,988 ש"ח', sourceRef: { ordinal: 0, locator: null } },
  ],
  intents: [
    {
      intent: 'reply_to_sender',
      subject: { kind: 'sender' },
      sourceRef: { ordinal: 0, locator: null },
      note: 'לאשר קבלה בכתב',
    },
  ],
  unreadable: [],
};

/** A stance that carries an action, so the conductor raises a card. */
const ACTING: Proposal = {
  headline: 'קראתי את הצעת המחיר',
  stance: 'act',
  reasons: [{ text: 'המחיר סביר', findingLabel: 'מחיר', sourceRef: { ordinal: 0, locator: null } }],
  clarifyingQuestion: null,
  action: {
    headline: 'אשיב לשולח שההצעה התקבלה',
    purpose: 'לאשר קבלה',
    agent: 'comms.email',
    intent: 'reply_to_sender',
    toolName: 'mail.send',
    expectedActionClass: 'email.initiate',
    input: { to: 'dana@example.com', subject: 'התקבל', body: 'ההצעה התקבלה, נחזור אליכם.' },
  },
};

/**
 * `buildRuntime` reads the installation's master key, so a test that is not
 * about the runtime supplies one explicitly. Nothing in this loop reaches an
 * adapter — every step is local (`doc.fetch`, `assert.evaluate`) — so the
 * registry is deliberately empty: a step that tried to leave the instance
 * would fail loudly here rather than quietly finding a recorder.
 */
function runtime(): Runtime {
  return {
    registry: new AdapterRegistry([]),
    credentials: envCredentials({}, 'TEST_CRED_'),
    warnings: [],
  };
}

interface Envelope {
  envelope_id: string;
  kind: string;
  parent_job_id: string;
  child_job_id: string | null;
}

async function envelopes(): Promise<Envelope[]> {
  const { rows } = await getPool().query<Envelope>(
    `SELECT envelope_id, kind, parent_job_id, child_job_id FROM agent_envelopes
      WHERE business_id = $1 ORDER BY created_at ASC, envelope_id ASC`,
    [BUSINESS],
  );
  return rows;
}

describe('the verification loop, end to end through schedulerPass', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  it('cards a document, delegates, parks, wakes, judges, and closes', async () => {
    // `doc.fetch` reads `config.documentReadsPerDay` DIRECTLY — the
    // `readsPerDay` option only reaches the conductor's own loop — and this
    // repo's `.env` sets it to 2. The conductor's read spends one, so the
    // child's `doc.fetch` is one row away from a ceiling it never intended to
    // test. Stated here rather than inherited: a test whose green depends on a
    // local env value fails for a reason that is not a regression.
    const mutableConfig = config as { documentReadsPerDay: number };
    const originalReads = mutableConfig.documentReadsPerDay;
    mutableConfig.documentReadsPerDay = 20;

    try {
      const dir = await mkdtemp(join(tmpdir(), 'verif-loop-doc-'));
      const path = join(dir, 'quote.txt');
      await writeFile(path, 'הצעת מחיר: 11988 ש"ח. נא לאשר בכתב.', 'utf8');
      const ingested = await ingestDocument(
        { path, source: 'manual' },
        { businessId: BUSINESS, documentRoot: dir },
      );
      expect(ingested.status).toBe('extracted');

      // An explicit, empty inbox: both conductor loops sit behind the same
      // switch, and `.env` here does configure a real folder. Stating it keeps
      // this test off whatever happens to be sitting in the operator's inbox.
      const inbox = await mkdtemp(join(tmpdir(), 'verif-loop-inbox-'));

      let judgeCalls = 0;
      const judge: Judge = async (request) => {
        judgeCalls += 1;
        // The composed answer really did reach the judge — `know.reader`'s
        // reading, turned into text by `composeVerificationAnswer`, carried
        // through the envelope round trip. Asserted inside the stub so the
        // loop fails here rather than producing a verdict formed on nothing.
        expect(request.answer).toContain('הצעת מחיר שמבקשת אישור בכתב');
        expect(request.draftText).toBe('ההצעה התקבלה, נחזור אליכם.');
        return {
          status: 'judged',
          raw: '{}',
          criteria: [
            {
              id: 'answers_question',
              statement: 'הטיוטה עונה על מה שהמסמך מבקש',
              severity: 'must',
              passed: true,
              detail: 'הטיוטה מאשרת קבלה בכתב',
            },
          ],
        };
      };

      let readerCalls = 0;
      const options = {
        businessId: BUSINESS,
        inbox,
        reader: async () => {
          readerCalls += 1;
          return { status: 'read' as const, reading: READING, raw: '{}', denials: [], turns: 1 };
        },
        proposer: async () => ({ status: 'proposed' as const, proposal: ACTING, raw: '{}' }),
        // The narrow seam. `verifier` is deliberately NOT passed: the
        // conductor's own `verifyDraft` call has to be the real one, or there
        // is no delegation to prove.
        judge,
        runtime: runtime(),
      };

      // ---- Pass 1 -------------------------------------------------------
      // The conductor reads, cards, and opens verification; `verifyDraft`
      // delegates and parks the `gov.verify` job; `runDueJobs` runs the
      // child's one `doc.fetch` step and `closeVerifiedJobs` closes it.
      const pass1 = await schedulerPass(options);

      expect(readerCalls).toBe(1);
      expect(pass1.conduct?.carded).toBe(1);
      expect(pass1.conduct?.verificationFailed).toBe(0);

      const afterFirst = await envelopes();
      expect(afterFirst).toHaveLength(1);
      const request = afterFirst[0];
      if (request === undefined) throw new Error('no help_request envelope');
      expect(request.kind).toBe('help_request');
      const verifyJobId = request.parent_job_id;
      const helperJobId = request.child_job_id;
      if (helperJobId === null) throw new Error('the child job was never attached');

      // The subject is the document's own job — a third row, and never the
      // delegating one.
      const subjectJobId = await documentJobId();
      expect(subjectJobId).not.toBe(verifyJobId);

      // Parked, not failed: this is the exact state the unconditional
      // `transition(..., 'failed')` used to destroy.
      expect((await loadJob(verifyJobId, { businessId: BUSINESS }))?.phase).toBe('followup');
      // The helper ran and closed inside this same pass — the ordering
      // `schedulerPass` documents (`runDueJobs` after the conductor,
      // `closeVerifiedJobs` after the plans) is what buys that.
      expect((await loadJob(helperJobId, { businessId: BUSINESS }))?.phase).toBe('closed');
      // Nothing judged yet, and the absence says "still running" — the one
      // meaning `verification_verdicts` reserves for a missing row.
      expect(judgeCalls).toBe(0);
      expect(await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS })).toBeNull();

      // ---- Pass 2 -------------------------------------------------------
      // `resumeDelegatedJobs` writes the `result` envelope and wakes the
      // parent to `execute`; `runDueJobs` runs `assert.evaluate` in the same
      // pass; `closeVerifiedJobs` closes it in the same pass again.
      const pass2 = await schedulerPass(options);

      expect(pass2.delegated.resumed).toEqual([verifyJobId]);
      expect(pass2.delegated.timedOut).toEqual([]);
      expect(pass2.delegated.errored).toEqual([]);
      expect(judgeCalls).toBe(1);

      const finished = await loadJob(verifyJobId, { businessId: BUSINESS });
      expect(finished?.phase).toBe('closed');

      const outcome = await loadVerificationOutcome(subjectJobId, { businessId: BUSINESS });
      expect(outcome?.status).toBe('judged');
      if (outcome === null || outcome.status !== 'judged') throw new Error('expected a verdict');
      expect(outcome.verdict.criteria).toHaveLength(1);
      expect(outcome.verdict.criteria[0]?.id).toBe('answers_question');
      // The real `verifyDraft` computed these, not the stub: `11988` appears
      // in the document's extraction but not in the draft, and the draft
      // carries no number of its own — so a grounded-set that was never
      // computed and one that came back empty are told apart by the three
      // code-owned flags below, all of which only this path can set.
      expect(outcome.verdict.ungroundedNumbers).toEqual([]);
      expect(outcome.verdict.draftTruncated).toBe(false);
      expect(outcome.verdict.answerTruncated).toBe(false);
      expect(outcome.verdict.fenceForgeryDetected).toBe(false);

      // Exactly one delegation for the whole run, and exactly one answer to
      // it — not one per pass. `requestHelp`'s idempotency key and
      // `resumeDelegatedJobs`'s both have to hold for this to be true.
      const finalEnvelopes = await envelopes();
      expect(finalEnvelopes.filter((row) => row.kind === 'help_request')).toHaveLength(1);
      expect(finalEnvelopes.filter((row) => row.kind === 'result')).toHaveLength(1);

      // ---- Pass 3 -------------------------------------------------------
      // A settled loop must stay settled: nothing left to resume, nothing
      // left to run, no second judge call, no second envelope.
      const pass3 = await schedulerPass(options);
      expect(pass3.delegated.resumed).toEqual([]);
      expect(pass3.due.ran).toEqual([]);
      expect(judgeCalls).toBe(1);
      expect(await envelopes()).toHaveLength(2);
    } finally {
      mutableConfig.documentReadsPerDay = originalReads;
    }
  });

  /**
   * **The hazard the two seam names exist to make impossible, pinned.**
   *
   * Until the split, `schedulerPass` had one `verifier` option and spread it
   * into both loops — so a caller wanting a free judge passed a stub that
   * REPLACED `verifyDraft`, and a replacement owns the delegation branch too.
   * The result: `requestHelp` never ran, no `help_request` envelope was
   * written, the `gov.verify` job never parked — and nothing said so.
   * `ConductResult.verificationFailed` stayed 0, because a stub returning a
   * `Verdict` is indistinguishable from success, and the pass reported a card
   * raised and a verification opened.
   *
   * This test stubs the judge the way production exposes it and asserts the
   * delegation happened anyway. It is written as a positive assertion on the
   * envelope row — the durable artefact — because "no error was reported" is
   * exactly the signal the old shape produced while doing nothing.
   */
  it('stubbing the judge cannot disable the delegation', async () => {
    const mutableConfig = config as { documentReadsPerDay: number };
    const originalReads = mutableConfig.documentReadsPerDay;
    mutableConfig.documentReadsPerDay = 20;

    try {
      const dir = await mkdtemp(join(tmpdir(), 'verif-seam-doc-'));
      const path = join(dir, 'quote.txt');
      await writeFile(path, 'הצעת מחיר: 11988 ש"ח. נא לאשר בכתב.', 'utf8');
      await ingestDocument(
        { path, source: 'manual' },
        { businessId: BUSINESS, documentRoot: dir },
      );
      const inbox = await mkdtemp(join(tmpdir(), 'verif-seam-inbox-'));

      let judgeCalls = 0;
      const judge: Judge = async () => {
        judgeCalls += 1;
        return {
          status: 'judged',
          raw: '{}',
          criteria: [{ id: 'x', statement: 'y', severity: 'must', passed: true, detail: 'z' }],
        };
      };

      const pass = await schedulerPass({
        businessId: BUSINESS,
        inbox,
        reader: async () => ({
          status: 'read' as const,
          reading: READING,
          raw: '{}',
          denials: [],
          turns: 1,
        }),
        proposer: async () => ({ status: 'proposed' as const, proposal: ACTING, raw: '{}' }),
        judge,
        runtime: runtime(),
      });

      expect(pass.conduct?.carded).toBe(1);
      expect(pass.conduct?.verificationFailed).toBe(0);
      // The two assertions the old shape would have failed: a real envelope,
      // and a parent actually parked on it.
      const rows = await envelopes();
      expect(rows.filter((row) => row.kind === 'help_request')).toHaveLength(1);
      const request = rows[0];
      if (request === undefined) throw new Error('the delegation never happened');
      expect((await loadJob(request.parent_job_id, { businessId: BUSINESS }))?.phase).toBe(
        'followup',
      );
      // And the judge genuinely was not reached on this pass, so the green
      // above is not a judge call standing in for a delegation.
      expect(judgeCalls).toBe(0);
    } finally {
      mutableConfig.documentReadsPerDay = originalReads;
    }
  });
});

/**
 * The document's own job — the subject the verdict is filed under.
 *
 * Found by elimination rather than by title: it is the only job of this
 * business sitting in `await_approval`, which is precisely the state the
 * conductor leaves it in and the state `verifyDraft`'s `parentJobId` can never
 * legally be in.
 */
async function documentJobId(): Promise<string> {
  const { rows } = await getPool().query<{ job_id: string }>(
    `SELECT job_id FROM jobs WHERE business_id = $1 AND phase = 'await_approval'`,
    [BUSINESS],
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`expected exactly one carded job, found ${rows.length}`);
  }
  return row.job_id;
}
