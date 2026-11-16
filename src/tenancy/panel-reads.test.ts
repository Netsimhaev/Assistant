import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { installCharter } from '../charter/store.js';
import { saveSetupPackage } from '../business/setup-package.js';
import { addColleague } from '../business/colleagues.js';
import { saveAddress } from '../business/profile.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { registerBusiness, resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { businessDetailForPanel, listBusinessesForPanel, setupDataForPanel } from './panel-reads.js';

const OTHER = 'other-business';
const TECH = 'staff-1';

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(TEST_BUSINESS);
});
afterAll(async () => {
  await closePool();
  await closePlatformPool();
});

async function seedWhatsappSecrets(businessId: string, refs = ['GREEN_API_INSTANCE_ID', 'GREEN_API_TOKEN']): Promise<void> {
  for (const ref of refs) {
    await testDb().query(
      `INSERT INTO credentials (business_id, ref, ciphertext, nonce, key_id, updated_by)
       VALUES ($1, $2, '\\x00', '\\x00', 'k1', 'test')`,
      [businessId, ref],
    );
  }
}

async function seedMailboxGrant(businessId: string, revoked = false): Promise<void> {
  await testDb().query(
    `INSERT INTO oauth_grants (business_id, system, provider, credential_ref, account, scopes,
                               ciphertext, nonce, key_id, granted_by, revoked_at)
     VALUES ($1, 'mailbox', 'google', 'MAILBOX_GRANT', 'owner@example.com', ARRAY['email'],
             '\\x00', '\\x00', 'k1', 'test', CASE WHEN $2::boolean THEN now() ELSE NULL END)`,
    [businessId, revoked],
  );
}

async function basicDone(businessId: string): Promise<number> {
  const rows = await listBusinessesForPanel();
  const row = rows.find((r) => r.businessId === businessId);
  if (!row) throw new Error(`no panel row for ${businessId}`);
  return row.basicDone;
}

