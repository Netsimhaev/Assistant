#!/usr/bin/env node
/**
 * Stop hook — the deterministic half of the after-task check.
 *
 * A Stop hook fires at the end of EVERY turn, including turns that were pure
 * conversation. Running the test suite there would add seconds to every reply
 * for no reason, so this exits immediately unless something under src/ (or a
 * build-config file) is newer than the last run.
 *
 * It never blocks. Blocking a Stop hook on a failing check risks a loop when
 * the failure is not fixable, and CLAUDE.md already asks Claude to run these
 * checks itself before reporting done — this is the backstop for when it
 * forgets, not the primary control.
 *
 * jq is not installed on this machine, so JSON is emitted via JSON.stringify
 * rather than assembled in shell.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = join(PROJECT_ROOT, 'node_modules', '.cache', 'claude-task-check.stamp');

/** Files whose change should trigger a re-check, beyond src/. */
const WATCHED_FILES = ['package.json', 'tsconfig.json', 'vitest.config.ts'];

function newestMtimeUnder(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeUnder(full));
    } else {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // Deleted between readdir and stat — nothing to measure.
      }
    }
  }
  return newest;
}

function newestRelevantMtime() {
  let newest = newestMtimeUnder(join(PROJECT_ROOT, 'src'));
  for (const name of WATCHED_FILES) {
    try {
      newest = Math.max(newest, statSync(join(PROJECT_ROOT, name)).mtimeMs);
    } catch {
      // Absent file simply does not contribute.
    }
  }
  return newest;
}

function lastCheckedMtime() {
  try {
    return Number(readFileSync(STAMP, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

function writeStamp(value) {
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, String(value), 'utf8');
}

/**
 * Budget for a single command.
 *
 * **A budget below the command's real runtime does not report a slow check —
 * it reports a FAILED one, on every turn, whatever the result.** This was
 * `150_000` for all three commands while `npm test` took 233–241s measured
 * across four clean runs, so the suite was killed mid-flight every time and
 * the hook printed a red `tests` line above output consisting entirely of
 * passes. Nobody changed the budget; the suite grew past it (1,638 tests when
 * this hook was written, 1,858 now) and the value quietly became a lie.
 *
 * So: per-command budgets, each with real headroom, and the one that needs it
 * named explicitly at its call site rather than sharing a constant with two
 * commands that finish in seconds. **When the suite's runtime approaches
 * `TEST_BUDGET_MS`, raise it — do not let a red line stand in for a slow one.**
 * `npm test -- --reporter=basic` prints the duration this should be compared
 * against.
 */
const DEFAULT_BUDGET_MS = 120_000;
const TEST_BUDGET_MS = 480_000;

/** Run a command, returning its outcome rather than throwing. */
function run(label, command, { tolerateFailure = false, timeoutMs = DEFAULT_BUDGET_MS } = {}) {
  try {
    execSync(command, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return { label, ok: true, tolerated: false, detail: '' };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    // Keep the tail — compiler and test runners put the summary last.
    const detail = output.split('\n').slice(-12).join('\n').slice(0, 1200);
    return { label, ok: false, tolerated: tolerateFailure, detail };
  }
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

async function main() {
  // Drain stdin so the hook never hangs waiting on the payload it does not use.
  if (!process.stdin.isTTY) {
    process.stdin.resume();
    process.stdin.on('data', () => {});
  }

  if (!existsSync(join(PROJECT_ROOT, 'node_modules'))) {
    // Dependencies not installed — nothing meaningful to check.
    return;
  }

  const newest = newestRelevantMtime();
  if (newest === 0 || newest <= lastCheckedMtime()) {
    // Nothing changed since the last check. Stay silent.
    return;
  }

  const results = [
    run('typecheck', 'npm run typecheck --silent'),
    run('tests', 'npm test --silent', { timeoutMs: TEST_BUDGET_MS }),
    // A dependency advisory is worth surfacing but should not read as a broken
    // build — it is rarely something this turn introduced.
    run('npm audit', 'npm audit --audit-level=high', { tolerateFailure: true }),
  ];

  writeStamp(newest);

  const hardFailures = results.filter((r) => !r.ok && !r.tolerated);
  const softFailures = results.filter((r) => !r.ok && r.tolerated);

  if (hardFailures.length === 0 && softFailures.length === 0) {
    emit({ systemMessage: '✓ בדיקה אוטומטית: typecheck, מבחנים ו-audit עברו.' });
    return;
  }

  const lines = [];
  if (hardFailures.length > 0) {
    lines.push(`✗ בדיקה אוטומטית נכשלה: ${hardFailures.map((r) => r.label).join(', ')}`);
    for (const failure of hardFailures) {
      lines.push('', `— ${failure.label} —`, failure.detail || '(ללא פלט)');
    }
  }
  if (softFailures.length > 0) {
    lines.push(`⚠ ${softFailures.map((r) => r.label).join(', ')} דיווח על ממצא — כדאי להסתכל.`);
  }

  emit({
    systemMessage: lines.join('\n'),
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: lines.join('\n'),
    },
  });
}

main().catch((error) => {
  // A broken hook must never break the session.
  emit({ systemMessage: `בדיקה אוטומטית לא רצה: ${error.message}` });
});
