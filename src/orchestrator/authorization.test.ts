import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { compileCharter } from '../charter/compile.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from './jobs.js';
import {
  AuthorizationAlreadyGrantedError,
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
/** The job/business identity `AUTH` itself belongs to — matches by default. */
const OWN_JOB = { jobId: AUTH.jobId, businessId: AUTH.businessId };

beforeEach(async () => {
  await resetDatabase();
  await installCharter(buildCharter(), { businessId: BUSINESS });
});
afterAll(async () => { await closePool(); });

describe('coveredByAuthorization', () => {
  it('covers the action class and recipient the owner named', () => {
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(true);
  });

  it('covers a recipient written with a display name, because the gate unwraps it', () => {
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'email.reply', input: { to: 'Dana Cohen <dana@example.com>' }, ...NO_MONEY,
    })).toBe(true);
  });

  it('does not cover a different recipient', () => {
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'email.reply', input: { to: 'someone@else.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover a payload that adds a recipient alongside the named one', () => {
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'email.reply', input: { to: 'dana@example.com, other@x.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover a different action class', () => {
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'email.initiate', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('covers an internal action as the one entailed step', () => {
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'crm.write', input: {}, ...NO_MONEY,
    })).toBe(true);
  });

  it('does not cover charter.amend, even though the class is internal', () => {
    // addresseeOf('charter.amend') === 'internal', but amending the charter is
    // not entailed by "reply to Dana" in any sense. The entailed set is a
    // named allowlist (crm.write only, after review removed artifact.write
    // and accounting.write), not "every internal class" — see CLAUDE.md,
    // "a control is written in the positive and never in the negative".
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'charter.amend', input: {}, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover purchase.place even with no declared amount', () => {
    // purchase.place is also addresseeOf === 'internal' (it addresses a
    // supplier as an organisation, not a person), but a standing instruction
    // to reply to a customer never entails placing a purchase. The money
    // guard alone is not enough here: this payload declares no amount at all,
    // so only the named allowlist stops it.
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'purchase.place', input: {}, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover artifact.write, even though the class is internal', () => {
    // The class file.write AND code_execution both map to artifact.write
    // (classify.ts), and prod.docs holds both tools. If artifact.write were
    // entailed by any standing grant, "reply to Dana" would cover arbitrary
    // code execution and arbitrary filesystem writes. This was the Critical
    // finding from review — pinned directly here, not only by omission from
    // ENTAILED_INTERNAL_CLASSES.
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'artifact.write', input: {}, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover accounting.write, even with no declared amount', () => {
    // accounting.write is AMOUNT_REQUIRED — the gate denies it outright as
    // amount_unreadable whenever no amount is declared, so it could never
    // usefully sit in the entailed list. Confirms it is not covered either
    // way, independent of that separate gate-level denial.
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'accounting.write', input: {}, ...NO_MONEY,
    })).toBe(false);
  });

  it('never covers an action carrying an amount, however small', () => {
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'email.reply', input: { to: 'dana@example.com' },
      amountDeclared: true, amountMinor: 1,
    })).toBe(false);
  });

  it('never covers an action that declares an amount of zero', () => {
    // Declaring zero is still declaring money. The owner's instruction proves
    // they wanted something done, never that they saw a figure.
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'email.reply', input: { to: 'dana@example.com' },
      amountDeclared: true, amountMinor: 0,
    })).toBe(false);
  });

  it('never covers an action carrying an amount not marked as declared', () => {
    // Pins the `amountMinor !== 0` half of the money guard on its own.
    // readAmountMinor (src/policy/facts.ts) reads amountMinor through the
    // prototype chain while amountDeclared stays own-property-only, so a
    // payload shaped `{ __proto__: { amountMinor: 900000 } }` produces exactly
    // this combination: amountDeclared: false, amountMinor: 900000. Deleting
    // `|| facts.amountMinor !== 0` from the guard would pass this test
    // through where amountDeclared alone did not catch it.
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'email.reply', input: { to: 'dana@example.com' },
      amountDeclared: false, amountMinor: 5000,
    })).toBe(false);
  });

  it('refuses money even for an entailed internal class', () => {
    // Pins that the money guard runs BEFORE the entailed-class shortcut.
    // Every other money test above uses a non-entailed class, so swapping the
    // order of these two checks would leave them all green.
    expect(coveredByAuthorization(AUTH, {
      ...OWN_JOB, actionClass: 'crm.write', input: {},
      amountDeclared: true, amountMinor: 1,
    })).toBe(false);
  });

  it('covers nothing when there is no authorisation', () => {
    expect(coveredByAuthorization(null, {
      ...OWN_JOB, actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover an action executing under a different job', () => {
    // AUTH.jobId is 'J-x'; this call executes under 'J-other'. An
    // authorisation loaded for one job must never stand in for a step
    // belonging to another — the same shape CLAUDE.md records for approvals
    // that were not proven to belong to the job at hand.
    expect(coveredByAuthorization(AUTH, {
      jobId: 'J-other', businessId: BUSINESS,
      actionClass: 'email.reply', input: { to: 'dana@example.com' }, ...NO_MONEY,
    })).toBe(false);
  });

  it('does not cover an action executing under a different business', () => {
    expect(coveredByAuthorization(AUTH, {
      jobId: AUTH.jobId, businessId: 'other-business',
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

  it('refuses to authorise a job whose provenance is not boss, and writes no row', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'unknown_external',
      businessId: BUSINESS, title: 'מסמך שהגיע',
    });
    await expect(
      grantAuthorization(
        { jobId: job.jobId, actionClass: 'email.reply', recipients: ['x@y.com'] },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow(/provenance unknown_external/);
    expect(await loadAuthorization(job.jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('refuses to authorise a job that does not exist', async () => {
    await expect(
      grantAuthorization(
        { jobId: 'J-does-not-exist', actionClass: 'email.reply', recipients: ['x@y.com'] },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow(/no job J-does-not-exist/);
  });

  it('refuses to authorise a boss job under a businessId that is not its own', async () => {
    // Write-side business boundary: the job belongs to BUSINESS, but the
    // grant is attempted under a different businessId. The provenance SELECT
    // filters on `AND business_id = $2`, so this job is simply not found
    // under that business — dropping that clause would make this pass
    // silently instead of rejecting.
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
    });
    await expect(
      grantAuthorization(
        { jobId: job.jobId, actionClass: 'email.reply', recipients: ['x@y.com'] },
        { businessId: 'other-business' },
      ),
    ).rejects.toThrow(/no job/);
    expect(await loadAuthorization(job.jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('refuses a second authorisation for the same job, and leaves the first row unchanged', async () => {
    const job = await createJob({
      charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS,
    });
    await grantAuthorization(
      { jobId: job.jobId, actionClass: 'email.reply', recipients: ['dana@example.com'] },
      { businessId: BUSINESS },
    );
    await expect(
      grantAuthorization(
        { jobId: job.jobId, actionClass: 'crm.write', recipients: [] },
        { businessId: BUSINESS },
      ),
    ).rejects.toThrow(AuthorizationAlreadyGrantedError);

    const loaded = await loadAuthorization(job.jobId, { businessId: BUSINESS });
    expect(loaded?.actionClass).toBe('email.reply');
    expect(loaded?.recipients).toEqual(['dana@example.com']);
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
