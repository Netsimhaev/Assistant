/**
 * PPTX renderer: a validated `PptxSpec` -> a real PowerPoint deck.
 *
 * One fixed layout function per slide type, all on a 16:9 canvas
 * (13.33in x 7.5in) with fixed positions. Direction comes from
 * `spec.language` in code. In Hebrew every text object is `rtlMode`,
 * right-aligned and tagged `he-IL`, and every digit run (`39%`, `₪1,890`)
 * is its own LTR run. Table columns are laid out right-to-left (first
 * column on the right). Charts are native pptxgenjs charts built from the
 * slide's own table data. A missing image becomes a grey "כאן תמונה" /
 * "Image here" box and is counted in `placeholders` (a deck may be drafted
 * before the photos exist); a present image of the wrong type still throws.
 */
import PptxModule from 'pptxgenjs';
import type { Cell, PptxSpec, Slide } from '../domain/document-spec.js';
import { formatCell } from './format-value.js';
import { SpecRenderError } from './render-error.js';
import { ACCENT_HEX, checkImage, splitNumberRuns, type CheckedImage, type ImageLoader } from './render-shared.js';
import { stripOwnNumber } from './validate-spec.js';

export interface RenderPptxOptions {
  currency: string;
  images: ImageLoader;
}

const FONT = 'Arial';
const W = 13.333;
const H = 7.5;
const MARGIN = 0.6;
const BODY_Y = 1.7;
const BODY_H = H - BODY_Y - 0.6;
const CONTENT_W = W - 2 * MARGIN;


interface Ctx {
  rtl: boolean;
  accent: string;
  currency: string;
  images: ImageLoader;
  placeholders: number;
}

// pptxgenjs ships CJS-style typings with `export default`; at runtime the ESM build's default is the class.
const PptxCtor = PptxModule as unknown as typeof PptxModule.default;
type Pres = InstanceType<typeof PptxCtor>;
type PptxSlide = ReturnType<Pres['addSlide']>;

/** One text run as pptxgenjs takes it (its own TextProps type is not importable under NodeNext). */
interface Run {
  text: string;
  options: Record<string, unknown>;
}

interface RunStyle {
  bold?: boolean;
  fontSize?: number;
  color?: string;
}

/** Text runs for one paragraph; digit runs are separate LTR runs in Hebrew. */
function runs(text: string, ctx: Ctx, style: RunStyle = {}): Run[] {
  const base = { fontFace: FONT, ...style };
  if (!ctx.rtl) return [{ text, options: { ...base, lang: 'en-US' } }];
  // pptxgenjs reads the paragraph's rtl from the first run's options, so every run carries it.
  return splitNumberRuns(text).map((p) => ({
    text: p.text,
    options: { ...base, rtlMode: true, lang: p.ltr ? 'en-US' : 'he-IL' },
  }));
}

function textOpts(ctx: Ctx, box: { x: number; y: number; w: number; h: number }, extra: Record<string, unknown> = {}) {
  return {
    ...box,
    fontFace: FONT,
    align: ctx.rtl ? ('right' as const) : ('left' as const),
    valign: 'top' as const,
    lang: ctx.rtl ? 'he-IL' : 'en-US',
    ...(ctx.rtl ? { rtlMode: true } : {}),
    ...extra,
  };
}

function addTitle(slide: PptxSlide, rawTitle: string, n: number, ctx: Ctx): void {
  const title = stripOwnNumber(rawTitle, n).trim();
  slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.18, fill: { color: ctx.accent }, line: { color: ctx.accent } });
  slide.addText(runs(title, ctx, { bold: true, fontSize: 32, color: ctx.accent }), textOpts(ctx, { x: MARGIN, y: 0.45, w: CONTENT_W, h: 1.0 }, { valign: 'middle' }));
}

async function loadImage(documentId: string, ctx: Ctx, where: string): Promise<CheckedImage | null> {
  const img = await ctx.images(documentId);
  if (img === null) return null;
  return checkImage(img, where);
}

function addPlaceholder(slide: PptxSlide, ctx: Ctx, box: { x: number; y: number; w: number; h: number }): void {
  ctx.placeholders += 1;
  slide.addText(ctx.rtl ? 'כאן תמונה' : 'Image here', {
    ...box,
    fontFace: FONT,
    fontSize: 20,
    color: '595959',
    align: 'center',
    valign: 'middle',
    lang: ctx.rtl ? 'he-IL' : 'en-US',
    ...(ctx.rtl ? { rtlMode: true } : {}),
    fill: { color: 'D9D9D9' },
    line: { color: 'A6A6A6', width: 1 },
  });
}

