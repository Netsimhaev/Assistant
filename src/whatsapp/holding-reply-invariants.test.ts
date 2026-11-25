import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');
const MODULE = readFileSync(join(SRC, 'whatsapp', 'holding-reply.ts'), 'utf8');

const SENDER_SIGNATURE = /export async function sendHoldingReply\(([\s\S]*?)\):\s*Promise</;
const SEND_CALLS = /\bsendMessage\(/g;
const SEND_SHAPE = /sendMessage\(\{\s*contactId: conv\.contactKey,\s*body: HOLDING_REPLY_TEXT\(/;
// Every way of reaching the module: named/default/namespace import, re-export, dynamic import.
const MODULE_REF = /(?:from\s*|import\s*\(\s*|import\s+)['"][^'"]*holding-reply(?:\.js)?['"]/;

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
    expect(SEND_SHAPE.test('sendMessage({ contactId: other, body: input.text })')).toBe(false);
    for (const planted of [
      "import { sendHoldingReply } from './holding-reply.js'",
      "import * as h from '../whatsapp/holding-reply.js'",
      "export { sendHoldingReply } from './holding-reply.js'",
      "export * from './holding-reply.js'",
      "const h = await import('./holding-reply.js')",
      "import h from './holding-reply'",
    ]) {
      expect(MODULE_REF.test(planted), planted).toBe(true);
    }
  });

  it('the sending function takes no text or body parameter', () => {
    const params = SENDER_SIGNATURE.exec(MODULE)?.[1] ?? '';
    expect(params).toContain('conversationId');
    expect(params).not.toMatch(/\b(text|body|message)\b/i);
  });

  it('the only sendMessage call sends the constant text to the conversation key', () => {
    expect(MODULE.match(SEND_CALLS)).toHaveLength(1);
    expect(SEND_SHAPE.test(MODULE)).toBe(true);
  });

  it('only the door, the scheduler, the contact flow and the auto re-raise reach the module', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(100); // positive control: the scan actually found the source tree
    const allowed = new Set([
      'orchestrator/whatsapp-door.ts',
      'orchestrator/scheduler.ts',
      'whatsapp/contact-flow.ts',
      // A failed auto reply becomes a card and only then owes the contact the holding reply (spec section 6).
      'whatsapp/contact-auto-reraise.ts',
      'whatsapp/holding-reply.ts',
    ]);
    const importers = files
      .filter((f) => MODULE_REF.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replaceAll('\\', '/'));
    for (const f of importers) expect(allowed.has(f), f).toBe(true);
  });
});
