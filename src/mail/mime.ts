/**
 * MIME helpers shared by the mailbox clients: header decoding, address
 * parsing, HTML-to-text and the body size cap. Pure functions, no I/O.
 */

export const MAX_BODY_CHARS = 1_000_000;

function decodeBytes(bytes: Buffer, charset: string): string {
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

/** Decode RFC 2047 encoded words (B and Q). Whitespace between adjacent encoded words is dropped. */
export function decodeHeader(value: string): string {
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    const bytes = enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : decodeQ(text);
    return decodeBytes(bytes, charset);
  });
}

export interface ParsedAddress {
  address: string;
  name: string | null;
}

/** Parse one mailbox: `Name <a@b>`, `"Name" <a@b>` or bare `a@b`. Address is bare and lowercased. */
export function parseAddress(raw: string): ParsedAddress | null {
  const decoded = decodeHeader(raw).trim();
  if (decoded === '') return null;
  const angle = /^(.*)<([^<>]*)>\s*$/.exec(decoded);
  if (angle) {
    const address = (angle[2] as string).trim().toLowerCase();
    if (address === '') return null;
    const name = (angle[1] as string).trim().replace(/^"(.*)"$/, '$1').trim();
    return { address, name: name === '' ? null : name };
  }
  return { address: decoded.toLowerCase(), name: null };
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
  return { text: text.slice(0, MAX_BODY_CHARS), truncated: true };
}
