/**
 * Test-only helpers for hand-building a minimal `.docx` (a ZIP, store
 * method, no deflate needed — this module's own reader never checks CRC and
 * neither does `mammoth`'s). Lifted out of `docx.test.ts` so `outline.test.ts`
 * can build its own small fixtures too, without duplicating a ZIP writer.
 *
 * There is no "admitted" docx-*writing* dependency (spec §9.1 only ever
 * justified *reading* one), so this stays hand-rolled rather than reaching
 * for a library — the same reasoning `xlsx.test.ts`'s macro-part test
 * already used to hand-patch raw ZIP bytes.
 *
 * Verified against `mammoth` directly: a docx containing only
 * `word/document.xml` opens fine (no `[Content_Types].xml`, no `_rels/`, no
 * `word/styles.xml` required — `docx-reader.js` falls back to sane defaults
 * for every part but the main document).
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

export function buildDocx(entries: Record<string, string>): Buffer {
  const names = Object.keys(entries);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(entries[name] ?? '', 'utf8');
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // method: store
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([localHeader, nameBuf, data]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

export async function tempDocxPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docx-fixture-'));
  return join(dir, name);
}

export async function writeDocx(fileName: string, entries: Record<string, string>): Promise<string> {
  const path = await tempDocxPath(fileName);
  await writeFile(path, buildDocx(entries));
  return path;
}

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function documentXml(bodyXml: string): string {
  return `${XML_HEADER}\n<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`;
}
