/**
 * `ramp:set` — the owner's tool for moving one action class off the floor.
 *
 * `setRampLevel` has existed since the ramp did, with no production caller:
 * promotion out of `draft_only` is a decision, and the only thing that should
 * move that row is a person running a command. This is that command.
 *
 * **Why it prints the ceilings afterwards.** The level the gate enforces is
 * the most restrictive of several: the charter's ceiling for the class, the
 * charter's ceiling for the trust level of the content that led here, any
 * per-counterparty override, and this ramp. Raising the ramp above a ceiling
 * that already binds changes nothing at all — and a change that does nothing
 * is indistinguishable from a broken system unless the command says so. This
 * session lost an hour to exactly that: a ramp raise proposed for documents
 * arriving from outside, where the charter caps `unknown_external` at
 * `draft_only` and the raise could never have been felt.
 */
import { closePool } from '../db/pool.js';
import { config } from '../config.js';
import { loadActiveCharter } from '../charter/store.js';
import { ActionClass } from '../domain/action.js';
import { AutonomyLevel, TrustLevel, mostRestrictiveAutonomy } from '../domain/trust.js';
import { setRampLevel } from '../orchestrator/ramp.js';

export interface SetRampCliDeps {
  log: (line: string) => void;
  businessId?: string;
}

/**
 * Parses argv, writes the level, then reports where it will actually be felt.
 *
 * Throws rather than calling `process.exit` — the same shape `ingest-doc.ts`
 * and `seed-job.ts` use, so `main` can print a readable message and a test can
 * assert `.rejects.toThrow()` without spawning a process. Nothing is written
 * before both arguments have been validated against their closed enums.
 */
export async function runSetRampCli(argv: string[], deps: SetRampCliDeps): Promise<void> {
  const { log } = deps;
  const businessId = deps.businessId ?? config.businessId;

  const rawClass = argv[0];
  const rawLevel = argv[1];

  if (rawClass === undefined || rawLevel === undefined) {
    throw new Error(
      `שימוש: npm run ramp:set -- <מחלקת פעולה> <רמה>\n` +
        `מחלקות: ${ActionClass.options.join(', ')}\n` +
        `רמות: ${AutonomyLevel.options.join(', ')}`,
    );
  }

  const parsedClass = ActionClass.safeParse(rawClass);
  if (!parsedClass.success) {
    throw new Error(
      `מחלקת פעולה לא מוכרת: ${rawClass}\nהמחלקות הקיימות: ${ActionClass.options.join(', ')}`,
    );
  }

  const parsedLevel = AutonomyLevel.safeParse(rawLevel);
  if (!parsedLevel.success) {
    throw new Error(
      `רמת אוטונומיה לא מוכרת: ${rawLevel}\nהרמות הקיימות: ${AutonomyLevel.options.join(', ')}`,
    );
  }

  const actionClass = parsedClass.data;
  const level = parsedLevel.data;

  // Read the charter before writing. Without it the ceilings cannot be
  // reported, and a raise reported without its ceilings is the exact
  // half-truth this command exists to prevent.
  const active = await loadActiveCharter(businessId);
  if (active === null) {
    throw new Error(
      `אין תקנון פעיל ל-${businessId}. הרמפה נאכפת יחד עם תקרות התקנון, ובלעדיו אי אפשר לומר מה הרמה תשנה בפועל.`,
    );
  }

  await setRampLevel(actionClass, level, { businessId });

  const classCeiling = active.bundle.autonomyBase[actionClass];
  log(`הרמפה של ${actionClass} הועלתה ל-${level} עבור ${businessId}.`);
  log(`תקרת התקנון למחלקה הזו: ${classCeiling}.`);
  log('');
  log('הרמה שתיאכף בפועל היא המחמירה מבין הרמפה, תקרת המחלקה, ותקרת מקור התוכן:');

  for (const provenance of TrustLevel.options) {
    const provenanceCeiling = active.bundle.provenanceCeiling[provenance];
    const effective = mostRestrictiveAutonomy([level, classCeiling, provenanceCeiling]);
    const note = effective === level ? '' : `  ← התקרה גוברת, ההעלאה לא מורגשת כאן`;
    log(`  ${provenance.padEnd(20)} ${effective}${note}`);
  }

  log('');
  log('תקרה לפי צד-שיח מסוים עשויה להדק עוד, ואינה מוצגת כאן — היא תלויה במי שבצד השני.');
}

async function main(): Promise<void> {
  await runSetRampCli(process.argv.slice(2), { log: (line) => console.log(line) });
}

// Only run when executed directly — never on import from the test. Same
// pattern as src/cli/seed-job.ts.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
  await closePool();
}
