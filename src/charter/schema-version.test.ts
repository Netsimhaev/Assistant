/**
 * The guard that makes `CURRENT_SCHEMA_VERSION` do its job.
 *
 * `BusinessCharter` embeds two enums **exhaustively** — `autonomy.base` is a
 * `z.record(ActionClass, …)` and `autonomy.provenanceCeiling` is a
 * `z.record(TrustLevel, …)`, both of which require every member to be present.
 * So adding a member to either enum silently invalidates every charter that
 * was ever signed: the stored document declares the old set, `.parse()` finds
 * a key missing, and the installation stops being able to read the document
 * its owner put their name to.
 *
 * `CURRENT_SCHEMA_VERSION` exists to make that failure legible — `loadActiveCharter`
 * compares it *before* parsing and raises a direction-aware remedy ("signed
 * under an older schema and must be re-signed") instead of a raw `ZodError`.
 * That only works if the version is bumped when the enums change, and nothing
 * forced it: `agent.delegate` joined `ActionClass` on the `agent-envelope`
 * branch with the version left at `1.1`, and the next installation to run a
 * scheduler pass got exactly the illegible `ZodError` the mechanism was
 * written to prevent — on every job, every pass, with no way to install a
 * replacement charter because the recovery path reads the old one first.
 *
 * This test is the thing that was missing. It pins the exact membership of
 * both enums as of the current schema version. It is deliberately a frozen
 * literal list and not `ActionClass.options` compared against itself — a
 * check written that way passes no matter what the enum says, which is the
 * shape of a test that cannot fail.
 *
 * **If this test fails, the fix is almost never in the test.** Adding or
 * removing a member here is a breaking change to every signed charter:
 * bump `CURRENT_SCHEMA_VERSION` in `src/domain/charter.ts`, update the list
 * below to match, and say in the constant's docblock what changed. Editing
 * only the list puts the project back in the state this guard exists to
 * catch.
 */
import { describe, expect, it } from 'vitest';
import { ActionClass } from '../domain/action.js';
import { CURRENT_SCHEMA_VERSION } from '../domain/charter.js';
import { TrustLevel } from '../domain/trust.js';

/**
 * Every enum the charter serialises exhaustively, and the members it declared
 * when `CURRENT_SCHEMA_VERSION` was last bumped.
 */
const FROZEN_AT_CURRENT_SCHEMA = {
  schemaVersion: '1.2',
  /** `CharterAutonomy.base` — one entry per member, no implicit default. */
  actionClasses: [
    'email.reply',
    'email.initiate',
    'whatsapp.reply',
    'whatsapp.initiate',
    'calendar.create',
    'calendar.move',
    'calendar.cancel',
    'quote.issue',
    'discount.grant',
    'commitment.make',
    'purchase.place',
    'payment.make',
    'refund.issue',
    'crm.write',
    'accounting.write',
    'artifact.write',
    'doc.deliver',
    'media.publish',
    'browser.interact',
    'browser.session',
    'contract.sign',
    'data.export',
    'memory.write_longterm',
    'charter.amend',
    'agent.delegate',
  ],
  /** `CharterAutonomy.provenanceCeiling` — the provenance ladder. */
  trustLevels: ['boss', 'staff', 'known_counterparty', 'unknown_external', 'open_web'],
} as const;

const REMEDY =
  'this enum is serialised exhaustively into every signed charter, so changing it ' +
  'makes every stored charter unparseable. Bump CURRENT_SCHEMA_VERSION in ' +
  'src/domain/charter.ts, update the frozen list in this file, and record what ' +
  'changed in the constant\'s docblock. Do not update the list alone.';

describe('charter schema version', () => {
  it('is the version the frozen enum lists were taken at', () => {
    // Catches the half-done change: someone bumps the constant and leaves the
    // lists, or updates the lists and leaves the constant.
    expect(CURRENT_SCHEMA_VERSION).toBe(FROZEN_AT_CURRENT_SCHEMA.schemaVersion);
  });

  it(`pins every ActionClass member — ${REMEDY}`, () => {
    expect([...ActionClass.options].sort()).toEqual(
      [...FROZEN_AT_CURRENT_SCHEMA.actionClasses].sort(),
    );
  });

  it(`pins every TrustLevel member — ${REMEDY}`, () => {
    expect([...TrustLevel.options].sort()).toEqual(
      [...FROZEN_AT_CURRENT_SCHEMA.trustLevels].sort(),
    );
  });

  it('counts them too, so a swap of one member for another cannot pass', () => {
    // `toEqual` on sorted arrays already catches a swap; this pins the sizes
    // separately so a future rewrite of the assertions above into something
    // looser (a subset check, say) still fails on a size change.
    expect(ActionClass.options.length).toBe(FROZEN_AT_CURRENT_SCHEMA.actionClasses.length);
    expect(TrustLevel.options.length).toBe(FROZEN_AT_CURRENT_SCHEMA.trustLevels.length);
  });
});
