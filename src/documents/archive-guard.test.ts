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

  it('returns an archive_malformed verdict for a forged end-of-central-directory record, instead of honouring an oversized declared size or throwing', async () => {
    // Synthetic, hand-forged input, not a real archive: 22 bytes containing
    // nothing but a bare end-of-central-directory record (no central
    // directory data actually precedes it) that declares a central
    // directory size of ~4GB. `centralDirSize` is itself an
    // attacker-declared field read before any of the three numeric
    // ArchiveVerdict caps apply to it -- a naive reader would `Buffer.alloc`
    // that size and become the resource-exhaustion bomb this guard exists
    // to prevent. The declared size overruns the 22-byte file, which is
    // what makes it provably forged rather than merely large.
    //
    // No try/catch around the call below: `inspectArchive`'s signature
    // promises `Promise<ArchiveVerdict>`, and a malformed ZIP has to honour
    // that promise like any other input -- a hostile or corrupt file must
    // never take down ingestion of every valid file behind it.
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

    const verdict = await inspectArchive(path);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('archive_malformed');
  });

  it('refuses an entry whose declared compressed size is larger than the file itself, closing the ratio-check bypass', async () => {
    // Synthetic, hand-forged central directory (not a real archive): one
    // entry declaring uncompressedSize = 1,000 (trivially under the 200MB
    // cap) and compressedSize = 0xFFFFFFF0 (~4.29GB -- impossible, since
    // the whole forged file is 73 bytes). Without the file-size bound in
    // readCentralDirectory, `ratioOf` would compute roughly 1,000 /
    // 4,294,967,280 ≈ 0.0000002, i.e. "ratio looks fine" -- exactly the
    // bypass a real attacker gets by forging compressedSize on a tiny true
    // deflate stream that actually inflates to something huge. The declared
    // compressed size is what proves the entry impossible, independent of
    // ratio arithmetic: it cannot fit in a 73-byte file.
    const name = Buffer.from('f.bin', 'ascii');
    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0); // central directory header signature
    header.writeUInt16LE(0, 4); // version made by
    header.writeUInt16LE(0, 6); // version needed to extract
    header.writeUInt16LE(0, 8); // general purpose bit flag
    header.writeUInt16LE(0, 10); // compression method
    header.writeUInt16LE(0, 12); // last mod file time
    header.writeUInt16LE(0, 14); // last mod file date
    header.writeUInt32LE(0, 16); // crc-32
    header.writeUInt32LE(0xfffffff0, 20); // compressed size: forged, ~4.29GB
    header.writeUInt32LE(1000, 24); // uncompressed size: honestly small
    header.writeUInt16LE(name.length, 28); // file name length
    header.writeUInt16LE(0, 30); // extra field length
    header.writeUInt16LE(0, 32); // file comment length
    header.writeUInt16LE(0, 34); // disk number start
    header.writeUInt16LE(0, 36); // internal file attributes
    header.writeUInt32LE(0, 38); // external file attributes
    header.writeUInt32LE(0, 42); // relative offset of local header
    name.copy(header, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8); // entries on this disk
    eocd.writeUInt16LE(1, 10); // total entries
    eocd.writeUInt32LE(header.length, 12); // central directory size (true, matches header)
    eocd.writeUInt32LE(0, 16); // central directory offset
    eocd.writeUInt16LE(0, 20); // comment length

    const dir = await mkdtemp(join(tmpdir(), 'archive-guard-'));
    const path = join(dir, 'forged-ratio.zip');
    await writeFile(path, Buffer.concat([header, eocd]));

    const verdict = await inspectArchive(path);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('archive_malformed');
  });
});
