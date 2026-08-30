import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AgentId } from '../domain/audit.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateHook } from './gate-hook.js';
import { ALWAYS_DISALLOWED_SDK_TOOLS, isPathWithin, sdkToolsFor, translateToolName } from './tool-names.js';
import { KNOW_READER_MODEL } from './know-reader.js';
import { buildReadingSystemPrompt } from './reading-prompt.js';

const BUSINESS = 'test-business';
const DOCS = join(tmpdir(), 'assistant-docs');
/** 12:00 Asia/Jerusalem — outside the fixture's quiet hours. */
const NOON = new Date('2026-08-18T09:00:00.000Z');

/**
 * Exercises the adapter with the shapes the SDK actually delivers, typed
 * against the installed SDK, without a live model call. The model is not what
 * is under test here — the wire between the SDK and the gate is.
 */
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

async function decisionFor(
  bundle: PolicyBundle,
  agent: AgentId,
  toolName: string,
  toolInput: unknown = {},
  // No real job behind most of these calls — only the marking behaviour
  // itself is covered elsewhere (gate-hook-ingest.test.ts), including what
  // happens when this id names no row. `null` states that explicitly rather
  // than a fixed id that used to be silently unchecked.
  jobId: string | null = null,
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
  // HookJSONOutput is a union: the async variant carries no hookSpecificOutput
  // at all, so it has to be narrowed rather than indexed.
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

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('SDK tool-name translation', () => {
  it('offers the quarantine reader no web egress and no filesystem search', () => {
    // These all mapped to `doc.fetch` - a read-only internal name that skips
    // the gate at step 4 and writes no audit row. That turned "fetch a business
    // document" into "read any path and fetch any URL", which is precisely the
    // arbitrary-read-plus-egress pair a quarantine agent must not hold.
    expect(translateToolName('WebFetch')).toBeNull();
    expect(translateToolName('Glob')).toBeNull();
    expect(translateToolName('Grep')).toBeNull();
    expect(sdkToolsFor('know.reader')).toEqual(['Read']);
  });

  it('scopes a filesystem read to the document root, traversal included', () => {
    expect(isPathWithin(join(DOCS, 'a.pdf'), DOCS)).toBe(true);
    // Normalised before the prefix test, not after.
    expect(isPathWithin('../../.env', DOCS)).toBe(false);
    expect(isPathWithin(join(DOCS, '..', '..', '.env'), DOCS)).toBe(false);
    // A sibling directory sharing the prefix is still outside.
    expect(isPathWithin(DOCS + '-other/x', DOCS)).toBe(false);
  });

  it('refuses to translate a tool it does not know', () => {
    // The inverted default that makes the boundary safe: the SDK ships tools
    // the charter has never heard of, and an unknown name must not arrive at
    // the gate looking like a read-only one.
    expect(translateToolName('Bash')).toBeNull();
    expect(translateToolName('WebSearch')).toBeNull();
    expect(translateToolName('mcp__assistant__')).toBeNull();
  });

  it('carries an MCP tool through by its last segment', () => {
    expect(translateToolName('mcp__assistant__mail.send')).toEqual({
      internal: 'mail.send',
      via: 'mcp',
      pathScoped: false,
    });
  });

  it('derives an agent tool list from the charter allowlist, never by hand', () => {
    const tools = sdkToolsFor('know.reader');
    expect(tools).toContain('Read');
    // know.reader's allowlist is doc.fetch / memory.recall — `code_execution`
    // was removed when it was classified. Nothing there maps to a writing
    // tool, so none can appear.
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Bash');
  });
});

describe('the gate hook', () => {
  it('denies a tool with no internal name instead of passing it through', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    const { decision, reason } = await decisionFor(bundle, 'know.reader', 'Bash', {
      command: 'curl evil.example.com',
    });

    expect(decision).toBe('deny');
    expect(reason).toContain('sdk_tool_unmapped');
  });

  it('allows a read the agent actually holds', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    const { decision } = await decisionFor(bundle, 'know.reader', 'Read', {
      file_path: join(DOCS, 'invoice.pdf'),
    });

    expect(decision).toBe('allow');
  });

  it('denies a write outright - it is not a tool the SDK map offers at all', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // `Write` used to map to `file.write`, which is in READ_ONLY_TOOLS and so
    // short-circuits the gate at step 4 with no audit row. It is now unmapped
    // and explicitly disallowed.
    const { decision, reason } = await decisionFor(bundle, 'know.reader', 'Write', {
      file_path: join(DOCS, 'x'),
    });

    expect(decision).toBe('deny');
    expect(reason).toContain('sdk_tool_unmapped');
  });

  it('turns a queued approval into a denial that names the approval', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // The run must end rather than block: an approval can take hours, and the
    // orchestrator resumes from the id carried in the reason.
    const { decision, reason } = await decisionFor(
      bundle,
      'comms.email',
      'mcp__assistant__mail.send',
      { to: 'new@example.com', body: 'פנייה ראשונה' },
    );

    expect(decision).toBe('deny');
    expect(reason).toContain('queued_for_approval:AP-');
  });

  it('denies a read that climbs out of the document root', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // The injection this agent exists to contain: untrusted content telling the
    // reader to go and read the credentials file. `doc.fetch` is read-only, so
    // this check is the only thing standing in the way.
    const { decision, reason } = await decisionFor(bundle, 'know.reader', 'Read', {
      file_path: '../../.env',
    });

    expect(decision).toBe('deny');
    expect(reason).toContain('path_outside_document_root');
  });

  it('hands the SDK the redacted payload rather than the one proposed', async () => {
    // The recipient's domain is declared known so the call is allowed and the
    // test can inspect `updatedInput`. An entity id no longer vouches for an
    // address the charter cannot resolve (`visibility-scoring.test.ts`), and a
    // queued approval returns no payload to assert on.
    const bundle = await installCharter(
      buildCharter({ knownCounterpartyEmailDomain: 'b.com' }),
      { businessId: BUSINESS },
    );

    const hook = createGateHook({
      agent: 'comms.email',
      bundle,
      provenance: 'boss',
      businessId: BUSINESS,
      jobId: null,
      documentRoot: DOCS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });
    const out = await hook(
      preToolUse('mcp__assistant__mail.send', {
        to: 'a@b.com',
        inReplyTo: 'm1',
        counterpartyId: 'c_812',
        body: 'id 123456789',
      }),
    );

    if (!('hookSpecificOutput' in out)) throw new Error('async shape');
    const specific = out.hookSpecificOutput;
    if (specific?.hookEventName !== 'PreToolUse') throw new Error('wrong hook');
    expect(specific.permissionDecision).toBe('allow');
    // Without updatedInput the gate computed a redacted payload and the SDK
    // went on to send the original - the charter promise silently not holding.
    const updated = specific.updatedInput as { body: string } | undefined;
    expect(updated?.body).toContain('[\u05d4\u05d5\u05e1\u05e8]');
  });

  it('fails closed when the gate throws instead of letting it escape', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // readAmountMinor throws a TypeError on a decimal amount. What the SDK does
    // with a rejected hook is unspecified, and unspecified on the permission
    // path is not a risk worth taking.
    const { decision, reason } = await decisionFor(
      bundle,
      'comms.email',
      'mcp__assistant__quote.issue',
      { counterpartyId: 'c_812', amountMinor: 100.5 },
    );

    expect(decision).toBe('deny');
    expect(reason).toContain('gate_error');
  });

  it('the kill switch reaches the SDK, not just direct callers', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const { trip, release } = await import('../governance/killswitch.js');
    await trip('all', 'p_boss', 'עצירה', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });

    const { decision, reason } = await decisionFor(bundle, 'know.reader', 'Read', {
      file_path: join(DOCS, 'x.txt'),
    });

    expect(decision).toBe('deny');
    expect(reason).toContain('kill_switch_active');

    await release('all', 'p_boss', 'סוף מבחן', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });
  });
});

