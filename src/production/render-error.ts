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
