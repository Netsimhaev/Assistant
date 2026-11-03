import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { activeCharterVersion, installCharter } from '../charter/store.js';
import { createJob } from './jobs.js';
import { saveInstruction } from '../governance/instructions.js';
import type { InstructionTextOrigin } from '../governance/typed-recipients.js';
import { createLedgerItem, loadLedgerItem } from '../ledger/store.js';
import { addCriticalRule } from '../ledger/settings.js';
import { localToInstant } from '../util/local-time.js';
import type { TrustLevel } from '../domain/trust.js';
import { ingestsExternalContent } from '../policy/classify.js';
import { AGENT_ALLOWLISTS } from '../charter/capabilities.js';
import { assertLedgerWriter, renderLocalToolContracts, runLocalTool } from './local-tools.js';
import { StepChannelError } from './step-error.js';

const BUSINESS = 'test-business';
const OTHER = 'other-business';

async function charterFor(businessId: string): Promise<string> {
  const active = await activeCharterVersion(businessId);
  if (active !== null) return active;
  const bundle = await installCharter(buildCharter({ version: `ledger-${businessId}` }), { businessId });
  return bundle.charterVersion;
}

async function aJob(
  options: { provenance?: TrustLevel; instruction?: string | null; origin?: InstructionTextOrigin; businessId?: string } = {},
): Promise<string> {
  const businessId = options.businessId ?? BUSINESS;
  const charterVersion = await charterFor(businessId);
  const job = await createJob({
    charterVersion,
    provenance: options.provenance ?? 'boss',
    businessId,
    title: 'ledger',
  });
  const text = options.instruction === undefined ? 'תזכירי לי לגבות מדנה' : options.instruction;
  if (text !== null) {
    await saveInstruction({ jobId: job.jobId, text, textOrigin: options.origin ?? 'typed' }, { businessId });
  }
  return job.jobId;
}

async function itemCount(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>('SELECT count(*)::text AS n FROM ledger_items');
  return Number(rows[0]?.n);
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof StepChannelError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal, got a result');
}

