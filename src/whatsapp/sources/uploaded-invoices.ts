/**
 * Invoices the owner uploaded and assigned to this contact on the people
 * screen (`contact_documents.assigned_by = 'owner_upload'`). The join is on
 * the business and the sender's key; nothing from message text is a filter.
 */
import { stripBidiControls, toOneLine } from '../../util/bidi.js';
import type { Tier2Source, SourceItem } from './types.js';

const MAX_ITEMS = 10;
const MAX_TEXT_CHARS = 2000;

interface Row {
  document_id: string;
  original_name: string;
  created_at: Date;
}

interface ArtifactRow {
  content: unknown;
}

function blockTexts(content: unknown): string[] {
  const blocks = (content as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const b of blocks) {
    const text = (b as { text?: unknown } | null)?.text;
    if (typeof text === 'string') out.push(text);
  }
  return out;
}

export const uploadedInvoicesOfSender: Tier2Source = async (db, ids, signal) => {
  const { rows } = await db.query<Row>(
    `SELECT d.document_id, d.original_name, d.created_at
       FROM contact_documents cd
       JOIN documents d ON d.business_id = cd.business_id AND d.document_id = cd.document_id
      WHERE cd.business_id = $1 AND cd.contact_key = $2 AND cd.kind = 'invoice'
        AND cd.assigned_by = 'owner_upload'
      ORDER BY d.created_at DESC, d.document_id DESC
      LIMIT $3`,
    [db.businessId, ids.key, MAX_ITEMS],
  );
  const items: SourceItem[] = [];
  for (const row of rows) {
    if (signal.aborted) break;
    const { rows: artifacts } = await db.query<ArtifactRow>(
      `SELECT content FROM document_artifacts
        WHERE business_id = $1 AND document_id = $2 AND kind = 'text'
        ORDER BY ordinal`,
      [db.businessId, row.document_id],
    );
    const text = artifacts.flatMap((a) => blockTexts(a.content)).join('\n').slice(0, MAX_TEXT_CHARS);
    items.push({
      source: 'uploaded_invoices',
      label: `חשבונית שהועלתה: ${toOneLine(stripBidiControls(row.original_name))}`,
      text,
      documentId: row.document_id,
      at: row.created_at.toISOString(),
    });
  }
  return { items, ownershipViolation: false };
};
