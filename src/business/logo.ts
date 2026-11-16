/**
 * What a logo upload is, judged by its bytes alone (admin-panel spec, "Logo").
 *
 * The name the upload carried never reaches this module: a `logo.png` holding
 * JPEG bytes is a JPEG, and an SVG renamed `.png` is not an image at all. SVG
 * is refused outright — it is a document that can carry script, and the logo
 * is shown on owner-facing pages. Only the two raster formats are accepted.
 */

/** 1 MB, inclusive. */
export const LOGO_MAX_BYTES = 1_048_576;

export type LogoMediaType = 'image/png' | 'image/jpeg';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Signature (8) + IHDR length (4) + type (4) + IHDR data (13) + CRC (4). A PNG
 * shorter than its first chunk is a truncated header, not an image.
 */
const PNG_MIN_BYTES = 33;

export function sniffImage(bytes: Buffer): LogoMediaType | null {
  if (
    bytes.length >= PNG_MIN_BYTES &&
    PNG_SIGNATURE.every((b, i) => bytes[i] === b) &&
    bytes.toString('latin1', 12, 16) === 'IHDR'
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  ) {
    return 'image/jpeg';
  }
  return null;
}
