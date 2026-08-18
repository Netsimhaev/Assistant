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
  businessId: process.env['BUSINESS_ID'] ?? 'dev-business',
} as const;
