/**
 * The task ledger's vocabulary: what the owner is waiting on or owes.
 * Identifiers stay English; the owner reads Hebrew only through `labels.ts`.
 */
import { z } from 'zod';
import { localParts } from '../util/local-time.js';

export const LedgerFamily = z.enum([
  'money_in',
  'money_out',
  'meetings',
  'warm_leads',
  'awaiting_reply',
  'projects',
]);
export type LedgerFamily = z.infer<typeof LedgerFamily>;

export const LedgerStatus = z.enum(['open', 'stuck', 'closed_by_evidence', 'done', 'cancelled']);
export type LedgerStatus = z.infer<typeof LedgerStatus>;

export const LedgerMode = z.enum(['remind', 'act']);
export type LedgerMode = z.infer<typeof LedgerMode>;

export const Importance = z.enum(['normal', 'critical']);
export type Importance = z.infer<typeof Importance>;

export const LedgerStage = z.object({ title: z.string().min(1).max(200), done: z.boolean() });
export type LedgerStage = z.infer<typeof LedgerStage>;

export const LedgerEventKind = z.enum([
  'created',
  'updated',
  'reminded',
  'nudged',
  'nudge_fallback',
  'closed_by_evidence',
  'reopened',
  'done',
  'cancelled',
  'snoozed',
  'stuck',
  'held',
  'not_held',
  'stages_saved',
  'address_confirmed',
  'pace_alert',
]);
export type LedgerEventKind = z.infer<typeof LedgerEventKind>;

export interface LedgerItem {
  itemId: string;
  businessId: string;
  family: LedgerFamily;
  description: string;
  dueAt: Date | null;
  dueIsDateOnly: boolean;
  importance: Importance;
  importanceManual: boolean;
  counterpartyName: string | null;
  counterpartyEmail: string | null;
  counterpartyEmailVerified: boolean;
  counterpartyDomain: string | null;
  reference: string | null;
  amountMinor: number | null;
  stages: LedgerStage[];
  proposedStages: LedgerStage[] | null;
  status: LedgerStatus;
  nudgeCount: number;
  /** Mail before this instant is not evidence for the item. */
  evidenceAfter: Date;
  originJobId: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface LedgerEvent {
  eventId: string;
  itemId: string;
  kind: LedgerEventKind;
  jobId: string | null;
  mailId: string | null;
  note: string | null;
  byWhom: string;
  at: Date;
}

/**
 * The ONE definition of "overdue" (spec T14), the reminder schedule's
 * (`ledger/schedule.ts`: the first `overdue` slot is the local day AFTER the
 * due date). A date-only due is overdue once its LOCAL date in the charter
 * zone has passed — not once the daily hour on the due day has; a timed due
 * once its instant has passed. Only an `open` item is overdue.
 *
 * Imports only `util/local-time` so the digest (whose import graph must
 * reach no model) can share it with the dashboard.
 */
export function isLedgerOverdue(
  item: Pick<LedgerItem, 'status' | 'dueAt' | 'dueIsDateOnly'>,
  now: Date,
  timeZone: string,
): boolean {
  if (item.status !== 'open' || item.dueAt === null) return false;
  if (item.dueIsDateOnly) return localParts(item.dueAt, timeZone).date < localParts(now, timeZone).date;
  return item.dueAt.getTime() < now.getTime();
}
