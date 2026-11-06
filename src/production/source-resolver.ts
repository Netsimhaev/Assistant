/**
 * Which documents the owner meant when he named a source for a production
 * (document production §5.6, C19) — deterministic, never a model call, in
 * the pattern of `resolveContacts` (`memory/contact-resolver.ts`).
 *
 * **Why no model.** A source decides what the drafter reads and what every
 * number in the document is grounded against. A model choosing "the price
 * list" would be a model choosing which stranger's file becomes the basis of
 * a document the owner sends; matching words against stored facts keeps that
 * choice in code, where it can be read and tested.
 *
 * **What a hint is matched against, all inside THIS business:** the
 * document's `original_name`, and — when it arrived as a mail attachment
 * (`mail_messages.attachments[].documentId`) — the sender's address (domain
 * included) and display name and the attachment's `docType` (the key and its
 * Hebrew label), plus the date the document arrived (in `timeZone`). Every
 * significant word of a hint must match something, so "המחירון של אלפא" needs
 * both a "מחירון" and an "אלפא". A word matches as typed or with up to two
 * attached Hebrew particles peeled (`המחירון` → `מחירון`, `מאלפא` → `אלפא`),
 * and a fixed list of filler words (`של`, `מסמך`, …) is skipped. A word that
 * reads as a date (`5/10`, `5.10.2026`, `2026-10-05`) matches the arrival date
 * instead of text.
 *
 * **Outcome per hint:** exactly one document → resolved; several → ambiguous,
 * with at most three candidates (newest first) for one clarifying question;
 * none → missing (the card says "לא מצאתי את …"). An explicit id resolves
 * only when it is a readable document of this business; anything else is
 * missing — another business's id reads exactly like one that never existed.
 * Only `extracted` and `stored` documents are candidates: a rejected file was
 * never kept for reading.
 */
import type { Queryable } from '../db/pool.js';
import { ATTACHMENT_DOC_TYPE_LABELS, AttachmentDocType } from '../domain/mail-triage.js';
import { stripBidiControls } from '../util/bidi.js';
import { extractDomain } from '../util/address.js';
import { localParts } from '../util/local-time.js';

/** The most candidates one clarifying question shows (spec §5.6). */
export const MAX_SOURCE_CANDIDATES = 3;

/** How many of the business's newest documents a hint is matched against. */
const SCAN_LIMIT = 500;

export interface SourceCandidate {
  documentId: string;
  name: string;
  /** The mail sender's display name or address; `null` for a file that did not come by mail. */
  sender: string | null;
  /** Arrival date, `YYYY-MM-DD` in the given zone. */
  date: string;
}

export interface SourceResolution {
  resolved: string[];
  ambiguous: { hint: string; candidates: SourceCandidate[] }[];
  /** Hints that matched nothing, then explicit ids that are not readable documents of this business. */
  missing: string[];
}

/** Filler words that never decide a match (Hebrew and English). */
const FILLER = new Set([
  'של', 'את', 'עם', 'על', 'אל', 'גם', 'או', 'זה', 'זו', 'ששלח', 'שנשלח', 'ששלחה',
  'מסמך', 'המסמך', 'קובץ', 'הקובץ', 'הקבצים', 'מהמייל', 'במייל', 'מייל',
  'the', 'of', 'from', 'for', 'and', 'a', 'an', 'file', 'document', 'doc', 'email', 'mail',
]);

