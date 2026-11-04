/** Raised when a validated spec still cannot be rendered faithfully. Shared by every renderer. */
export class SpecRenderError extends Error {
  constructor(
    readonly code: string,
    readonly where: string,
  ) {
    super(`${code} @ ${where}`);
    this.name = 'SpecRenderError';
  }
}

/**
 * The owner-facing reason a production fails with (stage `failed`) when the
 * server lacks LibreOffice or Chromium. Here, not in `page-images.ts`, so
 * `buildRuntime` can name it without loading Playwright.
 */
export const PRODUCTION_TOOLS_MISSING_REASON = 'כלי ההפקה אינו מותקן בשרת';
