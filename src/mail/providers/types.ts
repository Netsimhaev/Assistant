import type { IncomingMail } from '../inbox-store.js';

export interface MailboxHttp {
  request(input: {
    method: 'GET' | 'POST' | 'PATCH';
    url: string;
    accessToken: string;
    body?: unknown;
    /** Extra request headers (e.g. Prefer). The Authorization header is always set by the transport. */
    headers?: Record<string, string>;
    signal: AbortSignal;
  }): Promise<{ status: number; body: unknown; bytes?: Buffer }>;
}

export type MailboxFailure = { failure: 'auth' | 'transient' | 'rejected' | 'cursor_expired'; status: number; message: string };

export interface OutgoingReply {
  to: string[];
  subject: string;
  body: string;
  inReplyTo: string;
  references: string | null;
  threadId: string;
  /** Provider's own id of the mail being answered. Graph needs it (its reply is addressed by id, not by Message-ID); Gmail ignores it. */
  providerMessageId: string;
}

export interface MailboxClient {
  /** Throws `MailboxCursorError` on failure: this signature has no failure arm. */
  initialCursor(token: string, signal: AbortSignal): Promise<string>;
  listSince(
    token: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<{ messages: IncomingMail[]; nextCursor: string } | MailboxFailure>;
  fetchAttachment(
    token: string,
    providerMessageId: string,
    attachmentId: string,
    signal: AbortSignal,
  ): Promise<Buffer | MailboxFailure>;
  ensureLabels(
    token: string,
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<Record<string, string> | MailboxFailure>;
  addLabel(
    token: string,
    providerMessageId: string,
    labelName: string,
    labelId: string,
    signal: AbortSignal,
  ): Promise<true | MailboxFailure>;
  sendReply(
    token: string,
    reply: OutgoingReply,
    signal: AbortSignal,
  ): Promise<{ externalId: string | null } | MailboxFailure>;
}

export class MailboxCursorError extends Error {
  constructor(readonly failure: MailboxFailure) {
    super(failure.message);
    this.name = 'MailboxCursorError';
  }
}

export function isFailure(v: unknown): v is MailboxFailure {
  return typeof v === 'object' && v !== null && !Buffer.isBuffer(v) && 'failure' in v;
}

/** Same mapping as the calendar adapter: 401 auth; 429, 5xx and 0 transient; anything else rejected. */
export function failureFromStatus(status: number, body: unknown): MailboxFailure {
  let detail = '';
  if (typeof body === 'object' && body !== null) {
    const error = (body as Record<string, unknown>)['error'];
    if (typeof error === 'string') detail = error;
    else if (typeof error === 'object' && error !== null) {
      const m = (error as Record<string, unknown>)['message'];
      if (typeof m === 'string') detail = m;
    }
  }
  const suffix = detail === '' ? '' : `: ${detail}`;
  if (status === 401) return { failure: 'auth', status, message: `mailbox auth rejected (401)${suffix}` };
  if (status === 0 || status === 429 || status >= 500) {
    return { failure: 'transient', status, message: `mailbox provider unavailable (${status})${suffix}` };
  }
  return { failure: 'rejected', status, message: `mailbox provider rejected the request (${status})${suffix}` };
}

/** The cursor the provider was asked to resume from no longer exists. The poller re-takes it; there is no backfill. */
export function cursorExpired(status: number, message: string): MailboxFailure {
  return { failure: 'cursor_expired', status, message: `mailbox cursor expired (${status}): ${message}` };
}

export function ok2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Default HTTP: global fetch with a bearer token; a network failure is reported as status 0. */
export function defaultMailboxHttp(): MailboxHttp {
  return {
    async request(input) {
      try {
        const headers: Record<string, string> = { ...input.headers, Authorization: `Bearer ${input.accessToken}` };
        const init: RequestInit = { method: input.method, headers, signal: input.signal };
        if (input.body !== undefined) {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(input.body);
        }
        const response = await fetch(input.url, init);
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { status: response.status, body };
      } catch (error) {
        return { status: 0, body: { error: { message: error instanceof Error ? error.message : String(error) } } };
      }
    },
  };
}

/** Run a client call so an unexpected throw from the injected HTTP becomes a transient failure. */
export async function guarded<T>(fn: () => Promise<T | MailboxFailure>): Promise<T | MailboxFailure> {
  try {
    return await fn();
  } catch (error) {
    return { failure: 'transient', status: 0, message: error instanceof Error ? error.message : String(error) };
  }
}

/** A write may only name a label from the closed set (src/mail/mailbox.ts). */
export function labelNotAllowed(name: string): MailboxFailure {
  return { failure: 'rejected', status: 0, message: `label "${name}" is not in the closed label set` };
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
