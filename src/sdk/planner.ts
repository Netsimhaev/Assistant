import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { Plan, planProblems } from '../domain/plan.js';
import type { PolicyBundle } from '../domain/policy.js';
import type { AutonomyLevel, TrustLevel } from '../domain/trust.js';
import { READ_ONLY_CLASS_LABEL, capabilityCatalogue, renderCatalogue } from '../orchestrator/catalogue.js';

export interface PlanRequest {
  bundle: PolicyBundle;
  /** Structured intents from triage — never the raw message. */
  intents: unknown;
  provenance: TrustLevel;
  rampLevel: AutonomyLevel;
  /**
   * The owner's own words, when the job came through the instruction door.
   *
   * Mutually exclusive with `intents` in practice: triage produces intents
   * from content nobody vouches for, and this carries a sentence the owner
   * typed behind a session. Both land in the same final section of the prompt
   * so the cacheable prefix above it is untouched either way — see the
   * assembly order in `buildPlannerPrompt`.
   *
   * The planner's own header says "never the raw message", and that rule was
   * written about hostile input. Spec §4 of the instruction door records the
   * deliberate exception and why it does not extend to any other caller.
   */
  instruction?: string;
}

export type PlanOutcome =
  | { status: 'planned'; plan: Plan }
  | { status: 'unparseable'; raw: string; reason: string };

/**
 * The planner: one model call that turns structured intents into a Plan.
 *
 * The model is in this path, which is why everything it produces is validated
 * before it is worth anything — `Plan.safeParse` for shape, `planProblems` for
 * the DAG, and `runPlan` re-checks feasibility against the same tables the
 * gate reads. A plan is a proposal, not an authorisation.
 *
 * The prompt is assembled stable-part-first: charter summary, then the
 * capability catalogue, then the intents. Everything before the intents is
 * byte-identical across jobs, which is the only way the cached prefix survives
 * (docs/08-risks.md — verify with `usage.cache_read_input_tokens`, and if it
 * is zero across runs something is invalidating the prefix silently).
 */
export function buildPlannerPrompt(request: PlanRequest): string {
  const catalogue = renderCatalogue(
    capabilityCatalogue(request.bundle, request.provenance, {
      rampLevel: request.rampLevel,
    }),
  );

  return [
    '# התקנון',
    request.bundle.plainLanguage,
    '',
    '# מה כל סוכן יכול לעשות עכשיו',
    'הרשימה כבר לוקחת בחשבון את מקור השרשרת ואת רמת האוטונומיה. כלי שאינו ברשימה ייענה בסירוב.',
    catalogue,
    '',
    '# מה לייצר',
    'החזר JSON יחיד התואם לסכמה, בלי טקסט לפניו או אחריו:',
    '{"goal": string, "assumptions": string[], "clarifyingQuestion": string|null,',
    ' "steps": [{"id": string, "agent": string, "intent": string, "toolName": string,',
    '            "input": object, "dependsOn": string[], "expectedActionClass": string|null}],',
    ' "estimatedCostMinor": number}',
    '',
    'כללים: מזהי צעדים ייחודיים · dependsOn מפנה רק לצעדים בתוכנית הזו · בלי מעגלים ·',
    'שאלת הבהרה אחת לכל היותר · expectedActionClass הוא מה שאתה מאמין שהצעד ייחשב,',
    'ואי-התאמה לשער תפסול את התוכנית — עדיף null מאשר ניחוש.',
    // Built from the constant, not retyped: a hand-copied label drifts the
    // first time the rendering changes, and this rule exists precisely
    // because the model copies the label it is shown (L1).
    `כלי שהקטלוג מסמן «${READ_ONLY_CLASS_LABEL}» חייב לקבל \`null\` בשדה הזה. ` +
      'הסימון הזה אינו מחלקת פעולה ואין להעתיק אותו כמחרוזת — תוכנית שתעשה זאת תיפסל.',
    '',
    // Last, and the only part that varies per job: everything above is the
    // cacheable prefix.
    ...(request.instruction === undefined
      ? ['# ה-intents', JSON.stringify(request.intents)]
      : ['# ההוראה מבעל העסק', request.instruction]),
  ].join('\n');
}

