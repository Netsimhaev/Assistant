import { describe, expect, it } from 'vitest';
import { MeetingRequest, isMeetingInstruction, verifyTypedEmails } from './request.js';

const win = { fromDate: '2026-11-10', toDate: '2026-11-10', fromTime: null, toTime: null };

describe('MeetingRequest', () => {
  it('accepts create, move, cancel and edit ops and rejects an unknown field', () => {
    const ok = MeetingRequest.safeParse({
      ops: [
        { kind: 'create', client: { name: 'דני', email: null, phone: null }, location: null, clientNotes: null, internalNote: null, window: win, durationMinutes: 45 },
        { kind: 'move', clientName: 'דני', onDate: null, window: win },
        { kind: 'cancel', clientName: 'דני', onDate: '2026-11-11' },
        { kind: 'edit', clientName: 'דני', onDate: null, location: 'משרד' },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = MeetingRequest.safeParse({ ops: [{ kind: 'cancel', clientName: 'דני', onDate: null, extra: 1 }] });
    expect(bad.success).toBe(false);
  });
});

describe('verifyTypedEmails', () => {
  const req = MeetingRequest.parse({
    ops: [{ kind: 'create', client: { name: 'דני', email: 'dani@acme.co.il', phone: null }, location: null, clientNotes: null, internalNote: null, window: win, durationMinutes: null }],
  });
  it('drops an email that does not appear verbatim in the instruction', () => {
    const out = verifyTypedEmails(req, 'תקבעי פגישה עם דני מחר');
    expect(out.ops[0]).toMatchObject({ client: { email: null } });
  });
  it('keeps an email the owner typed', () => {
    const out = verifyTypedEmails(req, 'תקבעי פגישה עם דני dani@acme.co.il מחר');
    expect(out.ops[0]).toMatchObject({ client: { email: 'dani@acme.co.il' } });
  });
});

describe('isMeetingInstruction', () => {
  it('is true for "תקבעי פגישה עם דני מחר" and false for "תשלחי לדני מייל"', () => {
    expect(isMeetingInstruction('תקבעי פגישה עם דני מחר')).toBe(true);
    expect(isMeetingInstruction('תשלחי לדני מייל')).toBe(false);
  });
  it('accepts infinitive and ו-prefixed variants', () => {
    expect(isMeetingInstruction('צריך ולקבוע פגישה עם דנה')).toBe(true);
    expect(isMeetingInstruction('תזיזי את הפגישה של דנה למחר')).toBe(true);
    expect(isMeetingInstruction('תבטלי את הפגישה ביום שלישי')).toBe(true);
  });
  it('does not fire on a schedule question or a bare verb without a meeting/time word', () => {
    expect(isMeetingInstruction('מה יש לי מחר ביומן')).toBe(false);
    expect(isMeetingInstruction('תעדכני את דני')).toBe(false);
  });
});
