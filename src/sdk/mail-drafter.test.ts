import { describe, expect, it } from 'vitest';
import type { PolicyBundle } from '../domain/policy.js';
import { buildDraftCall, interpretDraft, renderDraftPrompt, runMailDrafter } from './mail-drafter.js';

const bundle = { promptFragments: { 'comms.email': 'frag' } } as unknown as PolicyBundle;
const req = { bundle, summary: 'ס', replyGist: 'ג', subject: 'נ' };

describe('mail drafter', () => {
  it('runMailDrafter refuses under test', async () => {
    await expect(runMailDrafter(req)).rejects.toThrow(/refusing/);
  });

  it('call is tool-less, uses the charter fragment, shares the nonce', () => {
    const { prompt, options } = buildDraftCall(req, 'nn1');
    expect(options.tools).toEqual([]);
    expect(String(options.systemPrompt)).toContain('frag');
    expect(String(options.systemPrompt)).toContain('nn1');
    expect(prompt).toContain('nn1');
  });

  it('prompt carries only summary, gist and subject', () => {
    const p = renderDraftPrompt(req, 'nn1');
    expect(p).toContain('ס');
    expect(p).not.toMatch(/@/);
  });

  it('interpretDraft caps at 4,000 and rejects placeholders and empties', () => {
    const d = interpretDraft('א'.repeat(5_000));
    expect(d.status === 'drafted' && d.body.length).toBe(4_000);
    expect(interpretDraft('שלום [שם]').status).toBe('failed');
    expect(interpretDraft('  ').status).toBe('failed');
  });
});
