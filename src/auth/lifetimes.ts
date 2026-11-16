/**
 * How long the sign-in artefacts live — shared by the owner's dashboard
 * (`dashboard/auth.ts`, `second-factor.ts`, `owner-links.ts`) and the platform
 * staff store (`tenancy/staff.ts`). Its own module so the tenancy layer does
 * not depend on the dashboard; the dashboard modules re-export these names.
 */

/** A session's life. The server sets the cookie's `Max-Age` from the same number. */
export const SESSION_HOURS = 12;

/** How long a trusted device skips the second factor. */
export const TRUSTED_DEVICE_DAYS = 30;

/** How long a one-time invite or reset link stays valid. */
export const LINK_HOURS = 72;
