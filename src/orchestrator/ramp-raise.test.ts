/**
 * The ramp raise, proved against the charter a real install actually has.
 *
 * `run-due.test.ts` already proves the mechanism — but it gets there by
 * installing the fixture with `autonomyBase: { 'email.initiate': 'auto' }`,
 * a ceiling no signed charter in this project carries. That override is
 * honest about its purpose (it makes the ramp the only variable) and useless
 * as evidence for the question the owner actually asks: *if I raise a ramp on
 * my install, does anything happen?*
 *
 * Here the charter is `buildCharter` unmodified — the same call
 * `scripts/seed-charter.ts` makes, and therefore the same ceilings the dev
 * install carries today. Under it, exactly one action class can move from
 * "the owner is asked and nothing leaves" to "a real message goes out" on the
 * strength of a ramp row alone:
 *
 *   - `email.reply` — charter base `auto_notify`, boss provenance ceiling
 *     `auto`, not in `NEVER_FULLY_AUTONOMOUS`, and `mail.send` is the one
 *     tool with an adapter that does something.
 *
 * Every other candidate fails for a reason this pair would hide rather than
 * show: `email.initiate` is capped at `approve_required` by the charter, so
 * `needsApproval`'s second term fires however high the ramp goes;
 * `calendar.create` and `whatsapp.reply` clear the ceilings but have no
 * adapter; `crm.write`, `artifact.write` and `memory.write_longterm` are
 * local, and a local step returns `null` because no local tool executor
 * exists yet.
 *
 * The two runs below differ in one row of `autonomy_ramp` and nothing else.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { grantAuthorization } from '../governance/authorization.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection } from '../domain/connection.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, markContentIngested, transition } from './jobs.js';
import { bindPlanToJob } from './plan-store.js';
import { setRampLevel } from './ramp.js';
import { runDueJobs } from './run-due.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'test-business';
const PREFIX = 'TEST_CRED_';
// Fixed clock for the same reason run-due.test.ts fixes one: an evening run of
// this suite would fall inside the charter's quiet hours, and the gate would
// defer the step for a reason that has nothing to do with the ramp.
const NOON = new Date('2026-08-18T09:00:00.000Z');

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

/**
 * One reply, to a counterparty the charter already knows.
 *
 * `inReplyTo` is what makes this `email.reply` rather than `email.initiate`:
 * `refineActionClass` (`policy/classify.ts`) reads a non-empty thread ref and
 * nothing else. Without it the class would be `email.initiate`, whose charter
 * base is `approve_required` — and the pair below would then prove only that
 * a charter ceiling outranks a ramp, which is not what it claims to prove.
 *
 * `counterpartyId: 'c_812'` is the known counterparty `buildCharter` always
 * carries. Without it `scoreVisibility` scores `one_unknown` and `bandFor`
 * returns `sensitive`, so `needsApproval`'s third term queues an approval no
 * matter how high the ramp is raised — again hiding the thing under test.
 */
const REPLY_PLAN: Plan = Plan.parse({
  goal: 'reply to a known customer',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'reply to the customer',
      toolName: 'mail.send',
      input: {
        to: 'dana@example.com',
        counterpartyId: 'c_812',
        inReplyTo: 'thread-9',
        subject: 'תשובה',
        body: 'גוף',
      },
      expectedActionClass: 'email.reply',
    },
  ],
});

/**
 * The same reply, to an address nothing vouches for.
 *
 * `scoreVisibility` rates an unresolved recipient `one_unknown` (55, against
 * 25 for a known one), and `isUnvettedFirstContact` escalates the band to
 * `sensitive` on that alone, so the owner is asked.
 *
 * It did not always. `FIRST_CONTACT_EXEMPT` held `boss`, which waived the
 * escalation for a chain whose provenance is `boss` and which had read no
 * external content — exactly what `runPlan` computes for this job — and this
 * plan was the one that showed what that bought once a raised ramp made the
 * waiver reachable: a real message, to an address nobody had confirmed, with
 * no card. The set was emptied the same day. The plan is kept because it is
 * still the sharpest statement of the boundary: nothing vouches for this
 * recipient, and nothing in the owner's own provenance stands in for that.
 */
const STRANGER_PLAN: Plan = Plan.parse({
  goal: 'reply to someone nothing vouches for',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'reply to the sender',
      toolName: 'mail.send',
      input: {
        to: 'stranger@nowhere.example',
        inReplyTo: 'thread-9',
        subject: 'תשובה',
        body: 'גוף',
      },
      expectedActionClass: 'email.reply',
    },
  ],
});

