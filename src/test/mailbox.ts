/**
 * Shared fixtures for mailbox-reply tests: the real charter plus the signed
 * mailbox amendment, a live `mailbox` binding, a stored mail, a stub drafter
 * and a fake mailbox client behind the real send adapter.
 */
import { expect } from 'vitest';
import { buildMailboxAmendment } from '../charter/amend-mailbox.js';
import { signCharter } from '../charter/sign.js';
import { installCharter } from '../charter/store.js';
import { BusinessCharter } from '../domain/charter.js';
import type { MailTriage } from '../domain/mail-triage.js';
import type { PolicyBundle } from '../domain/policy.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { recordIncoming, type IncomingMail, type StoredMail } from '../mail/inbox-store.js';
import type { MailProvider } from '../mail/mailbox.js';
import type { MailboxClient, MailboxFailure, OutgoingMessage, OutgoingReply } from '../mail/providers/types.js';
import { createMailboxSendAdapter } from '../orchestrator/adapters/mailbox-send.js';
import { AdapterRegistry } from '../orchestrator/adapters/registry.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { envCredentials } from '../orchestrator/credentials.js';
import type { Runtime } from '../orchestrator/runtime.js';
import type { Drafter } from '../sdk/mail-drafter.js';
import { buildCharter } from './fixtures.js';

const PREFIX = 'TEST_CRED_';
// 09:00 UTC is noon in Asia/Jerusalem — outside the fixture's quiet hours.
export const NOON = new Date('2026-10-21T09:00:00.000Z');
export const DRAFT_BODY = 'שלום דנה, קיבלנו את פנייתך ונחזור אלייך עד מחר.';

export const QUESTION_TRIAGE: MailTriage = {
  categories: ['question'],
  summary: 'דנה שואלת מתי תגיע הצעת המחיר',
  isPerson: true,
  invoice: null,
  replyGist: 'לומר שנחזור אליה עד מחר',
};

export async function installMailboxCharter(
  businessId: string,
  provider: MailProvider = 'google',
): Promise<PolicyBundle> {
  const base = buildCharter({ version: `2026-08-15.${businessId}` });
  // The amendment supersedes the base version, which must exist first.
  await installCharter(base, { businessId });
  const signed = BusinessCharter.parse(
    signCharter(buildMailboxAmendment(base, NOON, provider), {
      signedByPersonId: 'owner',
      method: 'dashboard_click',
      signedAt: NOON,
    }),
  );
  const bundle = await installCharter(signed, { businessId });
  await upsertBinding(
    {
      system: 'mailbox',
      status: 'live',
      endpoint: null,
      credentialRef: 'OAUTH_MAILBOX',
      provider,
      lastOkAt: null,
      lastError: null,
    },
    { businessId, by: 'test' },
  );
  expect(await loadAutonomyMode({ businessId })).toBe('off');
  return bundle;
}

export function incomingMail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    providerMessageId: 'PM-1',
    threadId: 'TH-1',
    internetMessageId: '<q-1@client.example>',
    references: '<q-0@client.example>',
    fromAddress: 'dana@client.example',
    fromName: 'דנה לוי',
    replyTo: null,
    toAddresses: ['office@business.example'],
    subject: 'מתי תגיע ההצעה?',
    receivedAt: '2026-10-21T08:00:00.000Z',
    bodyText: 'היי, מתי תגיע הצעת המחיר?',
    bodyTruncated: false,
    headerFlags: { listUnsubscribe: false, autoSubmitted: false, bulkPrecedence: false },
    attachments: [],
    ...overrides,
  };
}

export async function storedMail(businessId: string, overrides: Partial<IncomingMail> = {}): Promise<StoredMail> {
  const mail = await recordIncoming(incomingMail(overrides), { businessId });
  if (mail === null) throw new Error('duplicate mail in test setup');
  return mail;
}

export function stubDrafter(body: string = DRAFT_BODY): Drafter & { calls: number } {
  const fn = (async () => {
    fn.calls += 1;
    return { status: 'drafted' as const, body };
  }) as unknown as Drafter & { calls: number };
  fn.calls = 0;
  return fn;
}

export type SendResult = { externalId: string | null } | MailboxFailure;

export function fakeMailboxClient(results: SendResult[] = [{ externalId: 'SENT-1' }]) {
  const sent: OutgoingReply[] = [];
  /** New messages (`sendNew`, ruling R21) — kept apart so a reply test never counts one. */
  const sentNew: OutgoingMessage[] = [];
  const client = {
    sendReply: async (_token: string, reply: OutgoingReply) => {
      sent.push(reply);
      return results[Math.min(sent.length - 1, results.length - 1)] ?? { externalId: 'SENT-1' };
    },
    sendNew: async (_token: string, message: OutgoingMessage) => {
      sentNew.push(message);
      return { externalId: 'SENT-NEW-1' };
    },
  } as unknown as MailboxClient;
  return { client, sent, sentNew };
}

export function mailboxRuntime(client: MailboxClient): Runtime {
  return {
    registry: new AdapterRegistry([
      createMailboxSendAdapter({ system: 'mailbox', provider: 'google', client }),
    ]),
    credentials: envCredentials({ [`${PREFIX}OAUTH_MAILBOX`]: 'access-token' }, PREFIX),
    warnings: [],
  };
}
