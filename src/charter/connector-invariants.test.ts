/**
 * Two source scans and one end-to-end leak scan for the connector spine
 * (grant store, token service, consent ceremony).
 *
 * **Why this file lives in `src/charter/`, not `src/governance/` beside
 * `oauth-grants.ts` itself.** It follows `capabilities.test.ts`'s role in
 * this directory: a suite of structural invariants over the codebase, not a
 * behaviour test of any one module. `erasure-invariants.test.ts` is the
 * template both scans below copy, down to the walk itself.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { writeKeyState } from '../governance/master-key.js';
import { writeGrant } from '../governance/oauth-grants.js';
import { oauthCredentials } from '../orchestrator/oauth-token.js';
import type { RefreshOutcome, TokenHttp } from '../orchestrator/oauth-token.js';
import type { CredentialSource } from '../orchestrator/credentials.js';

/**
 * The grant store's own WRITE surface — `writeGrant`, `recordRefresh`,
 * `markNeedsReauth`, `revokeGrant`. This is the narrow path a deliberate
 * design decision opened (see `oauth-grants.ts`'s module docblock and
 * `oauth-routes.ts`'s "the grant write lives here, and ONLY here"), and
 * widening it undoes the control it sits beside.
 *
 * **Deliberately NOT every export of `oauth-grants.ts`.** The readers —
 * `readGrantByRef`, `readGrantBySystem`, `grantStatusByRef`, `listGrants` —
 * are fine anywhere: `listGrants` in particular takes no key and is
 * structurally incapable of returning a token, which is exactly why the
 * connections screen (`src/dashboard/views.ts` / whichever screen renders
 * `/connections`) is allowed to call it. A scan that pinned "any importer of
 * the module" would turn red the moment a screen reads a summary, and a
 * maintainer would loosen the invariant rather than fix a real violation —
 * worse than no invariant at all.
 */
const WRITER_EXPORTS = ['writeGrant', 'recordRefresh', 'markNeedsReauth', 'revokeGrant'] as const;

/**
 * True when `source` imports at least one of `WRITER_EXPORTS` from
 * `oauth-grants.js`. Matches the named-import clause specifically (not just
 * "the string `writeGrant` appears somewhere in the file") so a comment or a
 * docblock that merely *mentions* a writer's name — this file's own header
 * does, right above — can never be mistaken for an importer. The character
 * class `[^}]*` spans newlines the way `.` does not, so a braced import
 * spread across several lines is still matched.
 */
function importsGrantWriter(source: string): boolean {
  const importClauses = source.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*oauth-grants\.js['"]/g,
  );
  for (const match of importClauses) {
    const names = match[1] ?? '';
    for (const writer of WRITER_EXPORTS) {
      const namedPattern = new RegExp(`(?:^|[,{\\s])${writer}(?:\\s*,|\\s*}|\\s|$)`);
      if (namedPattern.test(names)) return true;
    }
  }
  return false;
}

describe('the grant writer stays behind two files', () => {
  /**
   * Recursive walk over all of `src/`, in the pattern
   * `erasure-invariants.test.ts` already uses for "is imported by nothing
   * outside erasure.ts itself and the dashboard" — NOT a hand-written
   * directory or file list. That file's own header explains why: a manual
   * `roots` list once covered five directories and silently skipped six
   * others. Walking the whole tree and excluding only by filename suffix
   * means a directory added next year is scanned by default, not skipped by
   * default.
   */
  it('only the token service and the dashboard import the grant writer', async () => {
    const scanned: string[] = [];
    const importers: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        scanned.push(path);
        const source = await readFile(path, 'utf8');
        if (importsGrantWriter(source)) {
          importers.push(path.split(sep).join('/'));
        }
      }
    };

    await walk('src');

    // A scan that read zero files would pass with the same empty
    // `importers` a correct scan produces — the same "found nothing" failure
    // mode `reading-invariants.test.ts` and `erasure-invariants.test.ts`
    // both guard against. The tree has well over a thousand `.ts` files
    // today; 100 only has to stay comfortably above zero.
    expect(scanned.length).toBeGreaterThan(100);

    expect(importers.sort()).toEqual([
      'src/dashboard/oauth-routes.ts',
      'src/orchestrator/oauth-token.ts',
    ]);
  });

  /**
   * `secret-key.ts`'s `rotate` re-encrypts `credentials` and `oauth_grants`
   * in the same transaction (see that file's own docblock on the grant
   * loop). A grant sealed under a retired key is unopenable forever — the
   * connector believes it has a live connection right up until the next
   * refresh, which fails with nothing pointing at why. Checked by reading
   * the source, the same way the module-import scan above is: the property
   * is "does the rotation loop name this table", not "does calling rotate
   * happen to work today with the fixture this test built".
   */
  it('key rotation names the grant table', async () => {
    const source = await readFile('src/cli/secret-key.ts', 'utf8');
    expect(source).toContain('FROM oauth_grants');
  });
});

