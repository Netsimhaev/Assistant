import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectArchive } from './archive-guard.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('inspectArchive', () => {
  it('admits an ordinary workbook', async () => {
    expect((await inspectArchive(fixture('tiny.xlsx'))).ok).toBe(true);
  });

  it('refuses an archive that would inflate past the 200MB ceiling, without unpacking it', async () => {
    // bomb.xlsx is a genuine ZIP (real central directory, real DEFLATE
    // stream — not a hand-forged header) holding one ~210MB all-zero entry
    // that compresses down to ~200KB. That same entry also crosses the
    // 120:1 ratio cap, so this fixture doubles as the "trips two caps,
    // reports the first" case: the assertion below is only meaningful
    // because archive_too_large is checked before archive_ratio.
    const verdict = await inspectArchive(fixture('bomb.xlsx'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('archive_too_large');
  });

  it('refuses an archive with more than 2,000 entries', async () => {
    // many-entries.zip holds 2,001 tiny STORE (uncompressed) entries, each
    // with a distinct name and body -- total inflated size and every
    // entry's ratio stay trivially within their own caps, so this isolates
    // the entry-count check.
    const verdict = await inspectArchive(fixture('many-entries.zip'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('archive_too_many_entries');
  });

  it('refuses an archive whose declared ratio for a single entry exceeds 120:1', async () => {
    // ratio-bomb.zip holds one 10MB all-'A' entry, DEFLATE level 9. 10MB is
    // far under the 200MB total cap and there is only one entry, so this
    // isolates the ratio check: it fails only because the entry's own
    // uncompressed/compressed ratio crosses 120:1.
    const verdict = await inspectArchive(fixture('ratio-bomb.zip'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('archive_ratio');
  });

  it('refuses a forged end-of-central-directory record instead of honouring an oversized declared size', async () => {
    // Synthetic, hand-forged input, not a real archive: 22 bytes containing
    // nothing but a bare end-of-central-directory record (no central
    // directory data actually precedes it) that declares a central
    // directory size of ~4GB. `centralDirSize` is itself an
    // attacker-declared field read before any of the three ArchiveVerdict
    // caps apply to it -- a naive reader would `Buffer.alloc` that size and
    // become the resource-exhaustion bomb this guard exists to prevent. The
    // declared size overruns the 22-byte file, which is what makes it
    // provably forged rather than merely large, so `inspectArchive` rejects
    // the promise instead of returning a verdict for a file it cannot trust.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with the start of the central directory
    eocd.writeUInt16LE(1, 8); // entries on this disk
    eocd.writeUInt16LE(1, 10); // total entries
    eocd.writeUInt32LE(0xfffffff0, 12); // declared central directory size: ~4GB
    eocd.writeUInt32LE(0, 16); // declared central directory offset
    eocd.writeUInt16LE(0, 20); // comment length

    const dir = await mkdtemp(join(tmpdir(), 'archive-guard-'));
    const path = join(dir, 'forged.zip');
    await writeFile(path, eocd);

    await expect(inspectArchive(path)).rejects.toThrow();
  });
});
