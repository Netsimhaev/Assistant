/**
 * Standing authorisation: the owner's instruction, on record, meant to stand
 * in for an approval question (spec §6) — but doing so today requires two
 * conditions neither of which is met in any production install: the action
 * class's autonomy ramp above `approve_required`, and the signed charter
 * granting that class a ceiling above `approve_required` too. Until both
 * hold, `needsApproval` in `policy/engine.ts` is refused earlier, at the ramp
 * floor, and this module's grant changes nothing the owner experiences.
 *
 * **It lives under `governance/` and not `orchestrator/` for a layering
 * reason, not a taxonomic one.** `policy/engine.ts` imports this module and
 * this module imports `policy/facts.js`; while it sat in `orchestrator/`,
 * that held only because it happened to import nothing from its own
 * directory, and the day it needed `jobs.js` or `channels.js` — which
 * `orchestrator/execute.ts` already reaches through `policy/engine.js` — the
 * loop would have closed. `src/orchestrator/step-error.ts` exists as its own
 * module because this project already paid that price once. Beside
 * `approvals.ts`, `consume.ts` and `killswitch.ts` it is also simply in the
 * right company: all three are imported by the gate, and standing
 * authorisation *is* an approval substitute.
 *
 * **Where the instruction is read from is the entire control.** It comes from
 * a row written when the owner opened the job, and from the job's stamped
 * provenance column — never from content. `grantAuthorization` refuses a job
 * whose provenance is not `boss`, which is what stops a document that claims
 * the owner asked for something from buying the authority to do it. Provenance
 * is written before any model sees content, and no prompt can change a column.
 *
 * Recipient matching reuses `readEmails` from `src/policy/facts.ts` rather
 * than reading the payload again here. That function's docblock records why it
 * is shared: the gate must screen the same addresses the mail adapter sends
 * to, and a second reader is exactly how those two drift apart. Display-name
 * forms like `Dana Cohen <dana@x.com>` unwrap there, so they compare equal
 * here without this file knowing that they need to.
 */

import { DatabaseError } from 'pg';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { ActionClass } from '../domain/action.js';
import { readEmails, readPhones } from '../policy/facts.js';

/** Postgres' unique/primary-key-violation error code (see `src/cli/create-owner.ts`). */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === UNIQUE_VIOLATION;
}

export interface StandingAuthorization {
  jobId: string;
  businessId: string;
  actionClass: ActionClass;
  /** Lower-cased addresses the owner named. */
  recipients: string[];
  /** Only one grantor is expressible; the field exists so audit reads plainly. */
  grantedBy: 'boss';
}

/**
 * Thrown when a job already carries a standing authorisation.
 *
 * One authorisation per job, by the migration's own design — see the column
 * comment on `job_authorizations` (migration 015). An `INSERT ... ON CONFLICT
 * DO UPDATE` here would let a second call silently widen an existing grant,
 * with nothing left recording what was originally asked for. Catching the
 * unique violation and naming it means that change trips a red, named test
 * instead of only a raw `23505` nobody who never opened the migration would
 * recognise.
 */
export class AuthorizationAlreadyGrantedError extends Error {
  constructor(jobId: string) {
    super(
      `grantAuthorization: job ${jobId} already carries a standing authorisation; a second grant would widen it silently instead of recording what was originally asked for`,
    );
    this.name = 'AuthorizationAlreadyGrantedError';
  }
}

interface AuthorizationRow {
  business_id: string;
  job_id: string;
  action_class: string;
  recipients: string[];
}

function toAuthorization(row: AuthorizationRow): StandingAuthorization {
  return {
    jobId: row.job_id,
    businessId: row.business_id,
    actionClass: row.action_class as ActionClass,
    recipients: row.recipients,
    grantedBy: 'boss',
  };
}

/**
 * Record what the owner authorised when they opened a job.
 *
 * Refuses any job whose provenance is not `boss`. The check reads the jobs
 * table rather than trusting the caller: a caller that could assert its own
 * provenance would be a caller that could forge an instruction, and this
 * function exists to make that impossible from inside the process. The same
 * query's `AND business_id = $2` is what stops a caller from authorising a
 * job that belongs to a different business than the one it claims to act for.
 */
