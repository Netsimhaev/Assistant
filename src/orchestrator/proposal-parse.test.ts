import { describe, expect, it } from 'vitest';
import type { Reading } from '../domain/reading.js';
import type { CatalogueEntry } from './catalogue.js';
import { parseProposal, proposalProblems } from './proposal-parse.js';

const SOURCE = { ordinal: 0, locator: null };

const READING: Reading = {
  summary: 'הצעת מחיר.',
  findings: [{ label: 'תנאי תשלום', value: 'שוטף + 60', sourceRef: SOURCE }],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
  unreadable: [],
};

const CATALOGUE: CatalogueEntry[] = [
  { agent: 'comms.email', tools: [{ toolName: 'mail.send', actionClass: 'email.reply', effectiveAutonomy: 'approve_required' }] },
];

const ACTION = {
  headline: 'אשלח מייל לדנה',
  purpose: 'כדי לאשר את התנאים',
  intent: 'reply_to_sender',
  agent: 'comms.email',
  toolName: 'mail.send',
  input: { to: 'dana@example.com', inReplyTo: 'msg-1' },
  expectedActionClass: 'email.reply',
};

const VALID = {
  stance: 'act',
  headline: 'אשיב לדנה על ההצעה',
  reasons: [{ text: 'התנאים הורעו', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
  action: ACTION,
};

describe('parseProposal', () => {
  it('parses a bare JSON object', () => {
    const outcome = parseProposal(JSON.stringify(VALID), READING, CATALOGUE);
    expect(outcome.status).toBe('proposed');
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    expect(outcome.proposal.headline).toBe('אשיב לדנה על ההצעה');
  });

  it('parses a response wrapped in prose and a fence', () => {
    const raw = `הנה ההצעה:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
    expect(parseProposal(raw, READING, CATALOGUE).status).toBe('proposed');
  });

  it('reports unproposable when there is no JSON', () => {
    const outcome = parseProposal('לא הצלחתי להחליט.', READING, CATALOGUE);
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('JSON');
  });

  it('refuses act with no action', () => {
    const outcome = parseProposal(JSON.stringify({ ...VALID, action: null }), READING, CATALOGUE);
    expect(outcome.status).toBe('unproposable');
  });

  /**
   * Found by the live run of 11/09, and by nothing else.
   *
   * The model read a supplier quote correctly, judged that the amount exceeded
   * its own spending authority, and proposed to act — with
   * `toolName: 'agent.request_help'` and `expectedActionClass: null`. That is
   * an honest reading of the catalogue, which offers the tool at `auto`.
   *
   * Nothing rejected it. `raiseProposalApproval` then returned `null` at its
   * read-only guard, the job closed, and a quote for ₪11,988 expiring in
   * three weeks reached the owner not at all. The `action_class_mismatch`
   * check above does not catch it, because it only fires when a class WAS
   * declared; here the model correctly declared `null` for a read-only tool
   * and was punished with silence.
   *
   * A proposal's action is a thing the owner can be asked to approve. A tool
   * the gate cannot classify can never become a card, so proposing one is not
   * a proposal to act — and "bring this to the owner" is not an action the
   * assistant takes, it is what raising the card already does.
   */
  it('refuses an action naming a tool the gate cannot classify', () => {
    const readOnlyAction = {
      ...ACTION,
      toolName: 'agent.request_help',
      input: { subject: 'הצעת מחיר', summary: 'דורש החלטה' },
      expectedActionClass: null,
    };
    const catalogue: CatalogueEntry[] = [
      {
        agent: 'comms.email',
        tools: [
          { toolName: 'agent.request_help', actionClass: null, effectiveAutonomy: 'auto' },
        ],
      },
    ];

    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: readOnlyAction }),
      READING,
      catalogue,
    );

    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('action_tool_cannot_be_carded');
  });

  /**
   * The other half, so the rule above cannot be satisfied by refusing every
   * action. A classifiable tool is still accepted, with the same catalogue
   * shape and the same declared-`null` class.
   */
  it('still accepts an action whose tool the gate can classify', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, expectedActionClass: null } }),
      READING,
      CATALOGUE,
    );
    expect(outcome.status).toBe('proposed');
  });

  it('refuses no_action that carries an action', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'no_action' }), READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses ask without a question', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'ask', action: null, clarifyingQuestion: null }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('accepts advise_against with an alternative action', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'אני נגד' }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('proposed');
  });

  it('accepts advise_against with no alternative', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'אני נגד', action: null }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('proposed');
  });

  it('refuses a reason citing a finding the reading does not have', () => {
    const invented = { text: 'x', findingLabel: 'סעיף שלא קיים', sourceRef: SOURCE };
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, reasons: [invented] }), READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toContain('סעיף שלא קיים');
  });

  it('refuses a tool the catalogue does not offer this agent', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, toolName: 'wa.send_message' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses an expectedActionClass that contradicts the real classification', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, expectedActionClass: 'whatsapp.reply' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  // The guard that used to stand here (`actual !== null`) let this exact
  // shape through: a read-only tool with a declared class was stored as
  // `proposed` and compiled, and `classMismatch` in `run-plan.ts` — which
  // has no such guard — then rejected the whole plan at execution. §8 says
  // this check catches an infeasible plan before it runs.
  it('refuses a read-only tool that still declares an action class, exactly as run-plan does', () => {
    const outcome = parseProposal(
      JSON.stringify({
        ...VALID,
        action: { ...ACTION, agent: 'know.reader', toolName: 'memory.recall' },
      }),
      READING,
      [
        ...CATALOGUE,
        { agent: 'know.reader', tools: [{ toolName: 'memory.recall', actionClass: null, effectiveAutonomy: 'auto' }] },
      ],
    );

    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected an unproposable outcome');
    // Named, not merely refused: without this the test would pass on
    // `tool_not_in_catalogue` and prove nothing about the guard.
    expect(outcome.reason).toContain('action_class_mismatch');
  });

  // `extractJsonObjects` yields the outermost object first and then every
  // object nested inside it — here, the `sourceRef` inside `reasons[0]`. That
  // nested fragment always fails `Proposal.safeParse` at `stance` (there is
  // no `stance` key on a bare `sourceRef`), with zod's message for a missing
  // enum. The bug this locks: the loop used to overwrite `reason` on every
  // failing candidate, so the nested fragment's unrelated "invalid stance"
  // complaint clobbered the outermost object's real, distinctive problem.
  it('reports the outermost object\'s reason, not a nested sourceRef\'s', () => {
    const brokenHeadline = {
      ...VALID,
      headline: '',
      reasons: [{ text: 'x', findingLabel: 'תנאי תשלום', sourceRef: SOURCE }],
    };
    const outcome = parseProposal(JSON.stringify(brokenHeadline), READING, CATALOGUE);
    expect(outcome.status).toBe('unproposable');
    if (outcome.status !== 'unproposable') throw new Error('expected unproposable');
    expect(outcome.reason).toBe('Too small: expected string to have >=1 characters');
    expect(outcome.reason).not.toContain('option');
    expect(outcome.reason).not.toContain('stance');
  });

  it("refuses a headline that is the action's own tool name", () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, headline: 'mail.send' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });

  it('refuses a headline that is a different known tool name', () => {
    const outcome = parseProposal(
      JSON.stringify({ ...VALID, action: { ...ACTION, headline: 'wa.send_message' } }),
      READING, CATALOGUE,
    );
    expect(outcome.status).toBe('unproposable');
  });
});

describe('proposalProblems', () => {
  it('finds nothing wrong with a well-formed proposal', () => {
    const outcome = parseProposal(JSON.stringify(VALID), READING, CATALOGUE);
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    expect(proposalProblems(outcome.proposal, READING, CATALOGUE)).toEqual([]);
  });

  it('names the stance problem it found', () => {
    const outcome = parseProposal(JSON.stringify({ ...VALID, stance: 'advise_against', headline: 'x' }), READING, CATALOGUE);
    if (outcome.status !== 'proposed') throw new Error('expected a proposal');
    const problems = proposalProblems({ ...outcome.proposal, action: null, stance: 'act' }, READING, CATALOGUE);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('act_without_action');
  });
});
