import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { raiseProposalApproval, RAMP_HONESTY } from './proposal-approval.js';
import type { Proposal } from '../domain/proposal.js';

const BUSINESS = 'biz-raise';

function aProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    headline: 'קראתי את החוזה',
    stance: 'act',
    reasons: [
      { text: 'המחיר תואם למה שסוכם', findingLabel: 'מחיר', sourceRef: { ordinal: 0, locator: null } },
    ],
    action: {
      headline: 'אשלח מייל לדנה לאשר את המועד',
      purpose: 'לאשר את מועד ההתקנה',
      agent: 'comms.email',
      intent: 'reply_to_sender',
      toolName: 'mail.send',
      expectedActionClass: 'email.initiate',
      input: { to: 'dana@example.com', subject: 'אישור מועד', body: 'מאשר' },
    },
    clarifyingQuestion: null,
    ...over,
  } as Proposal;
}

describe('raiseProposalApproval', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('raises a pending approval carrying the action headline', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      { jobId: null, proposal: aProposal(), bundle },
      { businessId: BUSINESS },
    );

    expect(approvalId).not.toBeNull();
    const { rows } = await getPool().query<{ state: string; summary: string; detail: string }>(
      `SELECT state, summary, detail FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    expect(rows[0]?.state).toBe('pending');
    expect(rows[0]?.summary).toBe('אשלח מייל לדנה לאשר את המועד');
  });

  it('says plainly that approving will not make it happen', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      { jobId: null, proposal: aProposal(), bundle },
      { businessId: BUSINESS },
    );
    const { rows } = await getPool().query<{ detail: string }>(
      `SELECT detail FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    expect(rows[0]?.detail).toContain(RAMP_HONESTY);
  });

  it('returns null and writes nothing when the proposal carries no action', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      {
        jobId: null,
        proposal: aProposal({ stance: 'no_action', action: null }),
        bundle,
      },
      { businessId: BUSINESS },
    );

    expect(approvalId).toBeNull();
    const { rows } = await getPool().query(`SELECT 1 FROM approval_requests`);
    expect(rows).toHaveLength(0);
  });

  it('returns null for a read-only action rather than throwing', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const proposal = aProposal();
    const readOnly = {
      ...proposal,
      action: { ...proposal.action!, toolName: 'crm.read', expectedActionClass: null },
    } as Proposal;

    const approvalId = await raiseProposalApproval(
      { jobId: null, proposal: readOnly, bundle },
      { businessId: BUSINESS },
    );

    expect(approvalId).toBeNull();
    const { rows } = await getPool().query(`SELECT 1 FROM approval_requests`);
    expect(rows).toHaveLength(0);
  });

  it('stamps the approval\'s risk with external provenance', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const approvalId = await raiseProposalApproval(
      { jobId: null, proposal: aProposal(), bundle },
      { businessId: BUSINESS },
    );
    const { rows } = await getPool().query<{ risk: { dimensions: { provenance: { level: string; chainDepth: number } } } }>(
      `SELECT risk FROM approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    // `assessRisk` copies `facts.provenance` straight onto this dimension, and
    // the whole assessment is stored as jsonb — so this is the stamp itself,
    // not a band inferred from it. The band is `sensitive` under either value,
    // which is why asserting on the band proved nothing.
    expect(rows[0]?.risk.dimensions.provenance.level).toBe('unknown_external');
    expect(rows[0]?.risk.dimensions.provenance.chainDepth).toBe(1);
  });
});
