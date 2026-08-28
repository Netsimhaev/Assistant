/**
 * The archive safety pre-check (docs/superpowers/specs/2026-08-28-document-intake-design.md
 * §5.2, caps table §3.4). Runs before Task 5's extractor child process is
 * ever spawned, so refusing a hostile archive here costs nothing — no child,
 * no disk write beyond the original bytes already stored.
 *
 * This reads the ZIP **central directory only**: the declared compressed and
 * uncompressed size of every entry, plus the entry count. Nothing here calls
 * into `node:zlib`'s inflate, or any other decompressor — there is no code
 * path in this file capable of unpacking a single byte of archive content.
 *
 * The declared **uncompressed** size is attacker-controlled, and that lie is
 * tolerated on purpose: an entry's central-directory header can claim any
 * inflated size regardless of what its compressed stream truly produces, and
 * an entry that *understates* it to slip under these caps still meets Task
 * 5's own output-size cap on the child process, enforced against what
 * actually comes out of the decompressor. This guard's job is narrower:
 * refuse what the archive admits to, before spending a process on it.
 *
 * The declared **compressed** size is a different lie, and this guard does
 * not tolerate it: nothing downstream re-derives the ratio dimension, so an
 * entry that overstates its compressed size defeats the ratio cap outright
 * — a 1KB deflate stream can carry a `compressedSize` field of any value up
 * to 4GB, making a true ~200,000:1 ratio read back as roughly 1:1. That is
 * checkable for free, because a compressed size cannot exceed the file that
 * allegedly contains it. `readCentralDirectory` refuses any entry whose
 * declared compressed size is larger than the archive itself, before the
 * ratio is ever computed from it.
 *
 * Three checks, in the spec's order — an archive that crosses more than one
 * cap reports the first it crosses, not the most severe:
 *   1. total declared inflated size across all entries > 200MB
 *   2. entry count > 2,000
 *   3. any single entry's declared ratio (uncompressed / compressed) > 120:1
 *
 * A ZIP that cannot be parsed as a ZIP at all — including one carrying a
 * declared size (central directory size, or now compressed entry size) that
 * is provably impossible given the file's own length — is a fourth outcome,
 * `archive_malformed`, not an exception. `inspectArchive`'s signature is
 * `Promise<ArchiveVerdict>`, and a caller that trusts that signature must
 * never see an uncaught rejection from a single hostile file.
 */

import { open } from 'node:fs/promises';

const MAX_INFLATED_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_RATIO = 120;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const CENTRAL_DIR_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_DIR_HEADER_FIXED_SIZE = 46;

export type ArchiveVerdict =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'archive_too_large'
        | 'archive_too_many_entries'
        | 'archive_ratio'
        | 'archive_malformed';
      detail: string;
    };

