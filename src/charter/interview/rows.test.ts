import { describe, expect, it } from 'vitest';
import { NEVER_FULLY_AUTONOMOUS } from '../../domain/action.js';
import type { CharterConnection } from '../../domain/connection.js';
import { REFINEMENT_ONLY_CLASSES } from '../../policy/classify.js';
import {
  ALONE_ALLOWED,
  availabilityOf,
  cannotAtAll,
  INTERVIEW_ROWS,
  isReachable,
  MONEY_ROWS,
  REFINES_FROM,
  ROW_DEFAULTS,
  ROW_EXAMPLES,
} from './rows.js';

const mailbox: CharterConnection = {
  system: 'mailbox',
  label: 'תיבת מייל',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

describe('interview rows', () => {
  it('every interview row is reachable', () => {
    for (const row of INTERVIEW_ROWS) expect(isReachable(row), row).toBe(true);
  });

  it('ALONE_ALLOWED never meets NEVER_FULLY_AUTONOMOUS or an initiate class', () => {
    for (const row of ALONE_ALLOWED) {
      expect(NEVER_FULLY_AUTONOMOUS.has(row), row).toBe(false);
      expect(row.endsWith('.initiate'), row).toBe(false);
    }
  });

  it('email.reply defaults to alone; money rows default to never', () => {
    expect(ROW_DEFAULTS['email.reply']).toBe('alone');
    for (const row of MONEY_ROWS) expect(ROW_DEFAULTS[row], row).toBe('never');
    expect(ROW_DEFAULTS['accounting.write']).toBe('never');
    expect(ROW_DEFAULTS['media.publish']).toBe('never');
    expect(ROW_DEFAULTS['email.initiate']).toBe('approve');
  });

  it('has a Hebrew example and a default for every row', () => {
    for (const row of INTERVIEW_ROWS) {
      expect(ROW_EXAMPLES[row], row).toMatch(/[א-ת]/);
      expect(ROW_DEFAULTS[row], row).toBeDefined();
    }
  });

  it('REFINES_FROM keys equal REFINEMENT_ONLY_CLASSES', () => {
    expect(Object.keys(REFINES_FROM).sort()).toEqual([...REFINEMENT_ONLY_CLASSES].sort());
  });

  it('mail is works with a mailbox connection and not_connected without one', () => {
    expect(availabilityOf('email.reply', [mailbox])).toBe('works');
    expect(availabilityOf('email.reply', [])).toBe('not_connected');
    expect(availabilityOf('email.initiate', [mailbox])).toBe('works');
  });

  it('calendar.create and quote.issue are not_built today', () => {
    expect(availabilityOf('calendar.create', [mailbox])).toBe('not_built');
    expect(availabilityOf('quote.issue', [mailbox])).toBe('not_built');
  });

  it('cannotAtAll includes contract.sign', () => {
    expect(cannotAtAll()).toContain('contract.sign');
  });
});
