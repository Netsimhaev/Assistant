import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWhatsAppContactsAmendment } from '../charter/amend-whatsapp-contacts.js';
import { signCharter } from '../charter/sign.js';
import { installCharter } from '../charter/store.js';
import { BusinessCharter } from '../domain/charter.js';
import { config } from '../config.js';
import { closePool, withBusiness } from '../db/pool.js';
import { insertOrGetDocument, markExtracted } from '../documents/store.js';
import { Plan } from '../domain/plan.js';
import type { ConnectionBinding } from '../domain/connection.js';
import { resolveStoredDocument } from '../production/attachments.js';
import { resetDatabase, TEST_BUSINESS, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { browserAdapter } from './adapters/browser.js';
import { AdapterRegistry } from './adapters/registry.js';
import type { AdapterCall, ExternalAdapter } from './adapters/types.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition } from './jobs.js';
import { runPlan } from './run-plan.js';

const DIR = `__wa-attach-${process.pid}`;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const NOON = new Date('2026-08-18T09:00:00.000Z');

async function seedDoc(businessId: string, id: string, bytes: Buffer, declared: Buffer = bytes): Promise<void> {
  const storedPath = `${DIR}/${id}.pdf`;
  await mkdir(join(config.documentRoot, DIR), { recursive: true });
  await writeFile(join(config.documentRoot, storedPath), bytes);
  await withBusiness(businessId, async (db) => {
    await insertOrGetDocument(db, {
      documentId: id,
      source: 'manual',
      originalName: 'הצעה.pdf',
      mediaType: 'application/pdf',
      sha256: sha(declared),
      byteSize: declared.length,
      storedPath,
    });
    await markExtracted(db, id, []);
  });
}

beforeEach(async () => {
  await resetDatabase();
});
afterEach(async () => {
  await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

describe('resolveStoredDocument', () => {
  it('returns the recorded bytes with the document id', async () => {
    const bytes = Buffer.from('pdf bytes');
    await seedDoc(TEST_BUSINESS, 'DOC-1', bytes);
    const r = await withBusiness(TEST_BUSINESS, (db) => resolveStoredDocument(db, 'DOC-1', config.documentRoot));
    expect(r).toMatchObject({ ok: true, file: { documentId: 'DOC-1', mediaType: 'application/pdf', filename: 'הצעה.pdf' } });
    if (r.ok) expect(r.file.bytes.equals(bytes)).toBe(true);
  });

  it('strips bidi controls from the filename', async () => {
    await seedDoc(TEST_BUSINESS, 'DOC-BIDI', Buffer.from('pdf bytes'));
    await testDb().query("UPDATE documents SET original_name = $1 WHERE document_id = 'DOC-BIDI'", ['invoice‮fdp.exe‏']);
    const r = await withBusiness(TEST_BUSINESS, (db) => resolveStoredDocument(db, 'DOC-BIDI', config.documentRoot));
    expect(r.ok && r.file.filename).toBe('invoicefdp.exe');
  });

  it('refuses when the file on disk no longer matches the recorded hash', async () => {
    await seedDoc(TEST_BUSINESS, 'DOC-2', Buffer.from('tampered!!'), Buffer.from('original!!'));
    const r = await withBusiness(TEST_BUSINESS, (db) => resolveStoredDocument(db, 'DOC-2', config.documentRoot));
    expect(r).toMatchObject({ ok: false, code: 'attachment_hash_mismatch' });
  });

  it("refuses another business's document as not found", async () => {
    await seedDoc('other-business', 'DOC-3', Buffer.from('x'));
    const r = await withBusiness(TEST_BUSINESS, (db) => resolveStoredDocument(db, 'DOC-3', config.documentRoot));
    expect(r).toMatchObject({ ok: false, code: 'attachment_not_found' });
  });
});

describe('wa.send_message attachDocumentId in runPlan', () => {
  async function run(documentId: string) {
    const plain = buildCharter({ autonomyBase: { 'whatsapp.initiate': 'auto' } });
    const { signature: _sig, ...unsignedBase } = plain;
    const base = BusinessCharter.parse(
      signCharter(
        {
          ...unsignedBase,
          counterparties: [
            ...unsignedBase.counterparties,
              { match: { phone: '972501234567' }, label: 'לקוח', trust: 'known_counterparty' as const, autonomyOverrides: {}, doNotContact: false, notes: '' },
          ],
        },
        { signedByPersonId: 'owner', method: 'dashboard_click' },
      ),
    );
    await withBusiness(TEST_BUSINESS, (db) => installCharter(db, base));
    const bundle = await withBusiness(TEST_BUSINESS, (db) =>
      installCharter(db, signCharter(buildWhatsAppContactsAmendment(base, new Date()), { signedByPersonId: 'owner', method: 'dashboard_click' })),
    );
    const job = await withBusiness(TEST_BUSINESS, (db) => createJob(db, { charterVersion: bundle.charterVersion, provenance: 'boss' }));
    for (const to of ['understand', 'plan', 'execute'] as const) {
      await withBusiness(TEST_BUSINESS, (db) => transition(db, job.jobId, { to, actor: 'orchestrator', reason: 'setup' }));
    }
    const loaded = await withBusiness(TEST_BUSINESS, (db) => loadJob(db, job.jobId));
    if (loaded === null) throw new Error('job vanished');
    const calls: AdapterCall[] = [];
    const adapter: ExternalAdapter = {
      system: 'whatsapp-contacts',
      channel: 'api',
      serves: ['wa.send_message'],
      async execute(call) {
        calls.push(call);
        return { ok: true, output: null, externalId: 'M' };
      },
    };
    const binding: ConnectionBinding = {
      system: 'whatsapp-contacts', status: 'live', endpoint: null, credentialRef: null, provider: null, lastOkAt: null, lastError: null,
    };
    const plan = Plan.parse({
      goal: 'לשלוח קובץ',
      steps: [
        {
          id: 's1',
          agent: 'comms.whatsapp',
          intent: 'send',
          toolName: 'wa.send_message',
          input: { to: '+972501234567', body: 'מצורף', attachDocumentId: documentId },
        },
      ],
    });
    const result = await withBusiness(TEST_BUSINESS, (db) =>
      runPlan(db, {
        job: loaded,
        bundle,
        plan,
        registry: new AdapterRegistry([adapter], [browserAdapter]),
        bindings: [binding],
        credentials: envCredentials({}, 'X_'),
        counterpartyTags: [],
        rampLevel: 'auto',
        now: NOON,
      }),
    );
    return { result, calls };
  }

  it('halts before the adapter when the document is missing, and when its bytes changed', async () => {
    const missing = await run('DOC-nope');
    expect(missing.result).toMatchObject({ status: 'halted', reason: 'attachment_not_found' });
    expect(missing.calls).toHaveLength(0);

    await resetDatabase();
    await seedDoc(TEST_BUSINESS, 'DOC-9', Buffer.from('tampered!!'), Buffer.from('original!!'));
    const changed = await run('DOC-9');
    expect(changed.result).toMatchObject({ status: 'halted', reason: 'attachment_hash_mismatch' });
    expect(changed.calls).toHaveLength(0);
  });
});
