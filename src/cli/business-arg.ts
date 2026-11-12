/**
 * `--business <id>` — the one way a command that touches a business learns
 * which business it is.
 *
 * Spec §5.8: every command that reads or writes a business's data takes the
 * business as a REQUIRED flag and refuses without it. There is no fallback to
 * a configured default: one server holds many businesses, and a command that
 * quietly picked "the usual one" is how an operator stops the wrong
 * business's assistant, or files a secret under the wrong customer.
 *
 * The id is checked twice, both times before anything is written: its shape
 * (`isValidBusinessId`, the same check `withBusiness` makes), and that the
 * business is registered (`getBusiness`). A typo'd id is refused here rather
 * than becoming a fresh, empty tenant that the command then writes into —
 * there are no foreign keys from data tables to `businesses` (plan, Global
 * Constraints), so this is the place that existence is enforced.
 *
 * A suspended business is NOT refused here, on purpose: suspension stops the
 * assistant and the owner's dashboard, and the operator's tools — the kill
 * switch, a secret, a ramp — are exactly what is still needed while it is
 * suspended.
 */
import { closePool, withBusiness, isValidBusinessId, type BusinessDb } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { getBusiness } from '../tenancy/businesses.js';

/** The exit code of every refusal over `--business`, matching a usage error. */
export const BUSINESS_ARG_EXIT_CODE = 2;

/** Printed when the flag is absent, empty or repeated. */
export const MISSING_BUSINESS_MESSAGE = 'חסר מזהה עסק: --business <id>';

/**
 * Printed when the id fails `isValidBusinessId`. `<id>` is the literal
 * placeholder: the input itself is not echoed, since it is whatever the
 * operator typed and cannot name a business anyway.
 */
export const MALFORMED_BUSINESS_MESSAGE = 'מזהה עסק לא תקין: --business <id>';

/** Printed when the id is well formed but no such business is registered. */
export function unknownBusinessMessage(id: string): string {
  return `העסק ${id} לא קיים`;
}

const FLAG = '--business';

export type BusinessArg =
  | { ok: true; businessId: string; rest: string[] }
  | { ok: false; message: string };

/**
 * Pull `--business <id>` (or `--business=<id>`) out of `argv`, and return
 * everything else in order. Pure: no database.
 *
 * Returns `businessId: null` when the flag is missing, has no value, or
 * appears more than once — two flags name two businesses, and picking one of
 * them is a guess. A malformed id is returned as it is; `resolveBusinessArg`
 * judges it.
 */
export function takeBusinessFlag(argv: readonly string[]): { businessId: string | null; rest: string[] } {
  const rest: string[] = [];
  const found: string[] = [];
  let missingValue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === FLAG) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        missingValue = true;
      } else {
        found.push(value);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${FLAG}=`)) {
      found.push(arg.slice(FLAG.length + 1));
      continue;
    }
    rest.push(arg);
  }
  const only = found[0];
  if (missingValue || found.length !== 1 || only === undefined || only.length === 0) {
    return { businessId: null, rest };
  }
  return { businessId: only, rest };
}

/**
 * Parse and check `--business`: missing, malformed (not echoed back), then
 * unknown. All three refuse with exit code 2.
 */
export async function resolveBusinessArg(argv: readonly string[]): Promise<BusinessArg> {
  const { businessId, rest } = takeBusinessFlag(argv);
  if (businessId === null) {
    return { ok: false, message: MISSING_BUSINESS_MESSAGE };
  }
  if (!isValidBusinessId(businessId)) {
    return { ok: false, message: MALFORMED_BUSINESS_MESSAGE };
  }
  if ((await getBusiness(businessId)) === null) {
    return { ok: false, message: unknownBusinessMessage(businessId) };
  }
  return { ok: true, businessId, rest };
}

/**
 * The entry every business-scoped command shares: resolve `--business`, and
 * on a refusal print it and return `BUSINESS_ARG_EXIT_CODE` without opening
 * a business connection at all. Otherwise run `body` on ONE `BusinessDb` for
 * that business, with the flag removed from argv.
 *
 * `body`'s own errors propagate — each command already has a catch that turns
 * them into a readable line and exit code 1.
 */
export async function runForBusiness(
  argv: readonly string[],
  refuse: (message: string) => void,
  body: (db: BusinessDb, rest: string[]) => Promise<number | void>,
): Promise<number> {
  const parsed = await resolveBusinessArg(argv);
  if (!parsed.ok) {
    refuse(parsed.message);
    return BUSINESS_ARG_EXIT_CODE;
  }
  const code = await withBusiness(parsed.businessId, (db) => body(db, parsed.rest));
  return code ?? 0;
}

/**
 * Close both pools a business-scoped command may have opened: the app pool,
 * and the platform pool `getBusiness` reads `businesses` through. A command
 * that closed only the first would hang on exit with the second still open.
 * Exported for the `sdk:*` scripts, which may not import the platform pool
 * themselves (plan, Global Constraints).
 */
export async function closeCliPools(): Promise<void> {
  await closePlatformPool();
  await closePool();
}
