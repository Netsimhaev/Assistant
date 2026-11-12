import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { config } from '../config.js';
import { resetDatabase, testDb } from '../test/db.js';
import { scratchSaveFolder } from '../test/save-root.js';
import {
  DOCUMENT_SETTINGS_DEFAULTS,
  DOCUMENT_SETTINGS_HE,
  loadDocumentSettings,
  saveDocumentSettings,
  type DocumentSettings,
} from './document-settings.js';

const B = 'test-business';
let scratch: string;

beforeEach(async () => {
  await resetDatabase();
  // Inside this business's save folder on the server (spec §5.8).
  scratch = await scratchSaveFolder(B, 'doc-settings-');
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

const channels = { toWhatsApp: false, toEmail: true, toScreen: true };

async function rowCount(): Promise<number> {
  const { rows } = await testDb().query('SELECT 1 FROM document_settings WHERE business_id = $1', [B]);
  return rows.length;
}

describe('document settings', () => {
  it('an absent row reads as the defaults — email and screen, no base folder — and writes nothing', async () => {
    expect(DOCUMENT_SETTINGS_DEFAULTS).toEqual({ toWhatsApp: false, toEmail: true, toScreen: true, baseFolder: null });
    expect(await withBusiness(B, (bdb) => loadDocumentSettings(bdb))).toEqual(DOCUMENT_SETTINGS_DEFAULTS);
    expect(await rowCount()).toBe(0);
  });

  it('round-trips, storing the realpath of the base folder', async () => {
    await symlink(scratch, join(tmpdir(), `doc-settings-link-${process.pid}`), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: join(tmpdir(), `doc-settings-link-${process.pid}`) }));
      expect(await withBusiness(B, (bdb) => loadDocumentSettings(bdb))).toEqual({ ...channels, baseFolder: await realpath(scratch) });
    } finally {
      await rm(join(tmpdir(), `doc-settings-link-${process.pid}`), { force: true, recursive: false }).catch(() => undefined);
    }
  });

  it('settings refuse all-false, in Hebrew, before touching the database', async () => {
    const none: DocumentSettings = { toWhatsApp: false, toEmail: false, toScreen: false, baseFolder: null };
    await expect(withBusiness(B, (bdb) => saveDocumentSettings(bdb, none))).rejects.toThrow(DOCUMENT_SETTINGS_HE.noChannel);
    expect(DOCUMENT_SETTINGS_HE.noChannel).toMatch(/[א-ת]/);
    expect(await rowCount()).toBe(0);
  });

  it('the CHECK is the second layer: an all-false row cannot be written from SQL', async () => {
    await expect(
      testDb().query(
        `INSERT INTO document_settings (business_id, to_whatsapp, to_email, to_screen) VALUES ($1, false, false, false)`,
        [B],
      ),
    ).rejects.toThrow(/document_settings_at_least_one_channel/);
  });

  it('settings refuse a relative base folder', async () => {
    for (const relative of ['מסמכים', './docs', 'docs\\a', '\\no-drive', '\\\\.\\C:\\x', '\\\\?\\C:\\x', '\\\\?\\UNC\\srv\\share']) {
      await expect(withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: relative }))).rejects.toThrow(
        DOCUMENT_SETTINGS_HE.notAbsolute,
      );
    }
    expect(await rowCount()).toBe(0);
  });

  it('refuses a base folder that does not exist', async () => {
    await expect(
      withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: join(scratch, 'missing') })),
    ).rejects.toThrow(DOCUMENT_SETTINGS_HE.missing);
    expect(await rowCount()).toBe(0);
  });

  it('refuses a base folder that is a file', async () => {
    await writeFile(join(scratch, 'file'), 'x');
    await expect(
      withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: join(scratch, 'file') })),
    ).rejects.toThrow(DOCUMENT_SETTINGS_HE.notDirectory);
  });

  it('refuses a base folder that is not writable (fs.access W_OK)', async () => {
    const calls: string[] = [];
    await expect(
      withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: scratch }, { access: async (path) => {
            calls.push(path);
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          } })),
    ).rejects.toThrow(DOCUMENT_SETTINGS_HE.notWritable);
    expect(calls).toHaveLength(1);
    expect(await rowCount()).toBe(0);
  });

  it('refuses a link inside the business folder that leads out of it', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'doc-settings-elsewhere-'));
    try {
      await symlink(elsewhere, join(scratch, 'out'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(
        withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: join(scratch, 'out') })),
      ).rejects.toThrow(DOCUMENT_SETTINGS_HE.outsideBusiness);
      expect(await rowCount()).toBe(0);
    } finally {
      await rm(join(scratch, 'out'), { force: true, recursive: false }).catch(() => undefined);
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('accepts no base folder at all on a server with no DOCUMENT_SAVE_ROOT', async () => {
    const mutable = config as { documentSaveRoot: string | null };
    const original = mutable.documentSaveRoot;
    mutable.documentSaveRoot = null;
    try {
      await expect(
        withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: scratch })),
      ).rejects.toThrow(DOCUMENT_SETTINGS_HE.noServerRoot);
      expect(await rowCount()).toBe(0);
      // Clearing the folder still works: no root is needed to have none.
      await withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: null }));
      expect(await rowCount()).toBe(1);
    } finally {
      mutable.documentSaveRoot = original;
    }
  });

  it("says the business's server folder is missing, rather than 'outside', when it does not exist", async () => {
    // A business with no save folder yet; any folder at all is then refused
    // with the operator-facing message, never as "outside the business".
    const NEW = 'business-without-save-folder';
    await expect(
      withBusiness(NEW, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: scratch })),
    ).rejects.toThrow(DOCUMENT_SETTINGS_HE.businessFolderMissing);
    expect(DOCUMENT_SETTINGS_HE.businessFolderMissing).toBe('התיקייה של העסק בשרת עדיין לא קיימת — פנה למנהל המערכת');
  });

  it('a null or blank base folder clears it', async () => {
    await withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: scratch }));
    await withBusiness(B, (bdb) => saveDocumentSettings(bdb, { ...channels, baseFolder: '  ' }));
    expect((await withBusiness(B, (bdb) => loadDocumentSettings(bdb))).baseFolder).toBeNull();
  });
});
