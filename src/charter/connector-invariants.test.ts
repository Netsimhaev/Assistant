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
 * Classifies how (if at all) `source` reaches `oauth-grants.js`.
 *
 * **Two stages, deliberately, and the order matters: broad first, narrow
 * second — never the other way round.** A single-stage "parse the named
 * import clause and check it for a writer name" — what this function used
 * to do — recognises exactly one import SHAPE and is silently blind to every
 * other one: `import * as grants from '…/oauth-grants.js'` then
 * `grants.writeGrant(...)`, `export { writeGrant } from '…/oauth-grants.js'`,
 * and `const { writeGrant } = await import('…/oauth-grants.js')` all reach a
 * writer while matching no named-import clause at all — three concrete
 * bypasses, not a hypothetical one, all demonstrated against this exact
 * function in review. `erasure-invariants.test.ts`, the file this scan is
 * explicitly modelled on, already carries the scar of the same mistake: its
 * own docblock on `ERASURE_MODULE_FILES` records being burned once by a scan
 * that checked only static `from` imports and missed a dynamic
 * `import('../governance/erasure.js')` — which is exactly why that file's
 * regex matches `from` **or** a dynamic `import(...)`, not `from` alone.
 *
 * So this function fails CLOSED instead: first a BROAD check for any mention
 * of the module through `from` or `import(` at all (this catches every
 * import shape, including the three bypasses above); only once that fires
 * does a NARROW parse look for the one recognized clause shape
 * (`import { … } from '…/oauth-grants.js'`, `type` optionally on the
 * keyword or on any individual name) to decide reader-versus-writer. If the
 * broad check still finds a mention **after** every recognized narrow clause
 * has been stripped out of the text, that residue is a form this scan does
 * not understand — and it is treated exactly like a writer import
 * (`'unrecognized'`), never silently assumed safe. A scan that trusts what
 * it cannot parse is not a scan.
 */
function classifyGrantImport(source: string): 'none' | 'writer' | 'reader-only' | 'unrecognized' {
  const namedImportClauses = [
    ...source.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*oauth-grants\.js['"]/g,
    ),
  ];
  const withRecognizedClausesRemoved = source.replace(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*oauth-grants\.js['"]/g,
    '',
  );

  // Anything other than the one recognized clause shape above that still
  // mentions the module by way of `from` or a dynamic `import(` — a
  // namespace import, a re-export, `await import(...)` — is a form this
  // scan cannot classify as reader-only. Fail closed.
  if (/(?:from|import\s*\()\s*['"][^'"]*oauth-grants\.js['"]/.test(withRecognizedClausesRemoved)) {
    return 'unrecognized';
  }

  if (namedImportClauses.length === 0) return 'none';

  for (const match of namedImportClauses) {
    const names = match[1] ?? '';
    for (const writer of WRITER_EXPORTS) {
      const namedPattern = new RegExp(`(?:^|[,{\\s])${writer}(?:\\s*,|\\s*}|\\s|$)`);
      if (namedPattern.test(names)) return 'writer';
    }
  }
  return 'reader-only';
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
        const classification = classifyGrantImport(source);
        // 'unrecognized' fails closed — see `classifyGrantImport`'s own
        // docblock — and is reported exactly like a genuine writer import,
        // not as a separate, softer category a maintainer could shrug off.
        if (classification === 'writer' || classification === 'unrecognized') {
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
   * adapter call goes through. **What that actually exercises, precisely:**
   * the sentinel is decrypted out of the grant row, passes the ambiguity
   * check against the fallback source, and reaches `recordRefresh` (which
   * re-seals it, unchanged, back into `oauth_grants`). What lands in the
   * cache and in the handle returned to the caller is a SEPARATE, freshly
   * issued access token — the stub `TokenHttp`'s own `'issued-access-token-
   * value'`, asserted on the line above this comment — never the sentinel
   * itself. `oauthCredentials`'s own module docblock states the same thing
   * as a design rule ("the REFRESH token... is never cached"); this test
   * does not exercise a different path than that rule describes, and an
   * earlier draft of this comment wrongly claimed the sentinel reaches "the
   * cache write" — it does not, and the assertion below would have caught it
   * if it had. What this scan actually proves is the stronger, true claim:
   * the long-lived secret does not land in any text/JSON/array column
   * anywhere in the schema on the path a real resolve takes, cache miss
   * included. Then pull every `text`/`character varying`/`json`/`jsonb`/
   * `ARRAY` column of every table from `information_schema.columns` — never
   * a list written by hand, for the identical reason
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
