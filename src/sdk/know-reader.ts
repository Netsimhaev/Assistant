import { query, type AgentDefinition, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { PolicyBundle } from '../domain/policy.js';
import type { TrustLevel } from '../domain/trust.js';
import { createGateHook, type GateHookBinding } from './gate-hook.js';
import { sdkToolsFor } from './tool-names.js';

const AGENT = 'know.reader' as const;

/**
 * `know.reader` as the SDK sees it.
 *
 * The prompt comes from the compiled bundle rather than from a string here, so
 * the charter the owner signed is the same text the model reads. The tool list
 * is derived from the same allowlist the gate enforces — writing it twice is
 * how the two drift apart.
 *
 * Haiku because this is the highest-volume, most mechanical work in the system
 * (docs/08-risks.md, cost controls). Note the caching caveat recorded there:
 * Haiku's minimum cacheable prefix is larger than Opus's, so a short prefix
 * silently never caches.
 */
export function knowReaderDefinition(bundle: PolicyBundle): AgentDefinition {
  return {
    description:
      'Reads a document or message and returns a structured summary. Holds no authority to act.',
    prompt: bundle.promptFragments[AGENT],
    tools: sdkToolsFor(AGENT),
    // Belt and braces. The hook is the control that decides, but there is no
    // reason to offer a shell to an agent whose entire job is reading, and
    // whose input is untrusted by construction.
    disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch'],
    model: 'haiku',
  };
}

export interface ReadRequest {
  bundle: PolicyBundle;
  /** What to read, in the agent's own terms. */
  task: string;
  /**
   * Trust of the content this job originates from.
   *
   * Defaults to `unknown_external`, not to `boss`. A reader exists to consume
   * material the business did not write, and a permissive default here would
   * quietly lift the provenance ceiling on everything downstream.
   */
  provenance?: TrustLevel;
  businessId?: string;
  jobId?: string | null;
}

export interface ReadResult {
  text: string;
  /** Deny codes the gate produced during the run, in order. */
  denials: string[];
  turns: number;
}

/**
 * Run `know.reader` end to end: SDK harness, charter-derived prompt, and every
 * tool call passing through `evaluateToolCall` before it executes.
 */
export async function runKnowReader(request: ReadRequest): Promise<ReadResult> {
  const denials: string[] = [];

  const binding: GateHookBinding = {
    agent: AGENT,
    bundle: request.bundle,
    provenance: request.provenance ?? 'unknown_external',
    onDecision: (event) => {
      if (event.decision === 'deny') denials.push(event.code);
    },
    ...(request.businessId !== undefined ? { businessId: request.businessId } : {}),
    ...(request.jobId !== undefined ? { jobId: request.jobId } : {}),
  };

  const options: Options = {
    agents: { [AGENT]: knowReaderDefinition(request.bundle) },
    allowedTools: sdkToolsFor(AGENT),
    // The hook is the authority; `permissionMode` only decides what happens to
    // calls the hook did not already settle.
    permissionMode: 'default',
    hooks: {
      PreToolUse: [{ hooks: [createGateHook(binding)] }],
    },
  };

  let text = '';
  let turns = 0;

  for await (const message of query({ prompt: request.task, options })) {
    if (message.type === 'assistant') {
      turns += 1;
      for (const block of message.message.content) {
        if (block.type === 'text') text += block.text;
      }
    }
    if (message.type === 'result' && message.subtype === 'success') {
      text = message.result;
    }
  }

  return { text, denials, turns };
}
