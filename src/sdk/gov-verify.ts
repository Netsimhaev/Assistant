/**
 * `gov.verify` — quality control, and the first agent in this project whose
 * own quarantine forces it to ask another agent for help.
 *
 * The agent table (`docs/01-agents.md`, `charter/render.ts`) defines this
 * agent as artefacts-only: it verifies a result against acceptance criteria
 * "in fresh context, without knowing how the work was done" — and it holds no
 * tool that opens a document. That is not a missing feature here; it is the
 * one property the rest of the system leans on. If `gov.verify` could read
 * the hostile text a draft was written from, its verdict would be exactly as
 * exposed to injection as the draft it is meant to check, and a sign-off from
 * it would mean nothing.
 *
 * So when it needs to know what the document actually asked, it cannot open
 * the document itself — it asks `know.reader`, the one agent whose whole job
 * is to read hostile text and hand back a bounded answer. **This module must
 * never import `loadArtifacts`, `readDocument`, or any other module that
 * reads document content** — `gov-verify.test.ts`'s quarantine invariant
 * greps this file's own source for exactly that, the same way
 * `erasure-invariants.test.ts` greps for an import of the eraser. Everything
 * this module needs about the document — the deterministic extraction for
 * numeric grounding, and eventually the delegated answer — arrives as plain
 * strings its caller already resolved.
 *
 * **Three checks, cheapest first.**
 * 1. Numeric grounding (`ungroundedNumbers`, Task 9) — deterministic, zero
 *    tokens, runs against the document's own extraction. Always computed
 *    first, whether or not a model is ever reached this call.
 * 2. Delegation (`requestHelp`, Task 6) — no model call of its own; it opens
 *    a child job for `know.reader` and returns. `verifyDraft` does the same:
 *    it does NOT wait for the child to answer. It ends its own run and
 *    reports `awaiting_delegation`, exactly the way `requestHelp`'s own
 *    caller (`agent.request_help` in `local-tools.ts`) never blocks on its
 *    child either. A parent job that is short and cheap when it is only
 *    waiting is a parent job that survives a crash while it waits.
 * 3. Judgment — one model call, the only one of the three that costs money,
 *    and it only runs once the caller has resolved what the document asked
 *    (`input.answer`) and hands it back in a second call.
 *
 * `judgeWithModel` carries the same restriction as `curateWithModel`
 * (`src/sdk/curator.ts`) and for the same reason: `tools: []`, `env: { PATH }`
 * only, and the parse (`interpretJudgeResponse`) separated from the network
 * call so it is testable without one. Its input is a draft written about a
 * document somebody else wrote, and an answer extracted from that same
 * document by a quarantined reader — hostile by construction, twice over.
 */
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import type { AgentEnvelope } from '../domain/envelope.js';
import type { PolicyBundle } from '../domain/policy.js';
import { ungroundedNumbers } from '../governance/numeric-grounding.js';
import { Verdict, saveVerdict } from '../governance/verdict-store.js';
import { requestHelp } from '../orchestrator/delegate.js';
import { extractJsonObjects } from './planner.js';

/**
 * The model `gov.verify` judges on.
 *
 * Sonnet 5, one verifier rather than one per action class (docs/01-agents.md):
 * independence needs a different context, not a different persona, and
 * per-intent verification recipes (not built here) give the specialisation
 * without a roster of models to keep in sync.
 *
 * Exported and declared once for the same reason `PROPOSER_MODEL` is: the
 * `Options` this module hands the SDK and any future stored attribution must
 * never be two separate literals that can drift.
 */
export const GOV_VERIFY_MODEL = 'sonnet';

