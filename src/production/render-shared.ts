/**
 * Helpers shared by the docx, pptx and pdf renderers: the bidi digit-run splitter
 * and the png/jpeg-only image check. One copy, so the two renderers cannot
 * drift on what counts as a number or an acceptable image.
 */
import type { AccentColor } from '../domain/document-spec.js';
import { SpecRenderError } from './render-error.js';
import { stripOwnNumber } from './validate-spec.js';

/** The closed accent palette, one copy for every renderer (hex, no `#`). */
export const ACCENT_HEX: Record<AccentColor, string> = {
  navy: '1F3864',
  teal: '1B7F8C',
  green: '2E7D32',
  burgundy: '7B1E3A',
  gray: '595959',
  orange: 'D9730D',
};

/**
 * Clause numbering, shared so docx and pdf number identically: clause `n` is
 * `n.`; a title that already starts with its own number is stripped, never
 * doubled; a text with more than one non-blank line becomes sub-clauses
 * `n.1`, `n.2`, ... and a single-line text gets no sub-number.
 */
export interface NumberedClause {
  label: string;
  title: string;
  /** One entry per body line; `label` is null for a single-line body. */
  lines: { label: string | null; text: string }[];
}

export function numberClause(n: number, title: string, text: string): NumberedClause {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return {
    label: `${n}.`,
    title: stripOwnNumber(title, n).trim(),
    lines:
      lines.length <= 1
        ? [{ label: null, text: lines[0] ?? '' }]
        : lines.map((line, i) => ({ label: `${n}.${i + 1}`, text: line })),
  };
}

export type ImageLoader = (documentId: string) => Promise<{ bytes: Buffer; mediaType: string } | null>;

/** Currency prefix + digits with inner separators + optional percent. */
const NUMBER_RUN = /(?:(?<![\p{L}\d])[-−])?[₪$€]?\d+(?:[,.:/]\d+)*%?/gu;

export interface TextPiece {
  text: string;
  /** True for a digit run that must stay left-to-right inside Hebrew text. */
  ltr: boolean;
}

/** Splits text so each digit run (incl. leading minus, currency, %) is its own LTR piece. */
export function splitNumberRuns(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(NUMBER_RUN)) {
    const at = m.index ?? 0;
    if (at > last) pieces.push({ text: text.slice(last, at), ltr: false });
    pieces.push({ text: m[0], ltr: true });
    last = at + m[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), ltr: false });
  if (pieces.length === 0) pieces.push({ text: '', ltr: false });
  return pieces;
}

export function imageSize(bytes: Buffer, mediaType: string): { width: number; height: number } | null {
  if (mediaType === 'image/png') {
    if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    return null;
  }
  // JPEG: walk markers to the first SOF.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

export interface CheckedImage {
  bytes: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** A present image must be png/jpeg with matching magic bytes; anything else throws. */
export function checkImage(img: { bytes: Buffer; mediaType: string }, where: string): CheckedImage {
  if (img.mediaType !== 'image/png' && img.mediaType !== 'image/jpeg') {
    throw new SpecRenderError('unsupported_image', where);
  }
  const size = imageSize(img.bytes, img.mediaType);
  if (size === null || size.width <= 0 || size.height <= 0) {
    throw new SpecRenderError('unsupported_image', where);
  }
  return { bytes: img.bytes, mediaType: img.mediaType, ...size };
}