interface CentralDirectoryEntry {
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Internal signal that `path` is not a well-formed ZIP central directory —
 * distinct from the three cap-based `ArchiveVerdict` codes, which all mean
 * "this is a ZIP, and it crosses a stated cap". `sniffMediaType` (§5.1)
 * already confirmed the file starts with the ZIP magic bytes before this
 * guard is ever called; a file that still fails to parse here (or declares
 * a size — central-directory size, or a single entry's compressed size —
 * that the file's own length proves impossible) is corrupt or adversarially
 * forged in a way none of the three numeric caps describes.
 *
 * This never crosses the `inspectArchive` function boundary: it is caught
 * there and turned into an `archive_malformed` verdict. Kept as a thrown
 * error internally only so `readCentralDirectory` can unwind out of a
 * nested loop with `throw` instead of threading a result type through every
 * parsing step.
 */
class MalformedZipError extends Error {}

/**
 * Locates and parses the ZIP end-of-central-directory record and every
 * central directory file header it points to. Reads only the trailing
 * comment-sized window plus the central directory itself — never the
 * (potentially far larger) compressed entry data that precedes it.
 *
 * Does not handle ZIP64 (the extension used for archives or entries beyond
 * 4GB / 65,535 entries with a >32-bit field). None of the three caps this
 * guard enforces can be satisfied by an archive that needs ZIP64 in the
 * first place, so a plain 32-bit central directory is what every admissible
 * archive — and every archive worth rejecting under these caps — actually
 * has.
 */
async function readCentralDirectory(path: string): Promise<CentralDirectoryEntry[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();

    const tailSize = Math.min(size, EOCD_FIXED_SIZE + MAX_COMMENT_SIZE);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);

    let eocdOffset = -1;
    for (let i = tail.length - EOCD_FIXED_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new MalformedZipError('no end-of-central-directory record found');
    }

    const totalEntries = tail.readUInt16LE(eocdOffset + 10);
    const centralDirSize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirOffset = tail.readUInt32LE(eocdOffset + 16);

    // `centralDirSize` is itself an attacker-declared field, read before any
    // of the three caps apply to it — a forged EOCD could claim a central
    // directory of several gigabytes to force an oversized allocation here,
    // which would be a resource-exhaustion bomb of exactly the kind this
    // guard exists to refuse, just aimed at the guard instead of Task 5's
    // child. The true central directory is bounded by the file itself (it
    // sits before the EOCD we just found), so a declared size that would
    // overrun the file is proof of forgery, not a size to honour.
    const eocdAbsoluteOffset = size - tail.length + eocdOffset;
    if (centralDirOffset + centralDirSize > eocdAbsoluteOffset) {
      throw new MalformedZipError('declared central directory size overruns the file');
    }

    const cd = Buffer.alloc(centralDirSize);
    await handle.read(cd, 0, centralDirSize, centralDirOffset);

    const entries: CentralDirectoryEntry[] = [];
    let pos = 0;
    for (let i = 0; i < totalEntries; i++) {
      if (pos + CENTRAL_DIR_HEADER_FIXED_SIZE > cd.length) {
        throw new MalformedZipError('central directory record truncated');
      }
      if (cd.readUInt32LE(pos) !== CENTRAL_DIR_HEADER_SIGNATURE) {
        throw new MalformedZipError('central directory entry has the wrong signature');
      }
      const compressedSize = cd.readUInt32LE(pos + 20);
      const uncompressedSize = cd.readUInt32LE(pos + 24);
      const nameLength = cd.readUInt16LE(pos + 28);
      const extraLength = cd.readUInt16LE(pos + 30);
      const commentLength = cd.readUInt16LE(pos + 32);

      // An entry's compressed bytes have to physically live somewhere
      // inside this file. A declared `compressedSize` larger than the file
      // itself cannot be real — and left unchecked, it defeats the ratio
      // cap below outright: a tiny real deflate stream can carry any
      // `compressedSize` value up to 4GB in its header, driving the
      // computed ratio arbitrarily close to 1:1 regardless of what the
      // entry truly inflates to.
      if (compressedSize > size) {
        throw new MalformedZipError(
          `entry declares a compressed size (${compressedSize}) larger than the file itself (${size})`,
        );
      }

      entries.push({ compressedSize, uncompressedSize });
      pos += CENTRAL_DIR_HEADER_FIXED_SIZE + nameLength + extraLength + commentLength;
    }

    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * An entry with zero declared compressed bytes but nonzero declared
 * uncompressed bytes is claiming an unbounded ratio (data from nothing) —
 * treated as `Infinity` so it fails the ratio cap rather than dividing by
 * zero. Two zero-byte declarations (an empty stored entry, or a directory
 * record) are a legitimate 0:1 and pass.
 */
function ratioOf(entry: CentralDirectoryEntry): number {
  if (entry.compressedSize === 0) {
    return entry.uncompressedSize === 0 ? 0 : Infinity;
  }
  return entry.uncompressedSize / entry.compressedSize;
}

export async function inspectArchive(path: string): Promise<ArchiveVerdict> {
  let entries: CentralDirectoryEntry[];
  try {
    entries = await readCentralDirectory(path);
  } catch (err) {
    // A caller that trusts this function's `Promise<ArchiveVerdict>`
    // signature must never take an uncaught rejection from a single
    // hostile or corrupt file — that would stop ingestion of every valid
    // file behind it. Only `MalformedZipError` is converted to a verdict
    // here; anything else (e.g. the file vanishing between the media-type
    // sniff and this call) is a genuine, unexpected failure and still
    // propagates.
    if (!(err instanceof MalformedZipError)) throw err;
    return { ok: false, code: 'archive_malformed', detail: `הארכיון פגום: ${err.message}` };
  }

  let totalInflated = 0;
  let maxRatio = 0;
  for (const entry of entries) {
    totalInflated += entry.uncompressedSize;
    const ratio = ratioOf(entry);
    if (ratio > maxRatio) maxRatio = ratio;
  }

  if (totalInflated > MAX_INFLATED_TOTAL_BYTES) {
    return {
      ok: false,
      code: 'archive_too_large',
      detail: `הארכיון מתנפח ל-${totalInflated.toLocaleString('he-IL')} בייטים, מעבר לתקרה של ${MAX_INFLATED_TOTAL_BYTES.toLocaleString('he-IL')}`,
    };
  }

  if (entries.length > MAX_ENTRIES) {
    return {
      ok: false,
      code: 'archive_too_many_entries',
      detail: `הארכיון מכיל ${entries.length.toLocaleString('he-IL')} רשומות, מעבר לתקרה של ${MAX_ENTRIES.toLocaleString('he-IL')}`,
    };
  }

  if (maxRatio > MAX_RATIO) {
    return {
      ok: false,
      code: 'archive_ratio',
      detail: `רשומה בארכיון מתנפחת ביחס של יותר מ-${MAX_RATIO}:1`,
    };
  }

  return { ok: true };
}
