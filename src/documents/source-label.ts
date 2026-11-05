import type { DocumentSource } from './types.js';

/**
 * Who brought a document in, as the owner reads it.
 *
 * Lives here, not in `src/domain/labels.ts`: labels.ts is imported by
 * `src/sdk/doc-judge.ts`, whose transitive import graph must reach no
 * document-reading module (gov-verify.test.ts BFS invariant). A type import of
 * `documents/types` from labels.ts was enough to break that walk.
 */
export const documentSourceLabel: Readonly<Record<DocumentSource, string>> = Object.freeze({
  manual: 'תיקיית הקליטה',
  mail: 'מייל נכנס',
  api: 'חיבור חיצוני',
  instruction: 'צורף להוראה',
});
