/**
 * Live end-to-end run of `proposeForReading` against the Agent SDK.
 *
 *   npm run sdk:propose -- <documentId> <jobId>
 *
 * Two arguments, not one: `proposeForReading` (`src/orchestrator/propose.ts`)
 * derives the trust level from the job row rather than accepting it as a
 * parameter — that is the provenance obligation sub-project ב' left open, and
 * ג' pays it here. There is no reading without a job whose provenance
 * `loadLatestReading` can key on, so this script needs both ids: a document
 * with a reading already stored under the job's own provenance (run
 * `sdk:read-document` first, against a job of the right provenance), and the
 * job itself.
 *
 * A script and not a test: it costs money and needs a key, and a suite that
 * skips silently without one reports green for work it did not do. Everything
 * this script composes is covered by tests that need neither.
 */
import { config } from '../config.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { closePool } from '../db/pool.js';
import { proposeForReading } from '../orchestrator/propose.js';

const documentId = process.argv[2];
const jobId = process.argv[3];

async function main(): Promise<void> {
  if (documentId === undefined || jobId === undefined) {
    console.error('שימוש: npm run sdk:propose -- <documentId> <jobId>');
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

  const result = await proposeForReading({ documentId, jobId, bundle });

  console.log('--- תוצאה ---');
  if (result.status === 'no_reading') {
    console.log('אין קריאה שמורה למסמך הזה תחת ה-provenance של המשימה. הרץ קודם את sdk:read-document.');
    return;
  }

  if (result.status === 'unproposable') {
    console.log(`לא ניתן להציע: ${result.reason}`);
    console.log(`\nמזהה הצעה: ${result.record.proposalId}`);
    return;
  }

  console.log(`עמדה: ${result.proposal.stance}`);
  console.log(`כותרת: ${result.proposal.headline}`);
  console.log('\nנימוקים:');
  for (const reason of result.proposal.reasons) {
    console.log(`  - ${reason.text} [מצטט: ${reason.findingLabel}]`);
  }
  if (result.proposal.action !== null) {
    console.log(`\nפעולה מוצעת: ${result.proposal.action.headline}`);
    console.log(`  כלי: ${result.proposal.action.toolName} · סוכן: ${result.proposal.action.agent}`);
    console.log(`  מטרה: ${result.proposal.action.purpose}`);
  }
  if (result.proposal.clarifyingQuestion !== null) {
    console.log(`\nשאלה מבהירה: ${result.proposal.clarifyingQuestion}`);
  }
  console.log(
    result.plan === null
      ? '\nתוכנית: אין (העמדה לא מייצרת פעולה)'
      : `\nתוכנית: ${result.plan.steps.length} צעד/ים`,
  );
  console.log(`\nמזהה הצעה: ${result.record.proposalId}`);
}

try {
  await main();
} finally {
  await closePool();
}
