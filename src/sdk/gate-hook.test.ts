import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AgentId } from '../domain/audit.js';
import { createGateHook } from './gate-hook.js';
import { sdkToolsFor, translateToolName } from './tool-names.js';
import { knowReaderDefinition } from './know-reader.js';

const BUSINESS = 'test-business';

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
) {
  const hook = createGateHook({
    agent,
    bundle,
    provenance: 'boss',
    businessId: BUSINESS,
    jobId: 'J-SDK',
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
    });
  });

  it('derives an agent tool list from the charter allowlist, never by hand', () => {
    const tools = sdkToolsFor('know.reader');
    expect(tools).toContain('Read');
    // know.reader's allowlist is doc.fetch / code_execution / memory.recall.
    // Nothing there maps to a writing tool, so none can appear.
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
      file_path: '/tmp/invoice.pdf',
    });

    expect(decision).toBe('allow');
  });

  it('denies a write the agent is not allowlisted for', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });

    // file.write is a real tool in the registry, but not one know.reader owns.
    // This is the capability layer denying before the charter is consulted.
    const { decision, reason } = await decisionFor(bundle, 'know.reader', 'Write', {
      file_path: '/tmp/x',
    });

    expect(decision).toBe('deny');
    expect(reason).toContain('tool_not_allowlisted');
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

  it('the kill switch reaches the SDK, not just direct callers', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const { trip, release } = await import('../governance/killswitch.js');
    await trip('all', 'p_boss', 'עצירה', {
      businessId: BUSINESS,
      charterVersion: bundle.charterVersion,
    });

    const { decision, reason } = await decisionFor(bundle, 'know.reader', 'Read', {
      file_path: '/tmp/x',
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
      onDecision: (event) => seen.push(event),
    });

    await hook(preToolUse('Read', { file_path: '/tmp/a' }));
    await hook(preToolUse('Bash', { command: 'id' }));

    // Without this the caller cannot tell "found nothing" from "was stopped".
    expect(seen).toEqual([
      { tool: 'doc.fetch', decision: 'allow', code: 'allow' },
      { tool: 'Bash', decision: 'deny', code: 'sdk_tool_unmapped' },
    ]);
  });
});

describe('the know.reader definition', () => {
  it('takes its prompt from the signed charter rather than a literal', async () => {
    const charter = buildCharter();
    const bundle = await installCharter(charter, { businessId: BUSINESS });
    const definition = knowReaderDefinition(bundle);

    expect(definition.prompt).toBe(bundle.promptFragments['know.reader']);
    expect(definition.prompt).toContain(charter.identity.tradeName);
    // The quarantine instruction is the whole point of this agent.
    expect(definition.prompt).toMatch(/אינו אמין/);
  });

  it('offers no shell and no writing tools', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const definition = knowReaderDefinition(bundle);
    expect(definition.disallowedTools).toContain('Bash');
    expect(definition.tools).not.toContain('Bash');
  });
});
