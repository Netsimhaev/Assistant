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
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * The three commands run one after another inside the hook's OWN timeout
 * (`timeout` on this hook in `.claude/settings.json`). If their budgets add up
 * past it, Claude Code kills the whole hook and nothing is reported at all —
 * worse than a red line. So the test budget is derived, not typed: everything
 * the outer timeout leaves after the two short commands and a margin.
 *
 * Measured 25/10: typecheck 5s, audit 1s, the suite 336–509s (the high end
 * under load from a second session). With the outer 780s that gives 630s.
 * Read from settings at run time so raising the outer timeout raises this
 * with it, instead of the two numbers drifting apart.
 */
const SHORT_BUDGET_MS = 60_000;
const MARGIN_MS = 30_000;
const FALLBACK_OUTER_TIMEOUT_S = 780;

function outerTimeoutSeconds() {
  try {
    const settings = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf8'));
    for (const group of settings?.hooks?.Stop ?? []) {
      for (const hook of group?.hooks ?? []) {
        if (typeof hook?.command === 'string' && hook.command.includes('post-task-check.mjs')
          && Number.isFinite(hook.timeout) && hook.timeout > 0) {
          return hook.timeout;
        }
      }
    }
  } catch {
    // Unreadable settings: fall back to the value they held when this was written.
  }
  return FALLBACK_OUTER_TIMEOUT_S;
}

const TEST_BUDGET_MS = Math.max(
  DEFAULT_BUDGET_MS,
  outerTimeoutSeconds() * 1000 - 2 * SHORT_BUDGET_MS - MARGIN_MS,
);

/**
 * Stop a timed-out command AND everything it started.
 *
 * `execSync`'s own `timeout` kills only the direct child. Measured 25/10 on
 * this Windows machine: a grandchild survived the kill and kept running. For
 * `npm test` the grandchild is vitest itself — so every time this hook ran out
 * of time it left an orphaned suite writing to the shared test database, and
 * the NEXT run (the hook's or a person's) collided with it and reported reds
 * that belonged to neither. `taskkill /T` takes the whole tree on Windows; on
 * POSIX the command runs in its own process group, which is killed as one.
 */
function killTree(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // Already gone between the timer and the kill.
  }
}

/** Run a command, returning its outcome rather than throwing. */
function run(label, command, { tolerateFailure = false, timeoutMs = DEFAULT_BUDGET_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: PROJECT_ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (ok) => {
      clearTimeout(timer);
      if (ok) {
        resolve({ label, ok: true, tolerated: false, detail: '' });
        return;
      }
      // Keep the tail — compiler and test runners put the summary last.
      const tail = output.trim().split('\n').slice(-12).join('\n').slice(0, 1200);
      // A command killed for running out of time printed only its header, and
      // reported that way it reads as a failure nobody can find. Say so.
      const detail = timedOut
        ? `נקטע אחרי ${Math.round(timeoutMs / 1000)} שניות — חריגה ממגבלת הזמן, לא תוצאה של מבחן.\n${tail}`
        : tail;
      resolve({ label, ok: false, tolerated: tolerateFailure, detail });
    };
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(!timedOut && code === 0));
  });
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

  // Sequential on purpose: the suite and the type checker would otherwise
  // compete for the same CPU and stretch each other toward their budgets.
  const results = [
    await run('typecheck', 'npm run typecheck --silent', { timeoutMs: SHORT_BUDGET_MS }),
    await run('tests', 'npm test --silent', { timeoutMs: TEST_BUDGET_MS }),
    // A dependency advisory is worth surfacing but should not read as a broken
    // build — it is rarely something this turn introduced.
    await run('npm audit', 'npm audit --audit-level=high', { tolerateFailure: true, timeoutMs: SHORT_BUDGET_MS }),
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
