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
import { MAIL_LABELS } from '../mailbox.js';
import { ADDRESS_SHAPE, capBody, htmlToText, isBulkPrecedence } from '../mime.js';
import {
  asRecord,
  cursorExpired,
  defaultMailboxHttp,
  failureFromStatus,
  guarded,
  labelNotAllowed,
  MailboxCursorError,
  ok2xx,
  type MailboxClient,
  type MailboxFailure,
  type MailboxHttp,
  type OutgoingAttachment,
} from './types.js';

const BASE = 'https://graph.microsoft.com/v1.0';
const SELECT =
  'id,conversationId,internetMessageId,subject,from,replyTo,toRecipients,receivedDateTime,body,hasAttachments,internetMessageHeaders';
const MAX_PAGES = 200;
const DELTA_HEADERS = { Prefer: 'odata.maxpagesize=50' };
const ALLOWED_LABELS: readonly string[] = Object.values(MAIL_LABELS);

/**
 * The largest single file this client attaches inline (spec §8.2, a Claude
 * ruling): Graph takes a `fileAttachment` in one request only up to 3MB, and
 * there is no upload session in this project. Larger is refused — the mailbox
 * adapter refuses it first, in Hebrew; this is the provider's own floor.
 */
export const GRAPH_MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function attachmentTooLarge(attachments: readonly OutgoingAttachment[]): MailboxFailure | null {
  return attachments.some((file) => file.bytes.length > GRAPH_MAX_ATTACHMENT_BYTES)
    ? { failure: 'rejected', status: 0, message: 'graph attachment is larger than 3MB' }
    : null;
}

/**
 * A failure once `createReply` has made a draft. Never retryable: a retry
 * starts over with a new draft, so a transient 4xx/5xx/401 becomes `rejected`.
 * Status 0 is kept as it is — the dropped connection may have been the send
 * itself, and the adapter already maps status 0 to its final, ambiguous
 * `delivery_unknown`.
 */
function afterDraftFailure(status: number, body: unknown): MailboxFailure {
  const failure = failureFromStatus(status, body);
  return status === 0 ? failure : { failure: 'rejected', status, message: failure.message };
}

function fileAttachment(file: OutgoingAttachment): Record<string, string> {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: file.filename,
    contentType: file.mediaType,
    contentBytes: file.bytes.toString('base64'),
  };
}

/**
 * The initial delta only needs to reach a deltaLink: filter to mail received from now on
 * (no backfill) and select just the id so the walk stays tiny. Later delta pages carry
 * only ids as well; `listSince` fetches each message in full.
 */
function initialDeltaUrl(now: Date): string {
  const filter = encodeURIComponent(`receivedDateTime ge ${now.toISOString()}`);
  return `${BASE}/me/mailFolders/inbox/messages/delta?$filter=${filter}&$select=id`;
}

function isExpiredCursor(status: number, body: unknown): boolean {
  if (status === 410) return true;
  const code = asRecord(asRecord(body)['error'])['code'];
  return typeof code === 'string' && /^(syncStateNotFound|resyncRequired|syncStateInvalid)$/i.test(code);
}

