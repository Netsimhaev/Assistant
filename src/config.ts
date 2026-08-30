import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `missing required environment variable ${name} — copy .env.example to .env`,
    );
  }
  return value;
}

/**
 * Vitest sets NODE_ENV=test via vitest.config.ts. A CLI run cannot rely on
 * that: `NODE_ENV=test <cmd>` is not portable to Windows shells, and pulling
 * in cross-env for one script is a dependency for nothing. `--test-db` selects
 * the same branch.
 *
 * Read from argv rather than written into env, because ESM hoists imports — a
 * module that sets process.env in its body runs *after* this file has already
 * been evaluated, so the assignment would come too late to matter.
 */
const isTest =
  process.env['NODE_ENV'] === 'test' || process.argv.includes('--test-db');

export const config = {
  isTest,
  /**
   * Tests run against a separate database because they truncate between files.
   * Pointing them at the dev database would silently destroy dev state.
   */
  databaseUrl: isTest ? required('TEST_DATABASE_URL') : required('DATABASE_URL'),
  // Required, not defaulted. This key scopes the charter, the kill switch, the
  // spend ledger and the audit chain; a deploy that forgets it would run under
  // someone else's name and interleave two businesses' audit chains.
  businessId: required('BUSINESS_ID'),
  // Required, not defaulted — same reasoning as BUSINESS_ID above. This is
  // the one directory the reading agent (`know.reader`, gate-hook.ts's path
  // check) is scoped to, and it is where ingestDocument stores every
  // document's bytes (spec §3.5: "same root, not a second root"). A deploy
  // that forgot this and fell back to some default would write documents
  // into a directory the reader was never told about — ingested and
  // unreadable.
  //
  // Resolved against `process.cwd()` here, once, rather than left relative:
  // a relative DOCUMENT_ROOT (the .env.example default, `./documents`) is
  // otherwise interpreted independently by every consumer that reads
  // `config.documentRoot` — `ingest.ts`'s `join(documentRoot, ...)`,
  // `gate-hook.ts`'s `isPathWithin` comparison, and `know-reader.ts`'s own
  // subprocess `cwd` — and none of them share a guarantee about the
  // process's current working directory at the time they run. Resolving
  // once here means every consumer agrees on the same absolute path
  // regardless of where the process was launched from; `resolve()` is a
  // no-op for a path that is already absolute (every test in this codebase
  // passes one via `documentRoot` overrides), so this changes nothing for
  // them.
  documentRoot: resolve(required('DOCUMENT_ROOT')),
} as const;
