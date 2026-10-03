/**
 * Structural, in the style of `instruction-invariants.test.ts`. Two
 * properties a future edit could remove while every behavioural test in
 * `whatsapp-door.test.ts` stayed green.
 *
 * **Fix round 1 rewrote the first test entirely — this is the reviewer's own
 * defect, not the implementer's, and the fix is recorded here rather than
 * re-litigated.** The original asserted `expect(source).not.toMatch(/provenance\s*:/)`
 * against the whole file. Two things were wrong with that: the hazard it
 * named was already closed structurally — `runInstruction(input: { text: string
 * }, options: RunInstructionOptions)` has no `provenance` field anywhere, and
 * under this project's strict TypeScript an excess property on an object
 * literal passed to it is a compile error, so the door cannot aim a
 * provenance whether or not this test exists — and as a bare substring ban
 * it would stay green if the door began passing some other sender-derived
 * value into the pipeline, which is the real version of the hazard; all it
 * actually pinned was "don't write the literal text `provenance:` anywhere
 * in this file", a placement property dressed as an authority property, and
 * a negative check besides, against this project's own rule that controls
 * are written positively. The replacement below states positively what
 * actually matters: exactly one thing crosses into `runInstruction`, it is
 * `{ text }`, and nothing that identifies the sender rides along with it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/orchestrator/whatsapp-door.ts', 'utf8');

/** The text of one call, by paren depth — same helper `instruction-invariants.test.ts` uses. */
function callBlock(text: string, callee: string): string {
  const start = text.indexOf(`${callee}(`);
  if (start === -1) throw new Error(`no call to ${callee}`);
  let depth = 0;
  for (let i = start + callee.length; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced call to ${callee}`);
}

describe('the WhatsApp door cannot widen its own authority', () => {
  /**
   * Sibling of `instruction-invariants.test.ts`'s own "stamps its job as
   * boss with a literal" test. Three positive assertions, each closing a gap
   * the old substring ban left open:
   *   - the call really does carry `{ text }` (so the test cannot pass on an
   *     empty or renamed call it never found);
   *   - nothing that identifies the sender — provenance, sender kind, the
   *     raw number, or the charter object itself — rides inside that one
   *     call's argument list;
   *   - there is exactly one call site, so a second, parallel call could not
   *     cover for the first by carrying the forbidden fields while this one
   *     stays clean.
   */
  it('passes only { text } into runInstruction — nothing that identifies the sender', () => {
    const block = callBlock(source, 'runInstruction');
    expect(block).toMatch(/\{\s*text\s*\}/);
    expect(block).not.toMatch(/provenance|senderKind|senderNumber|charter/);
    expect(source.match(/runInstruction\(/g)).toHaveLength(1);
  });

  /**
   * The door must not be able to send to anyone but the principal. Kept as a
   * tripwire (it does not catch `gateway['sendMessage'](…)` or an aliased
   * import), and strengthened below with a positive version of the same
   * property.
   */
  it('reaches WhatsApp only through the messenger', () => {
    expect(source).not.toContain('sendMessage'); // gateway.sendMessage is the messenger's alone
  });

  /**
   * The positive version of the test above: the gateway is touched only
   * through the two methods this door is supposed to use. A future edit that
   * reaches for `gateway.sendMessage` under a different spelling, or adds a
   * third gateway method this door was never meant to call, fails here even
   * if it dodges the substring ban.
   */
  it('touches the gateway only through onInbound and pollOnce', () => {
    // A method call, not the `../whatsapp/gateway.js` import path — the
    // lookahead requires an immediately-following `(`, which the import
    // specifier never has.
    const gatewayCalls = new Set(source.match(/gateway\.\w+(?=\()/g) ?? []);
    expect(gatewayCalls).toEqual(new Set(['gateway.onInbound', 'gateway.pollOnce']));
  });
});
