/**
 * Live run of the meeting extractor against the Agent SDK:
 *
 *   npm run sdk:meeting-extract -- "תקבעי פגישה עם דני מחר בשעה 10" --business <id>
 *
 * A script and not a test (billed call; `runMeetingExtractor` refuses under
 * NODE_ENV=test). It WRITES NOTHING: it prints the gate result, and the
 * extracted request after `verifyTypedEmails`.
 */
import { loadActiveCharter } from '../charter/store.js';
import type { BusinessDb } from '../db/pool.js';
import { closeCliPools, runForBusiness } from '../cli/business-arg.js';
import { isMeetingInstruction, verifyTypedEmails } from '../meetings/request.js';
import { localParts } from '../util/local-time.js';
import { runMeetingExtractor } from './meeting-extractor.js';

async function main(db: BusinessDb, args: string[]): Promise<void> {
  const text = args[0];
  if (text === undefined || text.trim() === '') {
    console.error('שימוש: npm run sdk:meeting-extract -- "<הוראה>" --business <id>');
    process.exitCode = 1;
    return;
  }
  if (process.env['ANTHROPIC_API_KEY'] === undefined && process.env['ANTHROPIC_AUTH_TOKEN'] === undefined) {
    console.error('אין ANTHROPIC_API_KEY בסביבה. ההרצה החיה דורשת מפתח; הלוגיקה עצמה מכוסה במבחנים.');
    process.exitCode = 1;
    return;
  }
  const active = await loadActiveCharter(db);
  const timeZone = active?.charter.identity.timezone ?? 'Asia/Jerusalem';
  const today = localParts(new Date(), timeZone).date;
  console.log(`isMeetingInstruction: ${isMeetingInstruction(text)}  today: ${today}  tz: ${timeZone}`);
  const outcome = await runMeetingExtractor({ text, today, timeZone, signal: AbortSignal.timeout(120_000) });
  if (outcome.status !== 'extracted') {
    console.log(JSON.stringify(outcome));
    if (outcome.status === 'failed') process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(verifyTypedEmails(outcome.request, text), null, 2));
}

try {
  // `main` sets exit code 1 itself on its own refusals; only a `--business`
  // refusal (2) comes back from here, and 0 must not overwrite that 1.
  const code = await runForBusiness(process.argv.slice(2), (line) => console.error(line), main);
  if (code !== 0) process.exitCode = code;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
await closeCliPools();
