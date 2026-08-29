import { describe, expect, it } from 'vitest';
import { interpretReaderResponse } from './know-reader.js';

/**
 * What the brief carried, not what the document holds. `runKnowReader` hands
 * this function `renderReadingBrief`'s `includedOrdinals`, so a part the total
 * ceiling dropped is absent here exactly as it is absent from the text.
 */
const INCLUDED = [0];

const VALID = JSON.stringify({
  summary: 'חשבונית מספק.',
  findings: [],
  intents: [{ intent: 'file_document', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null } }],
  unreadable: [],
});

describe('interpretReaderResponse', () => {
  it('turns a valid response into a reading and keeps the raw text', () => {
    const outcome = interpretReaderResponse(VALID, INCLUDED, [], 2);
    expect(outcome.status).toBe('read');
    expect(outcome.raw).toBe(VALID);
    expect(outcome.turns).toBe(2);
  });

  it('carries gate denials through on a successful read', () => {
    const outcome = interpretReaderResponse(VALID, INCLUDED, ['tool_not_allowlisted'], 1);
    expect(outcome.status).toBe('read');
    expect(outcome.denials).toEqual(['tool_not_allowlisted']);
  });

  it('reports unreadable, with the raw text kept, when nothing parses', () => {
    const outcome = interpretReaderResponse('לא הבנתי את המסמך', INCLUDED, [], 1);
    expect(outcome.status).toBe('unreadable');
    expect(outcome.raw).toBe('לא הבנתי את המסמך');
  });

  it('keeps denials on an unreadable outcome too', () => {
    const outcome = interpretReaderResponse('', INCLUDED, ['quiet_hours'], 0);
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
    const outcome = interpretReaderResponse(fabricated, INCLUDED, [], 1);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('42');
  });
});
