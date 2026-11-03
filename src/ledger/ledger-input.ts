/**
 * The ledger tools' input contract, shared by the handlers (`runLocalTool`,
 * `orchestrator/local-tools.ts`) and the instruction door's up-front check
 * (`planAndCheck`, `orchestrator/instruct.ts`).
 *
 * **One owner, so the echo cannot promise what the step will refuse (spec
 * F-I4).** The owner reads "ארשום: …" / "אעדכן: …" before the steps run; a
 * plan whose ledger step the handler would reject must be refused at the door
 * by the SAME schema and cross-field rules, not discovered when the step runs.
 * Pure: no database (the update check takes the already-loaded item).
 */
import { z } from 'zod';
import type { PolicyBundle } from '../domain/policy.js';
import { emailDomainProblem, SafeLookupKey } from '../domain/charter.js';
import { LedgerFamily, type LedgerItem } from '../domain/ledger.js';
import {
  appearsVerbatimIn,
  EMAIL_SHAPE,
  knownToCharter,
  type InstructionTextOrigin,
} from '../governance/typed-recipients.js';

/**
 * A calendar date the owner named: strict `YYYY-MM-DD` AND a day that exists.
 * `localToInstant` does not validate (it would roll `02-30` into March), so
 * the schema has to.
 */
export const LedgerDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  }, 'not a real date');

/** `HH:MM`, 24-hour, in the charter's zone. */
export const LedgerTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const LedgerAddInput = z
  .object({
    family: LedgerFamily,
    description: z.string().min(1).max(500),
    dueDate: LedgerDate.optional(),
    dueTime: LedgerTime.optional(),
    critical: z.boolean().optional(),
    counterpartyName: z.string().max(200).optional(),
    counterpartyEmail: z.string().max(320).optional(),
    counterpartyDomain: z.string().max(253).optional(),
    reference: z.string().max(100).optional(),
    amountMinor: z.number().int().nonnegative().optional(),
    stages: z.array(z.string().min(1).max(200)).max(20).optional(),
    proposedStages: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();
export type LedgerAddInput = z.infer<typeof LedgerAddInput>;

export const LedgerUpdateInput = z
  .object({
    itemId: SafeLookupKey.min(1).max(100),
    description: z.string().min(1).max(500).optional(),
    dueDate: LedgerDate.optional(),
    dueTime: LedgerTime.optional(),
    critical: z.boolean().optional(),
    reference: z.string().max(100).optional(),
    amountMinor: z.number().int().nonnegative().optional(),
    /** 1-based stage numbers that are now done. */
    stagesDone: z.array(z.number().int().min(1)).optional(),
    stages: z.array(z.string().min(1).max(200)).max(20).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
export type LedgerUpdateInput = z.infer<typeof LedgerUpdateInput>;

/** The trimmed, lower-cased address the handler stores; `null` for none. */
export function normalisedCounterpartyEmail(raw: string | undefined): string | null {
  const email = raw?.trim().toLowerCase();
  return email === undefined || email === '' ? null : email;
}

/** `ledger.add`'s cross-field rules (English, for the step's error); `null` when none is broken. */
export function ledgerAddRuleProblem(parsed: LedgerAddInput): string | null {
  // A project is a description and a deadline; without the deadline there
  // is nothing to pace or remind against.
  if (parsed.family === 'projects' && parsed.dueDate === undefined) return 'projects: dueDate is required';
  if (parsed.dueTime !== undefined && parsed.dueDate === undefined) return 'dueTime without dueDate';
  const email = normalisedCounterpartyEmail(parsed.counterpartyEmail);
  if (email !== null && !EMAIL_SHAPE.test(email)) return 'counterpartyEmail is not an email address';
  if (parsed.counterpartyDomain !== undefined) return emailDomainProblem(parsed.counterpartyDomain);
  return null;
}

/** `ledger.update`'s cross-field rules against the item it updates; `null` when none is broken. */
export function ledgerUpdateRuleProblem(
  parsed: LedgerUpdateInput,
  item: Pick<LedgerItem, 'dueAt' | 'stages'>,
): string | null {
  if (parsed.dueTime !== undefined && parsed.dueDate === undefined && item.dueAt === null) {
    return 'dueTime on an item with no date';
  }
  if (parsed.stagesDone !== undefined) {
    const count = parsed.stages !== undefined ? parsed.stages.length : item.stages.length;
    const missing = parsed.stagesDone.find((n) => n > count);
    if (missing !== undefined) return `stage ${missing} does not exist`;
  }
  return null;
}

/**
 * Is this counterparty address one the owner vouched for?
 *
 * The same two positive sources `authorisedRecipients` uses (spec §7.2): the
 * owner TYPED it in this job's instruction — `appearsVerbatimIn` AND a stored
 * `text_origin` of `typed`, because a transcript is a model's output and not
 * typing (spec §11.5) — or the signed charter already knows it. The
 * instruction is the job's stored row, never the tool input. Shared by the
 * handler (what is stored) and the echo (what the owner is told), so the two
 * never disagree on "לא מאומתת".
 */
export function counterpartyEmailIsVerified(
  email: string,
  instruction: { text: string; textOrigin: InstructionTextOrigin } | null,
  known: PolicyBundle['knownCounterparties'],
): boolean {
  if (knownToCharter(email, known)) return true;
  if (instruction === null || instruction.textOrigin !== 'typed') return false;
  return appearsVerbatimIn(email, instruction.text);
}
