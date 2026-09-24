import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { PolicyBundle } from '../domain/policy.js';
import { loadEnvelopeWithChild } from '../governance/envelope-store.js';
import { loadVerdict } from '../governance/verdict-store.js';
import { createJob, loadJob, transition, type Job } from '../orchestrator/jobs.js';
import {
  buildJudgeOptions,
  buildJudgeSystemPrompt,
  GOV_VERIFY_MODEL,
  interpretJudgeResponse,
  judgeWithModel,
  MAX_QUESTION_CHARS,
  verifyDraft,
  type AwaitingDelegation,
  type Judge,
  type VerifyDraftInput,
  type VerifyDraftResult,
} from './gov-verify.js';

const BUSINESS = 'test-business';

/** `Verdict` carries no `status` field at all, so the two arms of
 * `VerifyDraftResult` are told apart by presence of the field, not by a
 * shared discriminant TS can narrow on directly. */
function isAwaitingDelegation(result: VerifyDraftResult): result is AwaitingDelegation {
  return 'status' in result && result.status === 'awaiting_delegation';
}

async function openVerifyJob(): Promise<{ job: Job; bundle: PolicyBundle }> {
  const bundle = await installCharter(buildCharter({ version: `verify-${ulid()}` }), {
    businessId: BUSINESS,
  });
  const created = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'unknown_external',
    businessId: BUSINESS,
    title: 'verify a draft',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(created.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const job = await loadJob(created.jobId, { businessId: BUSINESS });
  if (job === null) throw new Error('verify job vanished');
  return { job, bundle };
}

function baseInput(job: Job, overrides: Partial<VerifyDraftInput> = {}): VerifyDraftInput {
  return {
    parentJobId: job.jobId,
    documentId: 'doc-quote-1',
    draftText: 'הסכום לתשלום הוא 11,988 ש"ח עד 15/10.',
    sources: ['סה"כ לתשלום: 11988 ש"ח, עד תאריך 15/10'],
    question: 'מה המסמך מבקש מאיתנו, ומהם הפרטים המרכזיים שתשובה צריכה לכלול?',
    answer: null,
    parentEnvelope: null,
    businessId: BUSINESS,
    ...overrides,
  };
}

const throwingJudge: Judge = async () => {
  throw new Error('judge must not be called when the delegation has not answered yet');
};

async function stepResultCount(jobId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM job_step_results WHERE business_id = $1 AND job_id = $2',
    [BUSINESS, jobId],
  );
  return Number(rows[0]?.n ?? '0');
}