/** Places an image scaled to fit (contain) and centred inside the box; a missing one becomes a placeholder. */
async function placeImage(
  slide: PptxSlide,
  documentId: string,
  ctx: Ctx,
  box: { x: number; y: number; w: number; h: number },
  where: string,
): Promise<void> {
  const img = await loadImage(documentId, ctx, where);
  if (img === null) {
    addPlaceholder(slide, ctx, box);
    return;
  }
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  slide.addImage({
    data: `${img.mediaType};base64,${img.bytes.toString('base64')}`,
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    w,
    h,
  });
}

function titleSlide(slide: PptxSlide, s: Extract<Slide, { type: 'title' }>, ctx: Ctx): void {
  slide.background = { color: ctx.accent };
  slide.addText(runs(s.title, ctx, { bold: true, fontSize: 44, color: 'FFFFFF' }), textOpts(ctx, { x: MARGIN, y: 2.3, w: CONTENT_W, h: 1.6 }, { valign: 'middle' }));
  if (s.subtitle !== undefined) {
    slide.addText(runs(s.subtitle, ctx, { fontSize: 24, color: 'F2F2F2' }), textOpts(ctx, { x: MARGIN, y: 4.1, w: CONTENT_W, h: 1.2 }));
  }
}

function bulletsSlide(slide: PptxSlide, s: Extract<Slide, { type: 'titleBullets' }>, n: number, ctx: Ctx): void {
  addTitle(slide, s.title, n, ctx);
  const items: Run[] = [];
  s.bullets.forEach((b, i) => {
    const r = runs(b, ctx, { fontSize: 24, color: '262626' });
    r.forEach((run, j) => {
      items.push({
        text: run.text,
        options: {
          ...run.options,
          ...(j === 0 ? { bullet: true } : {}),
          ...(j === r.length - 1 && i < s.bullets.length - 1 ? { breakLine: true } : {}),
          paraSpaceAfter: 10,
        },
      });
    });
  });
  slide.addText(items, textOpts(ctx, { x: MARGIN, y: BODY_Y, w: CONTENT_W, h: BODY_H }));
}

function tableSlide(slide: PptxSlide, s: Extract<Slide, { type: 'table' }>, n: number, ctx: Ctx, where: string): void {
  addTitle(slide, s.title, n, ctx);
  const order = s.header.map((_, i) => i);
  if (ctx.rtl) order.reverse(); // first column drawn at the right edge
  const cellOpts = (extra: Record<string, unknown>) => ({
    fontFace: FONT,
    fontSize: 16,
    align: ctx.rtl ? ('right' as const) : ('left' as const),
    valign: 'middle' as const,
    lang: ctx.rtl ? 'he-IL' : 'en-US',
    ...(ctx.rtl ? { rtlMode: true } : {}),
    border: { type: 'solid' as const, pt: 0.75, color: 'BFBFBF' },
    ...extra,
  });
  const head = order.map((i) => ({
    // runs() splits digit runs into their own LTR runs, like every other Hebrew text
    text: runs(s.header[i] as string, ctx, { bold: true, fontSize: 16, color: 'FFFFFF' }),
    options: cellOpts({ bold: true, color: 'FFFFFF', fill: { color: ctx.accent } }),
  }));
  const body = s.rows.map((row, r) =>
    order.map((i) => ({
      text: formatCell(row[i] ?? { t: '' }, s.numberFormat?.[i], ctx.currency, `${where}.rows[${r}][${i}]`),
      options: cellOpts({ color: '262626' }),
    })),
  );
  slide.addTable([head, ...body], { x: MARGIN, y: BODY_Y, w: CONTENT_W, autoPage: false });
}

function numericValue(cell: Cell | undefined, where: string): number {
  if (cell !== undefined && 'v' in cell) return cell.v;
  throw new SpecRenderError('chart_value_not_numeric', where);
}

function chartSlide(slide: PptxSlide, s: Extract<Slide, { type: 'chart' }>, n: number, ctx: Ctx, where: string): void {
  addTitle(slide, s.title, n, ctx);
  const labels = s.rows.map((row, r) =>
    formatCell(row[s.labelColumn] ?? { t: '' }, undefined, ctx.currency, `${where}.rows[${r}][${s.labelColumn}]`),
  );
  const values = s.rows.map((row, r) => numericValue(row[s.column], `${where}.rows[${r}][${s.column}]`));
  const type = s.chartType;
  const rtlAxis = ctx.rtl && s.chartType !== 'pie' ? { catAxisOrientation: 'maxMin' as 'minMax' } : {}; // typings only list 'minMax'; the writer emits any value
  slide.addChart(type, [{ name: s.header[s.column] ?? '', labels, values }], {
    x: MARGIN,
    y: BODY_Y,
    w: CONTENT_W,
    h: BODY_H,
    chartColors: [ctx.accent, '1B7F8C', '2E7D32', '7B1E3A', 'D9730D', '595959'],
    showLegend: s.chartType === 'pie',
    legendPos: 'b',
    showValue: true,
    // The data labels carry every value; a value axis would only add numbers no source gave.
    ...(s.chartType === 'pie' ? {} : { valAxisHidden: true }),
    catAxisLabelFontFace: FONT,
    valAxisLabelFontFace: FONT,
    dataLabelFontFace: FONT,
    ...rtlAxis,
  });
}

