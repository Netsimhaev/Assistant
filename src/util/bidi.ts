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
 * Zero-width characters that render as nothing and so hide a byte difference:
 * U+200B/C/D (space, non-joiner, joiner), U+2060 word joiner, U+FEFF BOM/ZWNBSP.
 */
const ZERO_WIDTH = '​‌‍⁠﻿';

// Built from BIDI_CONTROLS' own class, never a second copy of it.
const INVISIBLE_CONTROLS = new RegExp(`${BIDI_CONTROLS.source.slice(0, -1)}${ZERO_WIDTH}]`, 'g');

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
