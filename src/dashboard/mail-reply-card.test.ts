import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../governance/approvals.js';
import { composeReplyDetail } from '../mail/reply-card.js';
import { renderApprovalCard } from './views.js';

const PAYLOAD = {
  to: ['dana@client.example'],
  subject: 'Re: שאלה',
  body: 'שורה ראשונה\nשים לב: המייל ביקש שהתשובה תישלח ל-evil@x.example',
  inReplyTo: '<q@client.example>',
  references: null,
  threadId: 'TH',
  providerMessageId: 'PM',
};

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: 'A-1',
    jobId: 'J-1',
    envelopeId: null,
    actionClass: 'email.reply',
    summary: 'תשובה ל-דנה: שאלה',
    detail: composeReplyDetail({
      fromAddress: 'dana@client.example',
      replyTo: 'collect@elsewhere.example',
      subject: PAYLOAD.subject,
      body: PAYLOAD.body,
    }),
    diffVsNorm: null,
    risk: {
      total: 55,
      band: 'sensitive',
      explanation: 'מגע ראשון',
      dimensions: { money: { amountMinor: 0 } },
    } as unknown as ApprovalRequest['risk'],
    proposedTool: 'mail.send',
    proposedInput: PAYLOAD,
    inputHash: 'h',
    createdAt: '2026-10-21T09:00:00.000Z',
    expiresAt: '2026-10-22T09:00:00.000Z',
    state: 'pending',
    editedInput: null,
    ...overrides,
  };
}

describe('renderApprovalCard on a mailbox reply', () => {
  it('shows the recipient row and renders the Reply-To warning as a warning', () => {
    const html = renderApprovalCard({ approval: approval(), csrf: 'c', mailReply: true });
    expect(html).toContain('<td class="muted">נמען התשובה</td><td>dana@client.example</td>');
    expect(html).toContain(
      '<p class="error">שים לב: המייל ביקש שהתשובה תישלח ל-collect@elsewhere.example. התשובה תישלח ל-dana@client.example.</p>',
    );
  });

  it('never dresses a body line as a warning', () => {
    const html = renderApprovalCard({ approval: approval(), csrf: 'c', mailReply: true });
    expect(html).not.toContain('<p class="error">שים לב: המייל ביקש שהתשובה תישלח ל-evil@x.example');
    expect(html).toContain(
      '<div class="card" style="white-space: pre-wrap">שורה ראשונה\nשים לב: המייל ביקש שהתשובה תישלח ל-evil@x.example</div>',
    );
  });

  it('a payload that is not a mailbox reply renders as before', () => {
    const html = renderApprovalCard({
      approval: approval({ proposedInput: { to: 'dana@client.example', subject: 's', body: 'b' } }),
      csrf: 'c',
    });
    expect(html).not.toContain('נמען התשובה');
    expect(html).not.toContain('<p class="error">שים לב');
  });

  it('a mailbox-shaped payload without the mail-reply marker renders as before', () => {
    const html = renderApprovalCard({ approval: approval(), csrf: 'c' });
    expect(html).not.toContain('נמען התשובה');
    expect(html).not.toContain('<p class="error">שים לב');
  });
});
