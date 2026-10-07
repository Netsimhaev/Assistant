import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../test/db.js';
import { DIGEST_DEFAULTS, loadDigestSettings, setDigestSettings } from './digest-settings.js';

const BUSINESS = 'test-business';

describe('digest settings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * Spec §4: the main switch is off by default. A fresh installation does not
   * start emailing the owner before he asked — the same shape `autonomy_mode`
   * and the document inbox already hold.
   */
  it('reads as off for a business that never chose, without writing a row', async () => {
    const settings = await loadDigestSettings({ businessId: BUSINESS });
    expect(settings.schedule).toBe('off');
    expect(settings.toEmail).toBe(false);
    expect(settings.toWhatsApp).toBe(false);
    expect(settings.dailyHour).toBe(DIGEST_DEFAULTS.dailyHour);
  });

  it('round-trips a choice the owner made', async () => {
    await setDigestSettings(
      { schedule: 'both', dailyHour: 7, weeklyDay: 0, weeklyHour: 9, toEmail: true, toWhatsApp: false },
      'owner',
      { businessId: BUSINESS },
    );

    const settings = await loadDigestSettings({ businessId: BUSINESS });
    expect(settings.schedule).toBe('both');
    expect(settings.dailyHour).toBe(7);
    expect(settings.weeklyHour).toBe(9);
    expect(settings.toEmail).toBe(true);
    expect(settings.updatedBy).toBe('owner');
  });

  /**
   * Spec §9's closing note: these are the owner's choices in the database, so
   * an invalid hour must be impossible to WRITE. The database refuses it — the
   * reader never has to decide what a 25th hour means.
   */
  it('refuses an hour outside the day at the database level', async () => {
    await expect(
      setDigestSettings(
        { schedule: 'daily', dailyHour: 25, weeklyDay: 0, weeklyHour: 9, toEmail: false, toWhatsApp: false },
        'owner',
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow();
  });

  it('keeps one business out of another, under the same defaults', async () => {
    await setDigestSettings(
      { schedule: 'daily', dailyHour: 6, weeklyDay: 0, weeklyHour: 9, toEmail: true, toWhatsApp: false },
      'owner',
      { businessId: BUSINESS },
    );

    const other = await loadDigestSettings({ businessId: 'other-business' });
    expect(other.schedule).toBe('off');
  });
});
