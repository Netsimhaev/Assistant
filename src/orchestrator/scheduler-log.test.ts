/**
 * Fix round 1, F4 — ruling 3's whole point was that counting `deferred` and
 * `errored` only matters once something reads the counter. Until this file,
 * nothing imported `logErrored` at all (it was a private, unexported
 * function inside `run-scheduler.ts`, a script with side effects on import),
 * so the reader itself had no coverage. These tests import `logErrored`
 * directly from its own module — never `run-scheduler.ts` — specifically so
 * importing this test file does not also build a runtime, run a pass and
 * start a scheduler loop.
 */
import { describe, expect, it, vi } from 'vitest';
import { logErrored } from './scheduler-log.js';
import type { SchedulerPassResult } from './scheduler.js';

/** A clean pass: every bucket empty, every error null. */
function cleanResult(): SchedulerPassResult {
  return {
    tick: { expiredApprovals: [], wokenJobs: [], skipped: false },
    scan: null,
    scanError: null,
    conduct: null,
    delegated: { resumed: [], timedOut: [], errored: [] },
    whatsappDoor: null,
    mail: null,
    mailError: null,
    due: { ran: [], lockedOut: [], unbound: [], phaseMoved: [], errored: [] },
    verified: {
      closed: [],
      failed: [],
      unbound: [],
      lockedOut: [],
      phaseMoved: [],
      errored: [],
      curated: [],
      curationSkipped: [],
    },
    whatsappReport: null,
    whatsappError: null,
    autonomy: { promoted: [], demoted: [], errored: [] },
    autonomyError: null,
    digest: null,
  };
}

describe('logErrored', () => {
  it('prints nothing for a clean pass', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logErrored(cleanResult());
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  /**
   * The exact gap F4 named: ruling 3 is only honest once a deferred count and
   * an errored job id are actually printed somewhere an operator reads.
   */
  it('names a nonzero deferred count and every errored WhatsApp-report job id', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result: SchedulerPassResult = {
        ...cleanResult(),
        whatsappDoor: { polled: 3, instructed: 1, recordedOnly: 0, refused: 2, closed: 0, malformedSenderCount: 0 },
        whatsappReport: { reported: 0, deferred: 2, errored: ['job-a', 'job-b'] },
      };
      logErrored(result);

      const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      const errored = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('2 WhatsApp-opened job(s) deferred this pass');
      expect(errored).toContain('job-a');
      expect(errored).toContain('job-b');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  /**
   * Fix round 1, F2 — the text must say what actually happened. `whatsappDoor
   * === null` means both loops were skipped; a non-null `whatsappDoor` means
   * the door ran and only the report's own candidate query failed.
   */
  it('says "both loops skipped" only when the door never ran', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logErrored({ ...cleanResult(), whatsappError: 'stale charter' });
      const errored = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(errored).toContain('WhatsApp loops skipped this pass');
      expect(errored).not.toContain('WhatsApp report failed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('says the report failed after the door ran, when the door has a result', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logErrored({
        ...cleanResult(),
        whatsappDoor: { polled: 0, instructed: 0, recordedOnly: 0, refused: 0, closed: 0, malformedSenderCount: 0 },
        whatsappError: 'reportCandidates query rejected',
      });
      const errored = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(errored).toContain('WhatsApp report failed after the door ran this pass');
      expect(errored).not.toContain('WhatsApp loops skipped this pass');
    } finally {
      errorSpy.mockRestore();
    }
  });

  /**
   * Fix round 1, item 2 — the most serious gap this round found: nothing
   * printed a stale-charter failure inside the digest, so an installation
   * with the schedule on and an unparseable charter failed on every pass,
   * forever, in total silence. Follows this repo's own precedent for a bare
   * `*Error` assertion (`scheduler-conducts.test.ts:441`,
   * `expect(pass.scanError).toBeTruthy()`), one layer down: the exact prefix
   * matters here because `digest` also carries `produced`/`screenOnly`,
   * which must stay out of the error text.
   */
  it('names a digest that failed to load its charter', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logErrored({
        ...cleanResult(),
        digest: { produced: [], screenOnly: 0, errored: 'charter stored under an older schema' },
      });
      const errored = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(errored).toContain('digest failed: charter stored under an older schema');
    } finally {
      errorSpy.mockRestore();
    }
  });

  /** `digest: null` (the schedule is off) has nothing to report. */
  it('prints nothing for a digest that did not run', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logErrored({ ...cleanResult(), digest: null });
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
