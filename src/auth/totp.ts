import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(now: Date): number {
  return Math.floor(now.getTime() / 30_000);
}

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = (h[h.length - 1] ?? 0) & 0x0f;
  const bin =
    (((h[offset] ?? 0) & 0x7f) << 24) |
    (((h[offset + 1] ?? 0) & 0xff) << 16) |
    (((h[offset + 2] ?? 0) & 0xff) << 8) |
    ((h[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

export function matchTotp(
  secretBase32: string,
  code: string,
  now: Date,
  lastStep: number | null,
): number | null {
  const cleaned = code.replace(/ /g, '');
  if (!/^\d{6}$/.test(cleaned)) return null;
  const given = Buffer.from(cleaned);
  const cur = currentStep(now);
  let matched: number | null = null;
  for (const step of [cur - 1, cur, cur + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secretBase32, step));
    if (timingSafeEqual(given, expected) && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(input: { issuer: string; account: string; secretBase32: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const q = [
    `secret=${encodeURIComponent(input.secretBase32)}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    'algorithm=SHA1',
    'digits=6',
    'period=30',
  ].join('&');
  return `otpauth://totp/${label}?${q}`;
}
