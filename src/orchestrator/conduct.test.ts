import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { ingestDocument } from '../documents/ingest.js';
import { conductPendingDocuments } from './conduct.js';
import type { Reading } from '../domain/reading.js';
import type { Proposal } from '../domain/proposal.js';

const BUSINESS = 'biz-conduct';

// Field names here follow the current `domain/reading.ts` / `domain/proposal.ts`
// schemas (`Finding.value`, `Intent.subject`/`sourceRef`, `Proposal.clarifyingQuestion`,
// `Reading.unreadable`) rather than the brief's literal snippet, which predates a
// rename in those schemas and does not typecheck as written (`as Reading` /
// `as Proposal` refused for insufficient overlap — TS2352). The content is the
// same; only the shape was brought back in line with what `z.infer` requires.
const READING: Reading = {
  summary: 'חוזה שיווק עם ספק',
  findings: [{ label: 'מחיר', value: 'המחיר 4,000 ש"ח', sourceRef: { ordinal: 0, locator: null } }],
  intents: [
    {
      intent: 'reply_to_sender',
      subject: { kind: 'sender' },
      sourceRef: { ordinal: 0, locator: null },
      note: 'לאשר קבלה',
    },
  ],
  unreadable: [],
};

const ACTING: Proposal = {
  headline: 'קראתי את החוזה',
  stance: 'act',
  reasons: [{ text: 'המחיר תואם', findingLabel: 'מחיר', sourceRef: { ordinal: 0, locator: null } }],
  clarifyingQuestion: null,
  action: {
    headline: 'אשלח מייל לדנה',
    purpose: 'לאשר קבלה',
    agent: 'comms.email',
    intent: 'reply_to_sender',
    toolName: 'mail.send',
    expectedActionClass: 'email.initiate',
    input: { to: 'dana@example.com', subject: 'התקבל', body: 'תודה' },
  },
};

const PASSIVE: Proposal = {
  headline: 'אני נגד חתימה',
  stance: 'advise_against',
  reasons: [
    { text: 'המחיר שונה ממה שסוכם', findingLabel: 'מחיר', sourceRef: { ordinal: 0, locator: null } },
  ],
  clarifyingQuestion: null,
  action: null,
};

async function aDocument(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cd-'));
  const path = join(dir, `${text.slice(0, 6)}.txt`);
  await writeFile(path, text, 'utf8');
  const doc = await ingestDocument(
    { path, source: 'manual' },
    { businessId: BUSINESS, documentRoot: dir },
  );
  return doc.documentId;
}

function deps(proposal: Proposal = ACTING) {
  const calls = { reads: 0, proposals: 0 };
  return {
    calls,
    reader: async () => {
      calls.reads += 1;
      // `ReadOutcome` (src/sdk/know-reader.ts) carries `denials` and `turns`
      // on both branches — a stub missing them does not typecheck.
      return { status: 'read' as const, reading: READING, raw: '{}', denials: [], turns: 1 };
    },
    proposer: async () => {
      calls.proposals += 1;
      return { status: 'proposed' as const, proposal, raw: '{}' };
    },
  };
}

describe('conductPendingDocuments', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  it('takes a document all the way to a pending card', async () => {
    const documentId = await aDocument('חוזה שיווק');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
    });

    expect(result.carded).toBe(1);
    const { rows } = await getPool().query<{ state: string; job_id: string }>(
      `SELECT state, job_id FROM approval_requests`,
    );
    expect(rows[0]?.state).toBe('pending');

    const jobs = await getPool().query<{ provenance: string; phase: string }>(
      `SELECT provenance, phase FROM jobs WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(jobs.rows[0]?.provenance).toBe('unknown_external');
    expect(jobs.rows[0]?.phase).toBe('await_approval');
    expect(documentId).toBeTruthy();
  });

  it('stores a passive proposal and raises no card', async () => {
    await aDocument('חוזה גרוע');
    const d = deps(PASSIVE);

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
    });

    expect(result.carded).toBe(0);
    expect(result.readOnly).toBe(1);
    const approvals = await getPool().query(`SELECT 1 FROM approval_requests`);
    expect(approvals.rows).toHaveLength(0);
    const proposals = await getPool().query(`SELECT 1 FROM proposals`);
    expect(proposals.rows, 'the proposal must still be stored').toHaveLength(1);
  });

  it('stops at the daily ceiling and leaves the rest for tomorrow', async () => {
    await aDocument('מסמך אחד');
    await aDocument('מסמך שני');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      readsPerDay: 1,
      reader: d.reader,
      proposer: d.proposer,
    });

    expect(result.ceilingReached).toBe(true);
    expect(d.calls.reads, 'the second document must not be read').toBe(1);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_readings WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('records a failure and carries on to the next document', async () => {
    await aDocument('נופל');
    await aDocument('עובד');
    let first = true;
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: async (...args: Parameters<typeof d.reader>) => {
        if (first) {
          first = false;
          throw new Error('model exploded');
        }
        return d.reader(...args);
      },
      proposer: d.proposer,
    });

    expect(result.failed).toBe(1);
    expect(result.carded, 'the second document must still get its card').toBe(1);
    const { rows } = await getPool().query<{ read_attempts: number; read_error: string }>(
      `SELECT read_attempts, read_error FROM documents WHERE read_attempts > 0`,
    );
    expect(rows[0]?.read_attempts).toBe(1);
    expect(rows[0]?.read_error).toContain('model exploded');
  });

  it('does nothing at all when no charter is installed', async () => {
    await resetDatabase();
    await aDocument('בלי תקנון');
    const d = deps();

    const result = await conductPendingDocuments({
      businessId: BUSINESS,
      reader: d.reader,
      proposer: d.proposer,
    });

    expect(result.considered).toBe(0);
    expect(d.calls.reads).toBe(0);
  });
});
