/**
 * Tier-2 sources: documents and records that belong to ONE contact and may
 * help answer that contact's WhatsApp message. Every source is keyed by the
 * sender's identity only — never by anything the message says.
 */
import type { BusinessDb } from '../../db/pool.js';

export interface SenderIds {
  /** `authorityNumberKey` digits (no '+'). */
  key: string;
  email: string | null;
  /** The managed-contact subject key ('+digits'). */
  subjectKey: string;
}

export interface SourceItem {
  source: 'uploaded_invoices' | 'sent_invoices' | 'accounting_invoices';
  label: string;
  text: string;
  documentId: string | null;
  at: string | null;
}

export interface Tier2Result {
  items: SourceItem[];
  /** True when the source found data that does not belong to this sender. */
  ownershipViolation: boolean;
}

export type Tier2Source = (db: BusinessDb, ids: SenderIds, signal: AbortSignal) => Promise<Tier2Result>;
