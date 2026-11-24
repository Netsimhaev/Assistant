/**
 * Tier-2 sources: documents and records that belong to ONE contact and may
 * help answer that contact's WhatsApp message. Every source is keyed by the
 * sender's identity only — never by anything the message says.
 */
import type { BusinessDb } from '../../db/pool.js';
import type { Tier2SourceName } from '../contact-topics.js';

export interface SenderIds {
  /** `authorityNumberKey` digits (no '+'). */
  key: string;
  email: string | null;
  /** The managed-contact subject key ('+digits'). */
  subjectKey: string;
  /** The contact's ids in signed external systems, keyed by system id. */
  externalIds?: Record<string, string>;
}

export interface SourceItem {
  source: Tier2SourceName;
  label: string;
  text: string;
  documentId: string | null;
  at: string | null;
}

export interface Tier2Result {
  items: SourceItem[];
  /** True when the source found data that does not belong to this sender. */
  ownershipViolation: boolean;
  /** The source ran and could not answer (provider failure, truncation): a failed source, not a violation. */
  failed?: boolean;
}

/** What the question is about, decided by the classifier and the charter - never by a source. */
export interface SourceContext {
  /** The time window the message asks about; null when it names none. */
  window: { from: Date; to: Date } | null;
  /** The charter's time zone. */
  timeZone: string;
  /** Charter currency for amounts; without it a source leaves amounts out. */
  currency?: string;
}

export type Tier2Source = (db: BusinessDb, ids: SenderIds, signal: AbortSignal, ctx: SourceContext) => Promise<Tier2Result>;

/** A source that says which tier-2 kind it is, so a topic can route to it. */
export type NamedTier2Source = Tier2Source & { readonly sourceName: Tier2SourceName };

/** A fresh function carrying the name — the shared module export is never mutated. */
export function namedSource(name: Tier2SourceName, run: Tier2Source): NamedTier2Source {
  const f: Tier2Source = (db, ids, signal, ctx) => run(db, ids, signal, ctx);
  Object.defineProperty(f, 'sourceName', { value: name, enumerable: true });
  return f as NamedTier2Source;
}

/** The source's own declared name; `null` for a source that declared none. */
export function sourceNameOf(source: Tier2Source): Tier2SourceName | null {
  if (!Object.hasOwn(source, 'sourceName')) return null;
  const name = (source as Partial<NamedTier2Source>).sourceName;
  return typeof name === 'string' ? name : null;
}
