import type { Reading } from '../domain/reading.js';

/**
 * The answer `gov.verify`'s judge receives, composed from what `know.reader`
 * produced — deterministically, with no model call of its own.
 *
 * **Why this function exists at all, rather than handing the judge the
 * document.** `verifyDraft` already receives `sources` (the full artifact
 * rendering) but uses them for ONE thing: deterministic numeric grounding,
 * which makes no model call. The judge's own prompt fences exactly three
 * fields — `question`, `answer`, `draftText` — and the raw document text is
 * deliberately not among them. The moment hostile document text enters the
 * judge's prompt, its verdict is exposed to the same injection as the draft it
 * is judging, and a judge that can be talked out of its finding is worth
 * nothing. This function is the bounded channel that replaces it.
 *
 * **Two fields, and why not more.** The summary is `know.reader`'s own
 * one-paragraph account of the document. The intent names are a CLOSED enum
 * (`IntentName`) — no free text can arrive through them, and they are
 * literally "what the document asks for", which is the first half of
 * `VERIFICATION_QUESTION`. Everything else in a `Reading` is excluded on
 * purpose: `findings[].label` and `intents[].note` are model-authored free
 * text, `sourceRef.quote` is a verbatim fragment of the hostile document
 * itself, and none of them tells the judge anything the summary does not.
 *
 * **No truncation here.** `verifyDraft` caps the answer it receives and
 * records the cut on the verdict (`Verdict.answerTruncated`). A second cap
 * here would be a second place a cut can happen, and only one of them would
 * be recorded — so the owner could read a verdict with no truncation flag on
 * an answer that was in fact cut. One cap, one record.
 *
 * Deterministic in the reading: intents are de-duplicated and sorted, so the
 * same reading always composes the same string regardless of the order the
 * model happened to emit them in.
 */
export function composeVerificationAnswer(reading: Reading): string {
  const asks = [...new Set(reading.intents.map((intent) => intent.intent))].sort();
  return [`תקציר: ${reading.summary}`, `מה המסמך מבקש: ${asks.join(', ')}`].join('\n');
}
