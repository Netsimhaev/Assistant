import { describe, expect, it } from 'vitest';
import { contactReplyEditAllowed } from './contact-reply-edit.js';

const ORIGINAL = { to: '+972501234567', body: 'שלום', conversationId: 'conv-1' };

describe('contactReplyEditAllowed', () => {
  it('accepts a body-only edit', () => {
    expect(contactReplyEditAllowed(ORIGINAL, { ...ORIGINAL, body: 'נוסח אחר' })).toBe(true);
  });
  it('refuses a changed to or conversationId', () => {
    expect(contactReplyEditAllowed(ORIGINAL, { ...ORIGINAL, to: '+972509999999' })).toBe(false);
    expect(contactReplyEditAllowed(ORIGINAL, { ...ORIGINAL, conversationId: 'conv-2' })).toBe(false);
  });
  it('refuses an added or dropped key and non-objects', () => {
    expect(contactReplyEditAllowed(ORIGINAL, { ...ORIGINAL, attachDocumentId: 'D' })).toBe(false);
    expect(contactReplyEditAllowed(ORIGINAL, { to: ORIGINAL.to, body: 'x' })).toBe(false);
    expect(contactReplyEditAllowed(ORIGINAL, 'x')).toBe(false);
    expect(contactReplyEditAllowed(null, ORIGINAL)).toBe(false);
  });
});
