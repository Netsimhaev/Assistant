/**
 * Live end-to-end read of a stored document.
 *
 *   npm run sdk:read-document -- DOC-01J...
 *
 * A script and not a test: it costs money and needs a key, and a suite that
 * skips silently without one reports green for work it did not do. Everything
 * this script composes is covered by tests that need neither.
 */
import { config } from '../config.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { closePool } from '../db/pool.js';
import { readDocument } from '../documents/read.js';

const documentId = process.argv[2];

async function main(): Promise<void> {
  if (documentId === undefined) {
    console.error('שימוש: npm run sdk:read-document -- <documentId>');
    process.exitCode = 1;
    return;
  }

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

  const result = await readDocument({
    documentId,
    bundle,
    provenance: 'unknown_external',
    jobId: null,
  });

  if (result.status === 'no_artifacts') {
    console.log('למסמך הזה אין חלקים מופקים. הרץ קודם את הקליטה.');
    return;
  }

  console.log(result.cached ? '--- קריאה שמורה ---' : '--- קריאה חדשה ---');
  if (result.status === 'read') {
    console.log(`\nסיכום:\n${result.reading.summary}`);
    console.log(`\nממצאים: ${result.reading.findings.length}`);
    for (const finding of result.reading.findings) {
      console.log(`  ${finding.label}: ${finding.value}  [חלק ${finding.sourceRef.ordinal}]`);
    }
    console.log('\nכוונות:');
    for (const intent of result.reading.intents) {
      console.log(`  ${intent.intent} → ${intent.subject.kind}  [חלק ${intent.sourceRef.ordinal}]`);
    }
    if (result.reading.unreadable.length > 0) {
      console.log(`\nלא נקבע: ${result.reading.unreadable.join(' · ')}`);
    }
  } else {
    console.log(`לא ניתן לקרוא: ${result.reason}`);
  }
  console.log(`\nמזהה קריאה: ${result.record.readingId}`);
}

try {
  await main();
} finally {
  await closePool();
}
