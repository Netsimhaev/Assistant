import { describe, expect, it } from 'vitest';
import {
  domainMatches,
  extractAddressCandidate,
  extractDomain,
  normaliseDomainString,
} from './address.js';

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

  it('strips a trailing dot', () => {
    // Legal DNS notation (a fully-qualified domain name), and EMAIL_SHAPE in
    // mail.ts accepts it -- without this, a charter entry for 'rival.co.il'
    // never matched 'rival.co.il.' and the message went out anyway.
    expect(extractDomain('dana@rival.co.il.')).toBe('rival.co.il');
  });

  it('strips every trailing dot, not just one', () => {
    // Stripping only one dot would normalise 'rival.co.il..' to
    // 'rival.co.il.', which still fails to match a charter entry for
    // 'rival.co.il' -- the same bypass shape, one character further out.
    expect(extractDomain('dana@rival.co.il..')).toBe('rival.co.il');
    expect(extractDomain('dana@rival.co.il...')).toBe('rival.co.il');
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

describe('normaliseDomainString', () => {
  // The function extractDomain delegates to, and the one
  // src/charter/compile.ts's normaliseDomain also delegates to -- this is
  // what keeps a charter entry and an inbound address comparable, not two
  // independent implementations of "strip a dot."
  it('lower-cases and trims', () => {
    expect(normaliseDomainString('  Rival.Co.IL  ')).toBe('rival.co.il');
  });

  it('drops a leading @', () => {
    expect(normaliseDomainString('@rival.co.il')).toBe('rival.co.il');
  });

  it('strips every trailing dot', () => {
    expect(normaliseDomainString('rival.co.il.')).toBe('rival.co.il');
    expect(normaliseDomainString('rival.co.il..')).toBe('rival.co.il');
  });

  it('returns null for a string that normalises to nothing', () => {
    expect(normaliseDomainString('')).toBeNull();
    expect(normaliseDomainString('.')).toBeNull();
    expect(normaliseDomainString('   ')).toBeNull();
  });

  it('agrees with itself on both a bare domain and the domain extracted from an address', () => {
    // The property T7-19 was about: whatever a charter author wrote for
    // emailDomain and whatever extractDomain reads off an inbound address
    // must land on the identical normalised string when they name the same
    // domain, however either side was spelled.
    expect(normaliseDomainString('Rival.co.il.')).toBe(extractDomain('dana@rival.co.il'));
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
