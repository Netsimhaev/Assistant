/**
 * Microsoft Graph mail client. Reads new inbox mail through the delta query,
 * adds categories (our labels), and sends replies.
 *
 * Writes are add-only: the only mutation of an existing message is a PATCH of
 * `categories` that keeps what is already there and adds one name. Nothing
 * here changes read state or relocates a message.
 * Every method returns a failure value rather than throwing.
 */
import type { HeaderFlags, IncomingMail, MailAttachment } from '../inbox-store.js';
import { capBody, htmlToText, isBulkPrecedence } from '../mime.js';
import {
  asRecord,
  defaultMailboxHttp,
  failureFromStatus,
  guarded,
  MailboxCursorError,
  ok2xx,
  type MailboxClient,
  type MailboxFailure,
  type MailboxHttp,
} from './types.js';

const BASE = 'https://graph.microsoft.com/v1.0';
const SELECT =
  'id,conversationId,internetMessageId,subject,from,replyTo,toRecipients,receivedDateTime,body,hasAttachments,internetMessageHeaders';
const INITIAL_DELTA_URL = `${BASE}/me/mailFolders/inbox/messages/delta?$select=${SELECT}`;
const MAX_PAGES = 200;

function addressOf(v: unknown): { address: string; name: string | null } | null {
  const email = asRecord(asRecord(v)['emailAddress']);
  const address = email['address'];
  if (typeof address !== 'string' || address.trim() === '') return null;
  const name = email['name'];
  return {
    address: address.trim().toLowerCase(),
    name: typeof name === 'string' && name.trim() !== '' && name !== address ? name.trim() : null,
  };
}

function internetHeader(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const h of headers) {
    const rec = asRecord(h);
    if (typeof rec['name'] === 'string' && rec['name'].toLowerCase() === wanted && typeof rec['value'] === 'string') {
      return rec['value'];
    }
  }
  return null;
}

function toIncoming(raw: Record<string, unknown>, attachments: MailAttachment[]): IncomingMail | null {
  const id = raw['id'];
  if (typeof id !== 'string') return null;
  const body = asRecord(raw['body']);
  const content = typeof body['content'] === 'string' ? body['content'] : '';
  const text = String(body['contentType']).toLowerCase() === 'html' ? htmlToText(content) : content;
  const capped = capBody(text);

  const headers = raw['internetMessageHeaders'];
  const autoSubmitted = internetHeader(headers, 'Auto-Submitted');
  const precedence = internetHeader(headers, 'Precedence');
  const flags: HeaderFlags = {
    listUnsubscribe: internetHeader(headers, 'List-Unsubscribe') !== null,
    autoSubmitted: autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== 'no',
    bulkPrecedence: precedence !== null && isBulkPrecedence(precedence),
  };

  const from = addressOf(raw['from']);
  const replyToList = Array.isArray(raw['replyTo']) ? raw['replyTo'] : [];
  const to = Array.isArray(raw['toRecipients']) ? raw['toRecipients'] : [];
  const received = Date.parse(String(raw['receivedDateTime']));

  return {
    providerMessageId: id,
    threadId: typeof raw['conversationId'] === 'string' ? raw['conversationId'] : id,
    internetMessageId: typeof raw['internetMessageId'] === 'string' ? raw['internetMessageId'] : null,
    references: internetHeader(headers, 'References'),
    fromAddress: from?.address ?? '',
    fromName: from?.name ?? null,
    replyTo: addressOf(replyToList[0])?.address ?? null,
    toAddresses: to.map((t) => addressOf(t)?.address).filter((a): a is string => a !== undefined),
    subject: typeof raw['subject'] === 'string' ? raw['subject'] : '',
    receivedAt: new Date(Number.isFinite(received) ? received : Date.now()).toISOString(),
    bodyText: capped.text,
    bodyTruncated: capped.truncated,
    headerFlags: flags,
    attachments,
  };
}

