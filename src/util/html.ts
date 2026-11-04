/**
 * The one HTML escaping helper. It lives here, not in the dashboard, so that
 * a non-dashboard caller (the PDF renderer, `src/production/render-html.ts`)
 * can use the same function without importing every dashboard view.
 * `src/dashboard/views.ts` re-exports it unchanged.
 *
 * Stringifies first (so numbers, booleans, `null` are safe to pass too), then escapes.
 */
export function escapeHtml(value: unknown): string {
  const str =
    typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