function addressOf(v: unknown): { address: string; name: string | null } | null {
  const email = asRecord(asRecord(v)['emailAddress']);
  const address = email['address'];
  if (typeof address !== 'string' || !ADDRESS_SHAPE.test(address.trim())) return null;
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
      const res = await http.request({ method: 'GET', url, accessToken: token, headers: DELTA_HEADERS, signal });
      if (isExpiredCursor(res.status, res.body)) return cursorExpired(res.status, 'delta state is no longer valid');
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
      const result = await guarded(() => walkDelta(token, initialDeltaUrl(new Date()), signal));
      if ('failure' in result) throw new MailboxCursorError(result);
      return result.deltaLink;
    },

    listSince(token, cursor, signal) {
      return guarded(async () => {
        const walked = await walkDelta(token, cursor, signal);
        if ('failure' in walked) return walked;
        const messages: IncomingMail[] = [];
        // Delta also reports messages that merely changed, so one may come back more than once;
        // the store dedupes on (business, provider message id).
        const seen = new Set<string>();
        for (const entry of walked.entries) {
          if (entry['@removed'] !== undefined) continue;
          const id = entry['id'];
          if (typeof id !== 'string' || seen.has(id)) continue;
          seen.add(id);
          const full = await http.request({
            method: 'GET',
            url: `${BASE}/me/messages/${encodeURIComponent(id)}?$select=${SELECT}`,
            accessToken: token,
            signal,
          });
          if (full.status === 404) continue; // gone since the delta
          if (!ok2xx(full.status)) return failureFromStatus(full.status, full.body);
          const raw = asRecord(full.body);
          const attachments: MailAttachment[] = [];
          if (raw['hasAttachments'] === true) {
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
          const mail = toIncoming(raw, attachments);
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
        const bad = names.find((n) => !ALLOWED_LABELS.includes(n));
        if (bad !== undefined) return labelNotAllowed(bad);
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
        if (!ALLOWED_LABELS.includes(labelName)) return labelNotAllowed(labelName);
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
        if (reply.providerMessageId === '') {
          return { failure: 'rejected', status: 0, message: 'graph reply needs the provider message id' } as MailboxFailure;
        }
        if (reply.to.length === 0 || !reply.to.every((a) => ADDRESS_SHAPE.test(a))) {
          return { failure: 'rejected', status: 0, message: 'reply recipient is not a plain address' } as MailboxFailure;
        }
        const attachments = reply.attachments ?? [];
        const tooLarge = attachmentTooLarge(attachments);
        if (tooLarge !== null) return tooLarge;
        const message = { toRecipients: reply.to.map((address) => ({ emailAddress: { address } })), ccRecipients: [] };
        if (attachments.length > 0) {
          // A reply with a file is three calls: createReply (a draft that
          // quotes the original, with the same explicit recipients and empty
          // cc), one POST per fileAttachment, then send. The one-call /reply
          // below takes no attachments. A failure before the send leaves an
          // unsent draft in the mailbox — never a sent mail without its file.
          // Nothing here removes that draft: this client carries no removal
          // call at all, and forbidden-ops.test.ts scans it to keep it so.
          // Every failure once the draft exists is therefore FINAL (see
          // `afterDraftFailure`): a retry would open a second draft.
          const created = await http.request({
            method: 'POST',
            url: `${BASE}/me/messages/${encodeURIComponent(reply.providerMessageId)}/createReply`,
            accessToken: token,
            body: { message, comment: reply.body },
            signal,
          });
          if (!ok2xx(created.status)) return failureFromStatus(created.status, created.body);
          const draftId = asRecord(created.body)['id'];
          if (typeof draftId !== 'string' || draftId === '') {
            return { failure: 'rejected', status: created.status, message: 'graph createReply returned no draft id' } as MailboxFailure;
          }
          const draftUrl = `${BASE}/me/messages/${encodeURIComponent(draftId)}`;
          for (const file of attachments) {
            const added = await http.request({
              method: 'POST',
              url: `${draftUrl}/attachments`,
              accessToken: token,
              body: fileAttachment(file),
              signal,
            });
            if (!ok2xx(added.status)) return afterDraftFailure(added.status, added.body);
          }
          const sent = await http.request({ method: 'POST', url: `${draftUrl}/send`, accessToken: token, signal });
          if (!ok2xx(sent.status)) return afterDraftFailure(sent.status, sent.body);
          return { externalId: null };
        }
        // One call, no draft left behind on failure. The recipients are set explicitly so a
        // different Reply-To on the original can never redirect the answer, and cc stays empty.
        // Graph answers 202 with an empty body, so there is no sent-message id to report.
        const res = await http.request({
          method: 'POST',
          url: `${BASE}/me/messages/${encodeURIComponent(reply.providerMessageId)}/reply`,
          accessToken: token,
          body: { message, comment: reply.body },
          signal,
        });
        if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
        return { externalId: null };
      });
    },

    sendNew(token, message, signal) {
      return guarded(async () => {
        if (message.to.length === 0 || !message.to.every((a) => ADDRESS_SHAPE.test(a))) {
          return { failure: 'rejected', status: 0, message: 'mail recipient is not a plain address' } as MailboxFailure;
        }
        // JSON, not raw headers, so a line break cannot open a header here —
        // refused anyway, so both providers answer the same payload the same way.
        if (/[\r\n]/.test(message.subject)) {
          return { failure: 'rejected', status: 0, message: 'mail subject contains a line break' } as MailboxFailure;
        }
        const attachments = message.attachments ?? [];
        const tooLarge = attachmentTooLarge(attachments);
        if (tooLarge !== null) return tooLarge;
        // One call: sendMail sends and files in Sent; no draft is created, so
        // nothing is left behind on failure. cc stays empty, as on a reply.
        // Graph answers 202 with an empty body: no sent-message id to report.
        // Attachments ride inline on the same message as fileAttachments.
        const res = await http.request({
          method: 'POST',
          url: `${BASE}/me/sendMail`,
          accessToken: token,
          body: {
            message: {
              subject: message.subject,
              body: { contentType: 'Text', content: message.body },
              toRecipients: message.to.map((address) => ({ emailAddress: { address } })),
              ccRecipients: [],
              ...(attachments.length > 0 ? { attachments: attachments.map(fileAttachment) } : {}),
            },
            saveToSentItems: true,
          },
          signal,
        });
        if (!ok2xx(res.status)) return failureFromStatus(res.status, res.body);
        return { externalId: null };
      });
    },
  };
}