async function imageTextSlide(slide: PptxSlide, s: Extract<Slide, { type: 'imageText' }>, n: number, ctx: Ctx, where: string): Promise<void> {
  addTitle(slide, s.title, n, ctx);
  const half = (CONTENT_W - 0.4) / 2;
  const textX = ctx.rtl ? MARGIN + half + 0.4 : MARGIN; // text on the reading-start side
  const imageX = ctx.rtl ? MARGIN : MARGIN + half + 0.4;
  slide.addText(runs(s.text, ctx, { fontSize: 22, color: '262626' }), textOpts(ctx, { x: textX, y: BODY_Y, w: half, h: BODY_H }));
  await placeImage(slide, s.documentId, ctx, { x: imageX, y: BODY_Y, w: half, h: BODY_H }, where);
}

type Box = { x: number; y: number; w: number; h: number };

/** Grid by image count: 2 -> 1x2, 3 -> 1+2, 4 -> 2x2, 5..6 -> 2x3. */
export function collageBoxes(count: number, area: Box): Box[] {
  const gap = 0.2;
  const rowsOf = (cols: number[]): Box[] => {
    const rows = cols.length;
    const h = (area.h - gap * (rows - 1)) / rows;
    return cols.flatMap((c, r) => {
      const w = (area.w - gap * (c - 1)) / c;
      return Array.from({ length: c }, (_, i) => ({ x: area.x + i * (w + gap), y: area.y + r * (h + gap), w, h }));
    });
  };
  switch (count) {
    case 2:
      return rowsOf([2]);
    case 3:
      return rowsOf([1, 2]);
    case 4:
      return rowsOf([2, 2]);
    case 5:
    case 6:
      return rowsOf(count === 5 ? [3, 2] : [3, 3]);
    default:
      throw new SpecRenderError('collage_size', String(count));
  }
}

async function collageSlide(slide: PptxSlide, s: Extract<Slide, { type: 'collage' }>, n: number, ctx: Ctx, where: string): Promise<void> {
  let area: Box = { x: MARGIN, y: 0.5, w: CONTENT_W, h: H - 1.0 };
  if (s.title !== undefined) {
    addTitle(slide, s.title, n, ctx);
    area = { x: MARGIN, y: BODY_Y, w: CONTENT_W, h: BODY_H };
  }
  const boxes = collageBoxes(s.documentIds.length, area);
  for (let i = 0; i < boxes.length; i += 1) {
    await placeImage(slide, s.documentIds[i] as string, ctx, boxes[i] as Box, `${where} image ${i + 1}`);
  }
}

function paragraphSlide(slide: PptxSlide, s: Extract<Slide, { type: 'paragraph' }>, n: number, ctx: Ctx): void {
  let y = 0.6;
  let h = H - 1.2;
  if (s.title !== undefined) {
    addTitle(slide, s.title, n, ctx);
    y = BODY_Y;
    h = BODY_H;
  }
  slide.addText(runs(s.text, ctx, { fontSize: 24, color: '262626' }), textOpts(ctx, { x: MARGIN, y, w: CONTENT_W, h }));
}

export async function renderPptx(
  spec: PptxSpec,
  options: RenderPptxOptions,
): Promise<{ buffer: Buffer; placeholders: number }> {
  const ctx: Ctx = {
    rtl: spec.language === 'he',
    accent: ACCENT_HEX[spec.style.accent],
    currency: options.currency,
    images: options.images,
    placeholders: 0,
  };
  const pres = new PptxCtor();
  pres.layout = 'LAYOUT_WIDE';
  pres.title = spec.title;
  pres.rtlMode = ctx.rtl;
  pres.theme = { headFontFace: FONT, bodyFontFace: FONT };

  for (let i = 0; i < spec.slides.length; i += 1) {
    const s = spec.slides[i] as Slide;
    const n = i + 1;
    const where = `slide ${n}`;
    const slide = pres.addSlide();
    switch (s.type) {
      case 'title':
        titleSlide(slide, s, ctx);
        break;
      case 'titleBullets':
        bulletsSlide(slide, s, n, ctx);
        break;
      case 'table':
        tableSlide(slide, s, n, ctx, where);
        break;
      case 'chart':
        chartSlide(slide, s, n, ctx, where);
        break;
      case 'imageText':
        await imageTextSlide(slide, s, n, ctx, where);
        break;
      case 'collage':
        await collageSlide(slide, s, n, ctx, where);
        break;
      case 'paragraph':
        paragraphSlide(slide, s, n, ctx);
        break;
    }
  }

  const out = (await pres.write({ outputType: 'nodebuffer' })) as Buffer;
  return { buffer: Buffer.from(out), placeholders: ctx.placeholders };
}
