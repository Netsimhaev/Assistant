import { describe, expect, it } from 'vitest';
import { parseReading, readingProblems } from './reading-parse.js';
import { BRIEF_TEXT_CHARS, renderReadingBrief } from './brief.js';
import type { DocumentArtifact } from './types.js';
import type { Reading } from '../domain/reading.js';

/** The ordinals a brief of the two parts below actually carries. */
const INCLUDED = [0, 1];

const VALID = {
  summary: 'הצעת מחיר מספק חדש.',
  findings: [{ label: 'סכום', value: '4,500 ש"ח', sourceRef: { ordinal: 1, locator: 'שורה 3' } }],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 1, locator: null } }],
  unreadable: [],
};

describe('parseReading', () => {
  it('parses a bare JSON object', () => {
    const outcome = parseReading(JSON.stringify(VALID), INCLUDED);
    expect(outcome.status).toBe('read');
    if (outcome.status !== 'read') throw new Error('expected a reading');
    expect(outcome.reading.summary).toBe('הצעת מחיר מספק חדש.');
  });

  it('parses a response wrapped in prose and a fenced block', () => {
    const raw = `הנה הקריאה:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\nזהו.`;
    expect(parseReading(raw, INCLUDED).status).toBe('read');
  });

  it('skips an illustrative object and finds the real one', () => {
    const raw = `לדוגמה: {"summary": "x"}\nוהתשובה: ${JSON.stringify(VALID)}`;
    const outcome = parseReading(raw, INCLUDED);
    expect(outcome.status).toBe('read');
  });

  it('reports unreadable when there is no JSON at all', () => {
    const outcome = parseReading('לא הצלחתי לקרוא את המסמך.', INCLUDED);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('JSON');
  });

  it('reports unreadable when the shape does not match', () => {
    const outcome = parseReading(JSON.stringify({ summary: 'x', intents: [] }), INCLUDED);
    expect(outcome.status).toBe('unreadable');
  });

  it('rejects a citation to a part that does not exist', () => {
    const fabricated = {
      ...VALID,
      findings: [{ label: 'סכום', value: '4,500', sourceRef: { ordinal: 99, locator: null } }],
    };
    const outcome = parseReading(JSON.stringify(fabricated), INCLUDED);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('99');
  });

  it('rejects a fabricated citation on an intent, not only on a finding', () => {
    const fabricated = {
      ...VALID,
      intents: [{ intent: 'file_document', subject: { kind: 'sender' }, sourceRef: { ordinal: 7, locator: null } }],
    };
    expect(parseReading(JSON.stringify(fabricated), INCLUDED).status).toBe('unreadable');
  });

  it('rejects __proto__ arriving as an entityId through JSON.parse', () => {
    const hostile = {
      ...VALID,
      intents: [
        {
          intent: 'contact_counterparty',
          subject: { kind: 'entity', entityId: '__proto__' },
          sourceRef: { ordinal: 1, locator: null },
        },
      ],
    };
    expect(parseReading(JSON.stringify(hostile), INCLUDED).status).toBe('unreadable');
  });
});

describe('citations against a brief the total ceiling cut', () => {
  /** Five text parts of BRIEF_TEXT_CHARS each — comfortably past the 24,000 total. */
  function oversizedDocument(): DocumentArtifact[] {
    const parts: DocumentArtifact[] = [];
    for (let ordinal = 0; ordinal < 5; ordinal += 1) {
      parts.push({
        ordinal,
        kind: 'text',
        partName: `חלק ${ordinal}`,
        content: { blocks: [{ kind: 'paragraph', text: 'א'.repeat(BRIEF_TEXT_CHARS) }] },
        flags: [],
      });
    }
    return parts;
  }

  it('rejects a citation to a part the total-brief ceiling dropped', () => {
    const artifacts = oversizedDocument();
    const { brief, includedOrdinals } = renderReadingBrief(artifacts);

    // The premise, asserted rather than assumed: part 4 exists in the document
    // and the ceiling cut it out of the brief. Without this the test could
    // pass because no truncation ever happened. Both of these hold however
    // `includedOrdinals` is computed, so the assertions below are what carry
    // the finding — feed the check every artefact instead and the citation is
    // accepted, which is the failure this test exists to produce.
    const dropped = 4;
    expect(artifacts.some((artifact) => artifact.ordinal === dropped)).toBe(true);
    expect(brief).not.toContain(`[חלק ${dropped}]`);

    const citesDropped = {
      ...VALID,
      findings: [
        { label: 'סכום', value: '4,500', sourceRef: { ordinal: dropped, locator: null } },
      ],
    };
    const outcome = parseReading(JSON.stringify(citesDropped), includedOrdinals);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain(String(dropped));
    expect(includedOrdinals).not.toContain(dropped);
  });

  it('still accepts a citation to a part that survived the cut', () => {
    // The other half: the ceiling must not turn every citation into a
    // fabrication. A test that only proves rejection would pass against a
    // check that rejects everything.
    const { includedOrdinals } = renderReadingBrief(oversizedDocument());
    const survivor = includedOrdinals[0];
    expect(survivor).toBeDefined();
    const citesSurvivor = {
      ...VALID,
      findings: [{ label: 'סכום', value: '4,500', sourceRef: { ordinal: survivor, locator: null } }],
      intents: [
        { intent: 'no_action', subject: { kind: 'sender' }, sourceRef: { ordinal: survivor, locator: null } },
      ],
    };
    expect(parseReading(JSON.stringify(citesSurvivor), includedOrdinals).status).toBe('read');
  });
});

describe('readingProblems', () => {
  it('finds nothing wrong with citations that resolve', () => {
    const outcome = parseReading(JSON.stringify(VALID), INCLUDED);
    if (outcome.status !== 'read') throw new Error('expected a reading');
    expect(readingProblems(outcome.reading, INCLUDED)).toEqual([]);
  });

  it('names the bad ordinal and where it appeared', () => {
    const readingWithBadFinding = {
      ...VALID,
      intents: [{ intent: 'no_action', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null } }],
    };
    const outcome = parseReading(JSON.stringify(readingWithBadFinding), INCLUDED);
    if (outcome.status !== 'read') throw new Error('expected a reading');
    const problems = readingProblems(outcome.reading, [0]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'unknown_source', ordinal: 1, where: 'finding' });
  });

  it('detects bad citations on intents, not only findings', () => {
    const outcome = parseReading(JSON.stringify(VALID), INCLUDED);
    if (outcome.status !== 'read') throw new Error('expected a reading');
    // Modify the reading to have an intent with a bad ordinal, but keep findings valid
    const readingWithBadIntent: Reading = {
      ...outcome.reading,
      intents: [{ intent: 'no_action', subject: { kind: 'sender' }, sourceRef: { ordinal: 99, locator: null }, note: '' }],
    };
    const problems = readingProblems(readingWithBadIntent, INCLUDED);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'unknown_source', ordinal: 99, where: 'intent' });
  });
});
