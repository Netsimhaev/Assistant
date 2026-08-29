import { describe, expect, it } from 'vitest';
import { parseReading, readingProblems } from './reading-parse.js';
import type { DocumentArtifact } from './types.js';

const ARTIFACTS: DocumentArtifact[] = [
  { ordinal: 0, kind: 'outline', partName: null, content: { parts: [], flags: [] }, flags: [] },
  { ordinal: 1, kind: 'text', partName: 'גוף', content: { blocks: [] }, flags: [] },
];

const VALID = {
  summary: 'הצעת מחיר מספק חדש.',
  findings: [{ label: 'סכום', value: '4,500 ש"ח', sourceRef: { ordinal: 1, locator: 'שורה 3' } }],
  intents: [{ intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: { ordinal: 1, locator: null } }],
  unreadable: [],
};

describe('parseReading', () => {
  it('parses a bare JSON object', () => {
    const outcome = parseReading(JSON.stringify(VALID), ARTIFACTS);
    expect(outcome.status).toBe('read');
    if (outcome.status !== 'read') throw new Error('expected a reading');
    expect(outcome.reading.summary).toBe('הצעת מחיר מספק חדש.');
  });

  it('parses a response wrapped in prose and a fenced block', () => {
    const raw = `הנה הקריאה:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\nזהו.`;
    expect(parseReading(raw, ARTIFACTS).status).toBe('read');
  });

  it('skips an illustrative object and finds the real one', () => {
    const raw = `לדוגמה: {"summary": "x"}\nוהתשובה: ${JSON.stringify(VALID)}`;
    const outcome = parseReading(raw, ARTIFACTS);
    expect(outcome.status).toBe('read');
  });

  it('reports unreadable when there is no JSON at all', () => {
    const outcome = parseReading('לא הצלחתי לקרוא את המסמך.', ARTIFACTS);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('JSON');
  });

  it('reports unreadable when the shape does not match', () => {
    const outcome = parseReading(JSON.stringify({ summary: 'x', intents: [] }), ARTIFACTS);
    expect(outcome.status).toBe('unreadable');
  });

  it('rejects a citation to a part that does not exist', () => {
    const fabricated = {
      ...VALID,
      findings: [{ label: 'סכום', value: '4,500', sourceRef: { ordinal: 99, locator: null } }],
    };
    const outcome = parseReading(JSON.stringify(fabricated), ARTIFACTS);
    expect(outcome.status).toBe('unreadable');
    if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
    expect(outcome.reason).toContain('99');
  });

  it('rejects a fabricated citation on an intent, not only on a finding', () => {
    const fabricated = {
      ...VALID,
      intents: [{ intent: 'file_document', subject: { kind: 'sender' }, sourceRef: { ordinal: 7, locator: null } }],
    };
    expect(parseReading(JSON.stringify(fabricated), ARTIFACTS).status).toBe('unreadable');
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
    expect(parseReading(JSON.stringify(hostile), ARTIFACTS).status).toBe('unreadable');
  });
});

describe('readingProblems', () => {
  it('finds nothing wrong with citations that resolve', () => {
    const outcome = parseReading(JSON.stringify(VALID), ARTIFACTS);
    if (outcome.status !== 'read') throw new Error('expected a reading');
    expect(readingProblems(outcome.reading, ARTIFACTS)).toEqual([]);
  });

  it('names the bad ordinal and where it appeared', () => {
    const readingWithBadFinding = {
      ...VALID,
      intents: [{ intent: 'no_action', subject: { kind: 'sender' }, sourceRef: { ordinal: 0, locator: null } }],
    };
    const outcome = parseReading(JSON.stringify(readingWithBadFinding), ARTIFACTS);
    if (outcome.status !== 'read') throw new Error('expected a reading');
    const problems = readingProblems(outcome.reading, [ARTIFACTS[0]!]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'unknown_source', ordinal: 1, where: 'finding' });
  });
});
