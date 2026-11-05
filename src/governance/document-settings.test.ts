import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
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
  scratch = await mkdtemp(join(tmpdir(), 'doc-settings-'));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

const channels = { toWhatsApp: false, toEmail: true, toScreen: true };

async function rowCount(): Promise<number> {
  const { rows } = await getPool().query('SELECT 1 FROM document_settings WHERE business_id = $1', [B]);
  return rows.length;
}

describe('document settings', () => {
  it('an absent row reads as the defaults — email and screen, no base folder — and writes nothing', async () => {
    expect(DOCUMENT_SETTINGS_DEFAULTS).toEqual({ toWhatsApp: false, toEmail: true, toScreen: true, baseFolder: null });
    expect(await loadDocumentSettings({ businessId: B })).toEqual(DOCUMENT_SETTINGS_DEFAULTS);
    expect(await rowCount()).toBe(0);
  });

  it('round-trips, storing the realpath of the base folder', async () => {
    await symlink(scratch, join(tmpdir(), `doc-settings-link-${process.pid}`), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await saveDocumentSettings(
        { ...channels, baseFolder: join(tmpdir(), `doc-settings-link-${process.pid}`) },
        { businessId: B },
      );
      expect(await loadDocumentSettings({ businessId: B })).toEqual({ ...channels, baseFolder: await realpath(scratch) });
    } finally {
      await rm(join(tmpdir(), `doc-settings-link-${process.pid}`), { force: true, recursive: false }).catch(() => undefined);
    }
  });

  it('settings refuse all-false, in Hebrew, before touching the database', async () => {
    const none: DocumentSettings = { toWhatsApp: false, toEmail: false, toScreen: false, baseFolder: null };
    await expect(saveDocumentSettings(none, { businessId: B })).rejects.toThrow(DOCUMENT_SETTINGS_HE.noChannel);
    expect(DOCUMENT_SETTINGS_HE.noChannel).toMatch(/[א-ת]/);
    expect(await rowCount()).toBe(0);
  });

  it('the CHECK is the second layer: an all-false row cannot be written from SQL', async () => {
    await expect(
      getPool().query(
        `INSERT INTO document_settings (business_id, to_whatsapp, to_email, to_screen) VALUES ($1, false, false, false)`,
        [B],
      ),
    ).rejects.toThrow(/document_settings_at_least_one_channel/);
  });

  it('settings refuse a relative base folder', async () => {
    for (const relative of ['מסמכים', './docs', 'docs\\a', '\\no-drive']) {
      await expect(saveDocumentSettings({ ...channels, baseFolder: relative }, { businessId: B })).rejects.toThrow(
        DOCUMENT_SETTINGS_HE.notAbsolute,
      );
    }
    expect(await rowCount()).toBe(0);
  });

  it('refuses a base folder that does not exist', async () => {
    await expect(
      saveDocumentSettings({ ...channels, baseFolder: join(scratch, 'missing') }, { businessId: B }),
    ).rejects.toThrow(DOCUMENT_SETTINGS_HE.missing);
    expect(await rowCount()).toBe(0);
  });

  it('refuses a base folder that is a file', async () => {
    await writeFile(join(scratch, 'file'), 'x');
    await expect(
      saveDocumentSettings({ ...channels, baseFolder: join(scratch, 'file') }, { businessId: B }),
    ).rejects.toThrow(DOCUMENT_SETTINGS_HE.notDirectory);
  });

  it('refuses a base folder that is not writable (fs.access W_OK)', async () => {
    const calls: string[] = [];
    await expect(
      saveDocumentSettings(
        { ...channels, baseFolder: scratch },
        {
          businessId: B,
          access: async (path) => {
            calls.push(path);
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          },
        },
      ),
    ).rejects.toThrow(DOCUMENT_SETTINGS_HE.notWritable);
    expect(calls).toHaveLength(1);
    expect(await rowCount()).toBe(0);
  });

  it('a null or blank base folder clears it', async () => {
    await saveDocumentSettings({ ...channels, baseFolder: scratch }, { businessId: B });
    await saveDocumentSettings({ ...channels, baseFolder: '  ' }, { businessId: B });
    expect((await loadDocumentSettings({ businessId: B })).baseFolder).toBeNull();
  });
});