describe('verifyDraft — the cheap check runs alone', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * The numeric check is deterministic and free; it must run — and its
   * result must come back — even on the call that only ever delegates and
   * never reaches a judge. A judge that throws if invoked proves the second
   * half: nothing here calls it.
   */
  it('reports ungrounded numbers without any model call', async () => {
    const { job } = await openVerifyJob();
    const result = await verifyDraft(
      baseInput(job, {
        draftText: 'הסכום לתשלום הוא 12,500 ש"ח, וגם 11,988 ש"ח שכבר שולמו.',
        sources: ['סה"כ לתשלום: 11988 ש"ח'],
        judge: throwingJudge,
      }),
    );

    expect(isAwaitingDelegation(result)).toBe(true);
    if (!isAwaitingDelegation(result)) throw new Error('expected awaiting_delegation');
    expect(result.ungroundedNumbers).toEqual(['12500']);
  });

  /** The field is set-shaped by meaning: a repeated ungrounded number is one fact, not three. */
  it('deduplicates a number the draft repeats', async () => {
    const { job } = await openVerifyJob();
    const result = await verifyDraft(
      baseInput(job, {
        draftText: '12,500 ש"ח, ושוב 12500 ש"ח, ושוב 12,500.',
        sources: ['אין קשר לסכום הזה'],
        judge: throwingJudge,
      }),
    );
    if (!isAwaitingDelegation(result)) throw new Error('expected awaiting_delegation');
    expect(result.ungroundedNumbers).toEqual(['12500']);
  });

  /**
   * `gov.verify` cannot open the document — the quarantine boundary this
   * whole module exists to respect — so the only way to learn what it asks
   * is to delegate to `know.reader`. The call must end there rather than
   * wait, and "ended without waiting" is asserted as a STATE fact, not a
   * timing one: no step result for the child exists yet, and no verdict was
   * saved — a version of `verifyDraft` that waited for the child and then
   * judged would produce both.
   */
  it('ends its own run and asks know.reader when it needs the document', async () => {
    const { job } = await openVerifyJob();

    const result = await verifyDraft(baseInput(job, { judge: throwingJudge }));

    expect(isAwaitingDelegation(result)).toBe(true);
    if (!isAwaitingDelegation(result)) throw new Error('expected awaiting_delegation');
    expect(result.childJobId).not.toBeNull();

    const stored = await loadEnvelopeWithChild(result.envelopeId, { businessId: BUSINESS });
    expect(stored).not.toBeNull();
    expect(stored?.envelope.from).toBe('gov.verify');
    expect(stored?.envelope.to).toBe('know.reader');
    expect(stored?.envelope.intent).toBe('read_for_question');
    expect(stored?.childJobId).toBe(result.childJobId);

    const parent = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(parent?.phase).toBe('followup');

    const childJobId = result.childJobId;
    if (childJobId === null) throw new Error('expected a child job id');
    const child = await loadJob(childJobId, { businessId: BUSINESS });
    expect(child).not.toBeNull();
    expect(child?.phase).toBe('execute');

    // The state a waiting-then-judging implementation could not produce:
    // nothing ran the child's one step, and nothing was ever judged or saved.
    expect(await stepResultCount(childJobId)).toBe(0);
    expect(await loadVerdict(job.jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('runs the judge once an answer is available, saves the verdict, and reads it back', async () => {
    const { job } = await openVerifyJob();
    let calls = 0;
    const stubJudge: Judge = async (request) => {
      calls += 1;
      expect(request.question).toContain('המסמך');
      expect(request.answer).toBe('המסמך מבקש אישור תשלום של 11988 ש"ח עד 15/10');
      return {
        status: 'judged',
        raw: '{}',
        criteria: [
          {
            id: 'answers_question',
            statement: 'הטיוטה עונה על הבקשה',
            severity: 'must',
            passed: true,
            detail: 'הטיוטה מאשרת את הסכום והתאריך',
          },
        ],
      };
    };

    const result = await verifyDraft(
      baseInput(job, {
        // A real ungrounded number here, so this test can tell "computed and
        // non-empty" apart from "never computed" — asserting `toEqual([])`
        // alone cannot.
        draftText: 'הסכום לתשלום הוא 999,999 ש"ח.',
        sources: ['אין קשר לסכום הזה'],
        answer: 'המסמך מבקש אישור תשלום של 11988 ש"ח עד 15/10',
        judge: stubJudge,
      }),
    );

    expect(calls).toBe(1);
    if (!('criteria' in result)) throw new Error('expected a Verdict');
    expect(result.criteria).toHaveLength(1);
    expect(result.ungroundedNumbers).toEqual(['999999']);

    // Round-trip through the store: the persistence contract this module has
    // with Task 9, not merely "saveVerdict was awaited and did not throw".
    const reloaded = await loadVerdict(job.jobId, { businessId: BUSINESS });
    expect(reloaded).toEqual(result);
  });

  /**
   * `requestHelp` can refuse — a job not in `execute` is the simplest way to
   * drive that deterministically, without exhausting a daily cap or an
   * oscillation guard. `verifyDraft` must surface the refusal loudly rather
   * than silently succeeding.
   */
  it('throws when the delegation itself is refused', async () => {
    const bundle = await installCharter(buildCharter({ version: `verify-refused-${ulid()}` }), {
      businessId: BUSINESS,
    });
    const created = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'unknown_external',
      businessId: BUSINESS,
      title: 'never reaches execute',
    });
    // Left in `intake` — `requestHelp` requires `execute`.
    const job = await loadJob(created.jobId, { businessId: BUSINESS });
    if (job === null) throw new Error('job vanished');

    await expect(verifyDraft(baseInput(job, { judge: throwingJudge }))).rejects.toThrow(
      /could not delegate to know.reader/,
    );
  });

  it('rejects a question longer than the registry allows', async () => {
    const { job } = await openVerifyJob();
    await expect(
      verifyDraft(baseInput(job, { question: 'x'.repeat(MAX_QUESTION_CHARS + 1), judge: throwingJudge })),
    ).rejects.toThrow();
  });
});

/**
 * `from: 'gov.verify'` in the `requestHelp` call must stay a literal, the
 * same reasoning and the same style `conductor-invariants.test.ts` and
 * `instruction-invariants.test.ts` apply to their own calls' `provenance:`.
 * Making the field caller-injectable instead would keep every OTHER test in
 * this file green — none of them supply a different agent name — which is
 * exactly why the property needs its own structural pin.
 */
describe('the from literal in the delegation call', () => {
  function callBlock(src: string, name: string): string {
    const marker = `${name}(`;
    const start = src.indexOf(marker);
    if (start === -1) throw new Error(`no call to ${name}(...) found`);
    let depth = 0;
    let i = start + name.length;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    return src.slice(start, i);
  }

  it('sets from to the literal gov.verify, never an expression a caller could steer', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'sdk', 'gov-verify.ts'), 'utf8');
    const block = callBlock(source, 'requestHelp');
    const match = /from\s*:\s*([^,\n}]+)/.exec(block);
    expect(match, 'requestHelp call must set from').not.toBeNull();
    expect((match?.[1] ?? '').trim()).toBe("'gov.verify'");
  });
});