describe('listBusinessesForPanel', () => {
  it('moves basicDone from 0 to 4 as each basic fact is seeded', async () => {
    expect(await basicDone(TEST_BUSINESS)).toBe(0);

    // One WhatsApp secret is not enough — both refs must be saved.
    await seedWhatsappSecrets(TEST_BUSINESS, ['GREEN_API_INSTANCE_ID']);
    expect(await basicDone(TEST_BUSINESS)).toBe(0);
    await seedWhatsappSecrets(TEST_BUSINESS, ['GREEN_API_TOKEN']);
    expect(await basicDone(TEST_BUSINESS)).toBe(1);

    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(db, { bossWhatsapp: '+972501234567', contacts: [], colleagues: [] }, TECH),
    );
    expect(await basicDone(TEST_BUSINESS)).toBe(2);

    // A revoked grant is not a connected mailbox.
    await seedMailboxGrant(TEST_BUSINESS, true);
    expect(await basicDone(TEST_BUSINESS)).toBe(2);
    await testDb().query('DELETE FROM oauth_grants');
    await seedMailboxGrant(TEST_BUSINESS);
    expect(await basicDone(TEST_BUSINESS)).toBe(3);

    await withBusiness(TEST_BUSINESS, (db) =>
      addColleague(db, { name: 'יוסי', role: 'מנהל משמרת', phone: '+972501112222' }),
    );
    expect(await basicDone(TEST_BUSINESS)).toBe(4);
  });

  it('counts a pending contact in the setup package as the people fact', async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(
        db,
        { bossWhatsapp: null, contacts: [{ name: 'דנה', role: 'לקוחה', phone: '+972501234567' }], colleagues: [] },
        TECH,
      ),
    );
    expect(await basicDone(TEST_BUSINESS)).toBe(1);
  });

  it("flips setupState to 'live' after installCharter, and the charter's principal counts as the boss number", async () => {
    let [row] = await listBusinessesForPanel();
    expect(row).toMatchObject({
      businessId: TEST_BUSINESS,
      displayName: TEST_BUSINESS,
      status: 'active',
      setupState: 'setting_up',
      basicDone: 0,
      basicTotal: 4,
      systems: [],
    });
    await withBusiness(TEST_BUSINESS, (db) => installCharter(db, buildCharter()));
    [row] = await listBusinessesForPanel();
    expect(row?.setupState).toBe('live');
    expect(row?.basicDone).toBe(1);
  });

  it("never lets another business's data affect this business's row", async () => {
    await registerBusiness(OTHER, 'suspended');
    await seedWhatsappSecrets(OTHER);
    await seedMailboxGrant(OTHER);
    await withBusiness(OTHER, (db) =>
      saveSetupPackage(
        db,
        { bossWhatsapp: '+972501234567', contacts: [{ name: 'דנה', role: 'לקוחה', phone: '+972501234568' }], colleagues: [] },
        TECH,
      ),
    );
    await withBusiness(OTHER, (db) => installCharter(db, buildCharter()));
    await withBusiness(OTHER, (db) => saveAddress(db, 'רחוב 1', TECH));
    await testDb().query(
      `UPDATE business_profiles SET logo_path = 'other-business/profile/logo.png',
              logo_media_type = 'image/png', logo_sha256 = repeat('a', 64)
        WHERE business_id = $1`,
      [OTHER],
    );
    await withBusiness(OTHER, async (db) => {
      const job = await createJob(db, { charterVersion: buildCharter().charterVersion, provenance: 'boss', title: 't' });
      await transition(db, job.jobId, { to: 'understand', actor: 'orchestrator', reason: 'x' });
      await transition(db, job.jobId, { to: 'failed', actor: 'orchestrator', reason: 'x' });
      await db.query(
        `INSERT INTO memories (memory_id, business_id, kind, subject_key, body, provenance, written_by_job, source_ref)
         VALUES ('M-other', $1, 'entity', 'dana', '{"name":"x"}', 'boss', $2, 'setup_package')`,
        [db.businessId, job.jobId],
      );
    });
    await withBusiness(OTHER, (db) => addColleague(db, { name: 'יוסי', role: 'מנהל', phone: '+972501112222' }));
    await testDb().query(
      `INSERT INTO dashboard_users (business_id, username, password_hash, password_salt, login,
                                    totp_ciphertext, totp_nonce, totp_enrolled_at)
       VALUES ($1, 'owner', 'h', 's', 'owner@other.example', '\\x00', '\\x00', now())`,
      [OTHER],
    );
    await testDb().query(
      `INSERT INTO approval_requests (approval_id, business_id, action_class, summary, detail, risk,
                                      proposed_tool, proposed_input, input_hash, expires_at)
       VALUES ('A-other', $1, 'email.reply', 's', 'd', '{}', 'mail.send', '{}', 'h', now() + interval '1 day')`,
      [OTHER],
    );
    await testDb().query(
      `INSERT INTO spend_ledger (business_id, action_class, amount_minor, currency, idempotency_key)
       VALUES ($1, 'purchase.place', 5000, 'ILS', 'k-1')`,
      [OTHER],
    );

    const rows = await listBusinessesForPanel();
    expect(rows.map((r) => r.businessId)).toEqual([OTHER, TEST_BUSINESS]);
    const mine = rows.find((r) => r.businessId === TEST_BUSINESS);
    expect(mine).toMatchObject({ status: 'active', setupState: 'setting_up', basicDone: 0 });
    expect(rows.find((r) => r.businessId === OTHER)).toMatchObject({ status: 'suspended', setupState: 'live', basicDone: 4 });

    const detail = await businessDetailForPanel(TEST_BUSINESS);
    expect(detail).toMatchObject({
      whatsappSaved: false,
      bossNumberSet: false,
      mailboxConnected: false,
      ownerExists: false,
      ownerEnrolled: false,
      contactsPending: 0,
      colleaguesPending: 0,
      contactsConfirmed: 0,
      colleaguesConfirmed: 0,
      addressSet: false,
      logoSet: false,
      snapshot: { jobsLast7Days: 0, pendingApprovals: 0, spendTodayMinor: 0, lastActivityAt: null, failedLast7Days: 0 },
    });
    expect(await setupDataForPanel(TEST_BUSINESS)).toEqual({ bossWhatsapp: null, contacts: [], colleagues: [], address: null });

    // The seed really reached the other business's row — so the zeros above are a filter, not an empty seed.
    const other = await businessDetailForPanel(OTHER);
    expect(other).toMatchObject({
      whatsappSaved: true,
      bossNumberSet: true,
      mailboxConnected: true,
      ownerExists: true,
      ownerEnrolled: true,
      contactsPending: 1,
      contactsConfirmed: 1,
      colleaguesConfirmed: 1,
      addressSet: true,
      logoSet: true,
      snapshot: { jobsLast7Days: 1, pendingApprovals: 1, spendTodayMinor: 5000, failedLast7Days: 1 },
    });
    expect(other?.snapshot.lastActivityAt).toBeInstanceOf(Date);
  });
});

