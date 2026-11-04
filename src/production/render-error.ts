/**
 * Every reason a validated spec can still fail to render. Closed: a new code
 * is a compile error in `RENDER_ERROR_HE` until someone writes the owner's
 * Hebrew for it.
 */
export type RenderErrorCode =
  | 'chart_value_not_numeric'
  | 'collage_size'
  | 'formula_error'
  | 'formula_in_document'
  | 'image_too_large'
  | 'pdf_memory'
  | 'pdf_too_large'
  | 'render_failed'
  | 'render_memory'
  | 'render_timeout'
  | 'unknown_image'
  | 'unsupported_image';

/** Raised when a validated spec still cannot be rendered faithfully. Shared by every renderer. */
export class SpecRenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    readonly where: string,
  ) {
    super(`${code} @ ${where}`);
    this.name = 'SpecRenderError';
  }
}

/**
 * The owner-facing reason a production ends `failed` with, per render code.
 * Fixed text: no reason carries spec or source text. Exhaustive.
 */
export const RENDER_ERROR_HE: Readonly<Record<RenderErrorCode, string>> = Object.freeze({
  chart_value_not_numeric: 'לא ניתן היה לבנות גרף: אחד הערכים בו אינו מספר',
  collage_size: 'לא ניתן היה לבנות קולאז׳ תמונות במספר התמונות שנבחר',
  formula_error: 'נוסחה בגיליון מחזירה שגיאה, ולכן הקובץ לא נבנה',
  formula_in_document: 'נוסחה הופיעה מחוץ לגיליון אקסל, ולכן הקובץ לא נבנה',
  image_too_large: 'אחת התמונות גדולה מדי לשילוב במסמך',
  pdf_memory: 'בניית ה-PDF חרגה ממגבלת הזיכרון של השרת',
  pdf_too_large: 'המסמך גדול מדי לבניית PDF',
  render_failed: 'בניית הקובץ נכשלה',
  render_memory: 'הכנת תמונות העמודים לבדיקה חרגה ממגבלת הזיכרון של השרת',
  render_timeout: 'בניית הקובץ או הכנת העמודים לבדיקה לא הסתיימה בזמן',
  unknown_image: 'תמונה שהמסמך מפנה אליה לא נמצאה',
  unsupported_image: 'אחת התמונות בפורמט שאינו נתמך',
});

/** The Hebrew reason for a render failure; anything that is not a `SpecRenderError` reads as a failed build. */
export function renderErrorReason(err: unknown): string {
  if (err instanceof SpecRenderError && Object.hasOwn(RENDER_ERROR_HE, err.code)) return RENDER_ERROR_HE[err.code];
  return RENDER_ERROR_HE.render_failed;
}

/**
 * The owner-facing reason a production fails with (stage `failed`) when the
 * server lacks LibreOffice or Chromium. Here, not in `page-images.ts`, so
 * `buildRuntime` can name it without loading Playwright.
 */
export const PRODUCTION_TOOLS_MISSING_REASON = 'כלי ההפקה אינו מותקן בשרת';
