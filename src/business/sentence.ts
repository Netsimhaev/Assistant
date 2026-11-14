/**
 * Pure sentence helpers for the business description. Kept free of DB imports
 * so the proposal parser (`description-proposals.ts`) stays a pure module;
 * `description-store.ts` re-exports both.
 */
import { createHash } from 'node:crypto';

/** Whitespace collapsed to one space, trimmed, Latin lower-cased. */
export function normaliseSentence(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function sentenceHash(s: string): string {
  return createHash('sha256').update(normaliseSentence(s)).digest('hex');
}