describe('businessDetailForPanel', () => {
  it('returns null for an unregistered business', async () => {
    expect(await businessDetailForPanel('no-such-business')).toBeNull();
  });

  it('reports owner, people counts, profile and the snapshot', async () => {
    await testDb().query(
      `INSERT INTO dashboard_users (business_id, username, password_hash, password_salt, login)
       VALUES ($1, 'owner', 'h', 's', 'owner@example.com')`,
      [TEST_BUSINESS],
    );
    let detail = await businessDetailForPanel(TEST_BUSINESS);
    expect(detail).toMatchObject({ ownerExists: true, ownerEnrolled: false });

    await testDb().query(
      `UPDATE dashboard_users SET totp_ciphertext = '\\x00', totp_nonce = '\\x00', totp_enrolled_at = now()
        WHERE business_id = $1`,
      [TEST_BUSINESS],
    );
    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(
        db,
        {
          bossWhatsapp: null,
          contacts: [
            { name: 'דנה', role: 'לקוחה', phone: '+972501234567' },
            { name: 'רונית', role: 'ספקית', phone: '+972501234568' },
          ],
          colleagues: [{ name: 'יוסי', role: 'מנהל', phone: '+972501234569' }],
        },
        TECH,
      ),
    );
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, 'רחוב הרצל 1', TECH));

    detail = await businessDetailForPanel(TEST_BUSINESS);
    expect(detail).toMatchObject({
      ownerExists: true,
      ownerEnrolled: true,
      contactsPending: 2,
      colleaguesPending: 1,
      contactsConfirmed: 0,
      colleaguesConfirmed: 0,
      addressSet: true,
      logoSet: false,
      setupState: 'setting_up',
    });

    await withBusiness(TEST_BUSINESS, (db) => installCharter(db, buildCharter()));
    await withBusiness(TEST_BUSINESS, async (db) => {
      const job = await createJob(db, { charterVersion: buildCharter().charterVersion, provenance: 'boss', title: 't' });
      await transition(db, job.jobId, { to: 'understand', actor: 'orchestrator', reason: 'x' });
      await db.query(
        `INSERT INTO memories (memory_id, business_id, kind, subject_key, body, provenance, written_by_job, source_ref)
         VALUES ('M-1', $1, 'entity', 'dana', '{"name":"x"}', 'boss', $2, 'setup_package'),
                ('M-2', $1, 'entity', 'other', '{"name":"y"}', 'boss', $2, 'document:1')`,
        [db.businessId, job.jobId],
      );
    });
    await withBusiness(TEST_BUSINESS, (db) =>
      addColleague(db, { name: 'יוסי', role: 'מנהל', phone: '+972501234569' }),
    );
    detail = await businessDetailForPanel(TEST_BUSINESS);
    expect(detail).toMatchObject({ contactsConfirmed: 1, colleaguesConfirmed: 1, bossNumberSet: true, setupState: 'live' });
    expect(detail?.snapshot.jobsLast7Days).toBe(1);
    expect(detail?.snapshot.lastActivityAt).toBeInstanceOf(Date);
  });
});

describe('setupDataForPanel', () => {
  it("returns the technician's data before install and 'locked' after", async () => {
    await withBusiness(TEST_BUSINESS, (db) =>
      saveSetupPackage(
        db,
        {
          bossWhatsapp: '+972501234567',
          contacts: [{ name: 'דנה', role: 'לקוחה', phone: '+972501234568' }],
          colleagues: [],
        },
        TECH,
      ),
    );
    await withBusiness(TEST_BUSINESS, (db) => saveAddress(db, 'רחוב הרצל 1', TECH));
    expect(await setupDataForPanel(TEST_BUSINESS)).toEqual({
      bossWhatsapp: '+972501234567',
      contacts: [{ name: 'דנה', role: 'לקוחה', phone: '+972501234568' }],
      colleagues: [],
      address: 'רחוב הרצל 1',
    });

    await withBusiness(TEST_BUSINESS, (db) => installCharter(db, buildCharter()));
    expect(await setupDataForPanel(TEST_BUSINESS)).toBe('locked');
  });
});
