/**
 * The vocabulary of document production: what the model may ask for (a
 * `DocumentSpec`) and the stages a production moves through.
 *
 * The model never writes a file; it writes this JSON, strict at every level,
 * and code renders it. Every number in a table cell carries a `SourceRef`
 * naming where it came from — a number without one does not parse. Ids go
 * through `SafeLookupKey` (the same guard the charter uses) so `__proto__`
 * cannot ride in as a document or memory id.
 */
import { z } from 'zod';
import { SafeLookupKey } from './charter.js';

export const DocumentFormat = z.enum(['xlsx', 'docx', 'pptx', 'pdf']);
export type DocumentFormat = z.infer<typeof DocumentFormat>;

export const DocumentLanguage = z.enum(['he', 'en']);
export type DocumentLanguage = z.infer<typeof DocumentLanguage>;

export const DocumentKind = z.enum([
  'contract',
  'protocol',
  'price_list',
  'profit_table',
  'report',
  'letter',
  'presentation',
  'other',
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const StyleTheme = z.enum(['clean', 'formal', 'bold', 'minimal']);
export type StyleTheme = z.infer<typeof StyleTheme>;

export const AccentColor = z.enum(['navy', 'teal', 'green', 'burgundy', 'gray', 'orange']);
export type AccentColor = z.infer<typeof AccentColor>;

export const ProductionStage = z.enum([
  'queued',
  'drafting',
  'building',
  'check1',
  'check2',
  'fixing',
  'ready',
  'failed_checks',
  'failed',
]);
export type ProductionStage = z.infer<typeof ProductionStage>;

export const SourceRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('instruction') }).strict(),
  z
    .object({
      kind: z.literal('document'),
      documentId: SafeLookupKey,
      ordinal: z.number().int().min(0),
    })
    .strict(),
  z.object({ kind: z.literal('memory'), memoryId: SafeLookupKey }).strict(),
]);
export type SourceRef = z.infer<typeof SourceRef>;

/** A formula string is stored without the leading `=`. */
export const Cell = z.union([
  z.object({ v: z.number().finite(), src: SourceRef }).strict(),
  z.object({ t: z.string() }).strict(),
  z.object({ d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ f: z.string().min(1).regex(/^[^=]/) }).strict(),
]);
export type Cell = z.infer<typeof Cell>;

const NumberFormat = z.enum(['int', 'money', 'percent', 'decimal2']);

export const XlsxTable = z
  .object({
    title: z.string().max(200).optional(),
    header: z.array(z.string()).min(1),
    rows: z.array(z.array(Cell)),
    totals: z.array(Cell).optional(),
    numberFormat: z.array(NumberFormat).optional(),
    conditional: z
      .array(
        z
          .object({
            column: z.number().int().min(0),
            rule: z.enum(['negative_red', 'top3_bold']),
          })
          .strict(),
      )
      .optional(),
    chart: z
      .object({
        type: z.enum(['bar', 'line', 'pie']),
        column: z.number().int().min(0),
        labelColumn: z.number().int().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();
export type XlsxTable = z.infer<typeof XlsxTable>;

export const XlsxSheet = z
  .object({ name: z.string().min(1).max(31), tables: z.array(XlsxTable).min(1) })
  .strict();
export type XlsxSheet = z.infer<typeof XlsxSheet>;

export const Block = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('heading'), level: z.number().int().min(1).max(3), text: z.string() })
    .strict(),
  z.object({ type: z.literal('paragraph'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('list'),
      style: z.enum(['ordered', 'bullet']),
      items: z.array(z.string()).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      header: z.array(z.string()).min(1),
      rows: z.array(z.array(Cell)),
    })
    .strict(),
  z.object({ type: z.literal('pageBreak') }).strict(),
  z.object({ type: z.literal('image'), documentId: SafeLookupKey }).strict(),
  // The clause number is assigned by the renderer, never written by the model.
  z.object({ type: z.literal('clause'), title: z.string(), text: z.string() }).strict(),
]);
export type Block = z.infer<typeof Block>;

export const Slide = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('title'), title: z.string(), subtitle: z.string().optional() })
    .strict(),
  z
    .object({
      type: z.literal('titleBullets'),
      title: z.string(),
      bullets: z.array(z.string()).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      title: z.string(),
      header: z.array(z.string()).min(1),
      rows: z.array(z.array(Cell)),
    })
    .strict(),
  z
    .object({
      type: z.literal('chart'),
      title: z.string(),
      chartType: z.enum(['bar', 'line', 'pie']),
      header: z.array(z.string()).min(1),
      rows: z.array(z.array(Cell)),
      column: z.number().int().min(0),
      labelColumn: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('imageText'),
      title: z.string(),
      text: z.string(),
      documentId: SafeLookupKey,
    })
    .strict(),
  z
    .object({
      type: z.literal('collage'),
      title: z.string().optional(),
      documentIds: z.array(SafeLookupKey).min(2).max(6),
    })
    .strict(),
  z.object({ type: z.literal('paragraph'), title: z.string().optional(), text: z.string() }).strict(),
]);
export type Slide = z.infer<typeof Slide>;

const LegalBasis = z
  .array(z.object({ law: z.string().min(1), note: z.string().optional() }).strict())
  .min(1);

const common = {
  language: DocumentLanguage,
  kind: DocumentKind,
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(120),
  style: z.object({ theme: StyleTheme, accent: AccentColor }).strict(),
  sources: z.array(SourceRef),
  legalBasis: LegalBasis.optional(),
};

export const XlsxSpec = z
  .object({ format: z.literal('xlsx'), ...common, sheets: z.array(XlsxSheet).min(1) })
  .strict();
export type XlsxSpec = z.infer<typeof XlsxSpec>;

export const DocxSpec = z
  .object({ format: z.literal('docx'), ...common, blocks: z.array(Block).min(1) })
  .strict();
export type DocxSpec = z.infer<typeof DocxSpec>;

export const PptxSpec = z
  .object({ format: z.literal('pptx'), ...common, slides: z.array(Slide).min(1) })
  .strict();
export type PptxSpec = z.infer<typeof PptxSpec>;

// R2: a PDF carries the same Block union as a Word document.
export const PdfSpec = z
  .object({ format: z.literal('pdf'), ...common, blocks: z.array(Block).min(1) })
  .strict();
export type PdfSpec = z.infer<typeof PdfSpec>;

export const DocumentSpec = z
  .discriminatedUnion('format', [XlsxSpec, DocxSpec, PptxSpec, PdfSpec])
  .superRefine((spec, ctx) => {
    if (spec.kind === 'contract' && (spec.legalBasis === undefined || spec.legalBasis.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['legalBasis'],
        message: 'חוזה חייב לציין לפחות בסיס חוקי אחד',
      });
    }
  });
export type DocumentSpec = z.infer<typeof DocumentSpec>;