const SRC = join(process.cwd(), 'src');
const GOV_VERIFY_PATH = join(SRC, 'sdk', 'gov-verify.ts');

/**
 * Every import specifier in `source`, in any of the three forms a module can
 * take: `from '...'`, `import('...')`, and the bare side-effect
 * `import '...'`. Round 1's version required the `from` keyword and checked
 * only lines starting with `import` — so a Prettier-shaped multi-line import
 * (the opening `import {` on one line, the `from '...'` on the next) passed
 * every assertion untouched, and `delegate.ts` already carries two of those.
 * Matched over the WHOLE file text, not line by line, for exactly that
 * reason — a specifier is not obliged to share a line with the keyword that
 * introduces it.
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

/** A relative specifier resolved to the `.ts` file it names, or `null` for a package import. */
function resolveRelativeImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  let resolved = resolvePath(dirname(fromFile), spec);
  if (resolved.endsWith('.js')) resolved = `${resolved.slice(0, -3)}.ts`;
  return resolved;
}

/**
 * Every local module file reachable from `entry`, walking `import`
 * statements transitively rather than checking `entry`'s own source alone.
 * `gov-verify.ts` importing `planner.ts` — which imports `local-tools.ts` for
 * an unrelated reason (rendering local tool contracts) and THAT imports
 * `readDocument` — was exactly the violation a one-hop check could not see:
 * no line in `gov-verify.ts` itself ever named `documents/` or
 * `readDocument`, so a check of its own source, however thorough, stayed
 * green while the quarantine was already crossed.
 */
function transitiveLocalImports(entry: string): string[] {
  const seen = new Set<string>();
  const queue: string[] = [resolvePath(entry)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveRelativeImport(file, spec);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
}

describe('gov.verify never opens the document itself', () => {
  /**
   * The quarantine boundary is the entire reason this agent has to delegate
   * rather than read. Two checks, neither of which alone would have caught
   * round 1's defect: a path-shaped regex over the WHOLE file (not lines
   * filtered to ones starting with `import`, which a multi-line import form
   * slips past), and a transitive walk of every module `gov-verify.ts`
   * reaches — because the crossing was two hops away, through `planner.ts`,
   * not a direct import this file's own text ever named.
   */
  it('names no forbidden path anywhere in its own source, in any import form', () => {
    const source = readFileSync(GOV_VERIFY_PATH, 'utf8');
    const specs = importSpecifiers(source);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec, `gov-verify.ts imports ${spec}`).not.toMatch(/[\\/]documents[\\/]/);
    }
  });

  /**
   * The real check: walk every module reachable from `gov-verify.ts` — not
   * just what it names directly — and demand that none of them lives under
   * `src/documents/`, the directory that holds every module that reads
   * document content (`read.ts`, `store.ts`'s `loadArtifacts`, and anything
   * added there later). A named-function check (`loadArtifacts`,
   * `readDocument`) would miss a third function added to that directory
   * tomorrow; a directory-shaped check does not need to know its name.
   */
  it('reaches no module under documents/ transitively, through any import chain', () => {
    const reached = transitiveLocalImports(GOV_VERIFY_PATH);
    expect(reached.length).toBeGreaterThan(1); // more than just itself
    const offenders = reached.filter((file) => /[\\/]documents[\\/]/.test(file));
    expect(offenders).toEqual([]);
  });
});

