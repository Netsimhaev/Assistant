/**
 * Every balanced JSON object in a response that may be wrapped in prose or a
 * fenced block.
 *
 * Balanced scanning rather than first `{` to last `}`: across two objects that
 * span is not valid JSON at all. Returning every candidate rather than the
 * first lets the caller decide which one is the answer — being parseable and
 * being the shape the caller wants are different questions.
 *
 * Shared rather than restated: this was three private, byte-for-byte
 * identical copies (`src/sdk/planner.ts`, `src/documents/reading-parse.ts`,
 * `src/orchestrator/proposal-parse.ts`) before this file existed. A fourth
 * copy in `src/sdk/gov-verify.ts` was the occasion to stop duplicating it —
 * that module must never import `planner.ts`, because `planner.ts` imports
 * `local-tools.ts` for an unrelated reason (rendering local tool contracts
 * into the planner's own prompt) and `local-tools.ts` imports `readDocument`.
 * `gov.verify`'s quarantine forbids reaching that module transitively, not
 * just directly — see `gov-verify.test.ts`'s import-graph invariant.
 */
export function extractJsonObjects(raw: string): unknown[] {
  const text = raw.replace(/```(?:json)?/g, '');
  const found: unknown[] = [];

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            found.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            // Not valid on its own; the next opening brace may still be.
          }
          break;
        }
      }
    }
  }
  return found;
}
