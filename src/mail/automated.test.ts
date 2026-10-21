import { describe, it, expect } from 'vitest';
import { isAutomatedSender } from './automated.js';

const none = { listUnsubscribe: false, autoSubmitted: false, bulkPrecedence: false };

describe('isAutomatedSender', () => {
  it('automated: List-Unsubscribe alone is automated', () => {
    expect(isAutomatedSender({ ...none, listUnsubscribe: true }, 'dana@x.co.il')).toBe(true);
    expect(isAutomatedSender({ ...none, autoSubmitted: true }, 'dana@x.co.il')).toBe(true);
    expect(isAutomatedSender({ ...none, bulkPrecedence: true }, 'dana@x.co.il')).toBe(true);
  });
  it('automated: noreply@ local part is automated, noreply-team@ is not', () => {
    expect(isAutomatedSender(none, 'noreply@x.com')).toBe(true);
    expect(isAutomatedSender(none, 'No-Reply@x.com')).toBe(true);
    expect(isAutomatedSender(none, 'mailer-daemon@x.com')).toBe(true);
    expect(isAutomatedSender(none, 'notifications@x.com')).toBe(true);
    expect(isAutomatedSender(none, 'noreply-team@x.com')).toBe(false);
    expect(isAutomatedSender(none, 'dana@x.com')).toBe(false);
  });
});
