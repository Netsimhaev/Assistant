/**
 * A document's media type comes from its bytes, never from its name
 * (docs/superpowers/specs/2026-08-28-document-intake-design.md §5.1). The
 * extension may only refine an ambiguous byte-level answer (which flavour of
 * ZIP, which flavour of plain text) — it may never promote one type to
 * another. A `.xlsx` file that is not actually a ZIP is `text/plain`, not a
 * spreadsheet; the registry (`registry.ts`) then decides which extractor, if
 * any, is trusted to parse it.
 */

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const CSV = 'text/csv';
export const TEXT = 'text/plain';
export const MARKDOWN = 'text/markdown';
export const JSON = 'application/json';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function isZipContainer(head: Buffer): boolean {
  return head.length >= ZIP_MAGIC.length && head.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
}

function extensionOf(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  return dot === -1 ? '' : originalName.slice(dot).toLowerCase();
}

/**
 * Valid UTF-8, containing no C0 control bytes other than tab/newline/CR.
 *
 * `head` is a prefix of a possibly-larger file, so a UTF-8 sequence can be
 * cut off mid-character at the end of the buffer — that is a truncation
 * artefact, not evidence the file is binary. One retry with up to three
 * trailing bytes trimmed (the longest a UTF-8 character can be, minus one)
 * absorbs that without weakening the check anywhere but the very last
 * character.
 */
function looksLikeText(head: Buffer): boolean {
  let decoded: string | null = null;
  for (let trim = 0; trim <= 3 && trim < head.length; trim++) {
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        trim === 0 ? head : head.subarray(0, head.length - trim),
      );
      break;
    } catch {
      // Might be a sequence truncated at the buffer's edge; try trimming.
    }
  }
  if (decoded === null) return false;

  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return false;
    }
  }
  return true;
}

/**
 * `null` means unknown — a type nobody named, which Task 10 must reject
 * rather than pass on to an extractor.
 */
export function sniffMediaType(head: Buffer, originalName: string): string | null {
  const ext = extensionOf(originalName);

  if (isZipContainer(head)) {
    // Only among ZIP containers does the extension get a say. A ZIP whose
    // name matches neither supported OOXML format is unsupported, full stop
    // — never handed to an extractor that expects the other one.
    if (ext === '.xlsx') return XLSX;
    if (ext === '.docx') return DOCX;
    return null;
  }

  if (looksLikeText(head)) {
    if (ext === '.csv') return CSV;
    if (ext === '.md' || ext === '.markdown') return MARKDOWN;
    if (ext === '.json') return JSON;
    return TEXT;
  }

  return null;
}
