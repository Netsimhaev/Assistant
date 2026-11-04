/**
 * DOCX renderer: a validated `DocxSpec` -> a real Word document.
 *
 * Direction comes from `spec.language` in code (never from the model). In
 * Hebrew every paragraph is bidirectional + right-aligned, every text run is
 * RTL, and every digit sequence (`39%`, `₪1,890`, `03/11/2026`) sits in its
 * own LTR run so the bidi algorithm cannot reorder it. Clause numbers are
 * generated here; a contract gets signature blocks, "הבסיס החוקי" and the
 * disclaimer in the footer of every page.
 *
 * Clause numbering: each `clause` block is numbered `N.` by the renderer (a
 * title that already starts with its own number is stripped, never doubled).
 * When the clause `text` has more than one non-blank line, every non-blank
 * line becomes its own sub-clause `N.1`, `N.2`, ...; a single-line text gets
 * no sub-number.
 */
import { open, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
} from 'docx';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import type { AccentColor, Block, DocxSpec } from '../domain/document-spec.js';
import { formatCell } from './format-value.js';
import { SpecRenderError } from './render-error.js';
import { CONTRACT_DISCLAIMER_EN, CONTRACT_DISCLAIMER_HE, stripOwnNumber } from './validate-spec.js';

export type ImageLoader = (documentId: string) => Promise<{ bytes: Buffer; mediaType: string } | null>;

export interface RenderDocxOptions {
  currency: string;
  images: ImageLoader;
}

const FONT = 'Arial';
/** A4 with 2cm margins leaves ~17cm; docx transformations are in pixels (96dpi). */
const MAX_IMAGE_WIDTH_PX = 600;

const ACCENT_HEX: Record<AccentColor, string> = {
  navy: '1F3864',
  teal: '1B7F8C',
  green: '2E7D32',
  burgundy: '7B1E3A',
  gray: '595959',
  orange: 'D9730D',
};

const HEADING_SIZE: Record<1 | 2 | 3, number> = { 1: 36, 2: 30, 3: 26 };
const HEADING_LEVEL = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

/** Currency prefix + digits with inner separators + optional percent. */
const NUMBER_RUN = /(?:(?<![\p{L}\d])[-−])?[₪$€]?\d+(?:[,.:/]\d+)*%?/gu;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface Ctx {
  rtl: boolean;
  accent: string;
  currency: string;
}

interface RunStyle {
  bold?: boolean;
  size?: number;
  color?: string;
}

function textRuns(text: string, ctx: Ctx, style: RunStyle = {}): TextRun[] {
  const base = { font: FONT, ...style };
  if (!ctx.rtl) return [new TextRun({ text, ...base })];
  const runs: TextRun[] = [];
  let last = 0;
  for (const m of text.matchAll(NUMBER_RUN)) {
    const at = m.index ?? 0;
    if (at > last) runs.push(new TextRun({ text: text.slice(last, at), rightToLeft: true, ...base }));
    runs.push(new TextRun({ text: m[0], ...base }));
    last = at + m[0].length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), rightToLeft: true, ...base }));
  if (runs.length === 0) runs.push(new TextRun({ text: '', rightToLeft: true, ...base }));
  return runs;
}

/** A label such as `2.1` that must stay left-to-right even inside a Hebrew line. */
function numberRun(label: string, style: RunStyle = {}): TextRun {
  return new TextRun({ text: label, font: FONT, ...style });
}

function para(
  children: TextRun[] | (TextRun | ImageRun)[],
  ctx: Ctx,
  extra: { heading?: 1 | 2 | 3; center?: boolean; spacingAfter?: number } = {},
): Paragraph {
  return new Paragraph({
    children,
    ...(ctx.rtl ? { bidirectional: true } : {}),
    alignment: extra.center ? AlignmentType.CENTER : ctx.rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
    ...(extra.heading ? { heading: HEADING_LEVEL[extra.heading] } : {}),
    spacing: { after: extra.spacingAfter ?? 120 },
  });
}

function imageSize(bytes: Buffer, mediaType: string): { width: number; height: number } | null {
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

async function imageParagraph(documentId: string, ctx: Ctx, options: RenderDocxOptions, where: string) {
  const img = await options.images(documentId);
  if (img === null) throw new SpecRenderError('unknown_image', where);
  if (img.mediaType !== 'image/png' && img.mediaType !== 'image/jpeg') {
    throw new SpecRenderError('unsupported_image', where);
  }
  const size = imageSize(img.bytes, img.mediaType);
  if (size === null || size.width <= 0 || size.height <= 0) {
    throw new SpecRenderError('unsupported_image', where);
  }
  const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / size.width);
  return para(
    [
      new ImageRun({
        type: img.mediaType === 'image/png' ? 'png' : 'jpg',
        data: img.bytes,
        transformation: {
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
        },
      }),
    ],
    ctx,
    { center: true },
  );
}

function tableOf(block: Extract<Block, { type: 'table' }>, ctx: Ctx, where: string): Table {
  const { header, rows, numberFormat } = block;
  const cell = (runs: TextRun[], shade?: string) =>
    new TableCell({
      children: [para(runs, ctx, { spacingAfter: 40 })],
      ...(shade ? { shading: { fill: shade } } : {}),
    });
  const headRow = new TableRow({
    tableHeader: true,
    children: header.map((h) => cell(textRuns(h, ctx, { bold: true }), 'E7E6E6')),
  });
  const body = rows.map(
    (row, r) =>
      new TableRow({
        children: row.map((c, i) => cell(textRuns(formatCell(c, numberFormat?.[i], ctx.currency, `${where}.rows[${r}][${i}]`), ctx))),
      }),
  );
  return new Table({
    rows: [headRow, ...body],
    width: { size: 100, type: WidthType.PERCENTAGE },
    ...(ctx.rtl ? { visuallyRightToLeft: true } : {}),
  });
}

