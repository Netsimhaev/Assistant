import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from './jobs.js';
import {
  coveredByAuthorization,
  grantAuthorization,
  loadAuthorization,
  type StandingAuthorization,
} from './authorization.js';

const BUSINESS = 'test-business';
const bundle = compileCharter(buildCharter());

const AUTH: StandingAuthorization = {
  jobId: 'J-x',
  businessId: BUSINESS,
  actionClass: 'email.reply',
  recipients: ['dana@example.com'],
  grantedBy: 'boss',
};

const NO_MONEY = { amountDeclared: false, amountMinor: 0 };

beforeEach(async () => {
  await resetDatabase();
  await installCharter(buildCharter(), { businessId: BUSINESS });
});
afterAll(async () => { await closePool(); });

describe('coveredByAuthorization', () => {
  it('covers the action class and recipient the owner named', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(true);
  });

  it('covers a recipient written with a display name, because the gate unwraps it', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'Dana Cohen <dana@example.com>' }, ...NO_MONEY,
    })).toBe(true);
  });

  it('does not cover a different recipient', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'someone@else.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover a payload that adds a recipient alongside the named one', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'dana@example.com, other@x.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover a different action class', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.initiate', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('covers an internal action as the one entailed step', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'crm.write', input: {}, ...NO_MONEY,
    })).toBe(true);
  });

  it('does not cover charter.amend, even though the class is internal', () => {
    // addresseeOf('charter.amend') === 'internal', but amending the charter is
    // not entailed by "reply to Dana" in any sense. The entailed set is a
    // named allowlist (crm.write, accounting.write, artifact.write), not
    // "every internal class" — see CLAUDE.md, "a control is written in the
    // positive and never in the negative".
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'charter.amend', input: {}, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover purchase.place even with no declared amount', () => {
    // purchase.place is also addresseeOf === 'internal' (it addresses a
    // supplier as an organisation, not a person), but a standing instruction
    // to reply to a customer never entails placing a purchase. The money
    // guard alone is not enough here: this payload declares no amount at all,
    // so only the named allowlist stops it.
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'purchase.place', input: {}, ...NO_MONEY,
    })).toBe(false);
  });

  it('never covers an action carrying an amount, however small', () => {
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' },
      amountDeclared: true, amountMinor: 1,
    })).toBe(false);
  });

  it('never covers an action that declares an amount of zero', () => {
    // Declaring zero is still declaring money. The owner's instruction proves
    // they wanted something done, never that they saw a figure.
    expect(coveredByAuthorization(AUTH, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' },
      amountDeclared: true, amountMinor: 0,
    })).toBe(false);
  });

  it('covers nothing when there is no authorisation', () => {
    expect(coveredByAuthorization(null, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover an outbound action when the owner named no recipient', () => {
    expect(coveredByAuthorization({ ...AUTH, recipients: [] }, {
      actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });
});

describe('grantAuthorization', () => {
  it('stores and reloads what the owner named', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss',
      businessId: BUSINESS, title: 'להשיב לדנה',
    });
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['Dana@Example.com'] },
      { businessId: BUSINESS },
    );
    const loaded = await loadAuthorization(job.jobId, { businessId: BUSINESS });
    expect(loaded?.actionClass).toBe('email.reply');
    // Lower-cased on the way in, so a match cannot be defeated by casing.
    expect(loaded?.recipients).toEqual(['dana@example.com']);
  });

  it('refuses to authorise a job whose provenance is not boss', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'unknown_external',
      businessId: BUSINESS, title: 'מסמך שהגיע',
    });
    await expect(
      grantAuthorization(
        { jobId: job.jobId, actionClass: 'email.reply', recipients: ['x@y.com'] },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow();
  });

  it('returns null for a job nobody authorised', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
    });
    expect(await loadAuthorization(job.jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('does not cross the business boundary', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
    });
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['x@y.com'] },
      { businessId: BUSINESS },
    );
    expect(await loadAuthorization(job.jobId, { businessId: 'other-business' })).toBeNull();
  });
});
