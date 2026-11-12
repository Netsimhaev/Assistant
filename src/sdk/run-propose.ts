/**
 * Live end-to-end run of `proposeForReading` against the Agent SDK.
 *
 *   npm run sdk:propose -- <documentId> <jobId> --business <id>
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
import { buildCharter } from '../test/fixtures.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import type { BusinessDb } from '../db/pool.js';
import { closeCliPools, runForBusiness } from '../cli/business-arg.js';
import { proposeForReading } from '../orchestrator/propose.js';

async function main(db: BusinessDb, args: string[]): Promise<void> {
  const documentId = args[0];
  const jobId = args[1];
  if (documentId === undefined || jobId === undefined) {
    console.error('שימוש: npm run sdk:propose -- <documentId> <jobId> --business <id>');
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

  const active = await loadActiveCharter(db);
  const bundle = active?.bundle ?? (await installCharter(db, buildCharter()));

  const result = await proposeForReading(db, { documentId, jobId, bundle });

  console.log('--- תוצאה ---');
  if (result.status === 'no_reading') {
    console.log('אין קריאה שמורה למסמך הזה תחת ה-provenance של המשימה. הרץ קודם את sdk:read-document.');
    return;
  }

  if (result.status === 'unproposable') {
    console.log(`לא ניתן להציע: ${result.reason}`);
    console.log('\n--- תגובת המודל הגולמית ---');
    console.log(result.record.raw);
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
  // `main` sets exit code 1 itself on its own refusals; only a `--business`
  // refusal (2) comes back from here, and 0 must not overwrite that 1.
  const code = await runForBusiness(process.argv.slice(2), (line) => console.error(line), main);
  if (code !== 0) process.exitCode = code;
} finally {
  await closeCliPools();
}
