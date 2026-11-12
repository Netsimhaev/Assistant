/**
 * The dashboard login as it is stored and matched: trimmed and lower-cased,
 * the same normalisation `resolveLogin` (platform.ts), the dashboard's own
 * lookups (dashboard/auth.ts, recovery.ts), `owner:create`, and the unique
 * index on `lower(login)` (migration 066) use. One function, so they cannot
 * disagree about whether `" Dana@X.example "` is `dana@x.example`.
 *
 * Its own module, depending on nothing: the tenancy layer reads it without
 * depending on the dashboard, and the dashboard without depending on the
 * platform pool.
 */
export function normaliseLogin(login: string): string {
  return login.trim().toLowerCase();
}
