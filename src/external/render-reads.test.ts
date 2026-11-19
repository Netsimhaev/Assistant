import { describe, expect, it } from 'vitest';
import { cutLine, MAX_READ_LINES, READS_ON_DASHBOARD_LINE, renderReadsForOwner } from './render-reads.js';
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

  it('caps at 40 lines and the cut line counts FIELD lines, not headings', () => {
    const fields = Array.from({ length: 60 }, (_, i) => ({ label: `f${i}`, value: 'v' }));
    const out = renderReadsForOwner([{ systemId: 'crm', operation: 'lookup', fields }], SYSTEMS);
    const lines = out.split('\n');
    expect(lines).toHaveLength(MAX_READ_LINES);
    // 1 header + 38 fields + the cut line: 22 of the 60 fields are omitted.
    expect(lines.at(-1)).toBe(cutLine(22));
  });

  it('respects a character budget, cutting at whole lines', () => {
    const fields = Array.from({ length: 20 }, (_, i) => ({ label: `f${i}`, value: 'x'.repeat(500) }));
    const out = renderReadsForOwner([{ systemId: 'crm', operation: 'lookup', fields }], SYSTEMS, { maxChars: 1500 });
    expect(out.length).toBeLessThanOrEqual(1500);
    const lines = out.split('\n');
    expect(lines.at(-1)).toMatch(/^… ועוד \d+ שורות שלא הוצגו$/);
    expect(lines.slice(1, -1).every((l) => l.length > 500)).toBe(true);
  });

  it('says the result is on the dashboard when not one field fits', () => {
    const out = renderReadsForOwner(
      [{ systemId: 'crm', operation: 'lookup', fields: [{ label: 'a', value: 'x'.repeat(500) }] }],
      SYSTEMS,
      { maxChars: 100 },
    );
    expect(out).toBe(READS_ON_DASHBOARD_LINE);
  });

  it('stringifies non-string values instead of throwing', () => {
    const out = renderReadsForOwner(
      [{
        systemId: 'crm', operation: 'lookup',
        fields: [{ label: 'n', value: 5 as never }, { label: 'o', value: { a: 1 } as never }, { label: 'z', value: null as never }],
      }],
      SYSTEMS,
    );
    expect(out).toBe('מה-CRM — חיפוש לקוח:\nn: 5\no: {"a":1}\nz: ');
  });

  it('is empty for no reads', () => {
    expect(renderReadsForOwner([], SYSTEMS)).toBe('');
  });
});
