/**
 * Curation from mail: the sender is the only subject a mail job may teach the
 * assistant about, and the daily count is kept apart from document curation.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { settleMail } from '../mail/inbox-store.js';
import { createJob } from '../orchestrator/jobs.js';
import { pollMailbox } from '../orchestrator/mail-poll.js';
import type { MailTriage } from '../domain/mail-triage.js';
import type { MailboxClient } from '../mail/providers/types.js';
import type { Triage } from '../sdk/mail-triage.js';
import { resetDatabase } from '../test/db.js';
import { incomingMail, installMailboxCharter, mailboxRuntime, stubDrafter, storedMail } from '../test/mailbox.js';
import { setCursor } from '../mail/inbox-store.js';
import { buildCurationBrief } from './curation-brief.js';
import { curateJob, curationRunsToday } from './curate.js';
import { siftCandidates, type CurationResult } from './curation-parse.js';
import { recallMemories } from './store.js';

const BUSINESS = 'test-business';
const SENDER = 'supplier@vendor.example';

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closePool();
});

async function seedMailJob(): Promise<string> {
  const bundle = await installMailboxCharter(BUSINESS);
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
    title: 'מייל: חשבונית',
    businessId: BUSINESS,
  });
  const mail = await storedMail(BUSINESS, { fromAddress: SENDER });
  await settleMail(
    mail.mailId,
    { state: 'triaged', categories: ['invoice'], summary: 'חשבונית לאוקטובר', jobId: job.jobId },
    { businessId: BUSINESS },
  );
  return job.jobId;
}

async function seedCurationRows(n: number, reason: string): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await appendAudit(
      {
        actor: 'orchestrator',
        kind: 'curation',
        charterVersion: 'n/a',
        provenance: 'boss',
        inputHash: `${i}`.padStart(64, '0'),
        artifacts: [],
        costMinor: null,
        tokens: null,
        reason,
      },
      { businessId: BUSINESS },
    );
  }
}


async function pollOne(category: MailTriage['categories'], fromAddress: string, curator: () => Promise<CurationResult>) {
  await installMailboxCharter(BUSINESS);
  await setCursor({ provider: 'google', cursor: 'C-0' }, { businessId: BUSINESS });
  const mail = incomingMail({ providerMessageId: 'PM-X', fromAddress });
  const client = {
    initialCursor: async () => 'C-NEW',
    listSince: async () => ({ messages: [mail], nextCursor: 'C-1' }),
    fetchAttachment: async () => Buffer.alloc(0),
    ensureLabels: async (_t: string, names: string[]) => Object.fromEntries(names.map((n) => [n, `L-${n}`])),
    addLabel: async () => true as const,
    sendReply: async () => ({ externalId: 'S' }),
  } as unknown as MailboxClient;
  const triaged: MailTriage = {
    categories: category,
    summary: 'סיכום',
    isPerson: false,
    invoice: category.includes('invoice') ? { number: '1', amountText: '10', dateText: null } : null,
    replyGist: null,
  };
  const triage = (async () => ({ status: 'read', triage: triaged })) as unknown as Triage;
  return pollMailbox({
    businessId: BUSINESS,
    runtime: mailboxRuntime(client),
    client,
    triage,
    drafter: stubDrafter(),
    curator,
  });
}

describe('curation from mail', () => {
  it('mail job brief touches exactly the sender address', async () => {
    const jobId = await seedMailJob();
    const brief = await buildCurationBrief(jobId, { businessId: BUSINESS });
    expect(brief).not.toBeNull();
    expect(brief?.touched).toEqual({ recipients: [SENDER], entityIds: [] });
    expect(brief?.text).toContain('חשבונית לאוקטובר');
  });

  it('candidate about another address is rejected by siftCandidates', async () => {
    const jobId = await seedMailJob();
    const brief = await buildCurationBrief(jobId, { businessId: BUSINESS });
    const result: CurationResult = {
      candidates: [
        { kind: 'chunk', subjectKey: SENDER, body: { note: 'ok' }, sourceRef: 'mail' },
        { kind: 'chunk', subjectKey: 'someone-else@other.example', body: { note: 'no' }, sourceRef: 'mail' },
      ],
    };
    const sifted = siftCandidates(result, brief!.touched);
    expect(sifted.accepted.map((c) => c.subjectKey)).toEqual([SENDER]);
    expect(sifted.rejected).toHaveLength(1);

    // And end to end: only the sender's row is written, labelled with the job's provenance.
    const outcome = await curateJob(jobId, { businessId: BUSINESS, scope: 'mail', curator: async () => result });
    expect(outcome).toMatchObject({ ran: true, written: 1, rejected: 1, failed: false });
    const memories = await recallMemories({ subjectKey: SENDER }, { businessId: BUSINESS });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.provenance).toBe('unknown_external');
  });

  it('mail curation cap is counted apart from document curation', async () => {
    const jobId = await seedMailJob();
    await seedCurationRows(20, 'אצירה · 0 עובדות נשמרו · 0 נדחו');
    expect(await curationRunsToday({ businessId: BUSINESS })).toBe(20);
    expect(await curationRunsToday({ businessId: BUSINESS, scope: 'mail' })).toBe(0);

    let calls = 0;
    const curator = async (): Promise<CurationResult> => {
      calls += 1;
      return { candidates: [] };
    };
    const outcome = await curateJob(jobId, { businessId: BUSINESS, scope: 'mail', curator });
    expect(outcome.ran).toBe(true);
    expect(calls).toBe(1);

    // The mail run counts on the mail side only, prefixed in the audit row.
    expect(await curationRunsToday({ businessId: BUSINESS, scope: 'mail' })).toBe(1);
    expect(await curationRunsToday({ businessId: BUSINESS })).toBe(20);
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'curation' AND reason LIKE 'mail:%'`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);

    // And the mail ceiling does bind on its own count.
    const capped = await curateJob(jobId, { businessId: BUSINESS, scope: 'mail', curator, runsPerDay: 1 });
    expect(capped.skipped).toBe('over_cap');
    expect(calls).toBe(1);
  });

  it('other-category mail is never curated', async () => {
    let curatorCalls = 0;
    const result = await pollOne(['other'], 'news@vendor.example', async () => {
      curatorCalls += 1;
      return { candidates: [] };
    });
    expect(result?.triaged).toBe(1);
    expect(curatorCalls).toBe(0);
    expect(await curationRunsToday({ businessId: BUSINESS, scope: 'mail' })).toBe(0);
  });

  it('an invoice mail is curated through the poll pass, a failing curator does not fail the mail', async () => {
    let calls = 0;
    const result = await pollOne(['invoice'], SENDER, async () => {
      calls += 1;
      throw new Error('model down');
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ triaged: 1, failed: 0 });
    const { rows } = await getPool().query<{ state: string; error: string | null }>(
      'SELECT state, error FROM mail_messages WHERE business_id = $1',
      [BUSINESS],
    );
    expect(rows).toEqual([{ state: 'triaged', error: 'curation_failed' }]);
    expect(await curationRunsToday({ businessId: BUSINESS, scope: 'mail' })).toBe(1);
  });
});
