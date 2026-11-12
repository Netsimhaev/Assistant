/**
 * `business` — the platform operator's handle on the registry of businesses.
 *
 *   npm run business -- create <id> "<name>" | suspend <id> | resume <id> | list
 *
 * Output is Hebrew; `list` shows id, name and status only.
 *
 * Exit codes: 2 for a usage error and for a business id that is malformed or
 * not registered (the same code every `--business` command uses, see
 * `business-arg.ts`), 1 for any other refusal or failure.
 */
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import {
  BusinessIdError,
  createBusiness,
  listBusinesses,
  setBusinessStatus,
  TenancyError,
} from '../tenancy/businesses.js';

/** A malformed command line. Exit code 2, like a bad business id. */
class BusinessUsageError extends TenancyError {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessUsageError';
  }
}

const USAGE =
  'שימוש:\n' +
  '  npm run business -- create <מזהה> "<שם>"\n' +
  '  npm run business -- suspend <מזהה>\n' +
  '  npm run business -- resume <מזהה>\n' +
  '  npm run business -- list';

export async function runBusinessCli(argv: string[], log: (line: string) => void): Promise<void> {
  const [action, id, name] = argv;
  switch (action) {
    case 'create':
      if (id === undefined || name === undefined || argv.length > 3) throw new BusinessUsageError(USAGE);
      await createBusiness(id, name);
      log(`העסק ${id} נוצר ופעיל.`);
      return;
    case 'suspend':
    case 'resume':
      if (id === undefined || argv.length > 2) throw new BusinessUsageError(USAGE);
      await setBusinessStatus(id, action === 'suspend' ? 'suspended' : 'active');
      log(action === 'suspend' ? `העסק ${id} הושעה.` : `העסק ${id} חזר לפעילות.`);
      return;
    case 'list': {
      const all = await listBusinesses();
      if (all.length === 0) log('אין עסקים רשומים.');
      for (const b of all) {
        log(`${b.businessId}\t${b.displayName}\t${b.status === 'active' ? 'פעיל' : 'מושעה'}`);
      }
      return;
    }
    default:
      throw new BusinessUsageError(USAGE);
  }
}

/**
 * Runs the command and returns its exit code instead of setting it, so a test
 * can assert the code without spawning a process.
 */
export async function main(
  argv: string[],
  io: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  try {
    await runBusinessCli(argv, io.log);
    return 0;
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return err instanceof BusinessIdError || err instanceof BusinessUsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] !== undefined && /business\.[tj]s$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2), { log: (line) => console.log(line), error: (line) => console.error(line) })
    .then((code) => {
      process.exitCode = code;
    })
    .finally(async () => {
      await closePlatformPool();
      await closePool();
    });
}