/**
 * The one guard standing between the test suite and a billed call.
 *
 * This machine carries a real `ANTHROPIC_API_KEY` (CLAUDE.md says so). No
 * committed test calls `makePlan` on purpose — `runInstruction` takes an
 * injectable `planner`, and every `instruct.test.ts` case supplies one — but
 * `src/dashboard/server.ts`'s `/instruct` and `/instruct/:jobId/answer`
 * routes call `runInstruction` with no `planner` option at all, because
 * production must reach the real one. `server.test.ts` drives those routes
 * over real HTTP and relies entirely on oversized input — three separate
 * character counts (an instruction over 4,000 chars, an answer over 4,000,
 * and an original-plus-answer pair that only exceeds the cap once joined) —
 * refusing before `createJob` so the planner is never reached. A test that
 * quietly gets one of those three counts wrong stops refusing early and
 * falls through to this function instead, and nothing before this line would
 * have stopped it: that is precisely what happened in two review rounds.
 *
 * `config.isTest` mirrors `vitest.config.ts`'s `env.NODE_ENV = 'test'`, so
 * this fires for every test file without any of them opting in, and does not
 * fire for the manual `npm run sdk:*` scripts or the dashboard in
 * production, neither of which run under `NODE_ENV=test`.
 */
function refuseUnderTest(): void {
  if (!config.isTest) return;
  throw new Error(
    'makePlan: refusing to run under NODE_ENV=test — this is a live, billed call to the Agent SDK. ' +
      'Inject a planner (see RunInstructionOptions.planner) instead of relying on the default reaching this function.',
  );
}

export async function makePlan(request: PlanRequest): Promise<PlanOutcome> {
  refuseUnderTest();
  const options: Options = {
    systemPrompt:
      'אתה המתכנן. אתה מקבל intents מובנים או הוראה ישירה מבעל העסק, ומחזיר תוכנית JSON. ' +
      'אינך מבצע דבר ואין לך כלים — התוכנית שלך היא הצעה שעוברת אימות.',
    // No tools at all. The planner reasons; it does not act, and a planner
    // that could act would be a second, ungated path to every capability.
    tools: [],
    settingSources: [],
    env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
    permissionMode: 'default',
    maxTurns: 3,
  };

  let raw = '';
  for await (const message of query({ prompt: buildPlannerPrompt(request), options })) {
    if (message.type === 'result' && message.subtype === 'success') raw = message.result;
  }

  return parsePlan(raw);
}

/**
 * Parse and validate what the model returned.
 *
 * Separated from the call so it can be tested without one — the interesting
 * failures here are malformed output, not network behaviour.
 */
export function parsePlan(raw: string): PlanOutcome {
  const candidates = extractJsonObjects(raw);
  if (candidates.length === 0) {
    return { status: 'unparseable', raw, reason: 'no JSON object in the response' };
  }

  // Every candidate is tried, not just the first. A response that opens with an
  // illustrative object — "for example: {...}" — and then gives the real plan
  // would otherwise be rejected on the example, which is a confusing failure
  // for something the model does routinely.
  let reason = 'schema mismatch';
  for (const candidate of candidates) {
    const parsed = Plan.safeParse(candidate);
    if (!parsed.success) {
      reason = parsed.error.issues[0]?.message ?? reason;
      continue;
    }

    const problems = planProblems(parsed.data);
    if (problems.length > 0) {
      // A well-formed plan that is not a DAG is a real answer to report, not
      // something to keep looking past.
      return { status: 'unparseable', raw, reason: `plan is not a DAG: ${problems[0]?.kind}` };
    }

    return { status: 'planned', plan: parsed.data };
  }

  return { status: 'unparseable', raw, reason };
}

/**
 * Every balanced JSON object in a response that may be wrapped in prose or a
 * fenced block.
 *
 * Balanced scanning rather than first `{` to last `}`: across two objects that
 * span is not valid JSON at all. Returning every candidate rather than the
 * first lets the caller decide which one is the plan — being parseable and
 * being a plan are different questions.
 */
function extractJsonObjects(raw: string): unknown[] {
  const text = raw.replace(/```(?:json)?/g, '');
  const found: unknown[] = [];

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            found.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            // Not valid on its own; the next opening brace may still be.
          }
          break;
        }
      }
    }
  }
  return found;
}
