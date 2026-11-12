import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool, withBusiness, type BusinessDb } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, loadJob } from '../orchestrator/jobs.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AgentId } from '../domain/audit.js';
import { createGateHook } from './gate-hook.js';

const BUSINESS = 'test-business';
const DOCS = join(tmpdir(), 'assistant-docs');
/** 12:00 Asia/Jerusalem — outside the fixture's quiet hours. */
const NOON = new Date('2026-08-18T09:00:00.000Z');

function preToolUse(toolName: string, toolInput: unknown) {
  return {
    session_id: 'S-1',
    transcript_path: '/dev/null',
    cwd: '/',
    hook_event_name: 'PreToolUse' as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tu_1',
  };
}

async function newJob(bundle: PolicyBundle): Promise<string> {
  const job = await withBusiness(BUSINESS, (db) => createJob(db, {
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
  }));
  return job.jobId;
}

async function callHook(
  bundle: PolicyBundle,
  agent: AgentId,
  toolName: string,
  toolInput: unknown,
  jobId: string | null,
) {
  const out = await withBusiness(BUSINESS, (db) => {
    const hook = createGateHook({
      agent,
      bundle,
      provenance: 'boss',
      db,
      jobId,
      documentRoot: DOCS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    return hook(preToolUse(toolName, toolInput));
  });
  if (!('hookSpecificOutput' in out)) {
    throw new Error('hook returned the async output shape');
  }
  const specific = out.hookSpecificOutput;
  if (specific === undefined || specific.hookEventName !== 'PreToolUse') {
    throw new Error('hook did not return PreToolUse output');
  }
  return {
    decision: specific.permissionDecision,
    reason: specific.permissionDecisionReason ?? '',
  };
}

describe('the gate hook marks content-ingestion on its own path', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('marks the job when an allowed tool ingests external content', async () => {
    const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
    const jobId = await newJob(bundle);

    const { decision } = await callHook(bundle, 'know.reader', 'Read', {
      file_path: join(DOCS, 'invoice.pdf'),
    }, jobId);

    expect(decision).toBe('allow');
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.contentIngested).toBe(true);
  });

  /**
   * Carried finding (Task 3 review): the gate ran on a fresh connection while
   * the ingest mark used another, so one hook decision could span two
   * connections. Both now run on `binding.db` — asserted by handing the hook
   * a connection that records every statement, and requiring the gate's own
   * audit write AND the `content_ingested` UPDATE to appear on it.
   */
  it('runs the gate and the ingest mark on the one connection it was given', async () => {
    const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
    const jobId = await newJob(bundle);

    const statements: string[] = [];
    const out = await withBusiness(BUSINESS, (db) => {
      const recording: BusinessDb = {
        businessId: db.businessId,
        inTransaction: db.inTransaction,
        query: ((text: unknown, ...rest: unknown[]) => {
          statements.push(typeof text === 'string' ? text : String((text as { text?: string }).text));
          return (db.query as (...a: unknown[]) => unknown)(text, ...rest);
        }) as BusinessDb['query'],
      };
      const hook = createGateHook({
        agent: 'know.reader',
        bundle,
        provenance: 'boss',
        db: recording,
        jobId,
        documentRoot: DOCS,
        counterpartyTags: [],
        rampLevel: 'auto',
        now: NOON,
      });
      return hook(preToolUse('Read', { file_path: join(DOCS, 'invoice.pdf') }));
    });

    if (!('hookSpecificOutput' in out)) throw new Error('async shape');
    expect(out.hookSpecificOutput?.hookEventName === 'PreToolUse' && out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(statements.some((q) => /content_ingested/.test(q))).toBe(true);
    expect(statements.some((q) => /kill_switch/.test(q))).toBe(true);
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.contentIngested).toBe(true);
  });

  it('leaves the flag false when an allowed tool does not ingest content', async () => {
    const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
    const jobId = await newJob(bundle);

    // `escalate_to_human` is read-only and carries no external content — it is
    // explicitly `false` in the ingest table (src/policy/classify.ts).
    const { decision } = await callHook(
      bundle,
      'comms.whatsapp',
      'mcp__assistant__escalate_to_human',
      { reason: 'לא ברור מה מבקשים' },
      jobId,
    );

    // Assert the call was actually allowed, so this cannot pass because
    // nothing ran.
    expect(decision).toBe('allow');
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.contentIngested).toBe(false);
  });

  it('does not mark when the gate denies a reading tool', async () => {
    const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));
    const jobId = await newJob(bundle);

    // Climbs out of the document root — denied at the path-scoping check
    // before `evaluateToolCall` ever runs, so nothing is read.
    const { decision, reason } = await callHook(bundle, 'know.reader', 'Read', {
      file_path: '../../.env',
    }, jobId);

    expect(decision).toBe('deny');
    expect(reason).toContain('path_outside_document_root');
    expect((await withBusiness(BUSINESS, (db) => loadJob(db, jobId)))?.contentIngested).toBe(false);
  });

  it('does not error when a reading tool runs with an explicit null jobId', async () => {
    const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));

    const { decision } = await callHook(
      bundle,
      'know.reader',
      'Read',
      { file_path: join(DOCS, 'invoice.pdf') },
      null,
    );

    expect(decision).toBe('allow');
  });

  it('fails closed instead of allowing when the jobId matches no row', async () => {
    const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter()));

    // Never created via `createJob` — stands in for a stale id, a typo, or a
    // job that belongs to another business. `markContentIngested`'s UPDATE
    // matches nothing, and the read must be refused rather than let through
    // with no memory of having happened: exactly the gap this test is here
    // to close. If the fail-closed check were removed, `decide` would still
    // return the gate's original `allow` here, since nothing else in this
    // path depends on the mark having landed — so a passing assertion of
    // `deny` genuinely depends on that branch existing.
    const { decision, reason } = await callHook(
      bundle,
      'know.reader',
      'Read',
      { file_path: join(DOCS, 'invoice.pdf') },
      'J-does-not-exist',
    );

    expect(decision).toBe('deny');
    expect(reason).toContain('content_ingest_unrecorded');
  });
});