function runtimeWith(sent: MailMessage[]): Runtime {
  return {
    registry: new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        transport: {
          async send(message) {
            sent.push(message);
            return { messageId: 'MSG-REPLY-1' };
          },
        },
      }),
    ]),
    credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
    warnings: [],
  };
}

/**
 * Everything a real install has: the unmodified charter, a live mail binding,
 * a boss-provenance job in `execute`, and the reply plan bound to it.
 *
 * Returns the compiled bundle as well as the job id so a test can assert on
 * the ceilings this pair depends on instead of assuming them.
 */
async function seedReplyJob(plan: Plan = REPLY_PLAN): Promise<{
  jobId: string;
  bundle: Awaited<ReturnType<typeof installCharter>>;
}> {
  const bundle = await installCharter(
    // No `autonomyBase` override. That absence is the entire point of this
    // file — see the module docblock.
    //
    // `knownCounterpartyEmailDomain` is not a convenience: for a class that
    // addresses a `person`, `scoreVisibility` resolves the recipient by
    // ADDRESS and refuses to let `counterpartyId` stand in for one, so a
    // reply to `dana@example.com` is `one_unknown` unless the charter knows
    // the domain. Until 10/09 that did not show, because the first-contact
    // exemption made a boss chain `routine` regardless; emptying the exempt
    // set is what revealed that the plan's `counterpartyId: 'c_812'` was
    // never what carried it. The honest production shape of "a counterparty
    // the charter knows" is therefore a charter that knows the domain.
    buildCharter({
      version: '2026-08-15.ramp-raise',
      connections: [MAIL_CONNECTION],
      knownCounterpartyEmailDomain: 'example.com',
    }),
    { businessId: BUSINESS },
  );

  // The owner's dial (Task 2) clamps `loadRampLevel` around a window that
  // defaults to `off` — everything pinned at `draft_only` — for a business
  // with no row in `autonomy_mode`. This file's whole premise is "does a
  // raised ramp row change anything", so it needs the dial open to its widest
  // setting first; the clamp itself is `ramp-floor.test.ts`'s job, not this
  // file's.
  await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });

  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'ramp-raise',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }

  await upsertBinding(
    {
      system: 'office-mail',
      status: 'live',
      endpoint: null,
      credentialRef: 'OFFICE_MAIL',
      lastOkAt: null,
      lastError: null,
    },
    { businessId: BUSINESS, by: 'test' },
  );
  await bindPlanToJob(job.jobId, plan, { businessId: BUSINESS });

  return { jobId: job.jobId, bundle };
}

