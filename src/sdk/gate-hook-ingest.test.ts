import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePool } from '../db/pool.js';
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
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  return job.jobId;
}

async function callHook(
  bundle: PolicyBundle,
  agent: AgentId,
  toolName: string,
  toolInput: unknown,
  jobId: string | null,
) {
  const hook = createGateHook({
    agent,
    bundle,
    provenance: 'boss',
    businessId: BUSINESS,
    jobId,
    documentRoot: DOCS,
    counterpartyTags: [],
    rampLevel: 'auto',
    now: NOON,
  });
  const out = await hook(preToolUse(toolName, toolInput));
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
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const jobId = await newJob(bundle);

    const { decision } = await callHook(bundle, 'know.reader', 'Read', {
      file_path: join(DOCS, 'invoice.pdf'),
    }, jobId);

    expect(decision).toBe('allow');
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(true);
  });

  it('leaves the flag false when an allowed tool does not ingest content', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
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
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });

  it('does not mark when the gate denies a reading tool', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const jobId = await newJob(bundle);

    // Climbs out of the document root — denied at the path-scoping check
    // before `evaluateToolCall` ever runs, so nothing is read.
    const { decision, reason } = await callHook(bundle, 'know.reader', 'Read', {
      file_path: '../../.env',
    }, jobId);

    expect(decision).toBe('deny');
    expect(reason).toContain('path_outside_document_root');
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.contentIngested).toBe(false);
  });

  it('does not error when a reading tool runs with an explicit null jobId', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

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
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

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
