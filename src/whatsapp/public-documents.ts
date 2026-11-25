/**
 * Documents the owner marked as safe to quote to clients and/or suppliers.
 * This module is the ONLY writer of `documents.public_for`.
 */
import { appendAudit } from '../audit/log.js';
import type { BusinessDb } from '../db/pool.js';
import { canonicalHash } from '../util/canonical.js';

export type PublicFor = 'client' | 'supplier' | 'both';

export async function setPublicFor(db: BusinessDb, documentId: string, value: PublicFor | null, by: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE documents SET public_for = $3 WHERE business_id = $1 AND document_id = $2`,
    [db.businessId, documentId, value],
  );
  if ((rowCount ?? 0) === 0) return false;
  await appendAudit(db, {
    actor: 'human',
    onBehalfOf: by,
    kind: 'tool_call',
    charterVersion: 'n/a',
    provenance: 'boss',
    inputHash: canonicalHash({ documentId }),
    reason: `public_document:${value ?? 'off'}`,
  });
  return true;
}

/**
 * The suggestion executor's write: sets `public_for` only on an owner-origin
 * document (`source = 'instruction'`), extracted, and not yet public — the
 * same conditions `applySuggestion` checked, held again in the UPDATE itself
 * so a change between the check and the write cannot be overwritten. False
 * when no row changed; the caller throws so its claim rolls back.
 */
export async function setPublicForSuggested(
  db: BusinessDb,
  documentId: string,
  value: PublicFor,
  by: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE documents SET public_for = $3
      WHERE business_id = $1 AND document_id = $2
        AND source = 'instruction' AND status = 'extracted' AND public_for IS NULL`,
    [db.businessId, documentId, value],
  );
  if ((rowCount ?? 0) === 0) return false;
  await appendAudit(db, {
    actor: 'human',
    onBehalfOf: by,
    kind: 'tool_call',
    charterVersion: 'n/a',
    provenance: 'boss',
    inputHash: canonicalHash({ documentId }),
    reason: `public_document:${value}`,
  });
  return true;
}

interface DocRow {
  document_id: string;
  original_name: string;
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

/** Extracted text of the public documents for `kind`, cut to `budgetChars` in total, ordered by document id. */
export async function publicDocumentsFor(
  db: BusinessDb,
  kind: 'client' | 'supplier',
  budgetChars: number,
): Promise<{ documentId: string; name: string; text: string }[]> {
  const { rows } = await db.query<DocRow>(
    `SELECT document_id, original_name FROM documents
      WHERE business_id = $1 AND status = 'extracted' AND public_for IN ($2, 'both')
      ORDER BY document_id`,
    [db.businessId, kind],
  );
  const out: { documentId: string; name: string; text: string }[] = [];
  let left = Math.max(0, budgetChars);
  for (const row of rows) {
    if (left <= 0) break;
    const { rows: artifacts } = await db.query<{ content: unknown }>(
      `SELECT content FROM document_artifacts
        WHERE business_id = $1 AND document_id = $2 AND kind = 'text' ORDER BY ordinal`,
      [db.businessId, row.document_id],
    );
    const text = artifacts.flatMap((a) => blockTexts(a.content)).join('\n').slice(0, left);
    left -= text.length;
    out.push({ documentId: row.document_id, name: row.original_name, text });
  }
  return out;
}
