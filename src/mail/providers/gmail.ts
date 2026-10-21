/**
 * Gmail REST client. Reads new inbox mail, adds our own labels, sends replies.
 *
 * Writes are add-only by construction: the only mutation of an existing
 * message is `messages.modify` with `addLabelIds`. There is no code path that
 * takes a label off, changes read state or relocates a message.
 * Every method returns a failure value rather than throwing.
 */
import type { HeaderFlags, IncomingMail, MailAttachment } from '../inbox-store.js';
import { capBody, decodeHeader, htmlToText, isBulkPrecedence, parseAddress, parseAddressList } from '../mime.js';
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
  type OutgoingReply,
} from './types.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_HISTORY_PAGES = 50;

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

function headerOf(headers: GmailPart['headers'], name: string): string | null {
  const wanted = name.toLowerCase();
  for (const h of headers ?? []) {
    if (typeof h.name === 'string' && h.name.toLowerCase() === wanted && typeof h.value === 'string') return h.value;
  }
  return null;
}

function walk(part: GmailPart, visit: (p: GmailPart) => void, depth = 0): void {
  visit(part);
  if (depth > 20) return;
  for (const child of part.parts ?? []) walk(child, visit, depth + 1);
}

function decodeData(data: string | undefined): string {
  return data === undefined ? '' : Buffer.from(data, 'base64url').toString('utf8');
}

function toIncoming(raw: unknown): IncomingMail | null {
  const msg = asRecord(raw);
  const id = msg['id'];
  const threadId = msg['threadId'];
  const payload = asRecord(msg['payload']) as GmailPart;
  if (typeof id !== 'string' || typeof threadId !== 'string') return null;

  let plain = '';
  let html = '';
  const attachments: MailAttachment[] = [];
  walk(payload, (p) => {
    if (p.filename !== undefined && p.filename !== '' && p.body?.attachmentId !== undefined) {
      attachments.push({
        attachmentId: p.body.attachmentId,
        filename: p.filename,
        mediaType: p.mimeType ?? 'application/octet-stream',
        size: p.body.size ?? 0,
      });
      return;
    }
    if (p.mimeType === 'text/plain') plain += decodeData(p.body?.data);
    else if (p.mimeType === 'text/html') html += decodeData(p.body?.data);
  });
  const text = plain.trim() !== '' ? plain : htmlToText(html);
  const body = capBody(text);

  const h = payload.headers;
  const from = parseAddress(headerOf(h, 'From') ?? '');
  const replyToRaw = headerOf(h, 'Reply-To');
  const replyTo = replyToRaw === null ? null : (parseAddressList(replyToRaw)[0]?.address ?? null);
  const autoSubmitted = headerOf(h, 'Auto-Submitted');
  const precedence = headerOf(h, 'Precedence');
  const flags: HeaderFlags = {
    listUnsubscribe: headerOf(h, 'List-Unsubscribe') !== null,
    autoSubmitted: autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== 'no',
    bulkPrecedence: precedence !== null && isBulkPrecedence(precedence),
  };
  const internal = Number(msg['internalDate']);
  const receivedAt = new Date(Number.isFinite(internal) && internal > 0 ? internal : Date.now()).toISOString();

  return {
    providerMessageId: id,
    threadId,
    internetMessageId: headerOf(h, 'Message-ID'),
    references: headerOf(h, 'References'),
    fromAddress: from?.address ?? '',
    fromName: from?.name ?? null,
    replyTo,
    toAddresses: parseAddressList(headerOf(h, 'To') ?? '').map((a) => a.address),
    subject: decodeHeader(headerOf(h, 'Subject') ?? ''),
    receivedAt,
    bodyText: body.text,
    bodyTruncated: body.truncated,
    headerFlags: flags,
    attachments,
  };
}

