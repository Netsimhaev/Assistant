/**
 * F1: the signature, its audit row and the approval decision are one act.
 *
 * What these tests drive is the sequence that runs AFTER the dashboard route's
 * own guard has read `state` and `expires_at` and let the request through.
 * The guard lives upstream in `server.ts`; `decideAndSign` is everything that
 * happens downstream of it. So calling `decideAndSign` on an approval that is
 * already denied, or already expired, IS the interleaving F1 names — a second
 * tab or the scheduler landing in the window between the guard's read and
 * `decide`'s predicate — reproduced without needing two racing requests.
 *
 * What that does NOT prove: it does not schedule two real HTTP requests
 * against one approval and observe the loser. It proves the property that
 * makes such a race harmless — that a `decide` which refuses leaves no
 * signature row and no audit row behind it — which is the property F1 asks
 * for and the one a race would otherwise violate.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { queryAudit } from '../audit/log.js';
import type { AuditEntryInput } from '../domain/audit.js';
import type { ActionFacts } from '../domain/policy.js';
import type { RiskAssessment } from '../domain/risk.js';
import { insertOrGetDocument } from '../documents/store.js';
import { canonicalHash } from '../util/canonical.js';
import { decide, enqueueApproval, getApproval } from './approvals.js';
import { loadSignature } from './signatures.js';
import { decideAndSign } from './sign-decision.js';

const BUSINESS = 'test-business';
const SHA = 'a'.repeat(64);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

function facts(input: unknown): ActionFacts {
  return {
    toolName: 'mail.send',
    actionClass: 'email.initiate',
    amountMinor: 0,
    amountDeclared: false,
    counterpartyId: null,
    counterpartyEmails: [],
    counterpartyPhones: [],
    counterpartyTags: [],
    provenance: 'boss',
    chainDepth: 0,
    provenanceChainDerived: false,
    dataClasses: [],
    leavesInstance: true,
    supplierId: null,
    discountPercent: 0,
    inputHash: canonicalHash(input),
  };
}

function risk(): RiskAssessment {
  return {
    actionId: 'A-test',
    actionClass: 'email.initiate',
    dimensions: {
      money: { amountMinor: 0, pctOfDailyCeiling: 0, score: 0 },
      reversibility: { class: 'reversible', score: 10 },
      externalVisibility: { audience: 'one_unknown', score: 20 },
      dataSensitivity: { classes: [], leavesInstance: false, score: 0 },
      novelty: { metric: null, z: 0, precedentIds: [], score: 0 },
      provenance: { level: 'boss', chainDepth: 0, score: 0 },
      charterFit: { verdict: 'within', citedRuleIds: [], score: 0 },
    },
    total: 15,
    band: 'sensitive',
    decidedBy: 'rules',
    explanation: 'בדיקה',
    suggestedApprovers: [],
  };
}

async function aDocument(): Promise<string> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'חוזה.docx',
      mediaType: 'text/plain',
      sha256: SHA,
      byteSize: 12,
      storedPath: `${BUSINESS}/${documentId}/original.txt`,
    },
    { businessId: BUSINESS },
  );
  return documentId;
}

async function anApproval(ttlMinutes = 60): Promise<string> {
  const proposedInput = { to: 'dana@example.com', body: 'שלום' };
  return enqueueApproval(
    {
      jobId: null,
      facts: facts(proposedInput),
      risk: risk(),
      proposedInput,
      summary: 'בקשה לחתימה',
      ttlMinutes,
    },
    { businessId: BUSINESS },
  );
}

function signPayload(approvalId: string, documentId: string) {
  const audit: AuditEntryInput = {
    actor: 'human',
    onBehalfOf: 'owner',
    kind: 'signature',
    charterVersion: 'unknown',
    provenance: 'boss',
    inputHash: canonicalHash({ documentId, approvalId, sha256: SHA }),
    reason: `signature:${documentId} by owner for approval ${approvalId}`,
  };
  return {
    approvalId,
    decision: { by: 'owner', channel: 'dashboard' as const },
    signature: {
      signatureId: `SIG-${ulid()}`,
      documentId,
      signedSha256: SHA,
      approvalId,
      signedBy: 'owner',
    },
    audit,
  };
}

describe('decideAndSign', () => {
  it('signs, audits and decides together on a live approval', async () => {
    const documentId = await aDocument();
    const approvalId = await anApproval();

    const decided = await decideAndSign(signPayload(approvalId, documentId), {
      businessId: BUSINESS,
    });

    expect(decided.state).toBe('approved');
    expect((await loadSignature(documentId, { businessId: BUSINESS }))?.approvalId).toBe(approvalId);
    expect((await queryAudit({ businessId: BUSINESS, kind: 'signature' })).length).toBe(1);
  });

  it('leaves no signature and no audit row when the approval was denied after the guard read it', async () => {
    const documentId = await aDocument();
    const approvalId = await anApproval();

    // The second tab. In the route this lands between the guard's read of
    // `approval.state` and `decide`'s own predicate; here it simply happens
    // before the call, which puts `decideAndSign` in exactly the state that
    // window would leave it in.
    await decide(approvalId, 'denied', { by: 'owner', channel: 'dashboard' }, { businessId: BUSINESS });

    await expect(
      decideAndSign(signPayload(approvalId, documentId), { businessId: BUSINESS }),
    ).rejects.toThrow(/already denied/);

    expect(await loadSignature(documentId, { businessId: BUSINESS })).toBeNull();
    expect(await queryAudit({ businessId: BUSINESS, kind: 'signature' })).toEqual([]);
    expect((await getApproval(approvalId, { businessId: BUSINESS }))?.state).toBe('denied');
  });

  it('leaves no signature and no audit row when the fuse burned out after the guard read it', async () => {
    const documentId = await aDocument();
    // A minute of TTL, then pushed into the past — what `expireOverdue` or a
    // slow file read does to a request the guard already waved through.
    const approvalId = await anApproval(1);
    const { getPool } = await import('../db/pool.js');
    await getPool().query(
      `UPDATE approval_requests SET expires_at = now() - interval '1 minute'
        WHERE approval_id = $1 AND business_id = $2`,
      [approvalId, BUSINESS],
    );

    await expect(
      decideAndSign(signPayload(approvalId, documentId), { businessId: BUSINESS }),
    ).rejects.toThrow(/expired/);

    expect(await loadSignature(documentId, { businessId: BUSINESS })).toBeNull();
    expect(await queryAudit({ businessId: BUSINESS, kind: 'signature' })).toEqual([]);
  });
});
