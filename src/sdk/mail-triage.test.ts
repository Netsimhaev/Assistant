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
    expect(Object.keys(options.env ?? {}).every((k) => k === 'PATH')).toBe(true);
    expect(options.maxTurns).toBe(1);
    expect(prompt).toContain('fixednonce');
    expect(String(options.systemPrompt)).toContain('fixednonce');
  });

  it('two builds without an explicit nonce use different nonces', () => {
    const bundle = { promptFragments: { 'intake.triage': 'f' } } as unknown as PolicyBundle;
    const mail = { subject: 's', fromName: null, bodyText: 'b', bodyTruncated: false } as never;
    expect(buildTriageCall({ bundle, mail }).prompt).not.toBe(buildTriageCall({ bundle, mail }).prompt);
  });

  it('parseTriageResponse tolerates attachment-only problems but not others', () => {
    const withAtt = { ...ok, attachments: [{ index: 1, docType: 'invoice', summary: 'חשבונית', invoice: null }] };
    expect(parseTriageResponse(JSON.stringify(withAtt), 2).status).toBe('read');
    // Out of range: still read — the poll drops that entry (Task 2 review, minor 5).
    expect(parseTriageResponse(JSON.stringify(withAtt), 1).status).toBe('read');
    // A non-attachment problem alongside still makes it unreadable.
    expect(parseTriageResponse(JSON.stringify({ ...withAtt, replyGist: null }), 1).status).toBe('unreadable');
  });

  it('the prompt carries the attachments and the contract names the closed type set', () => {
    const bundle = { promptFragments: { 'intake.triage': 'f' } } as unknown as PolicyBundle;
    const mail = { subject: 's', fromName: null, bodyText: 'b', bodyTruncated: false, fromAddress: 'x@y.example', replyTo: null, toAddresses: [] } as never;
    const attachments = [{ filename: 'a.pdf', text: 'PDF-BODY', notRead: null, truncated: false }];
    const { prompt, options } = buildTriageCall({ bundle, mail, attachments }, 'nn');
    expect(prompt).toContain('=== צרופה 0: a.pdf :: nn ===');
    expect(prompt).toContain('PDF-BODY');
    const system = String(options.systemPrompt);
    expect(system).toContain('"attachments"');
    for (const t of ['invoice', 'receipt', 'quote', 'contract', 'order', 'report', 'other']) expect(system).toContain(`"${t}"`);
  });
});
