/**
 * Removing the Unicode directionality controls from a string that will be
 * shown to a person.
 *
 * On a right-to-left surface a right-to-left override makes
 * `invoice‮gpj.exe` render as `invoiceexe.jpg` — a label that *looks* like
 * the thing the reader is expecting can be a different thing. Stripping the
 * controls does not make the value trustworthy (nothing can); it makes what
 * the reader sees the same as what the bytes say.
 *
 * **One definition, two surfaces, and that is the whole reason this file
 * exists.** `escLabel` (`src/dashboard/views.ts`) has carried this set since
 * the signing card needed it for `original_name`; the WhatsApp channel now
 * needs the same strip for plain text — an instruction snippet echoed back
 * to the owner, which can originate in a transcription provider's output
 * rather than in his own keystrokes. `escLabel` cannot serve that: it also
 * HTML-escapes, and an HTML entity in a WhatsApp message renders as the
 * literal `&lt;`. Two copies of the character class would be exactly the
 * duplicated control this project already paid for once
 * (`BROWSER_ADDRESSED_CLASSES`), so `escLabel` is now `esc(stripBidiControls(…))`
 * and this is the only place the set is written down.
 *
 * The set: U+061C ALM, U+200E/U+200F LRM/RLM, U+202A–U+202E (the embedding
 * and override family), U+2066–U+2069 (the isolate family).
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROLS, '');
}

/**
 * Characters that render as nothing (or as a line break), written as explicit
 * range strings. This is deliberately NOT derived from `BIDI_CONTROLS`: a
 * derivation that slices another regex's source breaks silently if that regex
 * changes shape. The bidi ranges below mirror `BIDI_CONTROLS`; a test checks
 * that every character `stripBidiControls` removes is marked here too.
 */
const BIDI_RANGES = '\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069';

/**
 * Zero-width and hidden characters: U+200B/C/D, U+2060 word joiner, U+FEFF,
 * U+00AD soft hyphen, U+034F combining grapheme joiner, U+180E Mongolian vowel
 * separator, U+2061-U+2064 invisible operators.
 */
const ZERO_WIDTH_RANGES = '\\u200B-\\u200D\\u2060\\uFEFF\\u00AD\\u034F\\u180E\\u2061-\\u2064';

/** Every C0/C1 control (Cc) except TAB (U+0009). */
const CONTROL_RANGES = '\\u0000-\\u0008\\u000A-\\u001F\\u007F-\\u009F';

/** Unicode tag characters U+E0000-U+E007F (needs the `u` flag). */
const TAG_RANGE = '\\u{E0000}-\\u{E007F}';

const INVISIBLE_CONTROLS = new RegExp(
  `[${BIDI_RANGES}${ZERO_WIDTH_RANGES}${CONTROL_RANGES}${TAG_RANGE}]`,
  'gu',
);

/**
 * Make invisible controls visible instead of removing them: each becomes
 * `⟦U+202E⟧`. For a value the owner is about to approve, stripping would show
 * `a@b.co` for bytes that are not `a@b.co`; the marker shows that they differ.
 */
export function markInvisibleControls(value: string): string {
  return value.replace(
    INVISIBLE_CONTROLS,
    (ch) => `⟦U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`,
  );
}
