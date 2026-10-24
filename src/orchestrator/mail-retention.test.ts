import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { MAIL_BODY_RETENTION_DAYS, scrubOldMailBodies } from './mail-retention.js';

const BUSINESS = 'test-business';
const NOW = new Date('2026-10-22T12:00:00.000Z');
const DAY = 24 * 3600_000;

async function seedMail(mailId: string, receivedAt: Date, businessId = BUSINESS): Promise<void> {
  await getPool().query(
    `INSERT INTO mail_messages
       (mail_id, business_id, provider_message_id, thread_id, from_address, from_name,
        subject, received_at, body_text, summary, state)
     VALUES ($1, $2, $3, 't-1', 'dana@supplier.example', 'דנה', 'חשבונית ספטמבר', $4,
             'הגוף המלא של המייל מדנה', 'דנה שלחה חשבונית', 'triaged')`,
    [mailId, businessId, `pm-${mailId}`, receivedAt.toISOString()],
  );
}

describe('scrubOldMailBodies', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('scrubs bodies older than 365 days and keeps summary and invoices', async () => {
    expect(MAIL_BODY_RETENTION_DAYS).toBe(365);
    const old = new Date(NOW.getTime() - 366 * DAY);
    const recent = new Date(NOW.getTime() - 364 * DAY);
    await seedMail('M-old', old);
    await seedMail('M-recent', recent);
    // Another business's old mail: the scrub is scoped, never global.
    await seedMail('M-other', old, 'other-business');
    await getPool().query(
      `INSERT INTO mail_invoices
         (invoice_id, business_id, mail_id, supplier_address, supplier_name, invoice_number,
          amount_text, document_id, file_name, received_at)
       VALUES ('INV-old', $1, 'M-old', 'dana@supplier.example', 'דנה', '1042', '1,170 ₪',
               'DOC-1', 'invoice.pdf', $2)`,
      [BUSINESS, old.toISOString()],
    );

    const result = await scrubOldMailBodies({ businessId: BUSINESS, now: NOW });
    expect(result).toEqual({ scrubbed: 1 });

    const { rows } = await getPool().query<{
      mail_id: string;
      body_text: string | null;
      body_scrubbed_at: Date | null;
      summary: string | null;
      subject: string;
      from_address: string;
    }>(
      `SELECT mail_id, body_text, body_scrubbed_at, summary, subject, from_address
         FROM mail_messages ORDER BY mail_id`,
    );
    const byId = new Map(rows.map((r) => [r.mail_id, r]));
    expect(byId.get('M-old')?.body_text).toBeNull();
    expect(byId.get('M-old')?.body_scrubbed_at?.toISOString()).toBe(NOW.toISOString());
    // Metadata and summary remain (spec §5.7).
    expect(byId.get('M-old')?.summary).toBe('דנה שלחה חשבונית');
    expect(byId.get('M-old')?.subject).toBe('חשבונית ספטמבר');
    expect(byId.get('M-old')?.from_address).toBe('dana@supplier.example');
    // Inside the window: untouched.
    expect(byId.get('M-recent')?.body_text).toBe('הגוף המלא של המייל מדנה');
    expect(byId.get('M-recent')?.body_scrubbed_at).toBeNull();
    expect(byId.get('M-other')?.body_text).toBe('הגוף המלא של המייל מדנה');

    const invoices = await getPool().query('SELECT 1 FROM mail_invoices WHERE invoice_id = $1', ['INV-old']);
    expect(invoices.rows).toHaveLength(1);

    // Idempotent: a scrubbed body is not counted again.
    expect(await scrubOldMailBodies({ businessId: BUSINESS, now: NOW })).toEqual({ scrubbed: 0 });
  });

  it('retention audit row carries only a count', async () => {
    const old = new Date(NOW.getTime() - 400 * DAY);
    await seedMail('M-a', old);
    await seedMail('M-b', old);

    await scrubOldMailBodies({ businessId: BUSINESS, now: NOW });

    const { rows } = await getPool().query<{ reason: string; kind: string; input_hash: string }>(
      `SELECT reason, kind, input_hash FROM audit_log WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('erasure');
    expect(rows[0]?.reason).toBe('mail_retention:2');
    // Numbers only: nothing a mail said, nor who sent it, lands in the trail.
    const text = JSON.stringify(rows);
    for (const leaked of ['dana@supplier.example', 'דנה', 'חשבונית', 'M-a', 'pm-M-a']) {
      expect(text.includes(leaked), `audit row carries ${leaked}`).toBe(false);
    }
  });

  it('writes no audit row on a pass that scrubbed nothing', async () => {
    await seedMail('M-fresh', new Date(NOW.getTime() - DAY));
    expect(await scrubOldMailBodies({ businessId: BUSINESS, now: NOW })).toEqual({ scrubbed: 0 });
    const { rows } = await getPool().query('SELECT 1 FROM audit_log WHERE business_id = $1', [BUSINESS]);
    expect(rows).toHaveLength(0);
  });
});