export async function grantAuthorization(
  input: { jobId: string; actionClass: ActionClass; recipients: string[] },
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  const businessId = options.businessId ?? config.businessId;

  const { rows } = await db.query<{ provenance: string }>(
    'SELECT provenance FROM jobs WHERE job_id = $1 AND business_id = $2',
    [input.jobId, businessId],
  );
  const provenance = rows[0]?.provenance;
  if (provenance === undefined) {
    throw new Error(`grantAuthorization: no job ${input.jobId} for business ${businessId}`);
  }
  if (provenance !== 'boss') {
    throw new Error(
      `grantAuthorization: job ${input.jobId} has provenance ${provenance}; only a boss-initiated job carries a standing instruction`,
    );
  }

  try {
    await db.query(
      `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
       VALUES ($1, $2, $3, $4)`,
      [businessId, input.jobId, input.actionClass, input.recipients.map((r) => r.toLowerCase())],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AuthorizationAlreadyGrantedError(input.jobId);
    }
    throw err;
  }
}

export async function loadAuthorization(
  jobId: string,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<StandingAuthorization | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<AuthorizationRow>(
    `SELECT business_id, job_id, action_class, recipients FROM job_authorizations
      WHERE business_id = $1 AND job_id = $2`,
    [options.businessId ?? config.businessId, jobId],
  );
  const row = rows[0];
  return row === undefined ? null : toAuthorization(row);
}

/**
 * The internal classes a "reply to Dana" instruction genuinely entails:
 * filing the correspondence, recording the contact.
 *
 * Named rather than derived from `addresseeOf(...) === 'internal'`. Eight
 * classes are internal in that sense; only `crm.write` is actually entailed
 * by anything a standing instruction says.
 *
 * `artifact.write` was on this list and came off after review: `classify.ts`
 * maps BOTH `file.write` and `code_execution` to `artifact.write`
 * (`capabilities.ts` grants `prod.docs` both tools), so leaving it in meant a
 * standing grant of `{ actionClass: 'email.reply', recipients:
 * ['dana@example.com'] }` — "reply to Dana" — covered arbitrary code
 * execution and arbitrary filesystem writes. Worse than one bad entry: the
 * entailed shortcut never consults `auth.actionClass` or `auth.recipients`,
 * so the narrowest possible grant bought the same coverage as the broadest.
 *
 * `accounting.write` came off too, for an unrelated reason: it is one of
 * `AMOUNT_REQUIRED_CLASSES` (`src/domain/action.ts`), so the gate already
 * denies it as `amount_unreadable` whenever no amount is declared, while the
 * money guard just below refuses coverage whenever one is. The two
 * conditions never overlap, so the entry could never change an outcome — a
 * dead member of a security-critical positive list, reading as a live
 * control while being unreachable.
 *
 * `memory.write_longterm` joins it for the reason the owner asked: "record
 * and remember" is a real instruction and this class is the mechanism that
 * exists for it. That reason is narrower than the class it is attached to,
 * and the gap is worth stating plainly rather than leaving it implicit.
 * `classify.ts` maps FOUR tools onto `memory.write_longterm` —
 * `memory.write_entity`, `memory.write_chunk`, `memory.upsert_preference`,
 * and `memory.retire` — and the last of those is forgetting, not
 * remembering a stated preference. `capabilities.ts` singles this class out
 * for a hand-written denylist (`LONGTERM_MEMORY_WRITES`) precisely because
 * its consequences are severe. The entailed shortcut here consults neither
 * `auth.actionClass` nor `auth.recipients` — the same gap `artifact.write`
 * was removed for above — so "reply to Dana" would also cover a
 * `memory.retire` call during a job that had ingested a hostile attachment,
 * if this check were the only thing standing between them.
 *
 * It is not. Exposure today is zero, and it is zero for a reason that has
 * nothing to do with this list being safe on its own: stage 8 of the gate
 * (`policy/engine.ts`) checks `effectiveAutonomy` before stage 10 is ever
 * reached, `RAMP_FLOOR` (`orchestrator/ramp.ts`) holds every action class at
 * `draft_only` until something raises it, and nothing in production does —
 * see CLAUDE.md's account of the first-contact exemption for the identical
 * argument made about a different control. Once a class's ramp does rise
 * past `draft_only`, this entry stops being inert, and whether that memory
 * write happened during a job that ingested untrusted content is a question
 * this function still cannot answer. Narrowing to tool-level entailment
 * would answer it properly; that is a larger change than this task carries,
 * and this paragraph exists so the next reader does not have to rediscover
 * the gap before deciding whether to make it.
 */
