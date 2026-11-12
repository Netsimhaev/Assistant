import type { BusinessDb } from '../db/pool.js';
import { listGrants } from '../governance/oauth-grants.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { OAuthGrantRevokedError, OAuthRefreshRejectedError } from '../orchestrator/oauth-token.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { CALENDAR_SYSTEM, type CalendarProvider } from './calendar.js';
import { createGoogleCalendarClient } from './providers/google.js';
import { createGraphCalendarClient } from './providers/graph.js';
import type { CalendarClient, CalendarHttp } from './types.js';

export function calendarClientFor(provider: CalendarProvider, http?: CalendarHttp): CalendarClient {
  return provider === 'google' ? createGoogleCalendarClient(http) : createGraphCalendarClient(http);
}

export interface CalendarAccess {
  client: CalendarClient;
  token: string;
  provider: CalendarProvider;
}

/** Binding, then grant status, then credential: the order `pollMailbox` reads them. */
export async function resolveCalendarAccess(db: BusinessDb, o: {
  runtime: Pick<Runtime, 'credentials'>;
  client?: CalendarClient;
}): Promise<CalendarAccess | { unavailable: 'not_connected' | 'needs_reauth' | 'credential_error' }> {
  const binding = (await loadBindings(db)).find((b) => b.system === CALENDAR_SYSTEM);
  if (binding === undefined || binding.status !== 'live') return { unavailable: 'not_connected' };
  if (binding.provider !== 'google' && binding.provider !== 'microsoft') return { unavailable: 'not_connected' };
  const ref = binding.credentialRef;
  if (ref === null) return { unavailable: 'not_connected' };
  const provider: CalendarProvider = binding.provider;

  const grant = (await listGrants(db)).find((g) => g.credentialRef === ref);
  if (grant !== undefined && (grant.revokedAt !== null || grant.needsReauthAt !== null)) {
    return { unavailable: 'needs_reauth' };
  }
  let token: string;
  try {
    const handle = await o.runtime.credentials.resolve(ref, db.businessId);
    if (handle === null) return { unavailable: 'needs_reauth' };
    token = handle.value;
  } catch (error) {
    if (error instanceof OAuthGrantRevokedError || error instanceof OAuthRefreshRejectedError) {
      return { unavailable: 'needs_reauth' };
    }
    return { unavailable: 'credential_error' };
  }
  return { client: o.client ?? calendarClientFor(provider), token, provider };
}
