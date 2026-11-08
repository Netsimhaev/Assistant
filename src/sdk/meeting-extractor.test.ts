import { describe, expect, it } from 'vitest';
import { parseExtractorReply, runMeetingExtractor } from './meeting-extractor.js';

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

describe('runMeetingExtractor', () => {
  it('refuses to run under NODE_ENV=test', async () => {
    await expect(
      runMeetingExtractor({ text: 'x', today: '2026-11-08', timeZone: 'Asia/Jerusalem', signal: new AbortController().signal }),
    ).rejects.toThrow(/refusing to run under NODE_ENV=test/);
  });
});
