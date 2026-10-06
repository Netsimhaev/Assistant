import { describe, expect, it } from 'vitest';
import { createFakeMessenger } from './fake-messenger.js';

describe('FakeMessenger', () => {
  it('records sentTexts in order', async () => {
    const messenger = createFakeMessenger();

    await messenger.send({ text: 'first', jobId: 'job-1' });
    await messenger.send({ text: 'second', jobId: null });
    await messenger.send({ text: 'third', jobId: 'job-3' });

    expect(messenger.sentTexts).toEqual(['first', 'second', 'third']);
  });

  it('makes exactly one call return { ok: false } after failNext, never throwing', async () => {
    const messenger = createFakeMessenger();
    messenger.failNext();

    const first = await messenger.send({ text: 'will fail', jobId: null });
    expect(first.ok).toBe(false);

    const second = await messenger.send({ text: 'will succeed', jobId: null });
    expect(second.ok).toBe(true);

    // The failed call must not have been recorded as said.
    expect(messenger.sentTexts).toEqual(['will succeed']);
  });

  it('returns { ok: true } for a normal call', async () => {
    const messenger = createFakeMessenger();
    const result = await messenger.send({ text: 'hello', jobId: null });
    expect(result).toEqual({ ok: true });
  });

  it('exposes the whatsapp channel', () => {
    const messenger = createFakeMessenger();
    expect(messenger.channel).toBe('whatsapp');
  });
});