function signatureTable(ctx: Ctx): Table {
  const labels = ctx.rtl ? ['חתימת צד א׳', 'חתימת צד ב׳'] : ['Party A signature', 'Party B signature'];
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
  const cell = (label: string) =>
    new TableCell({
      borders: { top: none, left: none, right: none, bottom: none },
      children: [
        para([new TextRun({ text: '______________________', font: FONT })], ctx, { spacingAfter: 40 }),
        para(textRuns(label, ctx), ctx),
        para(textRuns(ctx.rtl ? 'תאריך: ____________' : 'Date: ____________', ctx), ctx),
      ],
    });
  return new Table({
    rows: [new TableRow({ children: labels.map(cell) })],
    width: { size: 100, type: WidthType.PERCENTAGE },
    ...(ctx.rtl ? { visuallyRightToLeft: true } : {}),
  });
}

export async function renderDocx(spec: DocxSpec, options: RenderDocxOptions): Promise<Buffer> {
  const ctx: Ctx = {
    rtl: spec.language === 'he',
    accent: ACCENT_HEX[spec.style.accent],
    currency: options.currency,
  };
  const children: FileChild[] = [];

  children.push(
    para(textRuns(spec.title, ctx, { bold: true, size: 44, color: ctx.accent }), ctx, {
      center: true,
      spacingAfter: 240,
    }),
  );

  let clauseNo = 0;
  for (let i = 0; i < spec.blocks.length; i += 1) {
    const block = spec.blocks[i] as Block;
    const where = `blocks[${i}]`;
    switch (block.type) {
      case 'heading':
        children.push(
          para(textRuns(block.text, ctx, { bold: true, size: HEADING_SIZE[block.level as 1 | 2 | 3], color: ctx.accent }), ctx, {
            heading: block.level as 1 | 2 | 3,
          }),
        );
        break;
      case 'paragraph':
        children.push(para(textRuns(block.text, ctx), ctx));
        break;
      case 'list':
        block.items.forEach((item, n) => {
          const marker = block.style === 'ordered' ? `${n + 1}.` : '•';
          children.push(para([numberRun(marker), ...textRuns(` ${item}`, ctx)], ctx));
        });
        break;
      case 'table':
        children.push(tableOf(block, ctx, where));
        children.push(para([], ctx));
        break;
      case 'pageBreak':
        children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'image':
        children.push(await imageParagraph(block.documentId, ctx, options, where));
        break;
      case 'clause': {
        clauseNo += 1;
        children.push(
          para([numberRun(`${clauseNo}.`, { bold: true }), ...textRuns(` ${stripOwnNumber(block.title, clauseNo).trim()}`, ctx, { bold: true })], ctx),
        );
        const lines = block.text.split(/\r?\n/).filter((l) => l.trim() !== '');
        if (lines.length <= 1) {
          children.push(para(textRuns(lines[0] ?? '', ctx), ctx));
        } else {
          lines.forEach((line, n) =>
            children.push(para([numberRun(`${clauseNo}.${n + 1}`), ...textRuns(` ${line}`, ctx)], ctx)),
          );
        }
        break;
      }
    }
  }

  const isContract = spec.kind === 'contract';
  if (isContract) {
    children.push(para([], ctx));
    children.push(signatureTable(ctx));
    children.push(para([], ctx));
    children.push(
      para(textRuns(ctx.rtl ? 'הבסיס החוקי' : 'Legal basis', ctx, { bold: true, size: 30, color: ctx.accent }), ctx, {
        heading: 2,
      }),
    );
    for (const basis of spec.legalBasis ?? []) {
      const line = basis.note ? `${basis.law} — ${basis.note}` : basis.law;
      children.push(para([numberRun('•'), ...textRuns(` ${line}`, ctx)], ctx));
    }
  }

  const disclaimer = ctx.rtl ? CONTRACT_DISCLAIMER_HE : CONTRACT_DISCLAIMER_EN;
  const doc = new Document({
    title: spec.title,
    styles: { default: { document: { run: { font: FONT } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        ...(isContract
          ? {
              footers: {
                default: new Footer({
                  children: [para(textRuns(disclaimer, ctx, { size: 18, color: '595959' }), ctx, { center: true })],
                }),
              },
            }
          : {}),
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

interface DocumentRow {
  stored_path: string;
  media_type: string;
}

/** Production loader: the `documents` row of THIS business, bytes from under `documentRoot`. */
export function createDbImageLoader(businessId: string, db: Queryable = getPool()): ImageLoader {
  return async (documentId) => {
    const { rows } = await db.query<DocumentRow>(
      'SELECT stored_path, media_type FROM documents WHERE business_id = $1 AND document_id = $2',
      [businessId, documentId],
    );
    const row = rows[0];
    if (!row) return null;
    const root = resolve(config.documentRoot);
    const full = resolve(root, row.stored_path);
    const rel = relative(root, full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    try {
      const info = await stat(full);
      if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
      if (info.size > MAX_IMAGE_BYTES) throw new SpecRenderError('image_too_large', documentId);
      const handle = await open(full, 'r');
      try {
        return { bytes: await handle.readFile(), mediaType: row.media_type };
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
}
