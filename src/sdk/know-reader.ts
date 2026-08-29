import { query, type AgentDefinition, type Options } from '@anthropic-ai/claude-agent-sdk';
import { renderReadingBrief } from '../documents/brief.js';
import { parseReading } from '../documents/reading-parse.js';
import type { DocumentArtifact } from '../documents/types.js';
import type { Reading } from '../domain/reading.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { TrustLevel } from '../domain/trust.js';
import { createGateHook, type GateHookBinding } from './gate-hook.js';
import { buildReadingSystemPrompt } from './reading-prompt.js';
import { ALWAYS_DISALLOWED_SDK_TOOLS, sdkToolsFor } from './tool-names.js';

const AGENT = 'know.reader' as const;

/**
 * The model this reader runs on.
 *
 * Haiku because this is the highest-volume, most mechanical work in the system
 * (docs/08-risks.md, cost controls). Note the caching caveat recorded there:
 * Haiku's minimum cacheable prefix is larger than Opus's, so a short prefix
 * silently never caches.
 *
 * Exported and declared once because it has two consumers that must not drift:
 * the `Options` this module hands the SDK, and the `model` column
 * `document_readings` stores for attribution. They were two literals in two
 * files, and the reading table recorded `haiku` on every row while the run
 * itself had no `model` at all and took the CLI default.
 */
export const KNOW_READER_MODEL = 'haiku';

/**
 * `know.reader` as the SDK sees it.
 *
 * The prompt comes from the compiled bundle rather than from a string here, so
 * the charter the owner signed is the same text the model reads. The tool list
 * is derived from the same allowlist the gate enforces — writing it twice is
 * how the two drift apart.
 *
 * `definition.prompt` is the charter fragment alone. `runKnowReader` does not
 * use it directly as the system prompt any more — it composes the full one via
 * `buildReadingSystemPrompt`, which appends the intent registry and the output
 * schema. This definition still documents the agent's shape (tools, model,
 * disallowed tools) and is what `gate-hook.test.ts` asserts against.
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
    // reason to offer a shell — or web egress — to an agent whose entire job is
    // reading, and whose input is untrusted by construction.
    disallowedTools: [...ALWAYS_DISALLOWED_SDK_TOOLS],
    model: KNOW_READER_MODEL,
  };
}

export interface ReadRequest {
  bundle: PolicyBundle;
  /**
   * The document's extracted parts, as `loadArtifacts` returns them.
   *
   * Not a free-text task and not a path: the brief is rendered from these
   * deterministically (`renderReadingBrief`), so what the reader is asked
   * about is a function of what intake extracted rather than of a string a
   * caller composed. It also means `sourceRef` has something real to cite.
   */
  artifacts: readonly DocumentArtifact[];
  /**
   * Trust of the content this job originates from.
   *
   * Defaults to `unknown_external`, not to `boss`. A reader exists to consume
   * material the business did not write, and a permissive default here would
   * quietly lift the provenance ceiling on everything downstream.
   */
  provenance?: TrustLevel;
  businessId?: string;
  /**
   * The job this read belongs to, or explicitly `null` when there isn't one.
   *
   * Required so a caller has to say which — see `GateHookBinding.jobId`
   * (`src/sdk/gate-hook.ts`) for why an omitted job id and a genuinely
   * job-less run must not be the same value.
   */
  jobId: string | null;
  /**
   * Directory the reader may read from, and nothing above it.
   *
   * Required rather than defaulted to the process cwd: defaulting would put the
   * repository root — and its `.env` — inside the reader's reach, which is the
   * exact shape of the injection this agent exists to contain.
   */
  documentRoot: string;
}

/**
 * What a read produced. Free text is not among the possibilities.
 *
 * `raw` rides on both branches: on failure it is the evidence for the recorded
 * reason, and on success it is what the stored reading was derived from.
 */
export type ReadOutcome =
  | { status: 'read'; reading: Reading; raw: string; denials: string[]; turns: number }
  | { status: 'unreadable'; reason: string; raw: string; denials: string[]; turns: number };

