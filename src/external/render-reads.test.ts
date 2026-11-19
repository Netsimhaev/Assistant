import { describe, expect, it } from 'vitest';
import { cutLine, MAX_READ_LINES, renderReadsForOwner } from './render-reads.js';
import type { ExternalSystem } from '../domain/external-system.js';

const SYSTEMS = [
  { id: 'crm', label: 'ה-CRM', operations: [{ name: 'lookup', label: 'חיפוש לקוח' }] },
] as unknown as ExternalSystem[];

describe('renderReadsForOwner', () => {
  it('heads each read with the signed labels and lists label: value', () => {
    const out = renderReadsForOwner(
      [{ systemId: 'crm', operation: 'lookup', fields: [{ label: 'שם', value: 'דנה' }] }],
      SYSTEMS,
    );
    expect(out).toBe('מה-CRM — חיפוש לקוח:\nשם: דנה');
  });

  it('strips bidi controls from values and falls back to ids for unsigned systems', () => {
    const out = renderReadsForOwner(
      [{ systemId: 'gone', operation: 'op\u202E', fields: [{ label: 'a', value: 'x\u202Ey' }] }],
      SYSTEMS,
    );
    expect(out).toBe('מgone — op:\na: xy');
  });

  it('caps at 40 lines with a final line counting what was cut', () => {
    const fields = Array.from({ length: 60 }, (_, i) => ({ label: `f${i}`, value: 'v' }));
    const out = renderReadsForOwner([{ systemId: 'crm', operation: 'lookup', fields }], SYSTEMS);
    const lines = out.split('\n');
    expect(lines).toHaveLength(MAX_READ_LINES);
    expect(lines.at(-1)).toBe(cutLine(61 - 39));
  });

  it('is empty for no reads', () => {
    expect(renderReadsForOwner([], SYSTEMS)).toBe('');
  });
});
