/**
 * A file the owner attached to an instruction on the dashboard is HIS source
 * (document production D14, Task 11's concern 3): the instruction records the
 * ids, `doc.produce` puts them among the production's sources and records
 * them as owner sources, and the loop fences them as `boss` — every other
 * attached document stays `unknown_external`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, withBusiness } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { insertOrGetDocument } from '../documents/store.js';
import type { Plan } from '../domain/plan.js';
import { attachedDocumentsForJob, saveInstruction } from '../governance/instructions.js';
import { runInstruction } from '../orchestrator/instruct.js';
import { createJob, loadJob, transition, type Job } from '../orchestrator/jobs.js';
import { runLocalTool } from '../orchestrator/local-tools.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import { buildPlannerPrompt } from '../sdk/planner.js';
import { sourceProvenance } from './loop.js';
import { createProduction, loadProduction } from './store.js';

const B = 'test-business';
const OTHER = 'other-business';
const AVAILABLE = { available: true, sofficePath: '/opt/soffice', chromiumPath: '/opt/chromium' };

let seq = 0;
async function doc(businessId: string, name: string): Promise<string> {
  seq += 1;
  const documentId = `DOC-owner-${seq}`;
  await withBusiness(businessId, (db) => insertOrGetDocument(
    db,
    {
      documentId,
      source: 'manual',
      originalName: name,
      mediaType: 'text/plain',
      sha256: `${seq}`.padStart(64, '0'),
      byteSize: 1,
      storedPath: `${businessId}/${documentId}/original.txt`,
    },
  ));
  await getPool().query(`UPDATE documents SET status = 'extracted' WHERE document_id = $1`, [documentId]);
  return documentId;
}

const recallPlan: Plan = {
  goal: 'להיזכר',
  assumptions: [],
  clarifyingQuestion: null,
  estimatedCostMinor: 0,
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'להיזכר',
      toolName: 'memory.recall',
      input: { subject: 'dana@example.com' },
      dependsOn: [],
      expectedActionClass: null,
    },
  ],
};

async function ownerJob(text: string, attached: string[]): Promise<Job> {
  const job = await withBusiness(B, (db) => createJob(db, { charterVersion: 'v-owner', provenance: 'boss' }));
  await withBusiness(B, (bdb) => saveInstruction(bdb, { jobId: job.jobId, text, textOrigin: 'typed', attachedDocumentIds: attached }));
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await withBusiness(B, (db) => transition(db, job.jobId, { to, actor: 'orchestrator', reason: 'setup' }));
  }
  return (await withBusiness(B, (db) => loadJob(db, job.jobId)))!;
}

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(B, (bdb) => installCharter(bdb, buildCharter({ version: 'v-owner' })));
});
afterAll(async () => {
  await closePool();
});

describe('owner-attached sources', () => {
  it('runInstruction records the attached ids and hands the planner ids + names, never text — this business only', async () => {
    const mine = await doc(B, 'מחירון אלפא.xlsx');
    const theirs = await doc(OTHER, 'זר.xlsx');
    const seen: PlanRequest[] = [];
    const outcome = await withBusiness(B, (db) => runInstruction(db, { text: 'תכיני טבלת רווח לפי המחירון המצורף' }, {
        textOrigin: 'typed',
        channel: 'dashboard',
        attachedDocumentIds: [mine, theirs],
        planner: async (request): Promise<PlanOutcome> => {
          seen.push(request);
          return { status: 'planned', plan: recallPlan };
        },
      }));
    expect(outcome.status).toBe('planned');
    expect(seen[0]?.attachedDocuments).toEqual([{ documentId: mine, name: 'מחירון אלפא.xlsx' }]);
    if (outcome.status !== 'planned') return;
    expect(await withBusiness(B, (bdb) => attachedDocumentsForJob(bdb, outcome.jobId))).toEqual([mine]);
  });

  it('the planner prompt lists the attached files in a fence, after the instruction', async () => {
    const prompt = buildPlannerPrompt(
      {
        bundle: (await withBusiness(B, (bdb) => loadActiveCharter(bdb)))!.bundle,
        intents: [],
        instruction: 'הוראה',
        attachedDocuments: [{ documentId: 'DOC-1', name: 'a\nb.xlsx' }],
        provenance: 'boss',
        rampLevel: 'auto',
      },
      'NONCE',
    );
    const at = prompt.indexOf('DOC-1');
    expect(at).toBeGreaterThan(prompt.indexOf('# ההוראה מבעל העסק'));
    expect(prompt.slice(0, at)).toContain('NONCE');
    expect(prompt).toContain('a b.xlsx');
  });

  it('doc.produce adds the attached ids to the sources and records them as owner sources', async () => {
    const mine = await doc(B, 'מחירון.xlsx');
    const job = await ownerJob('תכיני מכתב לפי המחירון', [mine]);
    const result = await withBusiness(B, (db) => runLocalTool('doc.produce', { format: 'docx', kind: 'letter', request: 'מכתב', destination: { mode: 'save', folder: null } }, { ...{ jobId: job.jobId, production: AVAILABLE }, db }));
    const productionId = (result as unknown as { productionId: string }).productionId;
    const production = await withBusiness(B, (db) => loadProduction(db, productionId));
    expect(production?.sourceDocumentIds).toEqual([mine]);
    expect(production?.work.ownerSourceIds).toEqual([mine]);
  });

  it('a source the planner named that the owner did not attach is not an owner source', async () => {
    const mine = await doc(B, 'mine.xlsx');
    const inbox = await doc(B, 'inbox.xlsx');
    const job = await ownerJob('תכיני מכתב', [mine]);
    const result = await withBusiness(B, (db) => runLocalTool('doc.produce', {
        format: 'docx',
        kind: 'letter',
        request: 'מכתב',
        destination: { mode: 'save', folder: null },
        sources: [{ documentId: inbox }],
      }, { ...{ jobId: job.jobId, production: AVAILABLE }, db }));
    const production = await withBusiness(B, (db) => loadProduction(db, (result as unknown as { productionId: string }).productionId));
    expect([...(production?.sourceDocumentIds ?? [])].sort()).toEqual([mine, inbox].sort());
    expect(production?.work.ownerSourceIds).toEqual([mine]);
  });

  it('the loop fences an owner source as boss and every other source as unknown_external', async () => {
    const productionId = await withBusiness(B, (db) => createProduction(db, {
      originJobId: 'J-x',
      instructionText: 'x',
      textOrigin: 'typed',
      format: 'docx',
      language: 'he',
      kind: 'letter',
      destination: { mode: 'save', folder: null },
      sourceDocumentIds: ['DOC-a', 'DOC-b'],
      ownerSourceIds: ['DOC-a'],
    }));
    const production = (await withBusiness(B, (db) => loadProduction(db, productionId)))!;
    expect(sourceProvenance(production, 'DOC-a')).toBe('boss');
    expect(sourceProvenance(production, 'DOC-b')).toBe('unknown_external');
    const { rows } = await getPool().query<{ work: { ownerSourceIds: string[] } }>(
      'SELECT work FROM document_productions WHERE production_id = $1',
      [productionId],
    );
    expect(rows[0]?.work.ownerSourceIds).toEqual(['DOC-a']);
  });
});
