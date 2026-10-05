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
