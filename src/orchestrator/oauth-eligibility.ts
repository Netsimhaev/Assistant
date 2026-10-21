/**
 * ONE predicate, shared by three call sites that must never be allowed to
 * drift into disagreeing about the same question: "does a Google adapter
 * exist, or will one ever run, for this charter-declared connection?"
 *
 * Before this module existed, `runtime.ts` answered it once (to decide
 * whether to register `createGoogleCalendarAdapter` for a `provider:
 * 'google'` binding) and the OAuth consent ceremony answered it NOT AT ALL:
 * `handleOAuthStart` (`src/dashboard/oauth-routes.ts`) validated nothing
 * about `system` and walked the owner to Google's consent screen for ANY
 * path segment — including `office-mail`, which the seeded charter declares
 * for `mail.send` only. Finishing that ceremony writes `provider: 'google'`
 * and a DERIVED credential ref onto the mail binding (`upsertBinding` is a
 * whole-row replace), and because `credentialRefForSystem('office-mail')`
 * collides byte-for-byte with the static SMTP secret ref the runbook
 * provisions (`OFFICE_MAIL`), every later `mail.send` resolves that ref
 * through a source that now finds BOTH a grant and a static secret and
 * correctly refuses with `AmbiguousCredentialRefError` — poisoning the mail
 * path, the one capability this system has ever proven end to end in a live
 * run, permanently (revoking the grant does not restore the static secret;
 * `oauth-token.ts`'s own docblock names that refusal as deliberate). This is
 * the final fix wave's Critical finding, item 1.
 *
 * **Two independent checks of the same rule is how they diverge — hence one
 * exported function, not two copies.** `runtime.ts` calls this to decide
 * whether to register an adapter; `handleOAuthStart` calls it to decide
 * whether to let the ceremony start at all; `views.ts`'s `renderConnections`
 * calls it to decide whether to show the "לחיבור" link in the first place. A
 * link the server would refuse is a worse experience than no link, and a
 * ceremony that accepts a system no adapter will ever serve is exactly the
 * hole item 1 closes.
 *
 * **Provider-agnostic in name, Google-shaped in body, on purpose.** This
 * ceremony authorises exactly one provider today (`oauth-routes.ts`'s own
 * module docblock: "Google only, today"), so the tool list this checks is
 * `GOOGLE_CALENDAR_SERVED_TOOLS` — the same constant `runtime.ts` already
 * imported for the identical reason. A second provider needs a real mapping
 * from provider to served-tools here, not a second predicate module.
 */
import { oauthProfileFor } from '../dashboard/oauth-profiles.js';
import type { CharterConnection } from '../domain/connection.js';

/**
 * **Per-system profiles (mailbox connection, Task 4).** "Eligible" is now
 * `oauthProfileFor(connection) !== null` (`dashboard/oauth-profiles.ts`): the
 * `mailbox` connection serving `mail.send`, or any connection serving
 * `calendar.read`. This predicate therefore no longer implies "a calendar
 * adapter exists" -- `runtime.ts` checks `calendar.read` explicitly for that.
 *
 * Whether a charter-declared connection is one the OAuth ceremony (and the
 * adapter it authorises) can actually serve.
 *
 * `undefined` (no connection declared for this system at all) is `false`,
 * never an exception — both call sites already handle "nothing declared" as
 * an ordinary case (`views.ts` renders an unauthorised row for every
 * declared connection regardless; `handleOAuthStart` refuses a system the
 * charter never named exactly the same way it refuses one the charter named
 * but did not serve `calendar.read` on).
 *
 * Checked positively — `channel === 'api'` AND `serves` intersects the
 * provider's own served-tools list — never as "anything that is not
 * `office-mail`" or some other exclusion. `office-mail` is refused here
 * because it fails the `serves` intersection, the same reason ANY
 * non-calendar connection is refused, not because its name is special-cased.
 */
export function connectionAcceptsOAuthCeremony(connection: CharterConnection | undefined): boolean {
  if (connection === undefined) return false;
  return oauthProfileFor(connection) !== null && connection.channel === 'api';
}
