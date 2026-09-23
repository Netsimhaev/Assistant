import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import type { Proposal } from '../domain/proposal.js';
import type { Reading } from '../domain/reading.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel, TrustLevel } from '../domain/trust.js';
import { capabilityCatalogue, renderCatalogue, type CatalogueEntry } from '../orchestrator/catalogue.js';
import { parseProposal } from '../orchestrator/proposal-parse.js';
import { buildProposalSystemPrompt, renderReadingForProposal } from './proposal-prompt.js';

/**
 * The model the proposer runs on.
 *
 * Sonnet, not Haiku: `know.reader` extracts what a document says, which is
 * mechanical; the proposer weighs what a reading implies against the charter
 * and picks a stance, which is judgement. `document_readings` and
 * `proposal_records` already carry `haiku` and `sonnet` respectively as the
 * fixtures for their stores record.
 *
 * Exported and declared once because it has two consumers that must not
 * drift: the `Options` this module hands the SDK, and the `model` column the
 * composition (Task 9) stores for attribution. Sub-project ב' shipped those
 * as two separate literals, and the database went on recording a model the
 * reader had never actually run on.
 */
export const PROPOSER_MODEL = 'sonnet';

export interface ProposeRequest {
  bundle: PolicyBundle;
  reading: Reading;
  provenance: TrustLevel;
  rampLevel: AutonomyLevel;
}

/**
 * What a proposal call produced. Free text is not among the possibilities.
 *
 * `raw` rides on both branches, the same reason `ReadOutcome` (`know-reader.ts`)
 * carries it: on failure it is the evidence for the recorded reason, and on
 * success it is what the stored proposal was derived from.
 */
export type ProposeOutcome =
  | { status: 'proposed'; proposal: Proposal; raw: string }
  | { status: 'unproposable'; reason: string; raw: string };

/**
 * Everything about a proposal call except the model call itself.
 *
 * Separated so it can be tested without an API key — the same split
 * `parsePlan` has from `makePlan` and `interpretReaderResponse` has from
 * `runKnowReader`. Every interesting failure — malformed JSON, a stance that
 * carries an action it must not, a tool the acting agent does not hold in the
 * catalogue — is a parsing and validation question, not a network one, and
 * `parseProposal` (`src/orchestrator/proposal-parse.ts`) already carries the
 * full coverage for it. This function only adapts that result's shape to
 * `ProposeOutcome`, which keeps `raw` alongside the outcome on both branches.
 */
export function interpretProposerResponse(
  raw: string,
  reading: Reading,
  catalogue: readonly CatalogueEntry[],
): ProposeOutcome {
  const parsed = parseProposal(raw, reading, catalogue);
  if (parsed.status === 'proposed') {
    return { status: 'proposed', proposal: parsed.proposal, raw };
  }
  return { status: 'unproposable', reason: parsed.reason, raw };
}

/**
 * Same guard as `curateWithModel`'s (`src/sdk/curator.ts`) and `runKnowReader`'s
 * (`src/sdk/know-reader.ts`), and for the same reason: the protection against
 * a live, billed call under test must not rest on test discipline alone
 * (CLAUDE.md, "ההגנה מפני קריאה חיה לא תישען רק על משמעת מבחנים").
 * `ProposeForReadingOptions.proposer` (`orchestrator/propose.ts`) is the seam
 * a test injects instead — injecting bypasses this guard entirely, because
 * the guard lives in the DEFAULT this function is, not in the seam itself.
 */
function refuseUnderTest(): void {
  if (!config.isTest) return;
  throw new Error(
    'makeProposal: refusing to run under NODE_ENV=test — this is a live, billed call to the Agent SDK. ' +
      'Inject a proposer (see ProposeForReadingOptions.proposer) instead of relying on the default reaching this function.',
  );
}

/**
 * Run the proposer: one model call, no tools, over a reading already on file.
 *
 * `catalogue` is computed once and threaded through both the prompt
 * (`renderCatalogue`) and the interpretation (`interpretProposerResponse`),
 * so what the model was shown and what its answer is checked against can
 * never be two different catalogues.
 */
export async function makeProposal(request: ProposeRequest): Promise<ProposeOutcome> {
  refuseUnderTest();
  const catalogue = capabilityCatalogue(request.bundle, request.provenance, {
    rampLevel: request.rampLevel,
  });

  const options: Options = {
    systemPrompt: buildProposalSystemPrompt(request.bundle, renderCatalogue(catalogue)),
    // No tools at all. The proposer reasons about what should happen; it does
    // not make anything happen. A proposer that could act would be a second,
    // ungated path to every capability in the system — the same reasoning
    // `src/sdk/planner.ts` states for the planner, which shares this shape.
    tools: [],
    // Named, not defaulted, and the one constant used both here and for the
    // stored attribution — see the comment on `PROPOSER_MODEL`.
    model: PROPOSER_MODEL,
    // Load no settings from disk. Omitting this loads this repo's
    // .claude/settings.json and the operator's own ~/.claude/settings.json —
    // plugins, hooks, MCP connectors — into a call whose whole design is that
    // it has no authority beyond producing text. See `know-reader.ts` for the
    // incident this guards against.
    settingSources: [],
    // Name what the subprocess gets rather than inheriting process.env, which
    // config.ts has already populated from .env with the database
    // credentials.
    env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
    permissionMode: 'default',
    // A proposal is one answer, not a conversation. Bounded for the same
    // cost-incident reason `makePlan` bounds the planner.
    maxTurns: 3,
  };

  let raw = '';
  for await (const message of query({ prompt: renderReadingForProposal(request.reading), options })) {
    if (message.type === 'result' && message.subtype === 'success') raw = message.result;
  }

  return interpretProposerResponse(raw, request.reading, catalogue);
}
