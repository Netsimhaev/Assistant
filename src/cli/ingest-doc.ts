/**
 * `doc:ingest` — the caller `ingestDocument` was missing.
 *
 * Spec §7: "this is the question that felled four components in this
 * project." A pipeline that compiles and that nothing ever invokes is dead
 * code with better documentation. This command reads one file off disk and
 * runs it through the real pipeline — the same `ingestDocument` mail intake
 * will call in stage 1 (§7: "there is no second path").
 *
 * Follows the shape of `seed-job.ts`: the logic lives in an exported
 * function (`runIngestCli`) a test can drive directly with an in-memory
 * `log`, and the process wrapper (`main`) is guarded by the same
 * `import.meta.url` check so importing this module never runs it.
 */
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BusinessDb } from '../db/pool.js';
import { ingestDocument } from '../documents/ingest.js';
import { loadArtifacts } from '../documents/store.js';
import type { DocumentSource } from '../documents/types.js';
import { documentSourceLabel } from '../documents/source-label.js';
import { closeCliPools, runForBusiness } from './business-arg.js';

const SOURCES: readonly DocumentSource[] = ['manual', 'mail', 'api'];

function isDocumentSource(value: string): value is DocumentSource {
  return (SOURCES as readonly string[]).includes(value);
}

export interface IngestCliDeps {
  log: (line: string) => void;
  documentRoot?: string;
}

/**
 * Parses argv, runs `ingestDocument`, and prints the result through
 * `deps.log` — one call per line, so a test can join them and assert on
 * substrings without caring how the terminal wraps them.
 *
 * Throws (never calls `process.exit`) on a bad argument or a file that
 * cannot be read — that is what lets `main` below catch it and print a
 * readable message instead of a stack trace, and what lets a test assert
 * `.rejects.toThrow()` without spawning a process.
 */
export async function runIngestCli(db: BusinessDb, argv: string[], deps: IngestCliDeps): Promise<void> {
  const { log } = deps;

  const positionals: string[] = [];
  let source: DocumentSource = 'manual';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--source') {
      const value = argv[i + 1];
      if (value === undefined || !isDocumentSource(value)) {
        throw new Error(
          `--source חייב להיות אחד מ: ${SOURCES.join(', ')} (התקבל: ${value ?? '(חסר)'})`,
        );
      }
      source = value;
      i += 1;
      continue;
    }
    positionals.push(arg);
  }

  const path = positionals[0];
  if (path === undefined) {
    throw new Error('שימוש: npm run doc:ingest -- <נתיב> [--source mail|manual|api] --business <מזהה>');
  }

  // A readable Hebrew reason for the two common mistakes — a typo'd path or
  // a directory handed in by accident — rather than the English ENOENT/EISDIR
  // stack `readFile` inside `ingestDocument` would otherwise surface.
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      throw new Error(`הקובץ לא נמצא: ${path}`);
    }
    throw err;
  }
  if (!fileStat.isFile()) {
    throw new Error(`הנתיב אינו קובץ: ${path}`);
  }

  const options = {
    ...(deps.documentRoot !== undefined ? { documentRoot: deps.documentRoot } : {}),
  };
  const doc = await ingestDocument(
    db,
    { path, source, originalName: basename(path) },
    options,
  );

  log(`מסמך ${doc.documentId}`);
  log(`מקור: ${documentSourceLabel[doc.source]}`);
  log(`סטטוס: ${doc.status}`);
  log(`סוג מדיה: ${doc.mediaType}`);

  if (doc.status === 'rejected') {
    log(`סיבת הדחייה: ${doc.reason ?? '(לא צוינה)'}`);
    return;
  }

  // Ruling P7: an undecodable PDF is kept (downloadable) but never read.
  if (doc.status === 'stored' && doc.reason !== null) {
    log(`לא נקרא: ${doc.reason}`);
    return;
  }

  if (doc.status === 'extracted') {
    const artifacts = await loadArtifacts(db, doc.documentId);
    for (const artifact of artifacts) {
      log(`רכיב: ${artifact.kind} — ${artifact.partName ?? '(ללא שם)'}`);
    }
  }
}

/**
 * The process wrapper. Kept separate from `runIngestCli` so the test drives
 * the logic without spawning a process or reading argv — same reasoning as
 * `seed-job.ts`'s `main`. `--business` is checked first: exit code 2 and
 * nothing written on a refusal (`business-arg.ts`).
 */
export async function main(
  argv: string[],
  io: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  try {
    return await runForBusiness(argv, io.error, (db, rest) => runIngestCli(db, rest, { log: io.log }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.error(`שגיאה בקליטת המסמך: ${message}`);
    return 1;
  }
}

// Only run when executed directly — never on import from the test. Same
// pattern as src/cli/seed-job.ts and src/cli/create-owner.ts.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  process.exitCode = await main(process.argv.slice(2), {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  await closeCliPools();
}
