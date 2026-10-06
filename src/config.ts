import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `missing required environment variable ${name} — copy .env.example to .env`,
    );
  }
  return value;
}

/**
 * Absent means off, never a permissive default.
 *
 * `DOCUMENT_INBOX` unset is how an installation says "do not watch a folder".
 * The scheduler reports it once and carries on, exactly as `buildRuntime`
 * treats absent SMTP settings — a missing setting is a switch, not a fault.
 */
function optional(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer (got: ${raw})`);
  }
  return parsed;
}

/**
 * Vitest sets NODE_ENV=test via vitest.config.ts. A CLI run cannot rely on
 * that: `NODE_ENV=test <cmd>` is not portable to Windows shells, and pulling
 * in cross-env for one script is a dependency for nothing. `--test-db` selects
 * the same branch.
 *
 * Read from argv rather than written into env, because ESM hoists imports — a
 * module that sets process.env in its body runs *after* this file has already
 * been evaluated, so the assignment would come too late to matter.
 */
const isTest =
  process.env['NODE_ENV'] === 'test' || process.argv.includes('--test-db');

export const config = {
  isTest,
  /**
   * Tests run against a separate database because they truncate between files.
   * Pointing them at the dev database would silently destroy dev state.
   */
  databaseUrl: isTest ? required('TEST_DATABASE_URL') : required('DATABASE_URL'),
  // Required, not defaulted. This key scopes the charter, the kill switch, the
  // spend ledger and the audit chain; a deploy that forgets it would run under
  // someone else's name and interleave two businesses' audit chains.
  businessId: required('BUSINESS_ID'),
  // Required, not defaulted — same reasoning as BUSINESS_ID above. This is
  // the one directory the reading agent (`know.reader`, gate-hook.ts's path
  // check) is scoped to, and it is where ingestDocument stores every
  // document's bytes (spec §3.5: "same root, not a second root"). A deploy
  // that forgot this and fell back to some default would write documents
  // into a directory the reader was never told about — ingested and
  // unreadable.
  //
  // Resolved against `process.cwd()` here, once, rather than left relative:
  // a relative DOCUMENT_ROOT (the .env.example default, `./documents`) is
  // otherwise interpreted independently by every consumer that reads
  // `config.documentRoot` — `ingest.ts`'s `join(documentRoot, ...)`,
  // `gate-hook.ts`'s `isPathWithin` comparison, and `know-reader.ts`'s own
  // subprocess `cwd` — and none of them share a guarantee about the
  // process's current working directory at the time they run. Resolving
  // once here means every consumer agrees on the same absolute path
  // regardless of where the process was launched from; `resolve()` is a
  // no-op for a path that is already absolute (every test in this codebase
  // passes one via `documentRoot` overrides), so this changes nothing for
  // them.
  documentRoot: resolve(required('DOCUMENT_ROOT')),
  documentInbox: optional('DOCUMENT_INBOX'),
  documentReadsPerDay: positiveInt('DOCUMENT_READS_PER_DAY', 20),
  // A billed model call per finished job. A feature that spends money with no
  // switch starts charging an existing installation on the day it upgrades —
  // which is exactly what `DOCUMENT_INBOX` did before it became a switch.
  curationRunsPerDay: positiveInt('CURATION_RUNS_PER_DAY', 20),
  // A delegation costs at least one model call in the child. Same shape as
  // `curationRunsPerDay` and for the same reason: this project caps model cost
  // with a daily count off `audit_log`, not with a token budget — and a second,
  // unproven cost mechanism beside the one that works is how two readers drift.
  delegationsPerDay: positiveInt('DELEGATIONS_PER_DAY', 50),
  // Two budgets, not one — docs/superpowers/specs/2026-10-01-whatsapp-boss-channel-design.md
  // §6.2. Shared, a customer sending fifty voice notes exhausts the budget and
  // then the OWNER'S OWN recording goes untranscribed: a stranger degrading
  // the owner's channel. Both are counted off `audit_log`, same reasoning as
  // `curationRunsPerDay` above — see `whatsappTranscriptionsToday` in
  // `src/whatsapp/transcribe.ts`.
  whatsappTranscribeBossPerDay: positiveInt('WHATSAPP_TRANSCRIBE_BOSS_PER_DAY', 40),
  whatsappTranscribeOtherPerDay: positiveInt('WHATSAPP_TRANSCRIBE_OTHER_PER_DAY', 20),
  // A single recording longer than this is never sent to the provider at all
  // — see transcribe.ts, checked before either daily budget.
  whatsappMaxAudioSeconds: positiveInt('WHATSAPP_MAX_AUDIO_SECONDS', 180),
  // Every instruction spends a planner call, same shape as curationRunsPerDay/
  // delegationsPerDay above. Read by the triage task that wires instructions
  // to the planner, not by transcribe.ts. MUST be counted off its own
  // AuditKind (not 'whatsapp_transcription') — see that kind's docblock in
  // src/domain/audit.ts for why a shared kind would double-count against
  // the wrong budget.
  whatsappInstructionsPerDay: positiveInt('WHATSAPP_INSTRUCTIONS_PER_DAY', 50),
  // How long a clarifying question stays answerable over WhatsApp — spec
  // §5.4 and §10.3's own table, which declared this setting before anything
  // read it. Past the window, the owner's next message is a NEW instruction
  // rather than an answer to a question he may have forgotten he was asked.
  //
  // `positiveInt`, the same shape as the four caps above, for the reason
  // §10.3 states as the project's own rule: a value that cannot be read is
  // never a permissive value. A malformed `WHATSAPP_QUESTION_WINDOW_MINUTES`
  // throws at startup instead of quietly becoming `NaN` — and a `NaN`
  // window would make `elapsed <= window` false for every message, which
  // fails CLOSED here (everything routes as a new instruction, swallowing
  // no answers) but would still be a setting silently not doing its job.
  //
  // `0` is a legal value and means something real: no message is ever read
  // as an answer, so the channel keeps today's behaviour. That is a switch,
  // not a broken setting.
  whatsappQuestionWindowMinutes: positiveInt('WHATSAPP_QUESTION_WINDOW_MINUTES', 30),
} as const;