function encodeSubject(subject: string): string {
  // Plain ASCII passes through; anything else becomes one RFC 2047 encoded word.
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function buildRaw(reply: OutgoingReply): string {
  const refs = [reply.references, reply.inReplyTo].filter((v): v is string => v !== null && v !== '').join(' ');
  const encodedBody = (Buffer.from(reply.body, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  const lines = [
    `To: ${reply.to.join(', ')}`,
    `Subject: ${encodeSubject(reply.subject)}`,
    `In-Reply-To: ${reply.inReplyTo}`,
    `References: ${refs}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody,
  ];
  return lines.join('\r\n');
}

export function createGmailClient(http: MailboxHttp = defaultMailboxHttp()): MailboxClient {
  return {
    async initialCursor(token, signal) {
      const res = await http.request({ method: 'GET', url: `${BASE}/profile`, accessToken: token, signal });
      const historyId = asRecord(res.body)['historyId'];
      if (!ok2xx(res.status)) throw new MailboxCursorError(failureFromStatus(res.status, res.body));
      if (typeof historyId !== 'string' && typeof historyId !== 'number') {
        throw new MailboxCursorError({ failure: 'rejected', status: res.status, message: 'profile has no historyId' });
      }
      return String(historyId);
    },

    listSince(token, cursor, signal) {
      return guarded(async () => {
        const ids: string[] = [];
        let nextCursor = cursor;
        let pageToken: string | null = null;
        for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
          const url = new URL(`${BASE}/history`);
          url.searchParams.set('startHistoryId', cursor);
          url.searchParams.set('historyTypes', 'messageAdded');
          url.searchParams.set('labelId', 'INBOX');
          if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
          const res = await http.request({ method: 'GET', url: url.toString(), accessToken: token, signal });
          if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
          const body = asRecord(res.body);
          if (body['historyId'] !== undefined) nextCursor = String(body['historyId']);
          const history = Array.isArray(body['history']) ? body['history'] : [];
          for (const entry of history) {
            const added = asRecord(entry)['messagesAdded'];
            if (!Array.isArray(added)) continue;
            for (const a of added) {
              const m = asRecord(asRecord(a)['message']);
              const id = m['id'];
              const labels = Array.isArray(m['labelIds']) ? (m['labelIds'] as unknown[]) : null;
              if (typeof id !== 'string' || ids.includes(id)) continue;
              if (labels !== null && (!labels.includes('INBOX') || labels.includes('SENT') || labels.includes('DRAFT'))) continue;
              ids.push(id);
            }
          }
          const next = body['nextPageToken'];
          if (typeof next !== 'string' || next === '') break;
          pageToken = next;
        }

        const messages: IncomingMail[] = [];
        for (const id of ids) {
          const res = await http.request({
            method: 'GET',
            url: `${BASE}/messages/${encodeURIComponent(id)}?format=full`,
            accessToken: token,
            signal,
          });
          if (res.status === 404) continue; // gone between the history read and the fetch
          if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
          const mail = toIncoming(res.body);
          if (mail !== null) messages.push(mail);
        }
        return { messages, nextCursor };
      });
    },

    fetchAttachment(token, providerMessageId, attachmentId, signal) {
      return guarded(async () => {
        const res = await http.request({
          method: 'GET',
          url: `${BASE}/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
          accessToken: token,
          signal,
        });
        if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
        const data = asRecord(res.body)['data'];
        if (typeof data !== 'string') {
          return { failure: 'rejected', status: res.status, message: 'attachment response has no data' } as MailboxFailure;
        }
        return Buffer.from(data, 'base64url');
      });
    },

    ensureLabels(token, names, signal) {
      return guarded(async () => {
        const list = await http.request({ method: 'GET', url: `${BASE}/labels`, accessToken: token, signal });
        if (!ok2xx(list.status)) return failureFromStatus(list.status, list.body);
        const existing = new Map<string, string>();
        const labels = asRecord(list.body)['labels'];
        for (const l of Array.isArray(labels) ? labels : []) {
          const rec = asRecord(l);
          if (typeof rec['name'] === 'string' && typeof rec['id'] === 'string') existing.set(rec['name'], rec['id']);
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
            url: `${BASE}/labels`,
            accessToken: token,
            body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
            signal,
          });
          if (!ok2xx(created.status)) return failureFromStatus(created.status, created.body);
          const id = asRecord(created.body)['id'];
          if (typeof id !== 'string') {
            return { failure: 'rejected', status: created.status, message: 'label create returned no id' } as MailboxFailure;
          }
          out[name] = id;
        }
        return out;
      });
    },

    addLabel(token, providerMessageId, _labelName, labelId, signal) {
      return guarded(async () => {
        const res = await http.request({
          method: 'POST',
          url: `${BASE}/messages/${encodeURIComponent(providerMessageId)}/modify`,
          accessToken: token,
          body: { addLabelIds: [labelId] },
          signal,
        });
        if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
        return true as const;
      });
    },

    sendReply(token, reply, signal) {
      return guarded(async () => {
        const res = await http.request({
          method: 'POST',
          url: `${BASE}/messages/send`,
          accessToken: token,
          body: { raw: Buffer.from(buildRaw(reply), 'utf8').toString('base64url'), threadId: reply.threadId },
          signal,
        });
        if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
        const id = asRecord(res.body)['id'];
        return { externalId: typeof id === 'string' ? id : null };
      });
    },
  };
}

