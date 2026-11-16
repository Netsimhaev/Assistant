/**
 * The panel's reads return states, counts, ids and the business's display
 * name — never business content (admin-panel spec). A business with every
 * kind of content seeded with PROBE is read through every exported function,
 * and no result may carry it. The underscore in PROBE is deliberate: it is a
 * LIKE wildcard, so a match found only through careless pattern handling
 * still surfaces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { installCharter } from '../charter/store.js';
import { saveSetupPackage } from '../business/setup-package.js';
import { addColleague } from '../business/colleagues.js';
import { saveAddress } from '../business/profile.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { registerBusiness, resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import * as panelReads from './panel-reads.js';

const PROBE = 'PROBE_q7z';

beforeAll(async () => {
  await resetDatabase();
  await registerBusiness(TEST_BUSINESS);
  // Technician data typed before handover — hidden once the charter is active.
  await withBusiness(TEST_BUSINESS, (db) =>
    saveSetupPackage(
      db,
      {
        bossWhatsapp: '+972501234567',
        contacts: [{ name: `דנה ${PROBE}`, role: `לקוחה ${PROBE}`, phone: '+972501234568' }],
        colleagues: [{ name: `יוסי ${PROBE}`, role: 'מנהל', phone: '+972501234569' }],
      },
      'staff-1',
    ),
  );
  await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, `רחוב ${PROBE}`, 'staff-1'));
  await withBusiness(TEST_BUSINESS, (db) =>
    addColleague(db, { name: `רונית ${PROBE}`, role: `ספקית ${PROBE}`, phone: '+972501234570' }),
  );
  // The active charter carries PROBE in a do-not-contact label's match.
  const charter = buildCharter({ doNotContactEntityId: PROBE });
  await withBusiness(TEST_BUSINESS, (db) => installCharter(db, charter));
  await withBusiness(TEST_BUSINESS, async (db) => {
    const job = await createJob(db, { charterVersion: charter.charterVersion, provenance: 'boss', title: `משימה ${PROBE}` });
    await transition(db, job.jobId, { to: 'understand', actor: 'orchestrator', reason: `סיבה ${PROBE}` });
    await db.query(
      `INSERT INTO memories (memory_id, business_id, kind, subject_key, body, provenance, written_by_job, source_ref)
       VALUES ('M-probe', $1, 'entity', $2, $3::jsonb, 'boss', $4, 'setup_package')`,
      [db.businessId, PROBE, JSON.stringify({ name: PROBE }), job.jobId],
    );
  });
  await testDb().query(
    `INSERT INTO mail_messages
       (mail_id, business_id, provider_message_id, thread_id, from_address, subject,
        received_at, body_text, state)
     VALUES ('M-1', $1, 'pm-1', 'th-1', $2, $3, now(), $4, 'triaged')`,
    [TEST_BUSINESS, `dana_${PROBE}@example.com`.toLowerCase(), `נושא ${PROBE}`, `גוף ${PROBE}`],
  );
  await testDb().query(
    `INSERT INTO dashboard_users (business_id, username, password_hash, password_salt, login)
     VALUES ($1, 'owner', 'h', 's', $2)`,
    [TEST_BUSINESS, `owner_${PROBE}@example.com`.toLowerCase()],
  );
});
afterAll(async () => {
  await closePool();
  await closePlatformPool();
});

describe('panel reads carry no business content', () => {
  it('the seed really holds PROBE where the reads could reach it', async () => {
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT (SELECT count(*) FROM memories WHERE body::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM jobs WHERE title LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM mail_messages WHERE subject LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM charter_versions WHERE charter::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM setup_packages WHERE contacts::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM business_colleagues WHERE name LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM business_profiles WHERE address LIKE '%' || $1 || '%') AS n`,
      [PROBE],
    );
    expect(Number(rows[0]?.n)).toBe(7);
  });

  it('no exported read returns PROBE', async () => {
    const results = [
      await panelReads.listBusinessesForPanel(),
      await panelReads.businessDetailForPanel(TEST_BUSINESS),
      await panelReads.setupDataForPanel(TEST_BUSINESS),
    ];
    // The reads did run against the seeded business.
    expect(results[0]).toHaveLength(1);
    expect(results[1]).not.toBeNull();
    expect(results[2]).toBe('locked');
    for (const result of results) {
      expect(JSON.stringify(result).toLowerCase()).not.toContain(PROBE.toLowerCase());
    }
  });

  it('exports exactly the frozen list of reads — a new read is a deliberate change', () => {
    expect(Object.keys(panelReads).sort()).toEqual(
      ['listBusinessesForPanel', 'businessDetailForPanel', 'setupDataForPanel'].sort(),
    );
  });
});
