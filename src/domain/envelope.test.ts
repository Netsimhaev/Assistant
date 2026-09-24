import { describe, expect, it } from 'vitest';
import { AgentEnvelope, ContextRef, EnvelopeConstraints, MAX_HOPS } from './envelope.js';

describe('ContextRef', () => {
  /**
   * Every branch of ContextRef is a pointer. The next person to add one will
   * reach for a convenient `content: string`, and that single field turns
   * delegation into the injection path §3.2 exists to close.
   *
   * Asserted against the schema rather than a hand-written list of branch names,
   * so a branch added without touching this file is still covered.
   */
  it('has no branch carrying free text', () => {
    const branches = ContextRef.options;
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      const keys = Object.keys(branch.shape);
      expect(keys.length, JSON.stringify(keys)).toBe(2);
      expect(keys).toContain('kind');
      const idKey = keys.find((k) => k !== 'kind');
      expect(idKey, JSON.stringify(keys)).toMatch(/Id$/);
    }
  });
});

describe('EnvelopeConstraints', () => {
  const VALID = {
    charterVersion: 'v7',
    provenanceCeiling: 'staff',
    autonomyCeiling: 'approve_required',
    moneyCeilingMinor: 5000,
    deadlineAt: '2026-09-24T12:00:00.000Z',
  };

  it('accepts a well-formed constraints object', () => {
    expect(EnvelopeConstraints.safeParse(VALID).success).toBe(true);
  });

  it('accepts a null money ceiling', () => {
    expect(
      EnvelopeConstraints.safeParse({ ...VALID, moneyCeilingMinor: null }).success,
    ).toBe(true);
  });

  it('rejects an unknown trust level', () => {
    expect(
      EnvelopeConstraints.safeParse({ ...VALID, provenanceCeiling: 'nobody' }).success,
    ).toBe(false);
  });
});

describe('AgentEnvelope', () => {
  const VALID = {
    v: 1,
    id: 'env-1',
    correlationId: 'job-1',
    causalChain: ['env-1'],
    from: 'orchestrator',
    to: 'comms.email',
    kind: 'help_request',
    intent: 'draft_reply',
    payload: { note: 'x' },
    contextRefs: [{ kind: 'document', documentId: 'doc-1' }],
    constraints: {
      charterVersion: 'v7',
      provenanceCeiling: 'staff',
      autonomyCeiling: 'approve_required',
      moneyCeilingMinor: null,
      deadlineAt: '2026-09-24T12:00:00.000Z',
    },
    hops: 0,
    idempotencyKey: 'idem-1',
    createdAt: '2026-09-23T10:00:00.000Z',
  };

  it('accepts a well-formed envelope', () => {
    expect(AgentEnvelope.safeParse(VALID).success).toBe(true);
  });

  it(`rejects hops above MAX_HOPS (${MAX_HOPS})`, () => {
    expect(AgentEnvelope.safeParse({ ...VALID, hops: MAX_HOPS + 1 }).success).toBe(false);
  });

  it('rejects a `to` that is not a known agent', () => {
    expect(AgentEnvelope.safeParse({ ...VALID, to: 'orchestrator' }).success).toBe(false);
  });
});
