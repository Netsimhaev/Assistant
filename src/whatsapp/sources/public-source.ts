/**
 * The owner's public documents as tier-1 items: text the owner marked safe to
 * quote to clients and/or suppliers. Keyed by the contact's KIND only. Each
 * item names its document, so it is an allowed attachment.
 */
import type { BusinessDb } from '../../db/pool.js';
import { stripBidiControls, toOneLine } from '../../util/bidi.js';
import { publicDocumentsFor } from '../public-documents.js';
import type { SourceItem } from './types.js';

export const PUBLIC_BUDGET_CHARS = 12_000;

export async function publicSourceItems(
  db: BusinessDb,
  kind: 'client' | 'supplier',
  budgetChars: number = PUBLIC_BUDGET_CHARS,
): Promise<SourceItem[]> {
  const docs = await publicDocumentsFor(db, kind, budgetChars);
  return docs.map((d) => ({
    source: 'public' as const,
    label: `מסמך ציבורי: ${toOneLine(stripBidiControls(d.name))}`,
    text: d.text,
    documentId: d.documentId,
    at: null,
  }));
}
