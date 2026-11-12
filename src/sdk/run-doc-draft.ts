/**
 * Live run of the document drafter (`draftDocumentSpec`) against the Agent
 * SDK, from a fixture file:
 *
 *   npm run sdk:doc-draft -- src/sdk/fixtures/doc-draft-profit-table.json --business <id>
 *
 * A script and not a test, for the reason every `sdk:*` script here is: it
 * costs money and needs credentials, and `draftDocumentSpec` refuses under
 * `NODE_ENV=test`. It WRITES NOTHING: the charter is the active one if there
 * is one, else a test charter compiled in memory (never installed), and the
 * drafted spec is only printed, followed by what `validateSpec` says about
 * it against the fixture's own sources.
 *
 * Fixture shape: `{ instruction, format, kind, language, sources: FencedSource[], memories }`.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { compileCharter } from '../charter/compile.js';
import { loadActiveCharter } from '../charter/store.js';
import type { BusinessDb } from '../db/pool.js';
import { closeCliPools, runForBusiness } from '../cli/business-arg.js';
import { DocumentFormat, DocumentKind, DocumentLanguage } from '../domain/document-spec.js';
import { TrustLevel } from '../domain/trust.js';
import { validateSpec } from '../production/validate-spec.js';
import { buildCharter } from '../test/fixtures.js';
import { localParts } from '../util/local-time.js';
import { draftDocumentSpec, pickDrafterModel, type DraftRequest } from './doc-drafter.js';

const Fixture = z
  .object({
    instruction: z.string().min(1),
    format: DocumentFormat,
    kind: DocumentKind,
    language: DocumentLanguage,
    sources: z.array(
      z.object({
        documentId: z.string().min(1),
        provenance: TrustLevel,
        artifacts: z.array(z.object({ ordinal: z.number().int().min(0), text: z.string() })),
      }),
    ),
    memories: z.array(z.object({ memoryId: z.string().min(1), body: z.string(), provenance: TrustLevel })),
  })
  .strict();

async function main(db: BusinessDb, args: string[]): Promise<void> {
  const path = args[0];
  if (path === undefined) {
    console.error('שימוש: npm run sdk:doc-draft -- <קובץ fixture> --business <id>');
    process.exitCode = 1;
    return;
  }
  if (process.env['ANTHROPIC_API_KEY'] === undefined && process.env['ANTHROPIC_AUTH_TOKEN'] === undefined) {
    console.error('אין ANTHROPIC_API_KEY בסביבה. ההרצה החיה דורשת מפתח; הלוגיקה עצמה מכוסה במבחנים.');
    process.exitCode = 1;
    return;
  }
  const fixture = Fixture.parse(JSON.parse(readFileSync(path, 'utf8')));
  const active = await loadActiveCharter(db);
  const charter = active?.charter ?? buildCharter();
  const bundle = active?.bundle ?? compileCharter(charter);
  const today = localParts(new Date(), charter.identity.timezone).date;

  const request: DraftRequest = { bundle, ...fixture, today };
  console.log(`charter: ${bundle.charterVersion}${active === null ? ' (in-memory test charter)' : ''}`);
  console.log(`model: ${pickDrafterModel(request)}  today: ${today}\n`);

  const started = Date.now();
  const outcome = await draftDocumentSpec(request);
  console.log(`elapsed: ${Math.round((Date.now() - started) / 1000)}s`);
  if (outcome.status === 'undrafted') {
    console.log(`UNDRAFTED — ${outcome.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(outcome.spec, null, 2));
  const problems = validateSpec(
    outcome.spec,
    { instructionText: fixture.instruction, documents: fixture.sources, memories: fixture.memories },
    { today },
  );
  console.log(`\nvalidateSpec: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  [${p.code}] ${p.where}: ${p.detail}`);
}

try {
  // `main` sets exit code 1 itself on its own refusals; only a `--business`
  // refusal (2) comes back from here, and 0 must not overwrite that 1.
  const code = await runForBusiness(process.argv.slice(2), (line) => console.error(line), main);
  if (code !== 0) process.exitCode = code;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
await closeCliPools();
