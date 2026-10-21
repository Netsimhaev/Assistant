/**
 * MIME helpers shared by the mailbox clients: header decoding, address
 * parsing, HTML-to-text and the body size cap. Pure functions, no I/O.
 */

export const MAX_BODY_CHARS = 1_000_000;

export function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function decodeQ(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '_') {
      out.push(0x20);
    } else if (ch === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(...Buffer.from(ch, 'utf8'));
    }
  }
  return Buffer.from(out);
}

const ENCODED_WORD = String.raw`=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=`;

/**
 * Decode RFC 2047 encoded words (B and Q). Whitespace between adjacent encoded
 * words is dropped, and adjacent words with the same charset and encoding are
 * decoded as one byte run so a multibyte character split across them survives.
 * CR and LF never survive into the result.
 */
export function decodeHeader(value: string): string {
  const run = new RegExp(`${ENCODED_WORD}(?:[ \\t\\r\\n]+${ENCODED_WORD})*`, 'g');
  const one = new RegExp(ENCODED_WORD, 'g');
  const decoded = value.replace(run, (match) => {
    let out = '';
    let curKey = '';
    let bytes: Buffer[] = [];
    const flush = (): void => {
      if (bytes.length > 0) out += decodeBytes(Buffer.concat(bytes), curKey.split('|')[0] as string);
      bytes = [];
    };
    for (const m of match.matchAll(one)) {
      const charset = m[1] as string;
      const enc = (m[2] as string).toLowerCase();
      const key = `${charset.toLowerCase()}|${enc}`;
      if (key !== curKey) {
        flush();
        curKey = key;
      }
      bytes.push(enc === 'b' ? Buffer.from(m[3] as string, 'base64') : decodeQ(m[3] as string));
    }
    flush();
    return out;
  });
  return decoded.replace(/[\r\n]+/g, ' ');
}

export interface ParsedAddress {
  address: string;
  name: string | null;
}

/** Strict address shape: one @, no whitespace, no control characters, no header-structure characters. */
// eslint-disable-next-line no-control-regex
export const ADDRESS_SHAPE = /^[^\s<>()@,;:"\\\x00-\x1f\x7f]+@[^\s<>()@,;:"\\\x00-\x1f\x7f]+$/;

/**
 * Parse one mailbox: `Name <a@b>`, `"Name" <a@b>` or bare `a@b`.
 *
 * The raw value is split into name and address FIRST; only the display name is
 * RFC 2047 decoded. Decoding across the whole value would let an encoded word
 * inside the angle brackets smuggle CR/LF (and so extra headers) into the address.
 * An address that fails the strict shape yields null.
 */
export function parseAddress(raw: string): ParsedAddress | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const angle = /^(.*)<([^<>]*)>\s*$/s.exec(trimmed);
  const rawAddress = (angle ? (angle[2] as string) : trimmed).trim();
  if (!ADDRESS_SHAPE.test(rawAddress)) return null;
  const address = rawAddress.toLowerCase();
  if (!angle) return { address, name: null };
  const name = decodeHeader((angle[1] as string).trim())
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^"(.*)"$/, '$1')
    .trim();
  return { address, name: name === '' ? null : name };
}

/** Split a header value on commas outside quotes and angle brackets, then parse each. */
export function parseAddressList(raw: string): ParsedAddress[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') depth++;
    else if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !quoted && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const out: ParsedAddress[] = [];
  for (const p of parts) {
    const parsed = parseAddress(p);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** True when a `Precedence` header value marks bulk mail. */
export function isBulkPrecedence(value: string): boolean {
  return /^(bulk|list|junk)$/i.test(value.trim());
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  lrm: '‎',
  rlm: '‏',
};

function safeCodePoint(n: number, fallback: string): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#x')) return safeCodePoint(parseInt(body.slice(2), 16), m);
    if (body.startsWith('#')) return safeCodePoint(parseInt(body.slice(1), 10), m);
    return Object.hasOwn(NAMED_ENTITIES, body) ? (NAMED_ENTITIES[body] as string) : m;
  });
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function capBody(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_BODY_CHARS) return { text, truncated: false };
  let cut = text.slice(0, MAX_BODY_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // never end on half a surrogate pair
  return { text: cut, truncated: true };
}
