/**
 * `schedulerPass` wiring for Stage D's inbound half: the scan runs after the
 * mailbox poll and learning runs right after it, in the same pass — so what
 * the scan stored is learned from at once. The curator is injected; the
 * default (`curateWithModel`) refuses under test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import { putSecret, storedCredentials } from '../governance/credential-store.js';
import { writeKeyState } from '../governance/master-key.js';
import { AdapterRegistry } from '../orchestrator/adapters/registry.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { schedulerPass } from '../orchestrator/scheduler.js';
import type { CurationBrief } from '../memory/curation-brief.js';
import { crmConnection, crmFixture } from '../test/external-fixtures.js';
import { buildCharter } from '../test/fixtures.js';
import { registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { TEST_MASTER_KEY } from '../test/owner.js';
import type { ExternalHttp } from './http.js';

const B = 'sched-ext';
const NOW = new Date('2026-11-19T08:00:00.000Z');

function runtime(): Runtime {
  return {
    registry: new AdapterRegistry([]),
    credentials: storedCredentials(TEST_MASTER_KEY),
    warnings: [],
  } as unknown as Runtime;
}

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(B);
  await writeKeyState(TEST_MASTER_KEY, 'KEY-test', testDb());
});
afterAll(async () => {
  await closePool();
});

describe('schedulerPass external systems', () => {
  it('scans, then learns from what the scan stored, in one pass', async () => {
    await withBusiness(B, (db) => installCharter(db, buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] })));
    await withBusiness(B, (db) =>
      upsertBinding(
        db,
        { system: 'ext:crm', status: 'live', endpoint: null, credentialRef: 'EXT_CRM_KEY', provider: null, lastOkAt: null, lastError: null },
        { by: 'test' },
      ),
    );
    await withBusiness(B, (db) => putSecret(db, { ref: 'EXT_CRM_KEY', value: 'k-1', updatedBy: 'test' }, TEST_MASTER_KEY));

    const http: ExternalHttp = {
      send: async () => ({ kind: 'response', status: 200, body: JSON.stringify({ data: [{ name: 'דנה', email: 'd@x.example' }] }) }),
    };
    const briefs: CurationBrief[] = [];
    const pass = await schedulerPass(B, {
      runtime: runtime(),
      now: NOW,
      inbox: null,
      externalHttp: http,
      externalCurator: async (brief) => {
        briefs.push(brief);
        return { candidates: [] };
      },
    });

    expect(pass.externalScanError).toBeNull();
    expect(pass.externalScan).toMatchObject({ scanned: 1, newItems: 1 });
    expect(pass.externalLearnError).toBeNull();
    expect(pass.externalLearn).toMatchObject({ jobs: 1, curated: 1 });
    expect(briefs[0]?.text).toContain('שם: דנה');
  });

  it('a business with no signed system does nothing, and says nothing failed', async () => {
    await withBusiness(B, (db) => installCharter(db, buildCharter({})));
    let sent = 0;
    const pass = await schedulerPass(B, {
      runtime: runtime(),
      now: NOW,
      inbox: null,
      externalHttp: {
        send: async () => {
          sent += 1;
          return { kind: 'network', sent: false };
        },
      },
      externalCurator: async () => ({ candidates: [] }),
    });
    expect(pass.externalScan).toMatchObject({ scanned: 0, newItems: 0, skipped: 0, warnings: [] });
    expect(pass.externalLearn).toMatchObject({ jobs: 0, curated: 0 });
    expect(sent).toBe(0);
  });
});
