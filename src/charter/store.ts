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
  options: {
    businessId?: string;
    activate?: boolean;
    /**
     * Join a caller's open transaction instead of opening one. For a caller
     * that must commit the install together with something else — the
     * dashboard's mailbox amendment writes its `charter_change` audit row in
     * the same transaction, so a failed append rolls the install back.
     */
    tx?: Queryable;
  } = {},
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

  const write = async (tx: Queryable): Promise<void> => {
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
  };

  if (options.tx !== undefined) await write(options.tx);
  else await withTransaction(write);

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
 * What `probeActiveCharter` found, for the one caller shape that must survive
 * an unreadable charter.
 */
export type ActiveCharterProbe =
  | { readonly ok: true; readonly active: ActiveCharter | null }
  | { readonly ok: false; readonly reason: string };

/**
 * `loadActiveCharter`, but handing back a failure instead of throwing it.
 *
 * **This exists for exactly one caller shape, and widening it would undo the
 * control it sits beside.** `loadActiveCharter` throws on a charter this code
 * cannot read, and every production caller must keep failing that way: a job
 * that runs against a policy nobody can parse is a job running against no
 * policy at all. What throwing also did, until this function existed, was
 * close the only door out — installing a replacement charter reads the active
 * one first (to avoid superseding a charter that is already correct), so an
 * installation whose charter had fallen behind the schema could neither run
 * nor be repaired. That was measured on a real installation, not imagined;
 * see `CURRENT_SCHEMA_VERSION`'s docblock.
 *
 * So: the install path, the readiness report, and the dashboard's connections
 * screen may ask this question, and
 * nothing else may. A `false` here means "there is something stored and this
 * code cannot read it" — which, for an installer, is the same instruction as
 * "no charter is installed": go ahead and install one. It is never a reason
 * to let work proceed.
 *
 * The failure is returned as a message rather than a code because the caller's
 * whole job is to show it to a person: `loadActiveCharter` already composes a
 * direction-aware remedy ("signed under an older schema and must be re-signed"
 * versus "roll the code forward"), and flattening that to an enum would throw
 * away the half that says which way to move.
 */
export async function probeActiveCharter(
  businessId: string = config.businessId,
  db: Queryable = getPool(),
): Promise<ActiveCharterProbe> {
  try {
    return { ok: true, active: await loadActiveCharter(businessId, db) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One stored charter version of this business, parsed — or `null` when no
 * such version exists for it. Throws on a version this code cannot parse, the
 * same as `loadActiveCharter`; the one caller (the dashboard's mailbox
 * revert, which reads the version the mailbox amendment superseded) turns
 * that into a refusal. Never a source of policy: the gate reads only the
 * active charter.
 */
export async function loadCharterVersion(
  charterVersion: string,
  businessId: string = config.businessId,
  db: Queryable = getPool(),
): Promise<BusinessCharter | null> {
  const { rows } = await db.query<{ charter: unknown }>(
    'SELECT charter FROM charter_versions WHERE business_id = $1 AND charter_version = $2',
    [businessId, charterVersion],
  );
  const row = rows[0];
  return row ? BusinessCharter.parse(row.charter) : null;
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
