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
});
