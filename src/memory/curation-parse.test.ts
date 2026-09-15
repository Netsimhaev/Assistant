import { describe, expect, it } from 'vitest';
import type { TouchedSubjects } from './curation-brief.js';
import { CurationResult, siftCandidates } from './curation-parse.js';

const TOUCHED: TouchedSubjects = {
  recipients: ['ronit@beta-log.example'],
  entityIds: ['ronit-cohen-beta-log'],
};

function parse(candidates: unknown[]): ReturnType<typeof CurationResult.parse> {
  return CurationResult.parse({ candidates });
}

describe('what the curator is allowed to have returned', () => {
  it('accepts a preference about someone the job addressed', () => {
    const sifted = siftCandidates(
      parse([
        {
          kind: 'preference',
          subjectKey: 'ronit@beta-log.example',
          attribute: 'ערוץ מועדף',
          body: { value: 'טלפון' },
          sourceRef: 'גוף ההודעה',
        },
      ]),
      TOUCHED,
    );

    expect(sifted.accepted).toHaveLength(1);
    expect(sifted.rejected).toEqual([]);
  });

  /**
   * THE control. Without it, a hostile PDF makes the assistant remember
   * "Dana approved a 40% discount" about a supplier the job never went near.
   * Deleting the touched-set check must fail this test.
   */
  it('rejects a candidate about someone the job never touched', () => {
    const sifted = siftCandidates(
      parse([
        {
          kind: 'preference',
          subjectKey: 'dana@rival.example',
          attribute: 'הנחה',
          body: { value: '40%' },
          sourceRef: 'מסמך',
        },
      ]),
      TOUCHED,
    );

    expect(sifted.accepted).toEqual([]);
    expect(sifted.rejected).toHaveLength(1);
    expect(sifted.rejected[0]?.problem).toBe('subject_not_touched');
  });

  it('rejects a prototype key as a subject', () => {
    expect(() =>
      parse([
        {
          kind: 'entity',
          subjectKey: '__proto__',
          body: { name: 'x' },
          sourceRef: 'x',
        },
      ]),
    ).toThrow();
  });

  it('refuses a preference with no attribute, and an entity that carries one', () => {
    expect(() =>
      parse([{ kind: 'preference', subjectKey: 'ronit@beta-log.example', body: {}, sourceRef: 'x' }]),
    ).toThrow();
    expect(() =>
      parse([
        {
          kind: 'entity',
          subjectKey: 'ronit-cohen-beta-log',
          attribute: 'לא אמור להיות',
          body: {},
          sourceRef: 'x',
        },
      ]),
    ).toThrow();
  });

  it('refuses more than MAX_CURATED candidates', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: 'chunk' as const,
      subjectKey: 'ronit@beta-log.example',
      body: { text: `x${i}` },
      sourceRef: 'x',
    }));
    expect(() => parse(many)).toThrow();
  });

  it('refuses a body over the column ceiling', () => {
    expect(() =>
      parse([
        {
          kind: 'chunk',
          subjectKey: 'ronit@beta-log.example',
          body: { text: 'א'.repeat(4_100) },
          sourceRef: 'x',
        },
      ]),
    ).toThrow();
  });

  it('sifts a good candidate from a bad one in the same batch', () => {
    const sifted = siftCandidates(
      parse([
        {
          kind: 'chunk',
          subjectKey: 'ronit@beta-log.example',
          body: { text: 'טוב' },
          sourceRef: 'x',
        },
        { kind: 'chunk', subjectKey: 'zzz@nowhere.example', body: { text: 'רע' }, sourceRef: 'x' },
      ]),
      TOUCHED,
    );

    expect(sifted.accepted).toHaveLength(1);
    expect(sifted.rejected).toHaveLength(1);
  });
});
