/**
 * Structural, in the style of `instruction-invariants.test.ts`. Two
 * properties a future edit could remove while every behavioural test in
 * `whatsapp-door.test.ts` stayed green.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/orchestrator/whatsapp-door.ts', 'utf8');

describe('the WhatsApp door cannot widen its own authority', () => {
  /**
   * Sibling of `instruction-invariants.test.ts`. The door is a third caller
   * of `runInstruction`, and `provenance: 'boss'` must stay a literal in the
   * call body — a caller that can aim provenance is a caller that can forge
   * authority. The door itself does not even carry the word next to a colon:
   * every trust decision it needs (who the sender is, what `runInstruction`
   * stamps the job with) is made elsewhere, by name, and this module only
   * ever reads the Hebrew sentence those decisions already produced.
   */
  it('never passes a provenance it computed', () => {
    expect(source).not.toMatch(/provenance\s*:/); // the door does not mention it at all
  });

  /** The door must not be able to send to anyone but the principal. */
  it('reaches WhatsApp only through the messenger', () => {
    expect(source).not.toContain('sendMessage'); // gateway.sendMessage is the messenger's alone
  });
});
