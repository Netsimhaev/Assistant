import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Stance } from '../domain/proposal.js';
import { buildProposalSystemPrompt } from '../sdk/proposal-prompt.js';
import { compileCharter } from '../charter/compile.js';
import { buildCharter } from '../test/fixtures.js';

/**
 * These are structural invariants, not behaviour tests — the same genre as
 * `charter/capabilities.test.ts` and `documents/reading-invariants.test.ts`.
 * Each one blocks a way for the proposal/authorisation boundary this
 * sub-project drew to fall out of sync with the source tree and turn into a
 * silent hole rather than a loud failure.
 *
 * `fileURLToPath(new URL(...))`, never `.pathname` — on Windows the latter
 * yields a leading-slash drive path (`/C:/...`) that `readdirSync` rejects.
 * `capabilities.test.ts` and `reading-invariants.test.ts` already both make
 * this choice for the same reason.
 */

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));
const DOCUMENTS_DIR = join(SRC_DIR, 'documents');

/** Every `.ts` file under `dir`, recursing into subdirectories. */
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

/** Every non-test `.ts` source file under `src/`. */
const PRODUCTION_SOURCES = collectTsFiles(SRC_DIR).filter((path) => !path.endsWith('.test.ts'));

describe('the authorisation boundary this sub-project drew', () => {
  it('finds production sources to sweep, so an empty sweep cannot pass silently', () => {
    // A sweep of zero files is a misconfigured path, not a clean result — the
    // task brief names this failure mode by hand: "an empty sweep that
    // passes is not a control."
    expect(PRODUCTION_SOURCES.length).toBeGreaterThan(50);
  });

  it('has exactly one writer of job_authorizations', () => {
    // The security core: standing authorisation stands in for a human
    // approval, and a second writer is how an instruction gets forged —
    // written anywhere other than the one place that first checks the job's
    // own stamped provenance (`grantAuthorization` in
    // `src/governance/authorization.ts`).
    // Every write, not only the literal `INSERT INTO`. An
    // `UPDATE job_authorizations SET recipients = ...` — precisely the silent
    // widening the migration's primary key was chosen to forbid — passed a
    // substring match on the insert, and so did `INSERT  INTO` with two
    // spaces. `TRUNCATE` stays permitted on purpose: `src/test/db.ts` empties
    // the table between tests, and emptying a table grants nobody anything.
    const WRITE = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+job_authorizations/i;
    const writers = PRODUCTION_SOURCES.filter((path) => WRITE.test(readFileSync(path, 'utf8')));
    expect(writers).toHaveLength(1);
    expect(writers[0]?.replace(/\\/g, '/')).toMatch(/\/src\/governance\/authorization\.ts$/);
  });

  it('has no module under src/documents/ importing the authorisation module', () => {
    // The reading layer must not be able to grant authority to itself: a
    // document extractor or reading composer that could reach
    // `grantAuthorization` or `loadAuthorization` would let content the
    // system itself has not vetted stand in for the owner's own instruction.
    const documentSources = PRODUCTION_SOURCES.filter((path) => path.startsWith(DOCUMENTS_DIR));
    expect(documentSources.length).toBeGreaterThan(5);

    // Matched on the module's file name, not on the directory it currently
    // sits in. The module moved once already (orchestrator -> governance),
    // and a directory-anchored pattern would have kept passing while
    // checking for a path nothing imports any more — a control that quietly
    // stops applying is the failure mode the move itself was about.
    const offenders = documentSources.filter((path) =>
      /from\s+['"][^'"]*\/authorization\.js['"]/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the proposer prompt names every stance it can produce', () => {
  it('every Stance.options member appears in the built system prompt', () => {
    const bundle = compileCharter(buildCharter());
    const prompt = buildProposalSystemPrompt(bundle, '(קטלוג לצורך הבדיקה)');

    // A stance the enum declares but the prompt never mentions is a stance
    // the model was never told it may choose — the same "compiled but
    // unread" shape `capabilities.test.ts` guards for charter ceilings,
    // one layer up in the prompt instead of the gate.
    for (const stance of Stance.options) {
      expect(prompt, stance).toContain(`\`${stance}\``);
    }
  });
});
