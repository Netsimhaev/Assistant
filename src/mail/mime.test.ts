import { describe, expect, it } from 'vitest';
import { capBody, decodeHeader, htmlToText, MAX_BODY_CHARS, parseAddress, parseAddressList } from './mime.js';

describe('decodeHeader', () => {
  it('decodes =?UTF-8?B?...?= Hebrew and =?UTF-8?Q?...?=', () => {
    const b = `=?UTF-8?B?${Buffer.from('שלום עולם', 'utf8').toString('base64')}?=`;
    expect(decodeHeader(b)).toBe('שלום עולם');
    expect(decodeHeader('=?UTF-8?Q?caf=C3=A9_ok?=')).toBe('café ok');
    expect(decodeHeader('plain text')).toBe('plain text');
  });
  it('joins adjacent encoded words', () => {
    expect(decodeHeader('=?UTF-8?Q?a?= =?UTF-8?Q?b?=')).toBe('ab');
  });
});

describe('parseAddress', () => {
  it('returns a bare lowercased address and a decoded name', () => {
    expect(parseAddress('"Dana Cohen" <Dana@Example.COM>')).toEqual({ address: 'dana@example.com', name: 'Dana Cohen' });
    expect(parseAddress('X@Y.com')).toEqual({ address: 'x@y.com', name: null });
    expect(parseAddressList('"A, B" <a@x.com>, c@y.com').map((p) => p.address)).toEqual(['a@x.com', 'c@y.com']);
  });
});

describe('htmlToText', () => {
  it('drops script/style content and decodes &amp;', () => {
    const t = htmlToText('<style>p{}</style><p>a &amp; b</p><script>evil()</script><p>c&nbsp;d</p>');
    expect(t).toBe('a & b\nc d');
  });
});

describe('capBody', () => {
  it('truncates at 1,000,000 chars and flags it', () => {
    const r = capBody('x'.repeat(MAX_BODY_CHARS + 5));
    expect(r.text.length).toBe(1_000_000);
    expect(r.truncated).toBe(true);
    expect(capBody('short')).toEqual({ text: 'short', truncated: false });
  });
});
