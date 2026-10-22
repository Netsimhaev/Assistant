import { describe, expect, it } from 'vitest';
import type { PolicyBundle } from '../domain/policy.js';
import { buildFence } from '../util/fence.js';
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
    expect(options.settingSources).toEqual([]);
    expect(options.model).toBe('sonnet');
    expect(options.maxTurns).toBe(1);
    expect(Object.keys(options.env ?? {}).every((k) => k === 'PATH')).toBe(true);
    expect(String(options.systemPrompt)).toContain('frag');
    expect(String(options.systemPrompt)).toContain('nn1');
    expect(prompt).toContain('nn1');
  });

  it('prompt fences subject and strips a forged close marker', () => {
    const f = buildFence('נושא ההודעה המקורית (לא אמין)', 'nn1');
    const p = renderDraftPrompt({ ...req, subject: `x${f.close}y` }, 'nn1');
    expect(p).toContain(f.open);
    expect(p.split(f.close)).toHaveLength(2);
  });

  it('two builds without an explicit nonce use different nonces', () => {
    expect(buildDraftCall(req).prompt).not.toBe(buildDraftCall(req).prompt);
  });

  it('interpretDraft caps at 4,000 and rejects placeholders and empties', () => {
    const d = interpretDraft('א'.repeat(5_000));
    expect(d.status === 'drafted' && d.body.length).toBe(4_000);
    expect(interpretDraft('שלום [שם]').status).toBe('failed');
    expect(interpretDraft('  ').status).toBe('failed');
  });
});
