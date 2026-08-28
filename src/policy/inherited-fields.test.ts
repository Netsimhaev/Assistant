import { describe, expect, it } from 'vitest';
import { refineActionClass } from './classify.js';
import { buildFacts } from './facts.js';
import { readRecipients, readString } from '../orchestrator/adapters/mail.js';

/**
 * An inherited field is not something the payload said — but "ignore it" is
 * only the right answer where reading it would make the outcome *gentler*.
 *
 * The rule this codebase actually holds is not "own properties always". It is
 * the same rule as everywhere else: a value we cannot trust must never be a
 * permissive value. So the readers split into three groups, and each is pinned
 * here so a future sweep in either direction has to argue with a test:
 *
 *  - **Inheritance loosens → read own only.** `inReplyTo` and `conversationId`
 *    turn an initiated message into a reply, and a reply carries a gentler
 *    autonomy base. An inherited one is a downgrade of the exact control this
 *    system exists to hold.
 *  - **Inheritance tightens → leave it alone.** An inherited `amountMinor` or
 *    `dataClasses` makes the action look more expensive or more sensitive than
 *    it is. Ignoring it would be the loosening move, so these deliberately keep
 *    reading through the chain.
 *  - **Inheritance diverges → read own only.** `subject` and `body` are not
 *    policy inputs, but redaction rewrites the payload the gate saw, and the
 *    adapter must not then send a field that rewrite never touched.
 */
function withInherited(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.create(fields) as Record<string, unknown>;
}

const CTX = {
  provenance: 'boss' as const,
  chainDepth: 0,
  provenanceChainDerived: false,
  counterpartyTags: [] as string[],
};

describe('inherited fields that would loosen a decision are not read', () => {
  it('an inherited thread reference does not downgrade an initiated email', () => {
    expect(refineActionClass('email.reply', withInherited({ inReplyTo: 'thread-42' }))).toBe(
      'email.initiate',
    );
  });

  it('an inherited conversation id does not downgrade an initiated whatsapp message', () => {
    expect(refineActionClass('whatsapp.reply', withInherited({ conversationId: 'c-1' }))).toBe(
      'whatsapp.initiate',
    );
  });

  it('an inherited recipient is not delivered to', () => {
    expect(readRecipients(withInherited({ to: 'blocked@rival.co.il' }))).toEqual([]);
  });

  it('an inherited subject is not sent, because redaction never walked it', () => {
    expect(readString(withInherited({ subject: 'ת"ז 123456789' }), 'subject')).toBeNull();
  });
});

describe('inherited fields that would tighten a decision are still read', () => {
  it('an inherited amount still escalates a click to a purchase', () => {
    expect(refineActionClass('browser.interact', withInherited({ amountMinor: 50_000 }))).toBe(
      'purchase.place',
    );
  });

  it('an inherited amount still counts against the budget', () => {
    const facts = buildFacts('mail.send', withInherited({ amountMinor: 900_000 }), CTX);
    expect(facts.amountMinor).toBe(900_000);
  });

  it('an inherited data class still colours the payload', () => {
    const facts = buildFacts('mail.send', withInherited({ dataClasses: ['credentials'] }), CTX);
    expect(facts.dataClasses).toEqual(['credentials']);
  });
});