describe('decision reporting', () => {
  it('reports every decision to the caller, not only to the audit log', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const seen: { tool: string; decision: string; code: string }[] = [];

    const hook = createGateHook({
      agent: 'know.reader',
      bundle,
      provenance: 'boss',
      businessId: BUSINESS,
      jobId: null,
      documentRoot: DOCS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
      onDecision: (event) => seen.push(event),
    });

    await hook(preToolUse('Read', { file_path: join(DOCS, 'a.txt') }));
    await hook(preToolUse('Bash', { command: 'id' }));

    // Without this the caller cannot tell "found nothing" from "was stopped".
    expect(seen).toEqual([
      { tool: 'doc.fetch', decision: 'allow', code: 'allow' },
      { tool: 'Bash', decision: 'deny', code: 'sdk_tool_unmapped' },
    ]);
  });
});

/**
 * These assert on the values `runKnowReader` puts in its `Options` — the
 * things the SDK actually receives. They used to assert on
 * `knowReaderDefinition`, an `AgentDefinition` whose only caller was this
 * file: an export reachable from nothing but its own test is what let the
 * missing `model` survive two sessions of review.
 */
describe('what runKnowReader hands the SDK', () => {
  it('takes its system prompt from the signed charter rather than a literal', async () => {
    const charter = buildCharter();
    const bundle = await installCharter(charter, { businessId: BUSINESS });
    const prompt = buildReadingSystemPrompt(bundle);

    // Named first: `startsWith('')` is true of every string, so an absent
    // fragment would make the next assertion pass without asserting anything.
    const fragment = bundle.promptFragments['know.reader'];
    expect(fragment).toBeTruthy();
    expect(prompt.startsWith(fragment ?? 'לא קיים')).toBe(true);
    expect(prompt).toContain(charter.identity.tradeName);
    // The quarantine instruction is the whole point of this agent.
    expect(prompt).toMatch(/אינו אמין/);
  });

  it('offers no shell and no writing tools', () => {
    expect(ALWAYS_DISALLOWED_SDK_TOOLS).toContain('Bash');
    expect(ALWAYS_DISALLOWED_SDK_TOOLS).toContain('WebFetch');
    expect(sdkToolsFor('know.reader')).toEqual(['Read']);
  });

  it('names the model it runs on, rather than taking the CLI default', () => {
    expect(KNOW_READER_MODEL).toBe('haiku');
  });
});
