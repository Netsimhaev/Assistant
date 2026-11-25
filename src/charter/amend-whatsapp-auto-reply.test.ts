import { describe, expect, it } from 'vitest';
import { INTERVIEW_NEVER_PREFIX } from './interview/build.js';
import { whatsAppContactsConnection } from './amend-whatsapp-contacts.js';
import {
  AutoReplyNotSignedError,
  AutoReplyPreconditionError,
  autoReplyBlockedByNever,
  autoReplySigned,
  buildWhatsAppAutoReplyAmendment,
  buildWhatsAppAutoReplyRevert,
} from './amend-whatsapp-auto-reply.js';
import { buildCharter } from '../test/fixtures.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const connected = (base: 'approve_required' | 'auto_notify' | 'auto' = 'approve_required', extra = {}) =>
  buildCharter({ connections: [whatsAppContactsConnection()], subprocessorsAllowed: ['anthropic', 'green-api'], autonomyBase: { 'whatsapp.reply': base }, ...extra });

describe('whatsapp auto-reply amendment', () => {
  it('copies every field but the four changed ones', () => {
    const active = connected();
    const next = buildWhatsAppAutoReplyAmendment(active, NOW);
    expect(next.autonomy.base['whatsapp.reply']).toBe('auto_notify');
    expect(next.charterVersion).toMatch(/\.war-/);
    expect(next.supersedes).toBe(active.charterVersion);
    expect(next.effectiveFrom).toBe(NOW.toISOString());
    const strip = (c: Record<string, any>) => {
      const o = structuredClone(c);
      delete o['signature'];
      delete o['charterVersion'];
      delete o['effectiveFrom'];
      delete o['supersedes'];
      delete o['autonomy'].base['whatsapp.reply'];
      return o;
    };
    expect(strip(next as never)).toEqual(strip(active as never));
  });

  it('throws without the connection, when already signed, or when a never-rule exists', () => {
    expect(() => buildWhatsAppAutoReplyAmendment(buildCharter({ autonomyBase: { 'whatsapp.reply': 'approve_required' } }), NOW)).toThrow(AutoReplyPreconditionError);
    expect(() => buildWhatsAppAutoReplyAmendment(connected('auto_notify'), NOW)).toThrow(AutoReplyPreconditionError);
    const never = connected('approve_required', {
      forbidden: [{ id: `${INTERVIEW_NEVER_PREFIX}whatsapp.reply`, description: 'x', actionClasses: ['whatsapp.reply'] }],
    });
    expect(autoReplyBlockedByNever(never)).toBe(true);
    expect(() => buildWhatsAppAutoReplyAmendment(never, NOW)).toThrow(AutoReplyPreconditionError);
  });

  it('autoReplySigned reads connection and base', () => {
    expect(autoReplySigned(connected('auto_notify'))).toBe(true);
    expect(autoReplySigned(connected('auto'))).toBe(true);
    expect(autoReplySigned(connected('approve_required'))).toBe(false);
    expect(autoReplySigned(buildCharter({ autonomyBase: { 'whatsapp.reply': 'auto_notify' } }))).toBe(false);
  });

  it('revert sets approve_required and throws when not signed', () => {
    const active = connected('auto_notify');
    const back = buildWhatsAppAutoReplyRevert(active, NOW);
    expect(back.autonomy.base['whatsapp.reply']).toBe('approve_required');
    expect(back.charterVersion).toMatch(/\.war-revert-/);
    expect(() => buildWhatsAppAutoReplyRevert(connected('approve_required'), NOW)).toThrow(AutoReplyNotSignedError);
  });
});
