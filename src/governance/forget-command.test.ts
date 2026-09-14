import { describe, expect, it } from 'vitest';
import { readForgetCommand } from './forget-command.js';

describe('readForgetCommand', () => {
  it('recognises the four opening verbs', () => {
    for (const verb of ['תשכחי', 'שכחי', 'תמחקי', 'מחקי']) {
      expect(readForgetCommand(`${verb} מרונית`).recognised, verb).toBe(true);
    }
  });

  /**
   * The recogniser decides ROUTING, never what gets deleted. Anything it does
   * not recognise must fall through to the planner exactly as before, or an
   * ordinary instruction would vanish into a screen the owner did not ask for.
   */
  it('does not recognise an ordinary instruction', () => {
    expect(readForgetCommand('תשלחי לרונית מייל').recognised).toBe(false);
    expect(readForgetCommand('מה את יודעת על רונית?').recognised).toBe(false);
  });

  it('only recognises the verb at the start, never buried in a sentence', () => {
    // A supplier's own words can reach the instruction box by paste. The verb
    // has to open the command, or quoting someone becomes a way to trigger one.
    expect(readForgetCommand('הוא כתב לי "תשכחי מזה" אז תעני לו').recognised).toBe(false);
  });

  it('extracts an email address, lower-cased', () => {
    const command = readForgetCommand('תשכחי מ-Ronit@Beta-Log.Example בבקשה');
    expect(command.recognised).toBe(true);
    if (!command.recognised) throw new Error('unreachable');
    expect(command.identifier).toBe('ronit@beta-log.example');
  });

  it('extracts an Israeli date and normalises it', () => {
    const command = readForgetCommand('תשכחי מהשיחה של 3/9/2026');
    expect(command.recognised).toBe(true);
    if (!command.recognised) throw new Error('unreachable');
    expect(command.onDate).toBe('2026-09-03');
  });

  it('recognises the command but extracts nothing when the text names nothing', () => {
    const command = readForgetCommand('תשכחי מרונית כהן');
    expect(command.recognised).toBe(true);
    if (!command.recognised) throw new Error('unreachable');
    // A name is not an identifier — there is no entity resolver, so the owner
    // picks from a list rather than having a guess confirmed for them.
    expect(command.identifier).toBeNull();
    expect(command.onDate).toBeNull();
  });

  it('refuses a command that opens directly on a quotation mark', () => {
    // A quoted verb at position 0 is still a quote, not the owner's command.
    // The opening quote must be part of the verb test, not stripped away first.
    expect(readForgetCommand('"תשכחי מזה" - כך אמר הספק').recognised).toBe(false);
    expect(readForgetCommand('«תמחקי מזה»').recognised).toBe(false);
  });

  /**
   * The asymmetry the flag exists for, named in both directions.
   *
   * The security property is about a LEADING quote: a pasted supplier
   * sentence opens with one, so the opening-verb test must see it. A TRAILING
   * comma carries no such meaning — `תשכחי,` is an entirely ordinary Hebrew
   * opening, and refusing it sent the text to `runInstruction`, which opens a
   * job, grants a standing authorisation and calls the planner on a sentence
   * that says "forget".
   */
  it('recognises a verb that carries trailing punctuation, quoted or not', () => {
    expect(readForgetCommand('תשכחי, מרונית כהן').recognised).toBe(true);
    expect(readForgetCommand('תשכחי. הכול').recognised).toBe(true);
    expect(readForgetCommand('מחקי; את זה').recognised).toBe(true);
    // And the leading quote is still refused, with the same trailing comma
    // present — so a green here cannot come from the strip being dropped.
    expect(readForgetCommand('"תשכחי," כך אמר הספק').recognised).toBe(false);
  });

  it('rejects an impossible date (31/02)', () => {
    const command = readForgetCommand('תשכחי מהתאריך 31/02/2026');
    expect(command.recognised).toBe(true);
    if (!command.recognised) throw new Error('unreachable');
    // The date does not exist; it must not be normalised.
    expect(command.onDate).toBeNull();
  });

  it('accepts a valid leap day (29/02/2028)', () => {
    const command = readForgetCommand('תשכחי מ-29/02/2028');
    expect(command.recognised).toBe(true);
    if (!command.recognised) throw new Error('unreachable');
    // 2028 is a leap year; the date exists and round-trips correctly.
    expect(command.onDate).toBe('2028-02-29');
  });
});
