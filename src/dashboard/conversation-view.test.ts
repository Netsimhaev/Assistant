import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../whatsapp/store.js';
import { renderConversation } from './conversation-view.js';

function msg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'WA-1',
    providerMessageId: 'wamid.1',
    direction: 'inbound',
    senderNumber: '+972501234567',
    senderKind: 'principal',
    body: 'שלום',
    transcript: null,
    mediaKind: null,
    providerTimestamp: '2026-10-03T09:00:00.000Z',
    state: 'handled',
    jobId: null,
    createdAt: '2026-10-03T09:00:00.000Z',
    ...overrides,
  };
}

describe('renderConversation', () => {
  /**
   * Stranger-authored text on the owner's screen. `escLabel` exists because
   * a filename chosen by a sender can rearrange what the owner reads; a
   * message body is the same class and wider.
   */
  it('strips directionality characters from a message body', () => {
    const html = renderConversation({ messages: [msg({ body: 'שלום‮גרר' })], csrf: 'c' });
    expect(html).not.toContain('‮');
    expect(html).toContain('שלום');
  });

  it('escapes HTML in a message body', () => {
    const html = renderConversation({ messages: [msg({ body: '<script>alert(1)</script>' })], csrf: 'c' });
    expect(html).not.toContain('<script>');
  });

  // Ruling 1: `transcript` is the same class as `body` (a transcription
  // model's output from a stranger's audio) and `senderNumber` comes from
  // the provider, not from us. Both go through `escLabel` too.
  it('strips directionality characters from a transcript', () => {
    const html = renderConversation({
      messages: [msg({ body: null, transcript: 'הגעתי‮בשעה תשע' })],
      csrf: 'c',
    });
    expect(html).not.toContain('‮');
    expect(html).toContain('הגעתי');
  });

  it('strips directionality characters from the sender number', () => {
    const html = renderConversation({
      messages: [msg({ senderKind: 'other', senderNumber: '+97250000000‮0' })],
      csrf: 'c',
    });
    expect(html).not.toContain('‮');
  });

  it('shows a transcript where there is one, and marks it as a transcript', () => {
    const html = renderConversation({
      messages: [msg({ body: null, transcript: 'הגעתי בשעה תשע' })],
      csrf: 'c',
    });
    expect(html).toContain('הגעתי בשעה תשע');
    expect(html).toContain('תמלול');
  });

  // Decision 5: every message in the conversation is shown, labelled by who
  // sent it — the principal, a stranger, and the assistant's own outbound
  // replies all appear, and only the assistant's own compose box (one form
  // on the whole page) can originate anything new.
  it('shows messages from everyone, labelled by who sent them', () => {
    const html = renderConversation({
      messages: [
        msg({ id: 'WA-1', direction: 'inbound', senderKind: 'principal', body: 'הודעה מהבעלים' }),
        msg({
          id: 'WA-2',
          direction: 'inbound',
          senderKind: 'other',
          senderNumber: '+972500000000',
          body: 'הודעה משולח אחר',
        }),
        msg({ id: 'WA-3', direction: 'outbound', senderKind: null, senderNumber: null, body: 'תשובת העוזרת' }),
      ],
      csrf: 'c',
    });
    expect(html).toContain('הודעה מהבעלים');
    expect(html).toContain('אתה (בעל העסק)');
    expect(html).toContain('הודעה משולח אחר');
    expect(html).toContain('שולח אחר');
    expect(html).toContain('תשובת העוזרת');
    expect(html).toContain('העוזרת');

    // No per-message reply control, for a stranger's row or anyone else's:
    // the only form on the page is the single compose box.
    expect((html.match(/<form/g) ?? []).length).toBe(1);
  });

  it('marks a claimed-but-unsettled message as unfinished rather than hiding it', () => {
    const html = renderConversation({ messages: [msg({ state: 'claimed', body: 'תזכורת לפגישה' })], csrf: 'c' });
    expect(html).toContain('תזכורת לפגישה');
    expect(html).toContain('בטיפול');
  });

  // Ruling 2: `reported_interim` means the owner was told something once but
  // the job has not reached a terminal phase — a real report is still owed.
  // Rendering it as finished would re-create, one surface over, the exact
  // silence task 8 exists to prevent.
  it('marks a reported_interim message as unfinished, not as a closed report', () => {
    const html = renderConversation({
      messages: [msg({ state: 'reported_interim', body: 'בדיקת תקציב' })],
      csrf: 'c',
    });
    expect(html).toContain('בדיקת תקציב');
    expect(html).toContain('עודכנת בביניים');
  });

  it('adds no unfinished badge for a terminal state', () => {
    const html = renderConversation({ messages: [msg({ state: 'reported', body: 'כבר דווח' })], csrf: 'c' });
    expect(html).toContain('כבר דווח');
    expect(html).not.toContain('עודכנת בביניים');
    expect(html).not.toContain('בטיפול');
    expect(html).not.toContain('עדיין לא טופלה');
  });

  // Ruling 4: a row can legitimately carry neither body nor transcript
  // (audio too long, or a transcription that failed). That is an answer, not
  // an empty cell that reads as "nothing was said".
  it('says plainly what happened when a message has neither body nor transcript', () => {
    const html = renderConversation({
      messages: [msg({ body: null, transcript: null, mediaKind: 'audio' })],
      csrf: 'c',
    });
    expect(html).toContain('בלי תוכן טקסטואלי');
  });

  // Ruling 3: a state the type system never anticipated (a widened CHECK
  // constraint running ahead of this file) must render as unknown and
  // unfinished, never as silently finished — the runtime half of the
  // compile-time exhaustiveness check in `stateInfo`.
  it('renders an unrecognised state as unknown and unfinished, never as silently finished', () => {
    const html = renderConversation({
      messages: [msg({ state: 'some_future_state' as unknown as StoredMessage['state'], body: 'מצב עתידי' })],
      csrf: 'c',
    });
    expect(html).toContain('מצב עתידי');
    expect(html).toContain('מצב לא מוכר');
  });

  it('says so plainly when there is no conversation yet', () => {
    const html = renderConversation({ messages: [], csrf: 'c' });
    expect(html).toContain('לא התקבלה אף הודעה');
  });

  it('posts the compose box to the existing /instruct door, never a second one', () => {
    const html = renderConversation({ messages: [], csrf: 'the-csrf-token' });
    expect(html).toContain('action="/instruct"');
    expect(html).toContain('value="the-csrf-token"');
  });
});
