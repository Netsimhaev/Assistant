import { describe, expect, it } from 'vitest';
import { DESCRIPTION_HEADING } from '../business/description-prompt.js';
import type { PolicyBundle } from '../domain/policy.js';
import { buildNudgeDraftCall, type NudgeDraftRequest } from './nudge-drafter.js';

const bundle = { promptFragments: { 'comms.email': 'frag' } } as unknown as PolicyBundle;
const req: NudgeDraftRequest = {
  bundle,
  family: 'money_in',
  description: 'חשבונית 123',
  reference: null,
  dueText: null,
  counterpartyName: null,
  nudgeNumber: 1,
};

describe('nudge drafter prompt', () => {
  it('the system prompt carries the description when given and omits the heading when not', () => {
    const withDesc = String(buildNudgeDraftCall({ ...req, businessDescription: 'מספרה בחיפה' }, 'n').options.systemPrompt);
    expect(withDesc).toContain(DESCRIPTION_HEADING);
    expect(withDesc).toContain('מספרה בחיפה');
    expect(String(buildNudgeDraftCall(req, 'n').options.systemPrompt)).not.toContain(DESCRIPTION_HEADING);
  });
});
