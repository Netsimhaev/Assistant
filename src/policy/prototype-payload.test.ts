import { describe, expect, it } from 'vitest';
import type { PolicyBundle } from '../domain/policy.js';
import { redactPayload } from './redact.js';
import { readEmails } from './facts.js';
import { readRecipients } from '../orchestrator/adapters/mail.js';

/**
 * The gate screens `toolInput`; the mail adapter is handed `redactedInput`.
 * Those two must never be able to disagree about who a message reaches.
 *
 * `JSON.parse` creates `__proto__` as an ordinary own property, so a payload
 * can carry one. Rebuilding an object with `out[key] = …` turns that own key
 * into a *prototype assignment*: the copy loses the key and gains a prototype
 * whose fields answer a plain `input['to']` lookup. The gate reads the
 * original and sees no recipient — do-not-contact never fires, the counterparty
 * risk dimensions score empty, and the audit row records a send to nobody —
 * while the adapter reads the copy and mails a real address.
 */
const bundleWithRedaction = { redactPatterns: ['\\d{9}'] } as unknown as PolicyBundle;

describe('a payload key named __proto__', () => {
  it('cannot give the adapter a recipient the gate never saw', () => {
    const input = JSON.parse(
      '{"__proto__":{"to":"blocked@rival.co.il"},"subject":"נושא","body":"גוף"}',
    ) as Record<string, unknown>;

    const redacted = redactPayload(input, bundleWithRedaction) as Record<string, unknown>;

    expect(readRecipients(redacted)).toEqual(readEmails(input));
  });

  it('does not survive redaction as an inherited value', () => {
    const input = JSON.parse('{"__proto__":{"to":"blocked@rival.co.il"},"subject":"נושא"}') as Record<
      string,
      unknown
    >;

    const redacted = redactPayload(input, bundleWithRedaction) as Record<string, unknown>;

    expect(redacted['to']).toBeUndefined();
  });

  // Defence in depth for the same divergence: even handed an object that
  // already carries an inherited `to`, the two readers must agree — and they
  // agree on "there is no recipient here", because an inherited field is not
  // something the payload said.
  it('is invisible to both readers when it arrives as an actual prototype', () => {
    const carrier = { to: 'blocked@rival.co.il' };
    const payload = Object.create(carrier) as Record<string, unknown>;
    payload['subject'] = 'נושא';

    expect(readEmails(payload)).toEqual([]);
    expect(readRecipients(payload)).toEqual([]);
  });

  it('leaves the global prototype alone either way', () => {
    const input = JSON.parse('{"__proto__":{"polluted":"yes"},"subject":"נושא"}') as Record<
      string,
      unknown
    >;

    redactPayload(input, bundleWithRedaction);

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
