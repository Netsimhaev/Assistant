import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../governance/approvals.js';
import { composeReplyDetail, MAY_HAVE_SENT_WARNING, RETRY_PREFIX } from './reply-card.js';
import { MAIL_CARD_INSTRUCTION, renderMailCardWhatsApp, renderMailNotice } from './whatsapp-notice.js';

const PAYLOAD = {
  to: ['dana@client.example'],
  subject: 'Re: מתי תגיע ההצעה?',
  body: 'שלום דנה,\nנחזור אלייך עד מחר.',
  inReplyTo: '<q-1@client.example>',
  references: null,
  threadId: 'TH-1',
  providerMessageId: 'PM-1',
};

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: 'AP-1',
    jobId: 'J-1',
    envelopeId: null,
    actionClass: 'email.reply',
    summary: 'תשובה ל-דנה לוי: מתי תגיע ההצעה?',
    detail: composeReplyDetail({
      fromAddress: 'dana@client.example',
      replyTo: null,
      subject: PAYLOAD.subject,
      body: PAYLOAD.body,
    }),
    diffVsNorm: null,
    risk: {} as ApprovalRequest['risk'],
    proposedTool: 'mail.send',
    proposedInput: PAYLOAD,
    inputHash: 'h',
    createdAt: '2026-10-21T09:00:00.000Z',
    expiresAt: '2026-10-21T13:00:00.000Z',
    state: 'pending',
    editedInput: null,
    ...overrides,
  };
}

describe('renderMailNotice', () => {
  it('notice strips bidi controls from the from name and summary', () => {
    const text = renderMailNotice(
      { fromName: '\u202Eדנה\u2066 לוי', fromAddress: 'dana@client.example', summary: 'שואלת\u200F מתי\u200E תגיע ההצעה' },
      ['question'],
    );
    expect(text).toBe('📧 דנה לוי <dana@client.example>\nשאלה שמחכה לתשובה: שואלת מתי תגיע ההצעה');
    expect(text).not.toMatch(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/);
  });
});

describe('renderMailNotice attachments', () => {
  const base = { fromName: 'דנה', fromAddress: 'dana@client.example', summary: 'מצורף' };
  it('notice adds attachment lines, capped at 3', () => {
    const attachments = [1, 2, 3, 4, 5].map((n) => ({ docType: 'invoice' as const, summary: 'סכום ' + n }));
    const text = renderMailNotice({ ...base, attachments }, ['invoice']);
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('📎'))).toEqual([
      '📎 חשבונית: סכום 1', '📎 חשבונית: סכום 2', '📎 חשבונית: סכום 3',
    ]);
    expect(lines[lines.length - 1]).toBe('ועוד 2');
  });
  it('folds each line and strips bidi controls', () => {
    const text = renderMailNotice(
      { ...base, attachments: [{ docType: 'quote', summary: 'שורה\n‮שנייה' }] },
      ['question'],
    );
    expect(text.split('\n').filter((l) => l.startsWith('📎'))).toEqual(['📎 הצעת מחיר: שורה שנייה']);
    expect(text).not.toMatch(/[‪-‮]/);
  });
  it('no attachments leaves the notice unchanged', () => {
    expect(renderMailNotice(base, ['question']).split('\n')).toHaveLength(2);
  });
});

describe('renderMailCardWhatsApp', () => {
  it('carries the recipient, the subject, the full body and ends with the instruction line', () => {
    const text = renderMailCardWhatsApp(approval(), PAYLOAD);
    expect(text).toContain('dana@client.example');
    expect(text).toContain('Re: מתי תגיע ההצעה?');
    expect(text).toContain('שלום דנה,\nנחזור אלייך עד מחר.');
    expect(text.endsWith(MAIL_CARD_INSTRUCTION)).toBe(true);
    expect(MAIL_CARD_INSTRUCTION).toBe('השב "שלח" כדי לשלוח, או "נוסח:" ואחריו נוסח חדש.');
  });

  it('strips bidi controls from every field it shows, the body included', () => {
    const payload = { ...PAYLOAD, subject: 'Re: \u202Eהצעה', body: 'גוף\u202E 500 ש"ח' };
    const text = renderMailCardWhatsApp(approval({ summary: 'תשובה ל-\u202Eדנה' }), payload);
    expect(text).not.toMatch(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/);
    expect(text).toContain('גוף 500 ש"ח');
  });

  it('shows the body it is given, not the one in the stored detail', () => {
    const text = renderMailCardWhatsApp(approval(), { ...PAYLOAD, body: 'נוסח חדש של הבעלים' });
    expect(text).toContain('נוסח חדש של הבעלים');
    expect(text).not.toContain('נחזור אלייך עד מחר');
  });

  it('refuses to render a payload that does not name exactly one recipient', () => {
    expect(() => renderMailCardWhatsApp(approval(), { ...PAYLOAD, to: ['a@x.example', 'b@x.example'] })).toThrow();
    expect(() => renderMailCardWhatsApp(approval(), { ...PAYLOAD, to: [] })).toThrow();
    expect(() => renderMailCardWhatsApp(approval(), { ...PAYLOAD, to: 'a@x.example' })).toThrow();
  });

  it('repeats the warning lines the card header carries', () => {
    const detail = composeReplyDetail({
      fromAddress: 'dana@client.example',
      replyTo: 'other@elsewhere.example',
      subject: PAYLOAD.subject,
      body: PAYLOAD.body,
      retry: { mayHaveSent: true },
    });
    const text = renderMailCardWhatsApp(approval({ detail }), PAYLOAD);
    expect(text).toContain(RETRY_PREFIX);
    expect(text).toContain(MAY_HAVE_SENT_WARNING);
    expect(text).toContain('other@elsewhere.example');
  });
});
