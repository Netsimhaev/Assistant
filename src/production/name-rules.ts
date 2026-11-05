/**
 * The one rule for a name that may land on the owner's disk — a folder
 * segment in `doc.save` (`save.ts`) and the spec filename in `validateSpec`
 * (document production §9.2: "שם הקובץ עובר את אותם כללים").
 *
 * One module, no `node:fs`, so `validate-spec.ts` can import it without
 * pulling filesystem code. Before it existed the two copies disagreed: the
 * spec allowed combining marks (niqqud) and `COM¹`, so a name that production
 * accepted was refused at save — after the owner had already approved it.
 *
 * Positive throughout: the allowlist `/^[\p{L}\p{N} _.-]+$/u` (no `\p{M}`),
 * no leading dot, no `..`, no trailing dot or space (Windows strips them, so
 * `a.` IS `a` and `CON ` IS `CON`), no Windows device name — case-insensitive,
 * with or without an extension, and with the superscript digits `\p{N}` admits
 * (`COM¹` is a device too) — and at most 255 UTF-8 bytes, the per-component
 * limit of ext4 (NTFS counts 255 UTF-16 units, which 255 bytes never exceeds).
 */

export const SEGMENT_CHARS = /^[\p{L}\p{N} _.-]+$/u;
export const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
export const MAX_SEGMENT_BYTES = 255;

export const NAME_RULE_HE = {
  empty: 'יש שם ריק בנתיב',
  dots: 'אסור ".." בשם תיקייה או קובץ',
  chars: 'שם תיקייה או קובץ מכיל תו אסור (מותרים אותיות, ספרות, רווח, מקף, קו תחתון ונקודה)',
  leadingDot: 'שם תיקייה או קובץ לא יכול להתחיל בנקודה',
  trailing: 'שם תיקייה או קובץ לא יכול להסתיים בנקודה או ברווח',
  tooLong: 'שם תיקייה או קובץ ארוך מדי',
  reserved: (stem: string): string => `"${stem}" הוא שם שמור ב-Windows`,
} as const;

/** `null` when the name is allowed; otherwise the Hebrew reason. */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return NAME_RULE_HE.empty;
  if (name.includes('..')) return NAME_RULE_HE.dots;
  if (!SEGMENT_CHARS.test(name)) return NAME_RULE_HE.chars;
  if (name.startsWith('.')) return NAME_RULE_HE.leadingDot;
  if (name.endsWith('.') || name.endsWith(' ')) return NAME_RULE_HE.trailing;
  if (Buffer.byteLength(name, 'utf8') > MAX_SEGMENT_BYTES) return NAME_RULE_HE.tooLong;
  const stem = (name.split('.')[0] ?? '').trim();
  if (WINDOWS_RESERVED.test(stem)) return NAME_RULE_HE.reserved(stem);
  return null;
}
