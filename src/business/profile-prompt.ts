/**
 * The business's own name and address, rendered as a prompt section for the
 * drafters and the planner (admin-panel spec, task 14).
 *
 * Pure: imports nothing from `db/`, `policy/` or `sdk/` (the fragment that
 * reads the row is `profileFragment`, in `profile.ts`). Like the owner's
 * description it is the business's own data — typed by the owner or the
 * technician — so it is a trusted channel and is not fenced. Each value is
 * still folded to one line with bidi controls stripped (`toOneLine`), so a
 * name or address cannot open a forged heading in the prompt.
 */
import { toOneLine } from '../util/bidi.js';

export const PROFILE_HEADING = '# פרטי העסק (לשימוש בהודעות ובמסמכים רשמיים)';

const PROFILE_NOTE = 'כשההודעה או המסמך רשמיים, אפשר לציין את שם העסק ואת הכתובת — רק כשזה נחוץ, לא בכל הודעה.';

export interface ProfileForPrompt {
  name: string;
  address: string | null;
}

/** `''` for undefined; otherwise heading, fixed line, the name and (when set) the address. */
export function renderProfileSection(p: ProfileForPrompt | undefined): string {
  if (p === undefined) return '';
  const name = toOneLine(p.name);
  if (name === '') return '';
  const address = p.address === null ? '' : toOneLine(p.address);
  return [PROFILE_HEADING, PROFILE_NOTE, `שם העסק: ${name}`, ...(address === '' ? [] : [`כתובת: ${address}`])].join('\n');
}