const PARTICLE = /^[לבמהוכש]-?/;
const TRAILING = /[.,;:!?)"'״׳]+$/;
const LEADING = /^["'(״׳]+/;

interface Row {
  document_id: string;
  original_name: string;
  created_at: Date;
  from_address: string | null;
  from_name: string | null;
  doc_type: string | null;
}

interface Doc {
  documentId: string;
  name: string;
  sender: string | null;
  date: string;
  /** Lower-cased text fields a word may match inside. */
  haystack: string[];
}

type Word = { kind: 'text'; variants: string[] } | { kind: 'date'; day: number; month: number; year: number | null };

function wordOf(raw: string): Word | null {
  const token = raw.replace(LEADING, '').replace(TRAILING, '').toLowerCase();
  if (token === '' || FILLER.has(token)) return null;

  const variants: string[] = [token];
  let peeled = token;
  for (let i = 0; i < 2; i += 1) {
    const next = peeled.replace(PARTICLE, '');
    if (next === peeled || next.length < 2) break;
    peeled = next;
    variants.push(peeled);
  }
  const date = dateOf(variants[variants.length - 1] ?? token);
  if (date !== null) return date;
  if (variants.some((v) => FILLER.has(v))) return null;
  const usable = variants.filter((v) => v.length >= 2);
  return usable.length === 0 ? null : { kind: 'text', variants: usable };
}

function dateOf(token: string): Word | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
  if (iso) return { kind: 'date', year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const dm = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/.exec(token);
  if (!dm) return null;
  const day = Number(dm[1]);
  const month = Number(dm[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const y = dm[3];
  const year = y === undefined ? null : y.length === 2 ? 2000 + Number(y) : Number(y);
  return { kind: 'date', day, month, year };
}

function wordsOf(hint: string): Word[] {
  return stripBidiControls(hint)
    .split(/\s+/)
    .map(wordOf)
    .filter((w): w is Word => w !== null);
}

function matches(doc: Doc, word: Word): boolean {
  if (word.kind === 'date') {
    const [y, m, d] = doc.date.split('-').map(Number);
    return d === word.day && m === word.month && (word.year === null || y === word.year);
  }
  return word.variants.some((v) => doc.haystack.some((field) => field.includes(v)));
}

function toDoc(row: Row, timeZone: string): Doc {
  const haystack = [row.original_name];
  if (row.from_address !== null) {
    haystack.push(row.from_address);
    const domain = extractDomain(row.from_address);
    if (domain !== null) haystack.push(domain);
  }
  if (row.from_name !== null) haystack.push(row.from_name);
  const type = AttachmentDocType.safeParse(row.doc_type);
  if (type.success) haystack.push(type.data, ATTACHMENT_DOC_TYPE_LABELS[type.data]);
  return {
    documentId: row.document_id,
    name: row.original_name,
    sender: row.from_name ?? row.from_address,
    date: localParts(row.created_at, timeZone).date,
    haystack: haystack.map((field) => stripBidiControls(field).toLowerCase()),
  };
}

export async function resolveSourceDocuments(
  businessId: string,
  hints: readonly string[],
  explicitIds: readonly string[],
  db: Queryable,
  options: { timeZone?: string } = {},
): Promise<SourceResolution> {
  const timeZone = options.timeZone ?? 'UTC';
  const result: SourceResolution = { resolved: [], ambiguous: [], missing: [] };
  const add = (id: string): void => {
    if (!result.resolved.includes(id)) result.resolved.push(id);
  };

  if (hints.length > 0) {
    // Newest first; one row per document (its latest mail, if any).
    const { rows } = await db.query<Row>(
      `SELECT d.document_id, d.original_name, d.created_at,
              m.from_address, m.from_name, m.doc_type
         FROM documents d
         LEFT JOIN LATERAL (
           SELECT mm.from_address, mm.from_name, a.elem ->> 'docType' AS doc_type
             FROM mail_messages mm, jsonb_array_elements(mm.attachments) AS a(elem)
            WHERE mm.business_id = d.business_id AND a.elem ->> 'documentId' = d.document_id
            ORDER BY mm.received_at DESC
            LIMIT 1) m ON true
        WHERE d.business_id = $1 AND d.status IN ('extracted', 'stored')
        ORDER BY d.created_at DESC, d.document_id DESC
        LIMIT $2`,
      [businessId, SCAN_LIMIT],
    );
    const docs = rows.map((row) => toDoc(row, timeZone));

    for (const hint of hints) {
      const words = wordsOf(hint);
      const found = words.length === 0 ? [] : docs.filter((doc) => words.every((word) => matches(doc, word)));
      if (found.length === 1) add(found[0]!.documentId);
      else if (found.length === 0) result.missing.push(hint);
      else {
        result.ambiguous.push({
          hint,
          candidates: found.slice(0, MAX_SOURCE_CANDIDATES).map(({ documentId, name, sender, date }) => ({
            documentId,
            name,
            sender,
            date,
          })),
        });
      }
    }
  }

  if (explicitIds.length > 0) {
    const { rows } = await db.query<{ document_id: string }>(
      `SELECT document_id FROM documents
        WHERE business_id = $1 AND document_id = ANY($2::text[]) AND status IN ('extracted', 'stored')`,
      [businessId, [...explicitIds]],
    );
    const known = new Set(rows.map((row) => row.document_id));
    for (const id of explicitIds) {
      if (known.has(id)) add(id);
      else if (!result.missing.includes(id)) result.missing.push(id);
    }
  }
  return result;
}
