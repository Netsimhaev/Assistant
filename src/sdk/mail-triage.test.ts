import { describe, expect, it } from 'vitest';
import type { PolicyBundle } from '../domain/policy.js';
import { buildTriageCall, parseTriageResponse, runMailTriage } from './mail-triage.js';

const ok = {
  categories: ['question'], summary: 'שאלה', isPerson: true, invoice: null, replyGist: 'לאשר',
};

describe('mail triage', () => {
  it('runMailTriage refuses under test', async () => {
    await expect(runMailTriage({ bundle: {} as PolicyBundle, mail: {} as never })).rejects.toThrow(/refusing/);
  });

  it('parseTriageResponse accepts a valid response', () => {
    expect(parseTriageResponse(JSON.stringify(ok)).status).toBe('read');
  });

  it('parseTriageResponse rejects a response carrying "to"', () => {
    const r = parseTriageResponse(JSON.stringify({ ...ok, to: 'x@y.example' }));
    expect(r.status).toBe('unreadable');
  });

  it('parseTriageResponse rejects semantic problems and non-JSON', () => {
    expect(parseTriageResponse(JSON.stringify({ ...ok, replyGist: null })).status).toBe('unreadable');
    expect(parseTriageResponse('nothing').status).toBe('unreadable');
  });

  it('call is tool-less, PATH-only, and shares one nonce across both prompts', () => {
    const bundle = { promptFragments: { 'intake.triage': 'frag' } } as unknown as PolicyBundle;
    const mail = { subject: 's', fromName: null, bodyText: 'b', bodyTruncated: false } as never;
    const { prompt, options } = buildTriageCall({ bundle, mail }, 'fixednonce');
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.model).toBe('haiku');
    expect(Object.keys(options.env ?? {})).not.toContain('ANTHROPIC_API_KEY');
    expect(prompt).toContain('fixednonce');
    expect(String(options.systemPrompt)).toContain('fixednonce');
  });
});