export const JUDGE_SYSTEM_PROMPT =
  'את/ה gov.verify — בקרת האיכות. את/ה בודק/ת תוצאה מוגמרת בהקשר טרי, ' +
  'בלי לדעת איך היא הופקה. אין לך כלים ואינך יכול לפעול — רק לשפוט. ' +
  'תקבל/י שלושה דברים: השאלה שהופנתה לקורא-הסגר, התשובה שהוא החזיר על מה ' +
  'שהמסמך מבקש בפועל, וטיוטת תגובה שנועדה לענות עליה. ' +
  'החזר/י JSON בלבד — אובייקט יחיד, לא מערך חשוף ולא טקסט מסביבו — עם מפתח ' +
  'אחד בשם "criteria" שערכו מערך של קריטריוני קבלה, אחד לפחות. ' +
  'כל איבר במערך הוא אובייקט עם השדות הבאים בדיוק: ' +
  '"id" — מזהה קצר וקריא לקריטריון (למשל "answers_question"); ' +
  '"statement" — משפט אחד שמתאר את הקריטריון; ' +
  '"severity" — "must" אם אי-עמידה בקריטריון פוסלת את הטיוטה, ' +
  'או "should" אם מדובר בשיפור רצוי בלבד; ' +
  '"passed" — true או false, האם הטיוטה עומדת בקריטריון הזה בפועל; ' +
  '"detail" — הסבר קצר לפסיקה, שמצטט מהטיוטה או מהתשובה כשאפשר. ' +
  'הקריטריון הראשון חייב להיות "does the draft answer what was asked" — ' +
  'האם הטיוטה עונה בפועל על מה שהתשובה של קורא-הסגר אומרת שהמסמך מבקש. ' +
  'דוגמה לתשובה תקנית ויחידה: ' +
  '{"criteria":[{"id":"answers_question","statement":"הטיוטה עונה על מה שהמסמך ביקש",' +
  '"severity":"must","passed":true,"detail":"הטיוטה מאשרת את התאריך שהתבקש"}]}. ' +
  'שפוט/י רק את מה שדורש שיפוט — כל מה שניתן לבדיקה דטרמיניסטית כבר נבדק מחוץ אליך.';

function renderJudgePrompt(request: JudgeRequest): string {
  return (
    `# השאלה שהופנתה לקורא-הסגר\n${request.question}\n\n` +
    `# התשובה שקורא-הסגר החזיר\n${request.answer}\n\n` +
    `# הטיוטה שיש לשפוט\n${request.draftText}`
  );
}

export interface JudgeRequest {
  /** What `gov.verify` asked `know.reader` — the delegated question. */
  question: string;
  /** What `know.reader` answered — what the document actually asks for. */
  answer: string;
  /** The draft being verified against that answer. */
  draftText: string;
}

/**
 * What a judge call produced. Free text is not among the possibilities, the
 * same shape `ReadOutcome` and `ProposeOutcome` already take.
 */
export type JudgeOutcome =
  | { status: 'judged'; criteria: Verdict['criteria']; raw: string }
  | { status: 'unjudged'; reason: string; raw: string };

/**
 * Everything about a judge call except the model call itself, separated so it
 * is testable without an API key — the same split `interpretReaderResponse`
 * and `interpretProposerResponse` take from their own model calls.
 */
export function interpretJudgeResponse(raw: string): JudgeOutcome {
  const candidates = extractJsonObjects(raw);
  if (candidates.length === 0) {
    return { status: 'unjudged', reason: 'no JSON object in the response', raw };
  }

  const CriteriaOnly = Verdict.pick({ criteria: true });
  let lastProblem = 'schema mismatch';
  for (const candidate of candidates) {
    const parsed = CriteriaOnly.safeParse(candidate);
    if (parsed.success) return { status: 'judged', criteria: parsed.data.criteria, raw };
    lastProblem = parsed.error.issues[0]?.message ?? lastProblem;
  }
  return { status: 'unjudged', reason: lastProblem, raw };
}

export type Judge = (request: JudgeRequest) => Promise<JudgeOutcome>;

/**
 * Same guard as `curateWithModel`'s (`src/sdk/curator.ts`), `runKnowReader`'s
 * and `makeProposal`'s, and for the same reason: the protection against a
 * live, billed call under test must not rest on test discipline alone
 * (CLAUDE.md, "ההגנה מפני קריאה חיה לא תישען רק על משמעת מבחנים").
 * `VerifyDraftInput.judge` is the seam a test injects instead — injecting
 * bypasses this guard entirely, because the guard lives in the DEFAULT this
 * function is, not in the seam itself.
 */
function refuseUnderTest(): void {
  if (!config.isTest) return;
  throw new Error(
    'judgeWithModel: refusing to run under NODE_ENV=test — this is a live, billed call to the Agent SDK. ' +
      'Inject a judge (see VerifyDraftInput.judge) instead of relying on the default reaching this function.',
  );
}

export const judgeWithModel: Judge = async (request) => {
  refuseUnderTest();

  const options: Options = {
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    // No tools at all — the same reasoning `curator.ts` and `proposer.ts`
    // state: a judge that could act would be a second, ungated path to every
    // capability in the system, and this one judges a draft it did not write
    // about a document it never opened.
    tools: [],
    model: GOV_VERIFY_MODEL,
    settingSources: [],
    env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
    permissionMode: 'default',
    maxTurns: 3,
  };

  let raw = '';
  for await (const message of query({ prompt: renderJudgePrompt(request), options })) {
    if (message.type === 'result' && message.subtype === 'success') raw = message.result;
  }

  return interpretJudgeResponse(raw);
};

