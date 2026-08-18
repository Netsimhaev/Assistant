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
import { join } from 'node:path';
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

  // Never the repository root: that is where .env lives.
  const documentRoot = process.env['DOCUMENT_ROOT'] ?? join(process.cwd(), 'documents');
  await mkdir(documentRoot, { recursive: true });

  const result = await runKnowReader({
    bundle,
    task,
    provenance: 'unknown_external',
    documentRoot,
  });

  console.log('--- תוצאה ---');
  console.log(result.text);
  console.log(`\nתורות: ${result.turns}`);
  console.log(
    result.denials.length > 0
      ? `דחיות מהשער: ${result.denials.join(', ')}`
      : 'השער לא דחה דבר.',
  );
}

try {
  await main();
} finally {
  await closePool();
}