const ENTAILED_INTERNAL_CLASSES: readonly ActionClass[] = ['crm.write', 'memory.write_longterm'];

/**
 * Does the instruction already on record cover this call?
 *
 * Positive throughout: every condition must hold for the answer to be `true`,
 * and anything unrecognised falls to `false`. In order: the authorisation
 * belongs to the job and business actually executing the action, no money is
 * involved, and then either the class is one of the few genuinely entailed
 * internal ones or it matches the class and recipients the owner named.
 */
export function coveredByAuthorization(
  auth: StandingAuthorization | null,
  facts: {
    /** The job and business actually executing this action. */
    jobId: string;
    businessId: string;
    actionClass: ActionClass;
    input: Record<string, unknown>;
    amountDeclared: boolean;
    amountMinor: number;
  },
): boolean {
  if (auth === null) return false;

  // The authorisation must belong to the very job (and business) executing
  // this action. Without this, an authorisation loaded under one jobId could
  // stand in for a step belonging to another — the same shape CLAUDE.md
  // records for approvals ("an approval affects nothing before it is proven
  // to belong to this job"): edited input from one job's approval replacing
  // another job's payload before the gate ever saw it. Task 5 is responsible
  // for sourcing `facts.jobId`/`facts.businessId` from the job actually
  // running, not from anything the payload itself claims.
  if (auth.jobId !== facts.jobId || auth.businessId !== facts.businessId) return false;

  // Money always asks. An instruction proves the owner wanted something done;
  // it never proves they saw a figure. A declared zero is still a declaration.
  // Both halves of this condition are load-bearing on their own:
  // `amountDeclared` catches a value read only through `readAmountMinor`'s
  // prototype-chain read (`src/policy/facts.ts`) where `amountDeclared`
  // itself stays false because it is own-property-only — see
  // `inherited-fields.test.ts`'s `{ __proto__: { amountMinor: ... } }` case.
  if (facts.amountDeclared || facts.amountMinor !== 0) return false;

  // The one entailed step: an action that reaches nobody — filing the
  // correspondence, recording the contact. It carries no destination, so the
  // recipient question does not arise. A NAMED list, not "any class
  // addressed internally" — see ENTAILED_INTERNAL_CLASSES.
  if (ENTAILED_INTERNAL_CLASSES.includes(facts.actionClass)) return true;

  if (facts.actionClass !== auth.actionClass) return false;

  const named = new Set(auth.recipients);
  // Defence in depth, not load-bearing given the checks below: with `going`
  // non-empty, `going.every` over an empty `named` already returns `false`
  // for any address, and with `going` empty the next guard already returns
  // `false` first. Kept anyway because it is cheap and makes the empty-grant
  // case explicit at the point it matters, rather than relying on nobody
  // ever reordering the two checks below it. Deliberately not pinned by a
  // dedicated test — any test written against this line alone would pass
  // with it deleted, and a test that cannot fail is not a test.
  if (named.size === 0) return false;
  // `named` is only ever a set of exact strings, and `going` below is only
  // ever `readPhones`' digits-only output alongside `readEmails`' lower-cased
  // output — never what the owner literally typed. A caller that starts
  // storing recipients as-typed (a phone with dashes, an address with mixed
  // case) reopens the exact bug Task 3 fixed: a WhatsApp recipient that can
  // never match because the two sides were normalised differently, silently.

  // Emails and phones both, because a WhatsApp step's recipient is a number
  // and an authorisation that cannot see it could never cover one. The
  // `every` below still applies to the combined list: one authorised address
  // does not vouch for a stranger's number standing beside it.
  const going = [...readEmails(facts.input), ...readPhones(facts.input)];
  if (going.length === 0) return false;

  // `every`, not `some`: one authorised recipient does not vouch for the
  // strangers standing beside them. The same reasoning `scoreVisibility`
  // already applies in the risk engine.
  return going.every((address) => named.has(address));
}
