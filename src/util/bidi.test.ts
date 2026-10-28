import { describe, expect, it } from 'vitest';
import { markInvisibleControls, stripBidiControls } from './bidi.js';

const BIDI = [
  '\u061C',
  '\u200E',
  '\u200F',
  '\u202A',
  '\u202B',
  '\u202C',
  '\u202D',
  '\u202E',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
];

describe('stripBidiControls', () => {
  it('removes exactly the bidi family and nothing else', () => {
    expect(stripBidiControls(`a${BIDI.join('')}b`)).toBe('ab');
    expect(stripBidiControls('a\u200Bb\u00ADc')).toBe('a\u200Bb\u00ADc');
  });
});

describe('markInvisibleControls', () => {
  it('marks every character stripBidiControls removes', () => {
    for (const ch of BIDI) {
      expect(markInvisibleControls(ch)).toMatch(/^⟦U\+[0-9A-F]{4}⟧$/);
    }
  });

  it('marks zero-width and hidden characters', () => {
    for (const ch of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', '\u00AD', '\u034F', '\u180E', '\u2061', '\u2064']) {
      expect(markInvisibleControls(`a${ch}b`)).toMatch(/^a⟦U\+[0-9A-F]{4}⟧b$/);
    }
  });

  it('marks tag characters by code point', () => {
    expect(markInvisibleControls('a\u{E0041}b')).toBe('a⟦U+E0041⟧b');
    expect(markInvisibleControls('a\u{E007F}b')).toBe('a⟦U+E007F⟧b');
  });

  it('marks C0/C1 controls except TAB', () => {
    expect(markInvisibleControls('a\u0000b')).toBe('a⟦U+0000⟧b');
    expect(markInvisibleControls('a\u007Fb')).toBe('a⟦U+007F⟧b');
    expect(markInvisibleControls('a\u009Fb')).toBe('a⟦U+009F⟧b');
    expect(markInvisibleControls('a\tb')).toBe('a\tb');
  });

  it('leaves ordinary text, including Hebrew and emoji, alone', () => {
    expect(markInvisibleControls('שלום 😀 abc')).toBe('שלום 😀 abc');
  });
});