/**
 * Everything about a read except the model call.
 *
 * Separated so it can be tested without an API key — the same split
 * `parsePlan` has from `makePlan`. The interesting failures here are malformed
 * output and fabricated citations, neither of which needs network behaviour to
 * reproduce.
 */
export function interpretReaderResponse(
  raw: string,
  artifacts: readonly DocumentArtifact[],
  denials: string[],
  turns: number,
): ReadOutcome {
  const parsed = parseReading(raw, artifacts);
  if (parsed.status === 'read') {
    return { status: 'read', reading: parsed.reading, raw, denials, turns };
  }
  return { status: 'unreadable', reason: parsed.reason, raw, denials, turns };
}

/**
 * Run `know.reader` end to end: SDK harness, charter-derived prompt, and every
 * tool call passing through `evaluateToolCall` before it executes.
 */
export async function runKnowReader(request: ReadRequest): Promise<ReadOutcome> {
  const denials: string[] = [];
  const brief = renderReadingBrief(request.artifacts);

  const binding: GateHookBinding = {
    agent: AGENT,
    bundle: request.bundle,
    provenance: request.provenance ?? 'unknown_external',
    documentRoot: request.documentRoot,
    // No resolver yet — stated rather than defaulted, so the dead tag rules
    // are visible here instead of hidden behind an optional field.
    counterpartyTags: [],
    // No ramp yet. draft_only is the value the risk engine's comment assumes.
    rampLevel: 'draft_only',
    onDecision: (event) => {
      if (event.decision === 'deny') denials.push(event.code);
    },
    ...(request.businessId !== undefined ? { businessId: request.businessId } : {}),
    jobId: request.jobId,
  };

  const options: Options = {
    // The prompt goes in `systemPrompt`, not into an `agents` entry.
    //
    // An AgentDefinition only takes effect for a *subagent* invoked through the
    // Agent tool — and that tool is unmapped, so the hook denies it. Registering
    // the definition and then sending the task as a top-level prompt meant the
    // model doing the reading never received the charter's quarantine
    // instruction, never ran on Haiku, and never saw `disallowedTools`. The
    // tests asserted on a definition that nothing used.
    //
    // The charter fragment is still the first thing in it; the intent registry
    // and output schema follow, and all of it is byte-identical across reads.
    systemPrompt: buildReadingSystemPrompt(request.bundle),
    // `tools` restricts; `allowedTools` only auto-approves what is already
    // available. Using the latter alone left every built-in tool on the table.
    tools: sdkToolsFor(AGENT),
    disallowedTools: [...ALWAYS_DISALLOWED_SDK_TOOLS],
    // Named, not defaulted. `Options.model` defaults to the CLI default
    // model, so leaving it out meant the reader never ran on Haiku — the very
    // bug the comment above records — while `document_readings.model` went on
    // recording `haiku` on every row. The column whose whole purpose is
    // attribution has to name what actually ran.
    model: KNOW_READER_MODEL,
    // A second boundary under the hook's path check, so a filesystem read is
    // scoped by the SDK as well as by us.
    cwd: request.documentRoot,
    // Load no settings from disk.
    //
    // Omitting this loads every source "matching CLI defaults" — this repo's
    // .claude/settings.json (which registers a plugin and a Stop hook that
    // shells out) and the operator's own ~/.claude/settings.json with their
    // MCP connectors and permission rules. Handing all of that to the one
    // agent defined by having no authority, fed by untrusted documents, is the
    // opposite of a quarantine.
    settingSources: [],
    // Name what the subprocess gets rather than inheriting process.env, which
    // config.ts has just populated from .env with the database credentials.
    env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
    // An unbounded read loop is a cost incident waiting for a long document.
    maxTurns: 12,
    // The hook is the authority; `permissionMode` only decides what happens to
    // calls the hook did not already settle.
    permissionMode: 'default',
    hooks: {
      PreToolUse: [{ hooks: [createGateHook(binding)] }],
    },
  };

  let text = '';
  let turns = 0;

  for await (const message of query({ prompt: brief, options })) {
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

  return interpretReaderResponse(text, request.artifacts, denials, turns);
}
