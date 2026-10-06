/**
 * Structural, in the style of `conductor-invariants.test.ts`. Three properties
 * a future edit could remove while every behavioural test stayed green.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ActionClass } from '../domain/action.js';
import { TYPED_RECIPIENT_CLASSES } from '../governance/typed-recipients.js';

const SRC = join(process.cwd(), 'src');
const source = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** The text of one call, by paren depth, so two calls cannot cover for each other. */
function callBlock(text: string, callee: string): string {
  const start = text.indexOf(`${callee}(`);
  if (start === -1) throw new Error(`no call to ${callee}`);
  let depth = 0;
  for (let i = start + callee.length; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced call to ${callee}`);
}

describe('the instruction door cannot widen its own authority', () => {
  it('stamps its job as boss with a literal, not a value a caller supplies', () => {
    const block = callBlock(source('orchestrator/instruct.ts'), 'createJob');
    expect(block).toContain("provenance: 'boss'");
    // Only the literal is acceptable on the right of `provenance:` — an
    // allowlist, not a denylist of identifier names.
    const assignments = block.match(/provenance:\s*[^,\n]+/g) ?? [];
    expect(assignments).toEqual(["provenance: 'boss'"]);
  });

  it('admits only the named classes to a typed-recipient grant', () => {
    const admitted = ActionClass.options.filter((cls) => TYPED_RECIPIENT_CLASSES.includes(cls));
    expect(admitted).toEqual([...TYPED_RECIPIENT_CLASSES]);
    // The four the owner chose to keep asking about, named so a future edit
    // that adds one has to do it here in the open.
    for (const cls of ['purchase.place', 'commitment.make', 'quote.issue', 'discount.grant'] as const) {
      expect(TYPED_RECIPIENT_CLASSES).not.toContain(cls);
    }
  });

  /**
   * Owner's decision 2 (05/10/2026). `provenance` is a literal here because
   * it has one correct value on this path; `textOrigin` cannot be, because
   * it genuinely differs by door — a dashboard form is the owner's
   * keystrokes, a WhatsApp voice note is a transcription provider's model
   * output that nobody typed. So the property is the next strongest one
   * available: the value weighed for authority is the one the CALLER stated,
   * never one this module invented or defaulted.
   *
   * An allowlist of exactly one assignment, the same shape the provenance
   * test above uses. `options.textOrigin ?? 'typed'` — the single most
   * likely well-meant edit, and the one that would hand every future door
   * the permissive answer for free — fails here.
   */
  it('takes the text origin from its caller and substitutes none of its own', () => {
    const src = source('orchestrator/instruct.ts');
    const assignments = src.match(/const textOrigin[^;]+;/g) ?? [];
    expect(assignments).toEqual(['const textOrigin = options.textOrigin;']);

    // And it reaches the authority filter by name, so the pinned value is
    // provably what that filter weighs. A literal at the call site would
    // satisfy the required field while leaving the line above dead.
    const block = callBlock(src, 'authorisedRecipients');
    expect(block).toContain('textOrigin,');
  });

  /**
   * The same property one layer out, for the producer no behavioural test can
   * reach. `POST /instruct/:jobId/answer` re-plans the JOIN of a typed answer
   * and a parked instruction that may have arrived as a WhatsApp voice note,
   * so the join is the owner's own bytes only if the stored half was too —
   * and the route cannot be driven end to end under test at all, because it
   * deliberately calls `runInstruction` with no injected planner and
   * `refuseUnderTest` (`src/sdk/planner.ts`) stops the real one. Without this
   * pin, replacing that expression with a bare `'typed'` would reopen the
   * laundering path through the dashboard with every test still green.
   *
   * Pinned as the exact expression, the same way the WhatsApp door's own
   * derivation is pinned in `whatsapp-invariants.test.ts`.
   */
  it('derives the answer route origin from the stored instruction, not from the answer', () => {
    const server = source('dashboard/server.ts');
    const derivations = server.match(/textOrigin: instruction\.textOrigin[^,]*,/g) ?? [];
    expect(derivations).toEqual([
      "textOrigin: instruction.textOrigin === 'typed' ? 'typed' : 'transcribed',",
    ]);
    // And the fresh-submission route states its own, so neither of the two
    // call sites can be the one that quietly says nothing: this is a form
    // field from an authenticated owner session, which is his keystrokes.
    expect(server).toContain("textOrigin: 'typed'");
  });

  it('never raises a ramp level or amends the charter from this path', () => {
    for (const file of ['orchestrator/instruct.ts', 'governance/typed-recipients.ts']) {
      expect(source(file)).not.toContain('setRampLevel');
      expect(source(file)).not.toContain('installCharter');
    }
  });
});

/**
 * A fourth property, beyond the three above: nothing mechanically ties
 * `grantAuthorization` to `authorisedRecipients` today. `grantAuthorization`
 * (src/governance/authorization.ts) takes any `{ jobId, actionClass,
 * recipients }` its caller hands it — it checks the job's own stamped
 * provenance, but it has no idea whether `recipients` ever passed through the
 * class allowlist or the typed-verbatim-or-known-to-the-charter check.
 * `proposal-invariants.test.ts`'s "has exactly one writer of
 * job_authorizations" already pins the one file allowed to touch the table
 * with raw SQL; it does not — and by its own design cannot — notice a second
 * *caller* of the exported `grantAuthorization` function that reached the
 * table through that one writer while skipping `authorisedRecipients`
 * entirely. This closes part of that gap: it fails if a second production
 * file contains the literal text `grantAuthorization(`, and it fails if the
 * one remaining call site stops routing through `authorisedRecipients` first
 * or drops the ordering between the two.
 *
 * **What this still does not close.** Both checks below are textual, over
 * the literal identifier `grantAuthorization`. None of the following would be
 * caught: an aliased import (`import { grantAuthorization as grant } from
 * './authorization.js'`, then calling `grant(...)`); a re-export from a third
 * module that a caller imports instead of the original; or a wrapper function
 * — `function widen(x) { return grantAuthorization(x); }` — called from a
 * second production file, since that file's own text never contains the
 * banned literal. Each is a real gap, not a hypothetical one: nothing in this
 * codebase's tooling forbids any of the three. What this test actually locks
 * is narrower and still worth having — a second *literal, unaliased* call to
 * `grantAuthorization(`, and the fixed order inside the one call this
 * codebase currently makes.
 *
 * **The two-part sweep below is coupled to `authorization.ts` by name and
 * path, not just by the function it defines.** `AUTHORIZATION_MODULE` is
 * excluded from the caller search by comparing the swept file's path against
 * a hardcoded `governance/authorization.ts` — the one exclusion needed so the
 * function's own `export async function grantAuthorization(` declaration line
 * doesn't count as a call to itself. A pure rename or move of that module
 * (with every call site updated to match) would make this test fail on a
 * refactor that changed nothing about the property being guarded, rather than
 * on a real regression — the same trade-off `proposal-invariants.test.ts`
 * accepts for the same reason in its own writer-sweep test.
 *
 * `fileURLToPath(new URL(...))`, never `.pathname` — on Windows the latter
 * yields a leading-slash drive path (`/C:/...`) that `readdirSync` rejects.
 * `proposal-invariants.test.ts` and `capabilities.test.ts` already both make
 * this choice for the same reason.
 */
describe('grantAuthorization is reachable only through authorisedRecipients', () => {
  const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

  function collectTsFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
    return files;
  }

  const PRODUCTION_SOURCES = collectTsFiles(SRC_DIR).filter((path) => !path.endsWith('.test.ts'));
  const AUTHORIZATION_MODULE = join(SRC_DIR, 'governance', 'authorization.ts');

  it('finds production sources to sweep, so an empty sweep cannot pass silently', () => {
    expect(PRODUCTION_SOURCES.length).toBeGreaterThan(50);
  });

  it('is called from exactly one production file, and that file is instruct.ts', () => {
    // Excludes the module's own definition line
    // (`export async function grantAuthorization(`), which also matches
    // `grantAuthorization\(` — it is the callee being declared, not a call.
    const callers = PRODUCTION_SOURCES.filter(
      (path) => path !== AUTHORIZATION_MODULE && /grantAuthorization\(/.test(readFileSync(path, 'utf8')),
    );
    expect(callers).toHaveLength(1);
    expect(callers[0]?.replace(/\\/g, '/')).toMatch(/\/src\/orchestrator\/instruct\.ts$/);
  });

  it('reaches its one call to grantAuthorization only after filtering through authorisedRecipients', () => {
    const instruct = source('orchestrator/instruct.ts');

    // Exactly one call to each in the whole file — a second, parallel call to
    // either would mean a second path computing (or skipping) the filter.
    const authorisedCalls = instruct.match(/authorisedRecipients\(/g) ?? [];
    const grantCalls = instruct.match(/grantAuthorization\(/g) ?? [];
    expect(authorisedCalls).toHaveLength(1);
    expect(grantCalls).toHaveLength(1);

    // Ordering: the filter must run, and its result must be known, before the
    // grant is ever attempted.
    const authorisedAt = instruct.indexOf('authorisedRecipients(');
    const grantAt = instruct.indexOf('grantAuthorization(');
    expect(authorisedAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(authorisedAt);

    // The grant call must actually carry a `recipients` field — not, say, the
    // step's raw input — so there is something for the filtered result to
    // reach in the first place.
    const grantBlock = callBlock(instruct.slice(authorisedAt), 'grantAuthorization');
    expect(grantBlock).toMatch(/recipients/);
  });
});