describe('the judge call', () => {
  /**
   * The suite runs with NODE_ENV=test and this machine carries a real
   * ANTHROPIC_API_KEY. A test that reached the real call would bill the
   * owner silently — the same reasoning `curator.test.ts` and
   * `proposer.test.ts` state for their own guards.
   */
  it('refuses under NODE_ENV=test without an injected judge', async () => {
    // No database needed: `refuseUnderTest` throws before `request.bundle`
    // (or anything else about the request) is ever touched.
    const stubBundle = { promptFragments: { 'gov.verify': '' } } as unknown as PolicyBundle;
    await expect(
      judgeWithModel({ bundle: stubBundle, question: 'x', answer: 'y', draftText: 'z' }),
    ).rejects.toThrow(/NODE_ENV=test/);
  });

  it('names the model it runs on, rather than taking the CLI default', () => {
    expect(GOV_VERIFY_MODEL).toBe('sonnet');
  });

  /**
   * A minimal stand-in `PolicyBundle`, only ever used to check the FIXED,
   * code-owned half of the prompt (`buildJudgeSystemPrompt` puts the charter
   * fragment first, asserted on separately below) — a real compiled bundle
   * is unnecessary weight for these assertions.
   */
  function bundleWithFragment(fragment: string): PolicyBundle {
    return { promptFragments: { 'gov.verify': fragment } } as unknown as PolicyBundle;
  }

  it('states the envelope: a single object with a criteria array', () => {
    const prompt = buildJudgeSystemPrompt(bundleWithFragment(''));
    expect(prompt).toContain('criteria');
    expect(prompt).toContain('אובייקט');
  });

  it('states the two severities', () => {
    const prompt = buildJudgeSystemPrompt(bundleWithFragment(''));
    expect(prompt).toContain('must');
    expect(prompt).toContain('should');
  });

  it('warns explicitly that the fenced answer is untrusted, quoted content', () => {
    const prompt = buildJudgeSystemPrompt(bundleWithFragment(''));
    expect(prompt).toContain('אינו אמין');
  });

  it('puts the owner-editable charter fragment first, before the fixed contract', () => {
    const prompt = buildJudgeSystemPrompt(bundleWithFragment('MARKER-FROM-CHARTER'));
    expect(prompt.indexOf('MARKER-FROM-CHARTER')).toBeLessThan(prompt.indexOf('criteria'));
  });

  /**
   * `tools: []` is the single most safety-relevant line in this module — a
   * judge that could act would be a second, ungated path to every capability
   * in the system. It was entirely uncovered before this test: `judgeWithModel`
   * always throws under test, so nothing ever built the `Options` object and
   * looked at it.
   */
  it('builds an Options object with no tools, no loaded settings, and a PATH-only env', () => {
    const options = buildJudgeOptions({
      bundle: bundleWithFragment(''),
      question: 'q',
      answer: 'a',
      draftText: 'd',
    });
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.model).toBe(GOV_VERIFY_MODEL);
    expect(Object.keys(options.env ?? {})).toEqual(
      process.env['PATH'] === undefined ? [] : ['PATH'],
    );
  });
});

describe('interpretJudgeResponse', () => {
  it('parses a well-formed criteria object', () => {
    const raw = JSON.stringify({
      criteria: [
        {
          id: 'answers_question',
          statement: 'עונה על הבקשה',
          severity: 'must',
          passed: true,
          detail: 'הכל תואם',
        },
      ],
    });
    const outcome = interpretJudgeResponse(raw);
    expect(outcome.status).toBe('judged');
    if (outcome.status !== 'judged') throw new Error('expected judged');
    expect(outcome.criteria).toHaveLength(1);
  });

  it('tolerates prose around the JSON object', () => {
    const raw = `הנה התשובה:\n${JSON.stringify({
      criteria: [
        { id: 'x', statement: 'y', severity: 'should', passed: false, detail: 'z' },
      ],
    })}\nתודה.`;
    const outcome = interpretJudgeResponse(raw);
    expect(outcome.status).toBe('judged');
  });

  it('reports unjudged when nothing parses as a criteria object', () => {
    const outcome = interpretJudgeResponse('not json at all');
    expect(outcome.status).toBe('unjudged');
  });

  it('reports unjudged when criteria is an empty array', () => {
    const outcome = interpretJudgeResponse(JSON.stringify({ criteria: [] }));
    expect(outcome.status).toBe('unjudged');
  });
});
