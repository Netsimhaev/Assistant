/**
 * Per-call-nonce fences for hostile text in model prompts. Imports nothing, on
 * purpose: `sdk/gov-verify.ts` must stay free of any transitive import that
 * reads document content, so this helper cannot be allowed to grow imports.
 * The nonce is the boundary; stripping is belt-and-braces (see gov-verify.ts).
 */
export interface Fence {
  open: string;
  close: string;
}

/** `nonce` must be non-empty: an empty one is a fixed, forgeable marker. */
export function buildFence(label: string, nonce: string): Fence {
  if (nonce.length === 0) {
    throw new Error('buildFence: nonce must not be empty — an empty nonce is a fixed, forgeable marker');
  }
  return { open: `=== ${label} :: ${nonce} ===`, close: `=== סוף ${label} :: ${nonce} ===` };
}

/**
 * Remove every occurrence of `marker`, re-scanning until nothing changes — a
 * single pass lets two fragments around a real occurrence recombine into a
 * new marker. Terminates: each productive pass strictly shortens the string.
 */
export function stripUntilStable(text: string, marker: string): string {
  let result = text;
  for (;;) {
    const next = result.split(marker).join('');
    if (next === result) return result;
    result = next;
  }
}

export function stripFenceMarkers(text: string, fence: Fence): string {
  return stripUntilStable(stripUntilStable(text, fence.open), fence.close);
}