describe('an OAuth refresh token leaves no trace outside its own ciphertext', () => {
  const BUSINESS = 'connector-leak-business';
  const KEY = randomBytes(32);

  /**
   * Distinctive and shaped like a real refresh token, so a match anywhere is
   * this test's doing and not a coincidence — the same reasoning
   * `erasure-invariants.test.ts`'s `PROBE` constant documents for its own
   * sentinel.
   */
  const SENTINEL = 'zz-oauth-leak-probe-4d81-refresh-token-sentinel-value';

  beforeEach(async () => {
    await resetDatabase();
    await writeKeyState(KEY, 'KEY-connector-leak-scan');
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * Seed a grant carrying the sentinel as its refresh token, then drive a
   * FULL resolve through `oauthCredentials` — the token service every real
   * adapter call goes through — so the value passes through every layer
   * that touches it: decryption, the cache write, and the handle handed
   * back to a caller. Then pull every `text`/`character varying`/`json`/
   * `jsonb`/`ARRAY` column of every table from `information_schema.columns`
   * — never a list written by hand, for the identical reason
   * `erasure-invariants.test.ts` reads the schema instead of a fixed list —
   * and demand zero occurrences anywhere but the grant's own ciphertext.
   */
  it('never writes the refresh token anywhere the schema can hold text', async () => {
    await writeGrant(
      {
        businessId: BUSINESS,
        system: 'office-calendar',
        provider: 'google',
        credentialRef: 'OFFICE_CALENDAR',
        account: 'owner@example.com',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        refreshToken: SENTINEL,
        grantedBy: 'owner',
      },
      KEY,
    );

    const noFallback: CredentialSource = {
      resolve: async () => null,
    };
    const http: TokenHttp = {
      async exchangeRefresh(): Promise<RefreshOutcome> {
        return {
          ok: true,
          accessToken: 'issued-access-token-value',
          expiresInSeconds: 3600,
          rotatedRefreshToken: null,
        };
      },
    };

    const source = oauthCredentials({ key: KEY, fallback: noFallback, http });
    const handle = await source.resolve('OFFICE_CALENDAR', BUSINESS);
    expect(handle?.value).toBe('issued-access-token-value');

    const { rows: columns } = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`,
    );

    // An empty result set would make the loop below vacuous, exactly the
    // failure `erasure-invariants.test.ts` guards against for its own sweep
    // — zero columns scanned "passes" with the same `[]` as zero matches
    // found. The schema carries well over 200 such columns today; this only
    // has to stay comfortably above zero.
    expect(columns.length).toBeGreaterThan(200);

    const found: string[] = [];
    for (const column of columns) {
      // `oauth_grants.ciphertext`/`.nonce` are `bytea`, not in this type
      // list at all, so the sealed value itself is never a candidate here —
      // this loop can only catch the token appearing in PLAINTEXT.
      const { rows } = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${column.table_name}"
          WHERE "${column.column_name}"::text LIKE $1`,
        [`%${SENTINEL}%`],
      );
      if (Number(rows[0]?.n ?? '0') > 0) {
        found.push(`${column.table_name}.${column.column_name}`);
      }
    }

    expect(found).toEqual([]);
  });
});