export function createGraphClient(http: MailboxHttp = defaultMailboxHttp()): MailboxClient {
  /** Walk delta pages to the end. Returns the entries and the final delta link. */
  async function walkDelta(
    token: string,
    startUrl: string,
    signal: AbortSignal,
  ): Promise<{ entries: Array<Record<string, unknown>>; deltaLink: string } | MailboxFailure> {
    const entries: Array<Record<string, unknown>> = [];
    let url = startUrl;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await http.request({ method: 'GET', url, accessToken: token, signal });
      if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
      const body = asRecord(res.body);
      for (const v of Array.isArray(body['value']) ? body['value'] : []) entries.push(asRecord(v));
      const next = body['@odata.nextLink'];
      if (typeof next === 'string' && next !== '') {
        url = next;
        continue;
      }
      const deltaLink = body['@odata.deltaLink'];
      if (typeof deltaLink === 'string' && deltaLink !== '') return { entries, deltaLink };
      return { failure: 'rejected', status: res.status, message: 'delta response has neither nextLink nor deltaLink' };
    }
    return { failure: 'transient', status: 0, message: 'delta walk exceeded the page cap' };
  }

  return {
    async initialCursor(token, signal) {
      // Consume the whole initial delta without keeping a message: no backfill.
      const result = await guarded(() => walkDelta(token, INITIAL_DELTA_URL, signal));
      if ('failure' in result) throw new MailboxCursorError(result);
      return result.deltaLink;
    },

    listSince(token, cursor, signal) {
      return guarded(async () => {
        const walked = await walkDelta(token, cursor, signal);
        if ('failure' in walked) return walked;
        const messages: IncomingMail[] = [];
        for (const entry of walked.entries) {
          if (entry['@removed'] !== undefined) continue;
          const id = entry['id'];
          if (typeof id !== 'string') continue;
          const attachments: MailAttachment[] = [];
          if (entry['hasAttachments'] === true) {
            const res = await http.request({
              method: 'GET',
              url: `${BASE}/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size`,
              accessToken: token,
              signal,
            });
            if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
            const list = asRecord(res.body)['value'];
            for (const a of Array.isArray(list) ? list : []) {
              const rec = asRecord(a);
              if (typeof rec['id'] !== 'string') continue;
              attachments.push({
                attachmentId: rec['id'],
                filename: typeof rec['name'] === 'string' ? rec['name'] : 'attachment',
                mediaType: typeof rec['contentType'] === 'string' ? rec['contentType'] : 'application/octet-stream',
                size: typeof rec['size'] === 'number' ? rec['size'] : 0,
              });
            }
          }
          const mail = toIncoming(entry, attachments);
          if (mail !== null) messages.push(mail);
        }
        return { messages, nextCursor: walked.deltaLink };
      });
    },

    fetchAttachment(token, providerMessageId, attachmentId, signal) {
      return guarded(async () => {
        const res = await http.request({
          method: 'GET',
          url: `${BASE}/me/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
          accessToken: token,
          signal,
        });
        if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
        const bytes = asRecord(res.body)['contentBytes'];
        if (typeof bytes !== 'string') {
          return { failure: 'rejected', status: res.status, message: 'attachment has no contentBytes' } as MailboxFailure;
        }
        return Buffer.from(bytes, 'base64');
      });
    },

    ensureLabels(token, names, signal) {
      return guarded(async () => {
        const list = await http.request({
          method: 'GET',
          url: `${BASE}/me/outlook/masterCategories`,
          accessToken: token,
          signal,
        });
        if (!ok2xx(list.status)) return failureFromStatus(list.status, list.body);
        const existing = new Map<string, string>();
        const value = asRecord(list.body)['value'];
        for (const c of Array.isArray(value) ? value : []) {
          const rec = asRecord(c);
          if (typeof rec['displayName'] === 'string' && typeof rec['id'] === 'string') {
            existing.set(rec['displayName'], rec['id']);
          }
        }
        const out: Record<string, string> = {};
        for (const name of names) {
          const have = existing.get(name);
          if (have !== undefined) {
            out[name] = have;
            continue;
          }
          const created = await http.request({
            method: 'POST',
            url: `${BASE}/me/outlook/masterCategories`,
            accessToken: token,
            body: { displayName: name, color: 'preset0' },
            signal,
          });
          if (!ok2xx(created.status)) return failureFromStatus(created.status, created.body);
          const id = asRecord(created.body)['id'];
          if (typeof id !== 'string') {
            return { failure: 'rejected', status: created.status, message: 'category create returned no id' } as MailboxFailure;
          }
          out[name] = id;
        }
        return out;
      });
    },

    addLabel(token, providerMessageId, labelName, _labelId, signal) {
      return guarded(async () => {
        const url = `${BASE}/me/messages/${encodeURIComponent(providerMessageId)}`;
        const current = await http.request({ method: 'GET', url: `${url}?$select=categories`, accessToken: token, signal });
        if (!ok2xx(current.status)) return failureFromStatus(current.status, current.body);
        const raw = asRecord(current.body)['categories'];
        const existing = (Array.isArray(raw) ? raw : []).filter((c): c is string => typeof c === 'string');
        const categories = existing.includes(labelName) ? existing : [...existing, labelName];
        const res = await http.request({ method: 'PATCH', url, accessToken: token, body: { categories }, signal });
        if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
        return true as const;
      });
    },

    sendReply(token, reply, signal) {
      return guarded(async () => {
        if (reply.providerMessageId === undefined || reply.providerMessageId === '') {
          return { failure: 'rejected', status: 0, message: 'graph reply needs the provider message id' } as MailboxFailure;
        }
        // createReply threads the draft to the original; the recipients are then set
        // explicitly so a different Reply-To on the original can never redirect it.
        const created = await http.request({
          method: 'POST',
          url: `${BASE}/me/messages/${encodeURIComponent(reply.providerMessageId)}/createReply`,
          accessToken: token,
          body: {},
          signal,
        });
        if (!ok2xx(created.status)) return failureFromStatus(created.status, created.body);
        const draftId = asRecord(created.body)['id'];
        if (typeof draftId !== 'string') {
          return { failure: 'rejected', status: created.status, message: 'createReply returned no id' } as MailboxFailure;
        }
        const draftUrl = `${BASE}/me/messages/${encodeURIComponent(draftId)}`;
        const patched = await http.request({
          method: 'PATCH',
          url: draftUrl,
          accessToken: token,
          body: {
            toRecipients: reply.to.map((address) => ({ emailAddress: { address } })),
            ccRecipients: [],
            body: { contentType: 'text', content: reply.body },
          },
          signal,
        });
        if (!ok2xx(patched.status)) return failureFromStatus(patched.status, patched.body);
        const sent = await http.request({ method: 'POST', url: `${draftUrl}/send`, accessToken: token, signal });
        if (!ok2xx(sent.status)) return failureFromStatus(sent.status, sent.body);
        return { externalId: draftId };
      });
    },
  };
}

