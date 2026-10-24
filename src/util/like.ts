/**
 * LIKE-escaping helpers, shared by the erasure resolver and the mail search.
 * Moved out of governance/erasure-plan.ts: the erasure-invariants test forbids
 * production files outside its allowlist from importing that module.
 */

/**
 * Escapes what `LIKE` would otherwise read as a pattern.
 *
 * The anchor is owner-supplied text. A bare `%` would match every row in
 * every table searched — the same reason `recallMemories` escapes its
 * keyword.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The `ESCAPE` clause every `LIKE`/`ILIKE` in this module carries, written
 * once.
 *
 * `likeLiteral` above prefixes a backslash, and that prefix means nothing
 * unless the statement also DECLARES backslash as the escape character. The
 * two halves only work as a pair, so they live as a pair.
 *
 * **Why a constant and not fourteen typed clauses** (fix round 3, and the
 * class behind F1). Written inline, the clause is spelled with two
 * backslashes inside a template literal. One instead of two is not a syntax
 * error, not a type error and not visibly wrong: the literal quietly
 * collapses to `ESCAPE ''`, which disables escape processing altogether, and
 * the statement then fails *only* for an anchor containing `_`, `%` or a
 * backslash — an ordinary email local part. That is exactly how it reached
 * the last gate of this branch, in the one clause that had just been added.
 * A property held right fourteen times by hand is a property waiting to
 * break — the same argument that put the `proposals` predicate in one place.
 *
 * Spelled with `String.raw` deliberately: it is the one spelling the
 * collapsing rule cannot touch, so the fix cannot be undone by the mechanism
 * that caused the defect. It is the same ten characters as the two-backslash
 * template spelling — verified by running both, not assumed.
 */
export const LIKE_ESCAPE = String.raw`ESCAPE '\'`;
