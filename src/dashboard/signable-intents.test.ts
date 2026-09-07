/**
 * Structural, in the style of `positive-controls.test.ts`. This does not test
 * behaviour — it holds the shape of a control whose failure mode is a
 * permanent, un-deletable `signatures` row written by one wrong click.
 */
import { describe, expect, it } from 'vitest';
import { IntentName } from '../domain/reading.js';
import { DOCUMENT_DECISION_INTENTS, isDocumentDecisionIntent } from './signable-intents.js';

describe('the sign form is gated by an allowlist', () => {
  it('admits exactly the intents named in the list, and no others', () => {
    // Written against `IntentName.options` — the whole enum — rather than
    // against a handful of examples. A member added to the enum tomorrow is
    // covered by this the day it appears: it will not be in
    // `DOCUMENT_DECISION_INTENTS`, so it must not pass, and if someone ever
    // rewrites this control as "everything except …" this fails immediately.
    const admitted = IntentName.options.filter((intent) => isDocumentDecisionIntent(intent));
    expect(admitted).toEqual([...DOCUMENT_DECISION_INTENTS]);
    // And the list itself is spelled out here, not derived, so widening it is
    // a deliberate edit in two places rather than a quiet one in one.
    expect(admitted).toEqual(['file_document']);
  });

  it('refuses the intents that mean something is going out or nothing is settled', () => {
    // Named individually rather than as "the rest": the point of this test is
    // that a reader can see which specific decisions must never carry a
    // signature, not that a set difference came out empty.
    for (const intent of [
      'reply_to_sender',
      'contact_counterparty',
      'schedule_meeting',
      'pay_or_purchase',
      'record_entity',
      'record_preference',
      'flag_for_owner',
      'request_clarification',
      'no_action',
    ] as const) {
      expect(isDocumentDecisionIntent(intent), `${intent} must not be signable`).toBe(false);
    }
  });

  it('treats "no intent at all" as no', () => {
    // The proposal carries no action, the row predates the field, or the
    // stored value was not a member of the enum. All three arrive as `null`,
    // and an answer nobody could read is never the permissive answer.
    expect(isDocumentDecisionIntent(null)).toBe(false);
  });
});
