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
 * entirely. This closes that gap: it fails if a second production call site
 * to `grantAuthorization` appears anywhere, and it fails if the one call site
 * that remains stops routing through `authorisedRecipients` first.
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
