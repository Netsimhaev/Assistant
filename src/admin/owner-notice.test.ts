import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { registerBusiness, resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { putSecret, storedCredentials } from '../governance/credential-store.js';
import { saveRuntimeSettings } from '../tenancy/runtime-settings.js';
import { writeKeyState } from '../governance/master-key.js';
import { NOTIFY_SMTP_PASS_REF } from '../orchestrator/runtime.js';
import type { ServerRuntime, ServerRuntimeOverrides } from '../orchestrator/runtime.js';
import {
  noticeOwner,
  OWNER_NOTICE_FOOTER,
  OWNER_NOTICE_TEXT,
  runtimeOwnerNoticeSender,
  type OwnerNoticeSender,
} from './owner-notice.js';

const KEY = randomBytes(32);

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(TEST_BUSINESS);
  await writeKeyState(KEY, 'key-1', testDb());
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

function server(createTransport?: ServerRuntimeOverrides['createTransport']): ServerRuntime {
  return {
    credentials: storedCredentials(KEY),
    dashboardBaseUrl: 'http://127.0.0.1:8787',
    documentInboxRoot: null,
    production: { available: false, sofficePath: null, chromiumPath: null },
    warnings: [],
    overrides: createTransport ? { createTransport } : {},
  };
}

async function configure(): Promise<void> {
  await withBusiness(TEST_BUSINESS, (db) =>
    saveRuntimeSettings(db, {
      notifySmtpHost: '127.0.0.1',
      notifySmtpPort: 1025,
      notifySmtpSecure: false,
      notifySmtpFrom: 'assistant@example.com',
      notifySmtpUser: 'assistant',
      notifyTo: 'boss@example.com',
    }),
  );
  await withBusiness(TEST_BUSINESS, (db) =>
    putSecret(db, { ref: NOTIFY_SMTP_PASS_REF, value: 'pw', updatedBy: 'operator@example.com' }, KEY),
  );
}

async function incidents(): Promise<string[]> {
  const { rows } = await testDb().query<{ reason: string }>(
    "SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'incident' ORDER BY seq",
    [TEST_BUSINESS],
  );
  return rows.map((r) => r.reason);
}

describe('owner notice on a technician reset (final review I1)', () => {
  it('sends the Hebrew notice through the business notification seam when it is configured', async () => {
    await configure();
    const captured: Array<{ to: string; subject: string; text: string }> = [];
    const send = runtimeOwnerNoticeSender(
      server(() => ({
        sendMail: async (mail: { to: string; subject: string; text: NodeJS.ReadableStream }) => {
          let text = '';
          for await (const chunk of mail.text) text += String(chunk);
          captured.push({ to: mail.to, subject: mail.subject, text });
          return { messageId: 'stub' };
        },
      })),
    );

    expect(await noticeOwner(send, TEST_BUSINESS, 'totp_reset')).toBe('sent');
    expect(await noticeOwner(send, TEST_BUSINESS, 'reset_issued')).toBe('sent');
    expect(captured).toHaveLength(2);
    expect(captured[0]?.to).toBe('boss@example.com');
    expect(captured[0]?.text).toContain('איש התמיכה אפס את Google Authenticator של החשבון שלך.');
    expect(captured[1]?.text).toContain('איש התמיכה הנפיק קישור לאיפוס הסיסמה של החשבון שלך.');
    expect(captured[0]?.text).toContain(OWNER_NOTICE_FOOTER);
    expect(OWNER_NOTICE_FOOTER).toBe('אם לא ביקשת זאת, פנה למנהל המערכת.');
    // Two notices of one kind must not collapse at the mail server.
    expect(OWNER_NOTICE_TEXT.totp_reset.subject.length).toBeGreaterThan(0);
    expect(await incidents()).toEqual([]);
  });

  it('records that nothing was sent when the business has no notification configured', async () => {
    const send = runtimeOwnerNoticeSender(server());
    expect(await noticeOwner(send, TEST_BUSINESS, 'totp_reset')).toBe('not_configured');
    const reasons = await incidents();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^owner_notice_not_sent:totp_reset/);
  });

  it('a failed or throwing send never throws, and is recorded', async () => {
    const failing: OwnerNoticeSender = async () => ({ status: 'failed', error: 'smtp down' });
    const throwing: OwnerNoticeSender = async () => {
      throw new Error('boom');
    };
    expect(await noticeOwner(failing, TEST_BUSINESS, 'reset_issued')).toBe('failed');
    expect(await noticeOwner(throwing, TEST_BUSINESS, 'totp_reset')).toBe('failed');
    const reasons = await incidents();
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toMatch(/^owner_notice_failed:reset_issued/);
    expect(reasons[1]).toMatch(/^owner_notice_failed:totp_reset/);
  });
});
