import { describe, expect, it } from 'vitest';
import type { DocumentArtifact } from '../documents/types.js';
import { interpretReaderResponse } from './know-reader.js';

const ARTIFACTS: DocumentArtifact[] = [
  { ordinal: 0, kind: 'text', partName: null, content: { blocks: [] }, flags: [] },
];

const VALID = JSON.stringify({
  summary: 'חשבונית מספק.',
  findings: [],
  intents: [{ intent: 'file_document', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null } }],
  unreadable: [],
});

describe('interpretReaderResponse', () => {
  it('turns a valid response into a reading and keeps the raw text', () => {
    const outcome = interpretReaderResponse(VALID, ARTIFACTS, [], 2);
    expect(outcome.status).toBe('read');
    expect(outcome.raw).toBe(VALID);
    expect(outcome.turns).toBe(2);
  });

  it('carries gate denials through on a successful read', () => {
    const outcome = interpretReaderResponse(VALID, ARTIFACTS, ['tool_not_allowlisted'], 1);
    expect(outcome.status).toBe('read');
    expect(outcome.denials).toEqual(['tool_not_allowlisted']);
  });

  it('reports unreadable, with the raw text kept, when nothing parses', () => {
    const outcome = interpretReaderResponse('לא הבנתי את המסמך', ARTIFACTS, [], 1);
    expect(outcome.status).toBe('unreadable');
    expect(outcome.raw).toBe('לא הבנתי את המסמך');
  });

  it('keeps denials on an unreadable outcome too', () => {
    const outcome = interpretReaderResponse('', ARTIFACTS, ['quiet_hours'], 0);
    expect(outcome.status).toBe('unreadable');
    expect(outcome.denials).toEqual(['quiet_hours']);
  });

  it('refuses a reading that cites a part the artefacts do not have', () => {
    const fabricated = JSON.stringify({
      summary: 'x',
      findings: [],
      intents: [{ intent: 'no_action', subject: { kind: 'sender' }, sourceRef: { ordinal: 42, locator: null } }],
      unreadable: [],
    });
    const outcome = interpretReaderResponse(fabricated, ARTIFACTS, [], 1);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('42');
  });
});
