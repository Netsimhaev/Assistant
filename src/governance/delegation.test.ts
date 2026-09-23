import { describe, expect, it } from 'vitest';
import type { Plan } from '../domain/plan.js';
import {
  contextRefsHash,
  dailyCapGuard,
  delegationProblems,
  hopGuard,
  mayDelegate,
  noNewInformationGuard,
  oscillationGuard,
  tightenConstraints,
} from './delegation.js';
import type { EnvelopeConstraints, ContextRef } from '../domain/envelope.js';

const PARENT: EnvelopeConstraints = {
  charterVersion: 'v7',
  provenanceCeiling: 'staff',
  autonomyCeiling: 'approve_required',
  moneyCeilingMinor: 5000,
  deadlineAt: '2026-09-24T12:00:00.000Z',
};

describe('tightenConstraints', () => {
  /**
   * The whole security property of delegation in one test. Every field moves
   * only one way. Replacing any `mostRestrictive`/`lowest`/`Math.min` with its
   * opposite must fell this.
   */
  it('never loosens a single field, even when the source permits more', () => {
    const tightened = tightenConstraints(PARENT, {
      provenanceCeiling: 'boss',
      autonomyCeiling: 'auto',
      moneyCeilingMinor: 999_999,
      deadlineAt: '2026-12-31T00:00:00.000Z',
    });

    expect(tightened.provenanceCeiling).toBe('staff');
    expect(tightened.autonomyCeiling).toBe('approve_required');
    expect(tightened.moneyCeilingMinor).toBe(5000);
    expect(tightened.deadlineAt).toBe('2026-09-24T12:00:00.000Z');
  });

  it('takes the source value when the source is the stricter of the two', () => {
    const tightened = tightenConstraints(PARENT, {
      provenanceCeiling: 'unknown_external',
      autonomyCeiling: 'draft_only',
      moneyCeilingMinor: 100,
      deadlineAt: '2026-09-23T13:00:00.000Z',
    });

    expect(tightened.provenanceCeiling).toBe('unknown_external');
    expect(tightened.autonomyCeiling).toBe('draft_only');
    expect(tightened.moneyCeilingMinor).toBe(100);
    expect(tightened.deadlineAt).toBe('2026-09-23T13:00:00.000Z');
  });

  /**
   * `null` means "I carry no ceiling of my own", which must not be read as
   * "no ceiling applies" — the parent's number has to survive.
   */
  it('reads a null money ceiling as absent, not as unlimited', () => {
    expect(tightenConstraints(PARENT, { moneyCeilingMinor: null }).moneyCeilingMinor).toBe(5000);
    expect(
      tightenConstraints({ ...PARENT, moneyCeilingMinor: null }, { moneyCeilingMinor: 70 })
        .moneyCeilingMinor,
    ).toBe(70);
  });

  /**
   * A child running under a charter the parent never saw is a child whose
   * result the parent cannot explain. Copied, never negotiated.
   */
  it('copies the charter version from the parent verbatim', () => {
    expect(tightenConstraints(PARENT, { charterVersion: 'v9' }).charterVersion).toBe('v7');
  });
});

describe('hopGuard', () => {
  it('refuses at the ceiling, not one past it', () => {
    expect(hopGuard(5)).toBeNull();
    expect(hopGuard(6)?.code).toBe('hop_limit');
  });
});

describe('noNewInformationGuard', () => {
  it('refuses the identical quadruple and allows a changed context', () => {
    const candidate = {
      from: 'comms.email',
      to: 'know.reader',
      intent: 'summarise_document',
      contextRefsHash: 'hash-a',
    };
    expect(noNewInformationGuard(candidate, [candidate])?.code).toBe('no_new_information');
    expect(
      noNewInformationGuard({ ...candidate, contextRefsHash: 'hash-b' }, [candidate]),
    ).toBeNull();
  });
});

describe('oscillationGuard', () => {
  it('refuses at two exchanges', () => {
    expect(oscillationGuard(1)).toBeNull();
    expect(oscillationGuard(2)?.code).toBe('oscillation');
  });
});

describe('dailyCapGuard', () => {
  it('refuses when the cap is used up', () => {
    expect(dailyCapGuard(49, 50)).toBeNull();
    expect(dailyCapGuard(50, 50)?.code).toBe('daily_cap');
  });
});

describe('contextRefsHash', () => {
  it('is stable under reordering', () => {
    const a: ContextRef[] = [
      { kind: 'document', documentId: 'doc-1' },
      { kind: 'memory', memoryId: 'mem-1' },
    ];
    const b: ContextRef[] = [
      { kind: 'memory', memoryId: 'mem-1' },
      { kind: 'document', documentId: 'doc-1' },
    ];
    expect(contextRefsHash(a)).toBe(contextRefsHash(b));

    const c: ContextRef[] = [
      { kind: 'document', documentId: 'doc-2' },
      { kind: 'memory', memoryId: 'mem-1' },
    ];
    expect(contextRefsHash(a)).not.toBe(contextRefsHash(c));
  });
});

describe('mayDelegate', () => {
  const graph = { 'comms.email': ['know.reader'] };

  it('refuses an agent with no graph entry and refuses ops.web by name', () => {
    expect(mayDelegate(graph, 'ops.web', 'comms.email')).toBe(false);
    expect(mayDelegate({}, 'constructor', 'x')).toBe(false);
  });

  it('permits a pair the graph names', () => {
    expect(mayDelegate(graph, 'comms.email', 'know.reader')).toBe(true);
  });
});

describe('delegationProblems', () => {
  const graph = { 'comms.email': ['know.reader'] };

  function planWith(step: Plan['steps'][number]): Plan {
    return {
      goal: 'test',
      assumptions: [],
      clarifyingQuestion: null,
      steps: [step],
      estimatedCostMinor: 0,
    };
  }

  it('rejects a step whose payload names a pair outside the graph', () => {
    const plan = planWith({
      id: 's1',
      agent: 'comms.email',
      intent: 'ask_for_help',
      toolName: 'agent.request_help',
      input: { to: 'ops.web' },
      dependsOn: [],
      expectedActionClass: null,
    });
    const problems = delegationProblems(plan, graph);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: 'delegation_pair_not_permitted',
      stepId: 's1',
      from: 'comms.email',
      to: 'ops.web',
    });
  });

  it('rejects a delegation step with no "to" at all', () => {
    const plan = planWith({
      id: 's1',
      agent: 'comms.email',
      intent: 'ask_for_help',
      toolName: 'agent.request_help',
      input: {},
      dependsOn: [],
      expectedActionClass: null,
    });
    const problems = delegationProblems(plan, graph);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: 'delegation_pair_not_permitted',
      stepId: 's1',
      to: '(חסר)',
    });
  });

  it('allows a step naming a pair the graph permits', () => {
    const plan = planWith({
      id: 's1',
      agent: 'comms.email',
      intent: 'ask_for_help',
      toolName: 'agent.request_help',
      input: { to: 'know.reader' },
      dependsOn: [],
      expectedActionClass: null,
    });
    expect(delegationProblems(plan, graph)).toHaveLength(0);
  });
});
