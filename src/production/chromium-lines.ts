/**
 * The line joiner for the text of OUR OWN produced PDFs (check 2 only),
 * passed to the extractor's `linesOf` as its `joiner`. Incoming documents are
 * never read with it — they keep `joinLine` in `documents/extractors/pdf.ts`
 * (review ruling (a)): regrouping items across gaps would reorder the cells
 * of an arbitrary table.
 *
 * Why it exists: headless Chromium writes every glyph run as its own pdf.js
 * item, in VISUAL order — a Latin word split at a ligature (`O|ffi|ce`), a
 * currency sign apart from its number (`₪|1,890`), a lone mirrored bracket.
 * Ordering those items right to left, as `joinLine` does, reverses every
 * left-to-right run inside a Hebrew line (`Pro ceffiO`, `1,890₪`,
 * `)ראה סעיף 4.2(`), measured on a real produced PDF.
 *
 * What it does:
 *  - base direction by LETTERS only — digits and punctuation do not vote,
 *    so a Hebrew table row of numbers is still a Hebrew row;
 *  - items in visual order along the base direction; consecutive items of
 *    the OTHER direction form one run, which is reversed. Items that touch
 *    always group; across a word gap only two letters of that direction do,
 *    and only up to `MAX_CROSS_GAP_EM` (a space between words, never the
 *    gap between two table cells);
 *  - a terminator (`₪`, `%`) touching a number joins it; a neutral touching
 *    two items of the other direction joins their run;
 *  - every other neutral takes the base direction, and in a right-to-left
 *    context its bracket is the mirrored glyph, so it is swapped back.
 *
 * pdf.js's per-item `dir` (`PlacedText.rtl`) is deliberately unused: it
 * marks digits and every neutral `ltr`, which is exactly what goes wrong
 * here; the classes are read from the characters instead.
 *
 * Known limits: a producer that already maps a mirrored glyph to its logical
 * character would have its brackets swapped (Chromium does not); two-column
 * layouts are not separated.
 */
import { WORD_GAP, type PlacedText } from '../documents/extractors/pdf.js';

/** Widest gap (in ems of the larger font) two same-direction words are still joined across. */
export const MAX_CROSS_GAP_EM = 0.5;

/** Characters of a right-to-left script (Hebrew, Arabic, Syriac, Thaana, NKo). */
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
/** Terminators that belong to an adjacent number (₪1,890, 39%), as the bidi algorithm's ET class. */
const NUMBER_TERMINATOR = /^[\p{Sc}%‰°#+\-−]+$/u;
/** A neutral drawn in a right-to-left context is the mirrored glyph; its logical character is the other one. */
const MIRROR: Readonly<Record<string, string>> = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«',
};

/** R: right-to-left letters; L: other letters; EN: a number; N: neither (punctuation). */
type BidiClass = 'R' | 'L' | 'EN' | 'N';

function classOf(text: string): BidiClass {
  if (RTL_LETTER.test(text)) return 'R';
  if (LETTER.test(text)) return 'L';
  if (DIGIT.test(text)) return 'EN';
  return 'N';
}

function mirrored(text: string): string {
  return [...text].map((ch) => MIRROR[ch] ?? ch).join('');
}

export function joinChromiumLine(items: PlacedText[]): string {
  let rtlLetters = 0;
  let otherLetters = 0;
  for (const item of items) {
    for (const ch of item.str) {
      if (RTL_LETTER.test(ch)) rtlLetters += 1;
      else if (LETTER.test(ch)) otherLetters += 1;
    }
  }
  const rtl = rtlLetters > otherLetters;
  const ordered = [...items].sort((a, b) => (rtl ? b.x + b.width - (a.x + a.width) : a.x - b.x));

  // gapEm[i]: the gap between ordered[i - 1] and ordered[i], in ems of the larger font.
  const gapEm = ordered.map((item, i) => {
    const previous = ordered[i - 1];
    if (previous === undefined) return 0;
    const gap = rtl ? previous.x - (item.x + item.width) : item.x - (previous.x + previous.width);
    return gap / Math.max(previous.size, item.size);
  });
  const gapBefore = gapEm.map((g, i) => i > 0 && g > WORD_GAP);

  const classes = ordered.map((item) => classOf(item.str));
  // Terminators touching a number are part of it.
  classes.forEach((c, i) => {
    if (c !== 'N' || !NUMBER_TERMINATOR.test(ordered[i]?.str ?? '')) return;
    const touchesNumber =
      (classes[i - 1] === 'EN' && !gapBefore[i]) || (classes[i + 1] === 'EN' && gapBefore[i + 1] === false);
    if (touchesNumber) classes[i] = 'EN';
  });
  const isOther = (c: BidiClass | undefined) => (rtl ? c === 'L' || c === 'EN' : c === 'R');
  const otherLetter: BidiClass = rtl ? 'L' : 'R';
  // A neutral touching two items of the other direction joins their run.
  const foreign = classes.map(
    (c, i) =>
      isOther(c) ||
      (c === 'N' && isOther(classes[i - 1]) && isOther(classes[i + 1]) && !gapBefore[i] && gapBefore[i + 1] === false),
  );

  // Segments of consecutive ordered indices; other-direction runs are reversed.
  const segments: number[][] = [];
  for (let i = 0; i < ordered.length; i++) {
    const current = segments[segments.length - 1];
    const previous = i - 1;
    const wordGap =
      classes[previous] === otherLetter && classes[i] === otherLetter && (gapEm[i] ?? 0) <= MAX_CROSS_GAP_EM;
    const joins = current !== undefined && foreign[i] === true && foreign[previous] === true && (!gapBefore[i] || wordGap);
    if (joins) current.push(i);
    else segments.push([i]);
  }

  let line = '';
  let first = true;
  for (const segment of segments) {
    const start = segment[0] as number;
    const reversed = foreign[start] === true && segment.length > 1;
    const sequence = reversed ? [...segment].reverse() : segment;
    sequence.forEach((index, k) => {
      const item = ordered[index] as PlacedText;
      // Space before this item: the boundary gap for a segment's first item,
      // otherwise the gap that separated it from its visual neighbour.
      const spaceBefore = first ? false : k === 0 ? gapBefore[start] : reversed ? gapBefore[index + 1] : gapBefore[index];
      if (spaceBefore === true && !/\s$/.test(line) && !/^\s/.test(item.str)) line += ' ';
      const neutralInRtl = classes[index] === 'N' && (rtl ? !foreign[index] : foreign[index] === true);
      line += neutralInRtl ? mirrored(item.str) : item.str;
      first = false;
    });
  }
  return line;
}
