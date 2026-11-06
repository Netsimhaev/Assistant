/**
 * The `doc.produce` step payload (document production §4, §5.2) and the two
 * rules the handler applies to it in code rather than trusting the planner.
 *
 * Pure and DB-free, so the instruction door (`instruct.ts`) refuses a step
 * the handler would refuse with the SAME schema before the owner is told
 * anything, and the handler (`local-tools.ts`) parses with it.
 *
 * `request` is the planner's restatement of what to produce. It is validated
 * and NOT stored: the drafter reads the owner's own instruction
 * (`document_productions.instruction_text`), the trusted channel — a
 * restatement written by a model is not the owner's words.
 */
import { z } from 'zod';
import { SafeLookupKey } from '../domain/charter.js';
import { DocumentFormat, DocumentKind, DocumentLanguage } from '../domain/document-spec.js';

export const DocProduceInput = z
  .object({
    format: DocumentFormat,
    language: DocumentLanguage.optional(),
    kind: DocumentKind,
    request: z.string().min(1).max(4000),
    destination: z.discriminatedUnion('mode', [
      z
        .object({
          mode: z.literal('send'),
          to: z.array(z.string().min(1).max(320)).min(1).max(20),
          subject: z.string().max(200).optional(),
          body: z.string().max(4000).optional(),
        })
        .strict(),
      z.object({ mode: z.literal('save'), folder: z.string().max(1000).nullable() }).strict(),
    ]),
    sources: z.array(z.object({ documentId: SafeLookupKey }).strict()).max(10).optional(),
    sourceHints: z.array(z.string().min(1).max(200)).max(10).optional(),
  })
  .strict();
export type DocProduceInput = z.infer<typeof DocProduceInput>;

/**
 * The fixed phrases that count as an explicit request for English. Matched
 * case-insensitively as substrings of the OWNER's instruction — `in English`
 * is covered by `english`, and listed so the rule reads as the spec states it.
 */
export const ENGLISH_REQUEST_PHRASES: readonly string[] = ['באנגלית', 'in english', 'english'];

/**
 * `'en'` only when the planner asked for English AND the owner's own words
 * ask for it; otherwise `'he'`. A planner that writes `'en'` on its own —
 * steered by an English source document, say — does not turn the owner's
 * document into English.
 */
export function productionLanguage(
  planned: DocProduceInput['language'],
  instructionText: string,
): 'he' | 'en' {
  if (planned !== 'en') return 'he';
  const lower = instructionText.toLowerCase();
  return ENGLISH_REQUEST_PHRASES.some((phrase) => lower.includes(phrase)) ? 'en' : 'he';
}

/** The card note for an address the instruction did not authorise (spec §8.1, C12). */
export const UNAUTHORISED_ADDRESS_NOTE = 'כתובת לא מוסמכת — הקלידי אותה בכרטיס';

export function sourceMissingNote(hint: string): string {
  return `לא מצאתי את "${hint}"`;
}

export function sourceAmbiguousNote(hint: string): string {
  return `לא ידעתי בוודאות לאיזה מסמך התכוונת ב-"${hint}", ולכן לא צירפתי אותו`;
}
