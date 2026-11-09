import { describe, expect, it } from 'vitest';
import { buildExtractorSystemPrompt, parseExtractorReply, runMeetingExtractor, weekdayOf } from './meeting-extractor.js';

const json = {
  ops: [{ kind: 'cancel', clientName: 'דני', onDate: '2026-11-10' }],
};

describe('parseExtractorReply', () => {
  it('parses a fenced JSON reply into a MeetingRequest', () => {
    const out = parseExtractorReply('הנה:\n```json\n' + JSON.stringify(json) + '\n```');
    expect(out).toEqual({ status: 'extracted', request: json });
  });
  it('recognises notMeeting', () => {
    expect(parseExtractorReply('{"notMeeting": true}')).toEqual({ status: 'not_meeting' });
  });
  it('fails on garbage or a wrong shape', () => {
    expect(parseExtractorReply('לא יודע').status).toBe('failed');
    expect(parseExtractorReply('{"ops":[{"kind":"cancel"}]}').status).toBe('failed');
  });
});

describe('buildExtractorSystemPrompt', () => {
  it('gives today’s weekday in Hebrew and English and says the week starts on Sunday', () => {
    // 2026-11-08 is a Sunday; 2026-11-10 a Tuesday; 2026-11-14 a Saturday.
    const prompt = buildExtractorSystemPrompt('2026-11-10', 'Asia/Jerusalem');
    expect(prompt).toContain('2026-11-10, which is Tuesday (יום שלישי)');
    expect(prompt).toContain('The week starts on Sunday');
    expect(weekdayOf('2026-11-08')).toEqual({ he: 'ראשון', en: 'Sunday' });
    expect(weekdayOf('2026-11-14')).toEqual({ he: 'שבת', en: 'Saturday' });
  });
  it('states no weekday for an unreadable date rather than a wrong one', () => {
    expect(weekdayOf('not-a-date')).toBeNull();
    expect(buildExtractorSystemPrompt('not-a-date', 'Asia/Jerusalem')).not.toContain('which is');
  });
});

describe('runMeetingExtractor', () => {
  it('refuses to run under NODE_ENV=test', async () => {
    await expect(
      runMeetingExtractor({ text: 'x', today: '2026-11-08', timeZone: 'Asia/Jerusalem', signal: new AbortController().signal }),
    ).rejects.toThrow(/refusing to run under NODE_ENV=test/);
  });
});