describe('ledger.add / ledger.update', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('adds an item from a boss instruction job', async () => {
    const jobId = await aJob();
    const out = await runLocalTool(
      'ledger.add',
      { family: 'money_in', description: 'לגבות מדנה על הפרויקט', dueDate: '2026-12-01', amountMinor: 120000 },
      { jobId, businessId: BUSINESS },
    );
    expect(out.performed).toBe(true);
    expect(out['family']).toBe('money_in');

    const item = await loadLedgerItem(String(out['itemId']), { businessId: BUSINESS });
    expect(item?.family).toBe('money_in');
    expect(item?.originJobId).toBe(jobId);
    // Date-only due: the owner's daily hour (8:00 default) in the charter zone.
    expect(item?.dueAt?.toISOString()).toBe(localToInstant('2026-12-01', '08:00', 'Asia/Jerusalem').toISOString());
    expect(item?.dueIsDateOnly).toBe(true);
    expect(item?.importance).toBe('normal');
  });

  it('keeps an explicit time and marks the due as timed', async () => {
    const jobId = await aJob();
    const out = await runLocalTool(
      'ledger.add',
      { family: 'meetings', description: 'פגישה עם דנה', dueDate: '2026-12-01', dueTime: '14:30' },
      { jobId, businessId: BUSINESS },
    );
    const item = await loadLedgerItem(String(out['itemId']), { businessId: BUSINESS });
    expect(item?.dueAt?.toISOString()).toBe(localToInstant('2026-12-01', '14:30', 'Asia/Jerusalem').toISOString());
    expect(item?.dueIsDateOnly).toBe(false);
  });

  it('refuses a boss job with no instruction row', async () => {
    const jobId = await aJob({ instruction: null });
    const code = await refusalCode(() =>
      runLocalTool('ledger.add', { family: 'money_in', description: 'x' }, { jobId, businessId: BUSINESS }),
    );
    expect(code).toBe('ledger_not_boss_instruction');
    expect(await itemCount()).toBe(0);
  });

  it('refuses an unknown_external job, even one carrying an instruction row', async () => {
    const jobId = await aJob({ provenance: 'unknown_external' });
    const code = await refusalCode(() =>
      runLocalTool('ledger.add', { family: 'money_in', description: 'x' }, { jobId, businessId: BUSINESS }),
    );
    expect(code).toBe('ledger_not_boss_instruction');
    expect(await itemCount()).toBe(0);
  });

  it('refuses a job of another business even when the job id exists there', async () => {
    const jobId = await aJob({ businessId: OTHER });
    await charterFor(BUSINESS);
    const code = await refusalCode(() =>
      runLocalTool('ledger.add', { family: 'money_in', description: 'x' }, { jobId, businessId: BUSINESS }),
    );
    expect(code).toBe('ledger_not_boss_instruction');
    expect(await itemCount()).toBe(0);
  });

  it('assertLedgerWriter passes a boss job with an instruction row', async () => {
    const jobId = await aJob();
    await expect(assertLedgerWriter(jobId, BUSINESS, getPool())).resolves.toBeUndefined();
  });

  it('email typed in a typed instruction is verified', async () => {
    const jobId = await aJob({ instruction: 'תזכירי לי לגבות מדנה dana@acme.example עד ראשון' });
    const out = await runLocalTool(
      'ledger.add',
      { family: 'money_in', description: 'לגבות', counterpartyName: 'דנה', counterpartyEmail: 'Dana@Acme.example' },
      { jobId, businessId: BUSINESS },
    );
    expect(out['counterpartyEmailVerified']).toBe(true);
    const item = await loadLedgerItem(String(out['itemId']), { businessId: BUSINESS });
    expect(item?.counterpartyEmailVerified).toBe(true);
  });

  it('email from a transcribed instruction is not verified', async () => {
    const jobId = await aJob({
      instruction: 'תזכירי לי לגבות מדנה dana@acme.example עד ראשון',
      origin: 'transcribed',
    });
    const out = await runLocalTool(
      'ledger.add',
      { family: 'money_in', description: 'לגבות', counterpartyEmail: 'dana@acme.example' },
      { jobId, businessId: BUSINESS },
    );
    expect(out.performed).toBe(true);
    expect(out['counterpartyEmailVerified']).toBe(false);
    const item = await loadLedgerItem(String(out['itemId']), { businessId: BUSINESS });
    expect(item?.counterpartyEmail).toBe('dana@acme.example');
    expect(item?.counterpartyEmailVerified).toBe(false);
  });

  it('email absent from the instruction text is not verified', async () => {
    const jobId = await aJob({ instruction: 'תזכירי לי לגבות מדנה עד ראשון' });
    const out = await runLocalTool(
      'ledger.add',
      { family: 'money_in', description: 'לגבות', counterpartyEmail: 'dana@acme.example' },
      { jobId, businessId: BUSINESS },
    );
    expect(out.performed).toBe(true);
    expect(out['counterpartyEmailVerified']).toBe(false);
  });

  it('refuses a phone number the planner put in counterpartyEmail, even one the owner typed', async () => {
    const jobId = await aJob({ instruction: 'תזכירי לי לחזור לדנה +972501234567 מחר' });
    const code = await refusalCode(() =>
      runLocalTool(
        'ledger.add',
        { family: 'awaiting_reply', description: 'לחזור לדנה', counterpartyEmail: '+972501234567' },
        { jobId, businessId: BUSINESS },
      ),
    );
    expect(code).toBe('local_tool_bad_input');
    expect(await itemCount()).toBe(0);
  });

  async function addWithDomain(jobId: string, extra: Record<string, unknown> = {}) {
    const out = await runLocalTool(
      'ledger.add',
      { family: 'awaiting_reply', description: 'תשובה מאקמי', counterpartyDomain: 'Acme.example', ...extra },
      { jobId, businessId: BUSINESS },
    );
    const item = await loadLedgerItem(String(out['itemId']), { businessId: BUSINESS });
    return { out, item };
  }

  it('keeps a counterparty domain the owner typed', async () => {
    const jobId = await aJob({ instruction: 'אני מחכה לתשובה מ-acme.example על ההצעה' });
    const { out, item } = await addWithDomain(jobId);
    expect(item?.counterpartyDomain).toBe('acme.example');
    expect(out['counterpartyDomainDropped']).toBe(false);
  });

  it('drops a counterparty domain that only appears in a transcribed instruction', async () => {
    const jobId = await aJob({ instruction: 'אני מחכה לתשובה מ-acme.example על ההצעה', origin: 'transcribed' });
    const { out, item } = await addWithDomain(jobId);
    expect(out.performed).toBe(true);
    expect(item?.counterpartyDomain).toBeNull();
    expect(out['counterpartyDomainDropped']).toBe(true);
  });

  it('drops a counterparty domain absent from the instruction text', async () => {
    const jobId = await aJob({ instruction: 'אני מחכה לתשובה מאקמי על ההצעה' });
    const { out, item } = await addWithDomain(jobId);
    expect(out.performed).toBe(true);
    expect(item?.counterpartyDomain).toBeNull();
    expect(out['counterpartyDomainDropped']).toBe(true);
  });

  it('keeps a domain equal to a verified counterparty email domain', async () => {
    const jobId = await aJob({ instruction: 'מחכה לתשובה מדנה dana@acme.example' });
    const { out, item } = await addWithDomain(jobId, { counterpartyEmail: 'dana@acme.example' });
    expect(out['counterpartyEmailVerified']).toBe(true);
    expect(item?.counterpartyDomain).toBe('acme.example');
    expect(out['counterpartyDomainDropped']).toBe(false);
  });

  it('drops a parent of a verified counterparty email domain', async () => {
    for (const domain of ['acme.example', 'co.il']) {
      const email = domain === 'co.il' ? 'dana@acme.co.il' : 'x@sub.acme.example';
      const jobId = await aJob({ instruction: `מחכה לתשובה ${email}` });
      const { out, item } = await addWithDomain(jobId, { counterpartyEmail: email, counterpartyDomain: domain });
      expect(out['counterpartyEmailVerified'], domain).toBe(true);
      expect(item?.counterpartyDomain, domain).toBeNull();
      expect(out['counterpartyDomainDropped'], domain).toBe(true);
    }
  });

  it('does not keep a domain that is only a substring of a typed token', async () => {
    const jobId = await aJob({ instruction: 'מחכה לתשובה מ-evilx.co על ההצעה' });
    const { out, item } = await addWithDomain(jobId, { counterpartyDomain: 'x.co' });
    expect(out.performed).toBe(true);
    expect(item?.counterpartyDomain).toBeNull();
    expect(out['counterpartyDomainDropped']).toBe(true);
  });

  it('projects without dueDate is refused', async () => {
    const jobId = await aJob();
    const code = await refusalCode(() =>
      runLocalTool('ledger.add', { family: 'projects', description: 'מצגת למשקיעים' }, { jobId, businessId: BUSINESS }),
    );
    expect(code).toBe('local_tool_bad_input');
    expect(await itemCount()).toBe(0);

    // And the same payload with a deadline goes through: the refusal was the deadline.
    const out = await runLocalTool(
      'ledger.add',
      { family: 'projects', description: 'מצגת למשקיעים', dueDate: '2026-12-20', stages: ['טיוטה', 'עיצוב'] },
      { jobId, businessId: BUSINESS },
    );
    const item = await loadLedgerItem(String(out['itemId']), { businessId: BUSINESS });
    expect(item?.stages).toEqual([
      { title: 'טיוטה', done: false },
      { title: 'עיצוב', done: false },
    ]);
  });

  it('refuses a date that does not exist, before anything is written', async () => {
    const jobId = await aJob();
    const code = await refusalCode(() =>
      runLocalTool(
        'ledger.add',
        { family: 'money_in', description: 'x', dueDate: '2026-02-30' },
        { jobId, businessId: BUSINESS },
      ),
    );
    expect(code).toBe('local_tool_bad_input');
    expect(await itemCount()).toBe(0);
  });

  it('refuses a malformed counterparty domain', async () => {
    const jobId = await aJob();
    const code = await refusalCode(() =>
      runLocalTool(
        'ledger.add',
        { family: 'awaiting_reply', description: 'x', counterpartyDomain: '*.acme.example' },
        { jobId, businessId: BUSINESS },
      ),
    );
    expect(code).toBe('local_tool_bad_input');
    expect(await itemCount()).toBe(0);
  });

  it('allows money_in with an amount and no reference', async () => {
    const jobId = await aJob();
    const out = await runLocalTool(
      'ledger.add',
      { family: 'money_in', description: 'x', amountMinor: 5000 },
      { jobId, businessId: BUSINESS },
    );
    expect(out.performed).toBe(true);
  });

  it('critical rule marks importance', async () => {
    const jobId = await aJob();
    await addCriticalRule({ kind: 'family', family: 'money_in' }, { businessId: BUSINESS, by: 'owner' });
    const ruled = await runLocalTool(
      'ledger.add',
      { family: 'money_in', description: 'x' },
      { jobId, businessId: BUSINESS },
    );
    expect(ruled['importance']).toBe('critical');
    const ruledItem = await loadLedgerItem(String(ruled['itemId']), { businessId: BUSINESS });
    expect(ruledItem?.importanceManual).toBe(false);

    const other = await runLocalTool(
      'ledger.add',
      { family: 'meetings', description: 'y' },
      { jobId, businessId: BUSINESS },
    );
    expect(other['importance']).toBe('normal');

    const manual = await runLocalTool(
      'ledger.add',
      { family: 'meetings', description: 'z', critical: true },
      { jobId, businessId: BUSINESS },
    );
    expect(manual['importance']).toBe('critical');
    const manualItem = await loadLedgerItem(String(manual['itemId']), { businessId: BUSINESS });
    expect(manualItem?.importanceManual).toBe(true);
  });

  it('updates an item: stages done, new due date, note', async () => {
    const jobId = await aJob();
    const added = await runLocalTool(
      'ledger.add',
      { family: 'projects', description: 'מצגת', dueDate: '2026-12-20', stages: ['טיוטה', 'עיצוב'] },
      { jobId, businessId: BUSINESS },
    );
    const itemId = String(added['itemId']);
    const out = await runLocalTool(
      'ledger.update',
      { itemId, stagesDone: [1], dueDate: '2026-12-27', note: 'הטיוטה מוכנה' },
      { jobId, businessId: BUSINESS },
    );
    expect(out.performed).toBe(true);
    const item = await loadLedgerItem(itemId, { businessId: BUSINESS });
    expect(item?.stages).toEqual([
      { title: 'טיוטה', done: true },
      { title: 'עיצוב', done: false },
    ]);
    expect(item?.dueAt?.toISOString()).toBe(localToInstant('2026-12-27', '08:00', 'Asia/Jerusalem').toISOString());
  });

  it('update refuses a stage number out of range', async () => {
    const jobId = await aJob();
    const added = await runLocalTool(
      'ledger.add',
      { family: 'projects', description: 'מצגת', dueDate: '2026-12-20', stages: ['טיוטה'] },
      { jobId, businessId: BUSINESS },
    );
    const code = await refusalCode(() =>
      runLocalTool(
        'ledger.update',
        { itemId: String(added['itemId']), stagesDone: [2] },
        { jobId, businessId: BUSINESS },
      ),
    );
    expect(code).toBe('local_tool_bad_input');
  });

  it('update refuses an item of another business', async () => {
    const otherJob = await aJob({ businessId: OTHER });
    const foreign = await createLedgerItem(
      {
        family: 'money_in',
        description: 'של עסק אחר',
        dueAt: null,
        dueIsDateOnly: false,
        importance: 'normal',
        importanceManual: false,
        counterpartyName: null,
        counterpartyEmail: null,
        counterpartyEmailVerified: false,
        counterpartyDomain: null,
        reference: null,
        amountMinor: null,
        stages: [],
        proposedStages: null,
        originJobId: otherJob,
      },
      { businessId: OTHER, by: 'test' },
    );
    const jobId = await aJob();
    const code = await refusalCode(() =>
      runLocalTool(
        'ledger.update',
        { itemId: foreign.itemId, description: 'נחטף' },
        { jobId, businessId: BUSINESS },
      ),
    );
    expect(code).toBe('ledger_item_not_found');
    const untouched = await loadLedgerItem(foreign.itemId, { businessId: OTHER });
    expect(untouched?.description).toBe('של עסק אחר');
  });

  it('update refuses a job that is not a boss instruction', async () => {
    const jobId = await aJob({ instruction: null });
    const code = await refusalCode(() =>
      runLocalTool('ledger.update', { itemId: 'LI-nothing', description: 'x' }, { jobId, businessId: BUSINESS }),
    );
    expect(code).toBe('ledger_not_boss_instruction');
  });

  // The read-only/classified/known invariant lives in positive-controls.test.ts.
  it('gives both tools to ops.tasks and does not count them as outside content', () => {
    for (const tool of ['ledger.add', 'ledger.update']) {
      expect(ingestsExternalContent(tool), tool).toBe(false);
      expect(AGENT_ALLOWLISTS['ops.tasks'].includes(tool), tool).toBe(true);
    }
  });

  it('tells the planner when to use the ledger and where the old task tools went', () => {
    const rendered = renderLocalToolContracts();
    expect(rendered).toContain('`ledger.add`');
    expect(rendered).toContain('`ledger.update`');
    expect(rendered).toContain('רק כשיש מועד או התחייבות — אחרת זה זיכרון (`memory.*`)');
    for (const old of ['tasks.read', 'tasks.update_state', 'followup.schedule']) {
      expect(rendered).toContain(`\`${old}\``);
    }
    expect(rendered).toContain('לא ממומש — לפנקס השתמשי ב-ledger.add / ledger.update');
  });
});