export interface VerifyDraftInput {
  /**
   * `gov.verify`'s own job — the one `requestHelp` parks in `followup` while
   * it waits on `know.reader`. Must already be in `execute`, the same
   * precondition `requestHelp` itself enforces.
   */
  parentJobId: string;
  /** The active charter — loaded by the caller, never rebuilt here (see
   * this module's own docblock and `delegate.ts`'s on `requestHelp`): a
   * caller that builds its own bundle chooses its own collaboration graph. */
  bundle: PolicyBundle;
  /** The document the draft is meant to answer. */
  documentId: string;
  /** The draft being verified. */
  draftText: string;
  /**
   * The document's deterministic extraction — `document_artifacts` text,
   * exactly as `ungroundedNumbers`'s `sources` parameter expects. Supplied by
   * the caller: this module never loads artifacts itself.
   */
  sources: readonly string[];
  /** What to ask `know.reader` about the document. */
  question: string;
  /**
   * What `know.reader` answered, once the delegation this function itself
   * requested has come back — resolved and handed in by the caller, since
   * this module never reads a child job's own result. `null` means "not
   * resolved yet", and is what triggers the delegation.
   */
  answer: string | null;
  /**
   * The envelope that caused `gov.verify`'s OWN job to run, or `null` when it
   * is a root job — passed straight through to `requestHelp`, which re-verifies
   * it against the stored row rather than trusting it.
   */
  parentEnvelope: AgentEnvelope | null;
  businessId?: string;
  now?: Date;
  /** Injected by tests. Production leaves it unset and gets the billed call. */
  judge?: Judge;
}

/**
 * `gov.verify` still needs the document read, and has ended its own run to
 * ask for it. `childJobId` is `null` only in the same crash window
 * `requestHelp`'s own docblock names — the envelope committed but no child
 * was ever attached — which a caller repairs the same way any other caller
 * of `requestHelp` does.
 *
 * `ungroundedNumbers` rides along even here: the cheap check already ran
 * (see this module's docblock, "cheapest first") and there is no reason to
 * make a caller wait for the judge to see it.
 */
export interface AwaitingDelegation {
  status: 'awaiting_delegation';
  envelopeId: string;
  childJobId: string | null;
  ungroundedNumbers: string[];
}

export type VerifyDraftResult = Verdict | AwaitingDelegation;

/**
 * Run `gov.verify`'s three checks and return either a finished `Verdict` or a
 * marker that this call ended by delegating.
 *
 * The order is fixed and matters: `ungroundedNumbers` runs BEFORE any
 * delegation or model call, unconditionally — the cheapest check runs alone,
 * even on the call that only ever delegates and never reaches the judge.
 */
export async function verifyDraft(input: VerifyDraftInput): Promise<VerifyDraftResult> {
  const businessId = input.businessId ?? config.businessId;

  // Check 1 — deterministic, zero tokens, runs first no matter what happens
  // next.
  const ungrounded = ungroundedNumbers(input.draftText, input.sources);

  // Check 2 — the delegation is forced by the quarantine boundary itself:
  // `gov.verify` has no other way to learn what the document asks. This
  // function does not wait for `know.reader` to answer; it ends its own run
  // the moment the request is opened.
  if (input.answer === null) {
    const result = await requestHelp({
      parentJobId: input.parentJobId,
      // Literal, not threaded from a caller — the same reasoning
      // `conduct.ts` and `instruct.ts` apply to their own `provenance`
      // literals: a caller that could name the delegating agent could
      // impersonate one it is not.
      from: 'gov.verify',
      to: 'know.reader',
      intent: 'read_for_question',
      payload: { question: input.question },
      contextRefs: [{ kind: 'document', documentId: input.documentId }],
      bundle: input.bundle,
      parentEnvelope: input.parentEnvelope,
      businessId,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });

    if (result.status === 'refused') {
      throw new Error(
        `verifyDraft: could not delegate to know.reader (${result.code}): ${result.reason}`,
      );
    }

    return {
      status: 'awaiting_delegation',
      envelopeId: result.envelopeId,
      childJobId: result.childJobId,
      ungroundedNumbers: ungrounded,
    };
  }

  // Check 3 — the only one of the three that costs money, and only reached
  // once the caller hands back what know.reader answered.
  const judge = input.judge ?? judgeWithModel;
  const outcome = await judge({
    question: input.question,
    answer: input.answer,
    draftText: input.draftText,
  });
  if (outcome.status === 'unjudged') {
    throw new Error(`verifyDraft: the judge did not return a usable verdict — ${outcome.reason}`);
  }

  const verdict: Verdict = { criteria: outcome.criteria, ungroundedNumbers: ungrounded };
  await saveVerdict(input.parentJobId, verdict, { businessId });
  return verdict;
}
