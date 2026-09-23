import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
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
  includedOrdinals: readonly number[],
  denials: string[],
  turns: number,
): ReadOutcome {
  const parsed = parseReading(raw, includedOrdinals);
  if (parsed.status === 'read') {
    return { status: 'read', reading: parsed.reading, raw, denials, turns };
  }
  return { status: 'unreadable', reason: parsed.reason, raw, denials, turns };
}

/**
 * Same guard as `curateWithModel`'s (`src/sdk/curator.ts`), and for the same
 * reason: the protection against a live, billed call under test must not rest
 * on test discipline alone (CLAUDE.md, "ההגנה מפני קריאה חיה לא תישען רק על
 * משמעת מבחנים"). `readDocument`'s `reader` option (and, above it,
 * `LocalToolContext.reader` and `RunPlanRequest.reader`) is the seam a test
 * injects instead — injecting bypasses this guard entirely, because the guard
 * lives in the DEFAULT this function is, not in the seam itself. A test that
 * forgets to inject one is exactly what this is for.
 */
function refuseUnderTest(): void {
  if (!config.isTest) return;
  throw new Error(
    'runKnowReader: refusing to run under NODE_ENV=test — this is a live, billed call to the Agent SDK. ' +
      'Inject a reader (see ReadDocumentOptions.reader) instead of relying on the default reaching this function.',
  );
}

/**
 * Run `know.reader` end to end: SDK harness, charter-derived prompt, and every
 * tool call passing through `evaluateToolCall` before it executes.
 */
export async function runKnowReader(request: ReadRequest): Promise<ReadOutcome> {
  refuseUnderTest();
  const denials: string[] = [];
  // Both halves are used: the text goes to the model, and the ordinals it
  // survived with are what a citation is checked against. Checking against
  // `request.artifacts` instead would accept a citation to a part the total
  // ceiling dropped out of the brief.
  const { brief, includedOrdinals } = renderReadingBrief(request.artifacts);

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
    // a definition and then sending the task as a top-level prompt meant the
    // model doing the reading never received the charter's quarantine
    // instruction, never ran on Haiku, and never saw `disallowedTools`, while
    // the tests asserted on the definition that nothing used. That definition
    // is gone: every claim it made is made here, where it takes effect, and
    // `gate-hook.test.ts` asserts on these values instead.
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

  return interpretReaderResponse(text, includedOrdinals, denials, turns);
}
