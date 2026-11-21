import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');
const MODULE = readFileSync(join(SRC, 'whatsapp', 'holding-reply.ts'), 'utf8');

const SENDER_SIGNATURE = /export async function sendHoldingReply\(([\s\S]*?)\):\s*Promise</;
const SEND_CALLS = /\bsendMessage\(/g;
const IMPORTER = /import\s*\{[^}]*\b(sendHoldingReply|sendDueHoldingReplies)\b[^}]*\}\s*from/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('holding reply — the gate bypass stays narrow', () => {
  it('the regexes catch planted violations', () => {
    expect(
      SENDER_SIGNATURE.exec('export async function sendHoldingReply(db, deps, text: string): Promise<X>')?.[1],
    ).toContain('text');
    expect('x.sendMessage({ body: input.text })'.match(SEND_CALLS)).toHaveLength(1);
    expect(IMPORTER.test("import { sendHoldingReply } from './holding-reply.js'")).toBe(true);
  });

  it('the sending function takes no text or body parameter', () => {
    const params = SENDER_SIGNATURE.exec(MODULE)?.[1] ?? '';
    expect(params).toContain('conversationId');
    expect(params).not.toMatch(/\b(text|body|message)\b/i);
  });

  it('the only sendMessage call carries HOLDING_REPLY_TEXT', () => {
    expect(MODULE.match(SEND_CALLS)).toHaveLength(1);
    const at = MODULE.indexOf('sendMessage(');
    expect(MODULE.slice(at, at + 300)).toContain('HOLDING_REPLY_TEXT(');
  });

  it('only the door, the scheduler and the contact flow import the senders', () => {
    const allowed = new Set([
      'orchestrator/whatsapp-door.ts',
      'orchestrator/scheduler.ts',
      'whatsapp/contact-flow.ts',
      'whatsapp/holding-reply.ts',
    ]);
    const importers = sources(SRC)
      .filter((f) => IMPORTER.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replaceAll('\\', '/'));
    for (const f of importers) expect(allowed.has(f), f).toBe(true);
  });
});
