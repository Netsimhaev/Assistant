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
 * are written positively.
 *
 * **Fix round 1's own replacement was itself still half a denylist, and fix
 * round 2 closes that.** `expect(block).not.toMatch(/provenance|senderKind|senderNumber|charter/)`
 * named four identifiers, not the class they stand in for — `{ text, from:
 * msg.sender }` would have crossed that check cleanly, carrying exactly the
 * kind of sender-derived value the test exists to forbid, under a fifth name
 * nobody thought to list. The test below replaces it with the actual
 * positive claim: the first argument to `runInstruction` matches `{ text }`
 * **and nothing else**, char for char after whitespace. No field, named or
 * not, can ride beside `text` and still pass.
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

/**
 * The first top-level argument of a call block (as `callBlock` returns it),
 * split on the first comma that sits at bracket depth 0 — so a comma inside
 * the *second* argument's own object literal (`runInstruction`'s options,
 * which has several fields) is never mistaken for the argument separator.
 */
function firstArgument(block: string, callee: string): string {
  const inner = block.slice(callee.length + 1, -1); // strip `callee(` and the matching `)`
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) return inner.slice(0, i).trim();
  }
  return inner.trim();
}

describe('the WhatsApp door cannot widen its own authority', () => {
  /**
   * Sibling of `instruction-invariants.test.ts`'s own "stamps its job as
   * boss with a literal" test. Two positive assertions:
   *   - the first argument this one call passes is `{ text }` and **nothing
   *     else** — an exact shape match, not "contains `text`" and not "does
   *     not contain four named identifiers". Any extra field, whatever it is
   *     called, fails this regardless of its name;
   *   - there is exactly one call site, so a second, parallel call could not
   *     cover for the first by carrying a forbidden field while this one
   *     stays clean.
   */
  it('passes only { text } into runInstruction — nothing that identifies the sender', () => {
    const block = callBlock(source, 'runInstruction');
    expect(firstArgument(block, 'runInstruction')).toMatch(/^\{\s*text\s*\}$/);
    expect(source.match(/runInstruction\(/g)).toHaveLength(1);
  });

  /**
   * The door must not be able to send to anyone but the principal. Kept as a
   * tripwire alongside the positive version below — fix round 2 corrected
   * what this comment claimed it misses: `not.toContain('sendMessage')`
   * matches on the raw literal substring, so it *does* catch
   * `gateway['sendMessage'](…)` and an aliased import (`import { sendMessage
   * as foo }` still spells the name once, at the import itself). What it
   * cannot catch is a method name that is never written as one contiguous
   * literal — assembled at runtime (`gateway[['send', 'Message'].join('')]`)
   * or reached through a re-export under a different name. The positive
   * check below closes a different gap (a *third*, legitimately-named
   * gateway method this door was never meant to call) and the re-review
   * confirmed neither test subsumes the other — each catches something the
   * other misses, so both stay.
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
