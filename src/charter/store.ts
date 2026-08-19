import { config } from '../config.js';
import { BusinessCharter, CURRENT_SCHEMA_VERSION } from '../domain/charter.js';
import { PolicyBundle } from '../domain/policy.js';
import { getPool, withTransaction, type Queryable } from '../db/pool.js';
import { compileCharter } from './compile.js';
import { verifyCharterSignature } from './sign.js';

interface CharterRow {
  charter: unknown;
  policy_bundle: unknown;
}

/**
 * Compares two `major.minor` schema version strings. Returns negative when
 * `a` is older than `b`, positive when newer, `0` when equal, and `null` when
 * either string does not fit the pattern — in which case the caller must not
 * guess a direction, only report a mismatch.
 */
function compareSchemaVersions(a: string, b: string): number | null {
  const pattern = /^(\d+)\.(\d+)$/;
  const ma = pattern.exec(a);
  const mb = pattern.exec(b);
  if (!ma?.[1] || !ma[2] || !mb?.[1] || !mb[2]) return null;
  const majorDiff = Number(ma[1]) - Number(mb[1]);
  if (majorDiff !== 0) return majorDiff;
  return Number(ma[2]) - Number(mb[2]);
}

/**
 * Persist a signed charter and its compiled bundle, then make it the active one.
 *
 * Both happen in a single transaction: a charter that is stored but not
 * activated is harmless, but a pointer to a charter that failed to store would
 * leave the gate unable to load policy — and the gate refuses to run without it.
 */
export async function installCharter(
  charter: BusinessCharter,
  options: { businessId?: string; activate?: boolean } = {},
): Promise<PolicyBundle> {
  // The argument is typed as `BusinessCharter`, but a caller can construct one
  // without going through `.parse()` — an object literal, a value round-tripped
  // through JSON, a cast. Without a runtime check here, an invalid charter
  // installs and activates, and the failure surfaces on the *next read*
  // instead of at install time. Parsing throws before anything is written.
  const parsed = BusinessCharter.parse(charter);
  const businessId = options.businessId ?? config.businessId;
  const activate = options.activate ?? true;

  const signature = verifyCharterSignature(parsed);
  if (!signature.valid) {
    throw new Error(`refusing to install an unverified charter: ${signature.reason}`);
  }

  const bundle = compileCharter(parsed);

  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO charter_versions (
         charter_version, business_id, effective_from, supersedes,
         charter, policy_bundle, content_hash,
         signed_by, signed_at, signature_method
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        parsed.charterVersion,
        businessId,
        parsed.effectiveFrom,
        parsed.supersedes ?? null,
        JSON.stringify(parsed),
        JSON.stringify(bundle),
        parsed.signature.contentHash,
        parsed.signature.signedByPersonId,
        parsed.signature.signedAt,
        parsed.signature.method,
      ],
    );

    if (activate) {
      await tx.query(
        `INSERT INTO charter_active (business_id, charter_version, activated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (business_id)
         DO UPDATE SET charter_version = EXCLUDED.charter_version,
                       activated_at    = now()`,
        [businessId, parsed.charterVersion],
      );
    }
  });

  return bundle;
}

export interface ActiveCharter {
  charter: BusinessCharter;
  bundle: PolicyBundle;
}

/**
 * Load the active charter and its compiled bundle.
 *
 * Returns null when no charter is installed. The gate treats that as fatal
 * rather than permissive: an agent must not run against an absent policy.
 */
export async function loadActiveCharter(
  businessId: string = config.businessId,
  db: Queryable = getPool(),
): Promise<ActiveCharter | null> {
  const { rows } = await db.query<CharterRow>(
    // The join carries business_id as well as the version. Without it, two
    // businesses that both call their first charter "v1" resolve to whichever
    // row Postgres happened to return — a cross-business policy leak.
    `SELECT v.charter, v.policy_bundle
       FROM charter_active a
       JOIN charter_versions v
         ON v.charter_version = a.charter_version
        AND v.business_id     = a.business_id
      WHERE a.business_id = $1`,
    [businessId],
  );

  const row = rows[0];
  if (!row) return null;

  // Checked before `.parse()` rather than left to it. A charter stored under
  // a different schema would otherwise fail inside `BusinessCharter.parse`
  // with a raw ZodError — illegible in the same way a raised signature
  // failure is, except this one is not tampering, it is a version mismatch
  // with a knowable remedy. Named explicitly, and the remedy depends on which
  // direction the mismatch runs: a charter *older* than this code needs
  // re-signing, but a charter *newer* than this code (a rollback) needs the
  // code rolled forward instead — telling an operator to re-sign in that case
  // sends them the wrong way.
  const storedVersion =
    typeof row.charter === 'object' && row.charter !== null && 'schemaVersion' in row.charter
      ? (row.charter as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (storedVersion !== CURRENT_SCHEMA_VERSION) {
    const cmp =
      typeof storedVersion === 'string'
        ? compareSchemaVersions(storedVersion, CURRENT_SCHEMA_VERSION)
        : null;
    const remedy =
      cmp === null
        ? 'its schema version cannot be compared against what this code expects'
        : cmp < 0
          ? 'it was signed under an older schema and must be re-signed'
          : 'it was signed under a newer schema than this code understands — roll the code forward, do not re-sign';
    throw new Error(
      `charter stored for business "${businessId}" carries schemaVersion ` +
        `${JSON.stringify(storedVersion)}, expected ${JSON.stringify(CURRENT_SCHEMA_VERSION)} — ${remedy}`,
    );
  }

  return {
    charter: BusinessCharter.parse(row.charter),
    bundle: PolicyBundle.parse(row.policy_bundle),
  };
}

/**
 * The version the gate must be running against.
 *
 * A run holding a stale bundle is denied rather than allowed — a mid-flight
 * policy change must not retroactively authorise an action, and an agent
 * carrying yesterday's rules must not act on today's business.
 */
export async function activeCharterVersion(
  businessId: string = config.businessId,
  db: Queryable = getPool(),
): Promise<string | null> {
  const { rows } = await db.query<{ charter_version: string }>(
    'SELECT charter_version FROM charter_active WHERE business_id = $1',
    [businessId],
  );
  return rows[0]?.charter_version ?? null;
}
