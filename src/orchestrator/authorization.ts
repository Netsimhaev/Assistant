/**
 * Standing authorisation: the owner's instruction, on record, standing in for
 * an approval question (spec §6).
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

import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { ActionClass } from '../domain/action.js';
import { readEmails } from '../policy/facts.js';

export interface StandingAuthorization {
  jobId: string;
  businessId: string;
  actionClass: ActionClass;
  /** Lower-cased addresses the owner named. */
  recipients: string[];
  /** Only one grantor is expressible; the field exists so audit reads plainly. */
  grantedBy: 'boss';
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
 * function exists to make that impossible from inside the process.
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

  await db.query(
    `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
     VALUES ($1, $2, $3, $4)`,
    [businessId, input.jobId, input.actionClass, input.recipients.map((r) => r.toLowerCase())],
  );
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
 * filing the correspondence, recording the contact, writing the artefact.
 *
 * Named rather than derived from `addresseeOf(...) === 'internal'`. Eight
 * classes are internal, and five of them — purchase.place, data.export,
 * media.publish, memory.write_longterm, charter.amend — are not entailed by
 * anything. Written as "any internal class", an instruction to reply to a
 * customer would have covered amending the charter.
 */
const ENTAILED_INTERNAL_CLASSES: readonly ActionClass[] = [
  'crm.write',
  'accounting.write',
  'artifact.write',
];

/**
 * Does the instruction already on record cover this call?
 *
 * Positive throughout: every condition must hold for the answer to be `true`,
 * and anything unrecognised falls to `false`. The three the owner set:
 * the same action class, no recipient beyond the ones named, and no money at
 * all.
 */
export function coveredByAuthorization(
  auth: StandingAuthorization | null,
  facts: {
    actionClass: ActionClass;
    input: Record<string, unknown>;
    amountDeclared: boolean;
    amountMinor: number;
  },
): boolean {
  if (auth === null) return false;

  // Money always asks. An instruction proves the owner wanted something done;
  // it never proves they saw a figure. A declared zero is still a declaration.
  if (facts.amountDeclared || facts.amountMinor !== 0) return false;

  // The one entailed step: an action that reaches nobody — filing the
  // correspondence, recording the contact, writing the artefact. It carries
  // no destination, so the recipient question does not arise. A NAMED list,
  // not "any class addressed internally" — see ENTAILED_INTERNAL_CLASSES.
  if (ENTAILED_INTERNAL_CLASSES.includes(facts.actionClass)) return true;

  if (facts.actionClass !== auth.actionClass) return false;

  const named = new Set(auth.recipients);
  if (named.size === 0) return false;

  const going = readEmails(facts.input);
  if (going.length === 0) return false;

  // `every`, not `some`: one authorised recipient does not vouch for the
  // strangers standing beside them. The same reasoning `scoreVisibility`
  // already applies in the risk engine.
  return going.every((address) => named.has(address));
}
