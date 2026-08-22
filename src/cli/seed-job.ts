/**
 * `job:seed` — the starting pistol for the live thread.
 *
 * Creates one job, walks it to `execute`, binds it to a hand-written
 * one-step plan (`mail.send`), and raises the autonomy ramp for
 * `email.initiate` to `approve_required` — nothing else.
 *
 * A hand-written plan, not a planned one: the planner is a model behind an
 * API key this machine does not have, and the point of the thread is to
 * prove the execution path, not the planning path. When the planner is
 * wired this command keeps its value as an operational tool — "run exactly
 * this, now".
 *
 * The ramp is raised to `approve_required` and not `auto`: `auto` would skip
 * the approval, which is half the thread this command exists to demonstrate.
 * And it is raised for `email.initiate` only, not business-wide — a seed
 * command that raised every action class would be a far larger grant than it
 * appears to make.
 */
import { config } from '../config.js';
import { activeCharterVersion } from '../charter/store.js';
import { closePool } from '../db/pool.js';
import { Plan } from '../domain/plan.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { bindPlanToJob, planHashOf } from '../orchestrator/plan-store.js';
import { setRampLevel } from '../orchestrator/ramp.js';

export interface SeedMailJobOptions {
  to: string;
  subject: string;
  body: string;
  businessId?: string;
}

export async function seedMailJob(
  options: SeedMailJobOptions,
): Promise<{ jobId: string; planHash: string }> {
  const businessId = options.businessId ?? config.businessId;

  // `activeCharterVersion` is positional, not an options object, and returns
  // `string | null` rather than throwing — see src/charter/store.ts.
  const charterVersion = await activeCharterVersion(businessId);
  if (charterVersion === null) {
    throw new Error(
      `seedMailJob: no active charter for business ${businessId} — install one first`,
    );
  }

  const plan = Plan.parse({
    goal: `send one mail to ${options.to}`,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'send the seeded message',
        toolName: 'mail.send',
        input: { to: options.to, subject: options.subject, body: options.body },
        expectedActionClass: 'email.initiate',
      },
    ],
  });

  const job = await createJob({
    charterVersion,
    // The owner ran this command; nothing untrusted contributed to it.
    provenance: 'boss',
    businessId,
    title: `live thread: mail to ${options.to}`,
  });

  // `intake → understand → plan → execute`. There is no `intake → plan`
  // edge (LEGAL_TRANSITIONS, src/domain/job.ts) — every phase in between must
  // be walked. `actor` is a `JobActor` ('orchestrator' | 'human' | 'system' |
  // AgentId); the person running this command by hand is 'human'.
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, {
      to,
      actor: 'human',
      reason: 'seeded by job:seed',
      businessId,
    });
  }

  await bindPlanToJob(job.jobId, plan, { businessId });
  await setRampLevel('email.initiate', 'approve_required', { businessId });

  return { jobId: job.jobId, planHash: planHashOf(plan) };
}

/**
 * The process wrapper. Kept separate from `seedMailJob` so the test drives
 * the logic without spawning a process or reading argv.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };

  const to = read('--to');
  const subject = read('--subject') ?? 'הודעת בדיקה מהעוזרת';
  const body = read('--body') ?? 'זו הודעת בדיקה שנשלחה על ידי החוט החי.';

  if (to === undefined) {
    console.error('usage: npm run job:seed -- --to <address> [--subject <s>] [--body <b>]');
    process.exitCode = 1;
    return;
  }

  const { jobId, planHash } = await seedMailJob({ to, subject, body });

  console.log(`job ${jobId} created, in phase execute`);
  console.log(`plan ${planHash} stored — one step, mail.send to ${to}`);
  console.log(`ramp: email.initiate raised to approve_required for ${config.businessId}`);
  console.log('every other action class remains at draft_only');
  console.log('start `npm run scheduler` to run it');
}

// Only run when executed directly — never on import from the test. Same
// pattern as src/cli/create-owner.ts.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  await main();
  await closePool();
}
