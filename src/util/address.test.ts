import { describe, expect, it } from 'vitest';
import { domainMatches, extractAddressCandidate, extractDomain } from './address.js';

describe('extractAddressCandidate', () => {
  it('returns a bare address unchanged', () => {
    expect(extractAddressCandidate('dana@x.com')).toBe('dana@x.com');
  });

  it('trims surrounding whitespace off a bare address', () => {
    expect(extractAddressCandidate('  dana@x.com  ')).toBe('dana@x.com');
  });

  it('unwraps a trailing display-name form', () => {
    expect(extractAddressCandidate('Dana Cohen <dana@x.com>')).toBe('dana@x.com');
  });

  it('unwraps even when the text before the bracket looks like an address itself', () => {
    // The adversarial form: only the bracketed address counts.
    expect(extractAddressCandidate('a@b.com <evil@x.com>')).toBe('evil@x.com');
  });

  it('returns null for an empty fragment', () => {
    expect(extractAddressCandidate('')).toBeNull();
    expect(extractAddressCandidate('   ')).toBeNull();
  });

  it('does not unwrap a wrapper that is not at the end of the fragment', () => {
    // '<dana@x.com>' is not trailing here -- trailing text follows it -- so
    // this must not resolve to 'dana@x.com'. It also must not fall back to
    // the raw text, which still carries the bracket punctuation; see the
    // next two cases for why that punctuation is refused outright.
    expect(extractAddressCandidate('<dana@x.com> ignore this')).toBeNull();
  });

  it('falls through to null on an empty wrapper', () => {
    expect(extractAddressCandidate('<>')).toBeNull();
  });

  it('falls through to null on a doubled wrapper', () => {
    // Neither '<' can start a clean, single trailing '<...>' match: the
    // outer '<' is immediately followed by another '<', which the wrapper
    // pattern excludes from its content, and the inner '<...>' leaves a
    // trailing '>' that is not whitespace before the end of the string.
    // Falling back to the raw '<<a@b.com>>' would hand a later shape check
    // a "candidate" that still carries stray bracket punctuation.
    expect(extractAddressCandidate('<<a@b.com>>')).toBeNull();
  });

  it('falls through to null on a single stray closing bracket after a real address', () => {
    // The concrete regression: this is what 'dana@rival.co.il' becomes when
    // wrapped in a doubled closing bracket by malformed input. It must not
    // be treated as the plain address 'dana@rival.co.il' with punctuation
    // silently tolerated -- that is exactly how a domain check missed it.
    expect(extractAddressCandidate('<dana@rival.co.il>>')).toBeNull();
  });
});

describe('extractDomain', () => {
  it('reads the domain off a plain address, lower-cased', () => {
    expect(extractDomain('Dana@Rival.co.il')).toBe('rival.co.il');
  });

  it('strips exactly one trailing dot', () => {
    // Legal DNS notation (a fully-qualified domain name), and EMAIL_SHAPE in
    // mail.ts accepts it -- without this, a charter entry for 'rival.co.il'
    // never matched 'rival.co.il.' and the message went out anyway.
    expect(extractDomain('dana@rival.co.il.')).toBe('rival.co.il');
  });

  it('does not strip an internal dot, only a trailing one', () => {
    expect(extractDomain('dana@rival.co.il')).toBe('rival.co.il');
  });

  it('returns null for a candidate with no @', () => {
    expect(extractDomain('not-an-address')).toBeNull();
  });

  it('returns null for a candidate with more than one @, rather than guessing which part is the domain', () => {
    expect(extractDomain('a@b@c.com')).toBeNull();
  });

  it('returns null for a candidate with nothing after the @', () => {
    expect(extractDomain('dana@')).toBeNull();
  });

  it('returns null for a candidate that is only a trailing dot after the @', () => {
    expect(extractDomain('dana@.')).toBeNull();
  });
});

describe('domainMatches', () => {
  it('matches the domain itself', () => {
    expect(domainMatches('rival.co.il', 'rival.co.il')).toBe(true);
  });

  it('matches a true subdomain', () => {
    expect(domainMatches('mail.rival.co.il', 'rival.co.il')).toBe(true);
  });

  it('matches a deeper subdomain', () => {
    expect(domainMatches('a.b.rival.co.il', 'rival.co.il')).toBe(true);
  });

  it('does not match a lookalike domain that merely ends with the same letters', () => {
    // 'rival.co.il' is a plain substring of 'evilrival.co.il', but never
    // follows a '.' there -- a naive `.endsWith(pattern)` without the
    // anchoring dot would have matched this.
    expect(domainMatches('evilrival.co.il', 'rival.co.il')).toBe(false);
  });

  it('does not match an unrelated domain', () => {
    expect(domainMatches('example.com', 'rival.co.il')).toBe(false);
  });
});