describe('raising one action class off approve_required, under the charter a real install has', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * The premise, asserted rather than assumed.
   *
   * The pair below is only evidence while the unmodified fixture really does
   * leave `email.reply` above `approve_required` and boss provenance above it
   * too. Someone tightening either value in `test/fixtures.ts` would turn
   * both tests below into a pair that passes for the wrong reason — the raise
   * would stop being felt, and "no mail sent" would still be the expected
   * result in the first test while the second one simply broke. This names
   * the two ceilings so that edit fails here, with a message that says what
   * changed.
   */
  it('leaves email.reply above approve_required in the charter and for boss provenance', async () => {
    const { bundle } = await seedReplyJob();

    expect(bundle.autonomyBase['email.reply']).toBe('auto_notify');
    expect(bundle.provenanceCeiling.boss).toBe('auto');
    // And the class the owner would reach for first is genuinely capped, so
    // the CLI's "the raise is not felt here" output is not theoretical.
    expect(bundle.autonomyBase['email.initiate']).toBe('approve_required');
  });

  it('asks the owner and sends nothing while the ramp sits at approve_required', async () => {
    const { jobId } = await seedReplyJob();
    // The value this business's row actually holds today.
    await setRampLevel('email.reply', 'approve_required', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran).toEqual([{ jobId, status: 'halted', detail: 'awaiting_approval' }]);
    expect(sent).toEqual([]);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('await_approval');
  });

  it('actually sends once the ramp is raised to auto_notify, with nothing else changed', async () => {
    const { jobId } = await seedReplyJob();
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran).toEqual([{ jobId, status: 'done', detail: null }]);
    // The assertion that makes this a behaviour test and not a status test:
    // a real message reached the transport, addressed to the recipient the
    // plan named.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toContain('dana@example.com');
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('verify');
  });

  /**
   * What the raise opened, stated as behaviour rather than left to be
   * discovered in production.
   *
   * Nothing vouches for this recipient, so `scoreVisibility` returns
   * `one_unknown` and the band is `sensitive`. That is the whole of why the
   * owner is asked: stage 8 passes at `auto_notify`, and `needsApproval`'s
   * third term is what stops it.
   *
   * Until 10/09 it did not stop it. `runPlan` computes
   * `provenanceChainDerived = true` for a `boss` job whose plan reads no
   * external content, and `boss` was then the sole member of
   * `FIRST_CONTACT_EXEMPT`, so the escalation was waived. While the ramp held
   * the class at `draft_only` that was harmless — stage 8 denied long before
   * the band was consulted — and raising the ramp removed the only thing
   * standing in front of it, which is precisely the coupling
   * `docs/05-approvals.md` flagged as a knowingly accepted risk.
   *
   * Measured first, then closed. On the day the ramp was raised this sent —
   * `status: done`, a real message to an address nobody had confirmed, no
   * card. `FIRST_CONTACT_EXEMPT` was emptied the same day for exactly that
   * reason, so the escalation now fires for a `boss` chain like every other,
   * and the owner is asked.
   *
   * What the owner actually wanted from the exemption is not lost: a
   * recipient they typed into an instruction is covered by the standing
   * authorisation the instruction door writes, which cancels this same
   * risk-band term. This job has no such grant — nothing named this address —
   * which is the whole distinction.
   */
  it('asks before replying to an address nothing vouches for, even with the ramp raised', async () => {
    const { jobId } = await seedReplyJob(STRANGER_PLAN);
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran).toEqual([{ jobId, status: 'halted', detail: 'awaiting_approval' }]);
    expect(sent).toEqual([]);
  });

  /**
   * The other half of the same decision: what the owner asked for still works.
   *
   * Emptying the exempt set was only defensible because the case the owner
   * actually wanted — "a recipient I typed counts as known" — is carried by a
   * different mechanism entirely. The instruction door writes a standing
   * authorisation naming exactly the recipients the instruction contained,
   * and that cancels the same risk-band term the exemption used to cancel,
   * without extending to a recipient nobody named.
   *
   * Same plan, same unresolved address, same raised ramp as the test above.
   * The only difference is a grant naming that address — and it sends.
   */
  it('sends to that same address when the owner’s instruction named it', async () => {
    const { jobId } = await seedReplyJob(STRANGER_PLAN);
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    await grantAuthorization(
      { jobId, actionClass: 'email.reply', recipients: ['stranger@nowhere.example'] },
      { businessId: BUSINESS },
    );

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran).toEqual([{ jobId, status: 'done', detail: null }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toContain('stranger@nowhere.example');
  });

  /**
   * A tripwire, and honest about being one: today it proves nothing.
   *
   * This asserted, until the exempt set was emptied, that flipping
   * `content_ingested` was what put the card back — `runPlan` grants
   * `provenanceChainDerived` only to a job that has never ingested external
   * content, and a job that has read a document is exactly the shape a
   * prompt-injection attempt takes: the document names a recipient, the plan
   * replies to it, and the owner's own provenance carries it out.
   *
   * With the set empty that conjunct can no longer decide anything, so this
   * test now asserts the same outcome as the one two above it and would pass
   * with `markContentIngested` and the whole `!job.contentIngested` term
   * deleted. By this repository's own rule that is not a test, and saying so
   * here is the only honest way to keep it. It is kept because it costs one
   * database write and becomes load-bearing again the moment anyone puts a
   * level back into `FIRST_CONTACT_EXEMPT` — which is the edit most likely to
   * reopen this exact path. `plan-provenance.test.ts` carries the same
   * tripwire against `runPlan` directly, with the same caveat.
   */
  it('goes back to asking as soon as the job has read external content', async () => {
    const { jobId } = await seedReplyJob(STRANGER_PLAN);
    await setRampLevel('email.reply', 'auto_notify', { businessId: BUSINESS });
    expect(await markContentIngested(jobId, { businessId: BUSINESS })).toBe(1);

    const sent: MailMessage[] = [];
    const result = await runDueJobs({ businessId: BUSINESS, runtime: runtimeWith(sent), now: NOON });

    expect(result.ran).toEqual([{ jobId, status: 'halted', detail: 'awaiting_approval' }]);
    expect(sent).toEqual([]);
  });
});
