import { describe, expect, it } from 'vitest';
import { LOGO_MAX_BYTES, sniffImage } from './logo.js';

/** A minimal PNG: signature, then a 13-byte IHDR chunk with its CRC. */
function pngBytes(extra = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const length = Buffer.from([0x00, 0x00, 0x00, 0x0d]);
  const type = Buffer.from('IHDR', 'ascii');
  const data = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const crc = Buffer.from([0x1f, 0x15, 0xc4, 0x89]);
  return Buffer.concat([signature, length, type, data, crc, Buffer.alloc(extra, 0)]);
}

/** A minimal JPEG: SOI, an APP0 marker, a few bytes, EOI. */
function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
}

describe('sniffImage — judged by bytes, never by name', () => {
  it('recognises PNG bytes', () => {
    expect(sniffImage(pngBytes())).toBe('image/png');
  });

  it('recognises JPEG bytes — a file named logo.png holding JPEG is JPEG', () => {
    // The name never reaches this function; the bytes are what decide.
    expect(sniffImage(jpegBytes())).toBe('image/jpeg');
  });

  it('rejects an SVG, even one renamed .png', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg></svg>'))).toBeNull();
  });

  it('rejects a truncated PNG header — the 8-byte signature alone', () => {
    expect(sniffImage(pngBytes().subarray(0, 8))).toBeNull();
    // Signature plus a chunk that is not IHDR.
    const wrongChunk = pngBytes();
    wrongChunk.write('IDAT', 12, 'ascii');
    expect(sniffImage(wrongChunk)).toBeNull();
  });

  it('rejects a JPEG that does not end with the end-of-image marker', () => {
    expect(sniffImage(jpegBytes().subarray(0, 11))).toBeNull();
  });

  it('rejects empty and random bytes', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
  });

  it('caps a logo at exactly 1 MB', () => {
    expect(LOGO_MAX_BYTES).toBe(1_048_576);
  });
});
