import { withBusiness } from '../db/pool.js';
import { createOwner } from '../dashboard/auth.js';
import { registerBusiness } from './db.js';

/**
 * The login address a test owner signs in with. One dashboard serves every
 * business and the address decides which (spec §5.5), so it is derived from
 * the business: two businesses' test owners never collide on the server-wide
 * unique login.
 */
export function ownerLogin(businessId: string, username = 'owner'): string {
  return `${username}@${businessId}.example`;
}

/**
 * Register the business (login resolves only registered, active businesses)
 * and create its dashboard owner, logging in as `ownerLogin(businessId, username)`
 * unless `login` says otherwise.
 */
export async function createTestOwner(
  businessId: string,
  input: { username: string; password: string; login?: string },
): Promise<void> {
  await registerBusiness(businessId);
  await withBusiness(businessId, (db) =>
    createOwner(db, {
      username: input.username,
      login: input.login ?? ownerLogin(businessId, input.username),
      password: input.password,
    }),
  );
}
