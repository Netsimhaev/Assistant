/**
 * Live end-to-end run of `know.reader` against the Agent SDK.
 *
 * Kept as a script rather than a test on purpose: it costs money and needs
 * credentials, and a test suite that silently skips when a key is missing is a
 * suite that reports green for work it did not do.
 *
 *   npm run sdk:know-reader -- "סכם את הקובץ README.md"
 */
import { mkdir } from 'node:fs/promises';
import { config } from '../config.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { closePool } from '../db/pool.js';
import { runKnowReader } from './know-reader.js';

const task = process.argv.slice(2).join(' ') || 'סכם בשתי שורות את הקובץ README.md.';

async function main(): Promise<void> {
  const hasCredentials =
    process.env['ANTHROPIC_API_KEY'] !== undefined ||
    process.env['ANTHROPIC_AUTH_TOKEN'] !== undefined;
  if (!hasCredentials) {
    console.error(
      'אין ANTHROPIC_API_KEY בסביבה. ההרצה החיה דורשת מפתח; הלוגיקה עצמה מכוסה במבחנים.',
    );
    process.exitCode = 1;
    return;
  }

  const active = await loadActiveCharter(config.businessId);
  const bundle = active?.bundle ?? (await installCharter(buildCharter()));

  // DOCUMENT_ROOT is required config now (src/config.ts) — the same
  // directory ingestDocument (src/documents/ingest.ts) stores under.
  const documentRoot = config.documentRoot;
  await mkdir(documentRoot, { recursive: true });

  const outcome = await runKnowReader({
    bundle,
    // A one-part stand-in so the script exercises the real path without
    // needing a document in the database. `npm run sdk:read-document` is the
    // end-to-end script; this one stays the minimal SDK probe it always was.
    artifacts: [
      {
        ordinal: 0,
        kind: 'text',
        partName: 'הודעה',
        content: { blocks: [{ kind: 'paragraph', text: task }] },
        flags: [],
      },
    ],
    provenance: 'unknown_external',
    documentRoot,
    // This script runs a single ad hoc read with no orchestrator job behind
    // it, so there is no content-ingested flag to update. `null` says that
    // in the open rather than leaving `jobId` unset.
    jobId: null,
  });

  console.log('--- תוצאה ---');
  if (outcome.status === 'read') {
    console.log(JSON.stringify(outcome.reading, null, 2));
  } else {
    console.log(`לא ניתן לקרוא: ${outcome.reason}`);
    console.log(`--- מה שהוחזר בפועל ---\n${outcome.raw}`);
  }
  console.log(`\nתורות: ${outcome.turns}`);
  console.log(
    outcome.denials.length > 0
      ? `דחיות מהשער: ${outcome.denials.join(', ')}`
      : 'השער לא דחה דבר.',
  );
}

try {
  await main();
} finally {
  await closePool();
}
