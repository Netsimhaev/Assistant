import { describe, expect, it } from 'vitest';
import { refineActionClass } from './classify.js';

describe('calendar.update refinement', () => {
  it('refines calendar.write operation update to calendar.update', () => {
    expect(refineActionClass('calendar.create', { operation: 'update' })).toBe('calendar.update');
  });
  it('still refines an unknown calendar operation to calendar.cancel', () => {
    expect(refineActionClass('calendar.create', { operation: 'reschedule' })).toBe('calendar.cancel');
    expect(refineActionClass('calendar.create', { operation: 'cancel' })).toBe('calendar.cancel');
  });
});
