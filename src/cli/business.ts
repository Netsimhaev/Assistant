/**
 * `business` — the platform operator's handle on the registry of businesses.
 *
 *   npm run business -- create <id> "<name>" | suspend <id> | resume <id> | list
 *
 * Output is Hebrew; `list` shows id, name and status only.
 */
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import {
  createBusiness,
  listBusinesses,
  setBusinessStatus,
  TenancyError,
} from '../tenancy/businesses.js';

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
      if (id === undefined || name === undefined || argv.length > 3) throw new TenancyError(USAGE);
      await createBusiness(id, name);
      log(`העסק ${id} נוצר ופעיל.`);
      return;
    case 'suspend':
    case 'resume':
      if (id === undefined || argv.length > 2) throw new TenancyError(USAGE);
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
      throw new TenancyError(USAGE);
  }
}

const isMain = process.argv[1] !== undefined && /business\.[tj]s$/.test(process.argv[1]);
if (isMain) {
  runBusinessCli(process.argv.slice(2), (line) => console.log(line))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePlatformPool();
      await closePool();
    });
}
