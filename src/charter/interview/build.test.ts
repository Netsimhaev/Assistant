import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../../db/pool.js';
import { BusinessCharter } from '../../domain/charter.js';
import type { CharterConnection } from '../../domain/connection.js';
import { evaluateToolCall, type GateContext } from '../../policy/engine.js';
import type { PolicyBundle } from '../../domain/policy.js';
import { resetDatabase } from '../../test/db.js';
import { buildCharter } from '../../test/fixtures.js';
import { canonicalHash } from '../../util/canonical.js';
import { compileCharter } from '../compile.js';
import { signCharter } from '../sign.js';
import { installCharter } from '../store.js';
import { MAILBOX_SUBPROCESSOR } from '../amend-mailbox.js';
import type { InterviewAnswers } from './answers.js';
import { INTERVIEW_NEVER_PREFIX, buildCharterFromInterview, prefillFromCharter } from './build.js';
import { INTERVIEW_ROWS, MONEY_ROWS } from './rows.js';
import { completeAnswers } from './test-answers.js';

const BUSINESS = 'test-business';
const FROZEN = new Date('2026-10-31T10:00:00.000Z');
const NOON = new Date('2026-08-18T09:00:00.000Z');

function build(a: InterviewAnswers, previous: BusinessCharter | null = null) {
  return buildCharterFromInterview(a, { businessId: BUSINESS, frozenAt: FROZEN, previous });
}

function sign(unsigned: ReturnType<typeof build>): BusinessCharter {
  return BusinessCharter.parse(
    signCharter(unsigned, { signedByPersonId: 'u', method: 'dashboard_click', signedAt: FROZEN }),
  );
}

/** Fills the sections prefill could not recover with the complete fixture's. */
function completed(draft: ReturnType<typeof prefillFromCharter>): InterviewAnswers {
  const base = completeAnswers();
  return {
    ...base,
    ...draft,
    autonomy: draft.autonomy ?? base.autonomy,
  } as InterviewAnswers;
}

function ctx(bundle: PolicyBundle, over: Partial<GateContext> = {}): GateContext {
  return {
    agent: 'comms.email',
    bundle,
    provenance: 'boss',
    chainDepth: 0,
    businessId: BUSINESS,
    jobId: 'J-TEST',
    counterpartyTags: [],
    rampLevel: 'auto',
    now: NOON,
    ...over,
  } as GateContext;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('buildCharterFromInterview', () => {
  it('builds a charter that parses, verifies and compiles', () => {
    expect(() => compileCharter(sign(build(completeAnswers())))).not.toThrow();
  });

  it('is deterministic for the same frozenAt', () => {
    expect(canonicalHash(build(completeAnswers()))).toBe(canonicalHash(build(completeAnswers())));
  });

  it('changes the version when an answer changes', () => {
    const other = completeAnswers();
    other.business.employees = 4;
    expect(build(other).charterVersion).not.toBe(build(completeAnswers()).charterVersion);
    expect(build(other).charterVersion.startsWith(`${FROZEN.toISOString()}.iv-`)).toBe(true);
    expect(build(other).effectiveFrom).toBe(FROZEN.toISOString());
    expect(build(other).supersedes).toBeUndefined();
  });

  it('a never row becomes a forbidden rule that the gate enforces', async () => {
    const a = completeAnswers();
    a.actions['quote.issue'] = 'never';
    const charter = sign(build(a));
    expect(charter.autonomy.base['quote.issue']).toBe('draft_only');
    const bundle = await installCharter(charter, { businessId: BUSINESS });

    const decision = await evaluateToolCall('quote.issue', { amountMinor: 100 }, ctx(bundle));

    expect(decision.outcome).toBe('deny');
    if (decision.outcome !== 'deny') throw new Error('unreachable');
    expect(decision.code).toBe(`forbidden:${INTERVIEW_NEVER_PREFIX}quote.issue`);
  });

  it('email.reply defaults to auto_notify', () => {
    const a = completeAnswers();
    a.actions = {};
    const charter = build(a);
    expect(charter.autonomy.base['email.reply']).toBe('auto_notify');
    // And the other defaults are the strict ones: money rows never.
    for (const row of MONEY_ROWS) {
      expect(charter.autonomy.base[row]).toBe('draft_only');
      expect(charter.forbidden.some((r) => r.id === `${INTERVIEW_NEVER_PREFIX}${row}`)).toBe(true);
    }
  });

  it('maps approve and alone to approve_required and auto_notify', () => {
    const charter = build(completeAnswers());
    expect(charter.autonomy.base['email.initiate']).toBe('approve_required');
    expect(charter.autonomy.base['calendar.create']).toBe('auto_notify');
    expect(charter.autonomy.base['quote.issue']).toBe('approve_required');
    expect(charter.autonomy.base['contract.sign']).toBe('forbidden');
  });

  it('refuses alone on a row outside ALONE_ALLOWED', () => {
    const a = completeAnswers();
    a.actions['email.initiate'] = 'alone';
    expect(() => build(a)).toThrow(/email\.initiate/);
  });

  it('refuses an answer for a class that is not an interview row', () => {
    const a = completeAnswers();
    a.actions['payment.make'] = 'approve';
    expect(() => build(a)).toThrow(/payment\.make/);
  });

  it('all money rows never zeroes the ceilings', () => {
    const a = completeAnswers();
    for (const row of MONEY_ROWS) a.actions[row] = 'never';
    const { money } = build(a);
    expect(money.singleActionCeilingMinor).toBe(0);
    expect(money.dailyCeilingMinor).toBe(0);
    expect(money.monthlyCeilingMinor).toBe(0);
    expect(money.maxDiscountPercent).toBe(0);
  });

  it('carries the money answers when a money row is open', () => {
    const { money } = build(completeAnswers());
    expect(money).toMatchObject({
      currency: 'ILS',
      singleActionCeilingMinor: 100_000,
      dailyCeilingMinor: 300_000,
      monthlyCeilingMinor: 2_000_000,
      maxDiscountPercent: 5,
    });
  });

  it('declares the principal, the counterparties and the extra rules', () => {
    const a = completeAnswers();
    a.principal.whatsapp = null;
    a.extra.accepted.push(
      { kind: 'do_not_contact', text: 'לא לפנות לשכן.', entry: { label: 'השכן', emailDomain: 'neighbour.co.il' } },
      { kind: 'never_say', text: 'לא לומר "בחינם".', phrase: 'בחינם' },
      { kind: 'guidance', text: 'לא מקבלים לקוחות בלי תור.' },
    );
    const c = build(a);
    expect(c.people).toEqual([
      {
        id: 'p_principal',
        isPrincipal: true,
        displayName: 'דנה לוי',
        role: 'בעלים',
        channels: { email: 'dana@example.co.il' },
        approvalRights: [],
        canAmendCharter: true,
        canTripKillSwitch: true,
        notify: { digest: true, approvals: true, incidents: true },
        escalationOrder: 0,
      },
    ]);
    expect(c.counterparties.map((cp) => [cp.label, cp.trust, cp.doNotContact])).toEqual([
      ['ספק מוצרים', 'known_counterparty', false],
      ['מתחרה', 'unknown_external', true],
      ['השכן', 'unknown_external', true],
    ]);
    expect(c.counterparties[2]?.match).toEqual({ emailDomain: 'neighbour.co.il' });
    expect(c.voice.mustNeverSay).toEqual(['מובטח', 'בחינם']);
    expect(c.voice.signOff).toEqual({ he: 'תודה, דנה' });
    expect(c.voice.persona).toBe('את העוזרת של דוגמה תספורות.');
    expect(c.identity.whatWeDoNotDo).toEqual(['צביעת שיער', 'לא מקבלים לקוחות בלי תור.']);
    expect(c.identity.whatWeDo).toBe(
      'מספרה לגברים בחולון. בעסק 3 עובדים. מה מצופה ממני: לקבוע תורים ולענות ללקוחות.',
    );
    expect(c.identity.languages).toEqual(['he']);
    expect(c.forbidden.find((r) => r.id === 'interview_extra_0')).toEqual({
      id: 'interview_extra_0',
      description: 'לעולם לא לפרסם מחירים.',
      actionClasses: ['media.publish'],
    });
    expect(c.forbidden.slice(0, 3).map((r) => r.id)).toEqual([
      'no_customer_data_export',
      'no_contract_signing',
      'no_payments_to_new_payees',
    ]);
    expect(c.operations.quietHours).toEqual({ from: '21:00', to: '08:00', appliesTo: ['email', 'whatsapp'] });
    expect(c.operations.businessHours).toHaveLength(5);
    expect(c.data.subprocessorsAllowed).toEqual(['anthropic']);
    expect(c.connections).toEqual([]);
    expect(() => compileCharter(sign(c))).not.toThrow();
  });

  it('mailbox google adds the connection and moves mail.send to it', () => {
    const officeMail: CharterConnection = {
      system: 'office-mail',
      label: 'תיבת המשרד',
      channel: 'api',
      serves: ['mail.send'],
      target: null,
      subprocessor: null,
    };
    const calendar: CharterConnection = {
      system: 'office-calendar',
      label: 'יומן',
      channel: 'api',
      serves: ['calendar.read'],
      target: null,
      subprocessor: null,
    };
    const previous = buildCharter({ connections: [officeMail, calendar] });
    const a = completed(prefillFromCharter(previous));
    a.reading = { mailbox: 'google', documents: false };
    const c = sign(build(a, previous));
    expect(c.connections.map((x) => x.system)).toEqual(['office-calendar', 'mailbox']);
    expect(c.connections.find((x) => x.system === 'mailbox')?.subprocessor).toBe(MAILBOX_SUBPROCESSOR.google);
    expect(c.data.subprocessorsAllowed).toContain(MAILBOX_SUBPROCESSOR.google);
    expect(c.data.subprocessorsAllowed).toContain('anthropic');

    // Fresh install: the mailbox is the only connection.
    const fresh = completeAnswers();
    fresh.reading = { mailbox: 'microsoft', documents: false };
    const f = build(fresh);
    expect(f.connections.map((x) => [x.system, x.subprocessor])).toEqual([
      ['mailbox', MAILBOX_SUBPROCESSOR.microsoft],
    ]);
    expect(f.data.subprocessorsAllowed).toEqual(['anthropic', MAILBOX_SUBPROCESSOR.microsoft]);
  });

  it('keeps a mailbox the previous charter declares, whatever the answer', () => {
    const withMailbox = completeAnswers();
    withMailbox.reading = { mailbox: 'google', documents: false };
    const previous = sign(build(withMailbox));
    const a = completeAnswers();
    a.reading = { mailbox: 'none', documents: false };
    const c = build(a, previous);
    expect(c.connections.map((x) => x.system)).toEqual(['mailbox']);
    expect(c.data.subprocessorsAllowed).toContain(MAILBOX_SUBPROCESSOR.google);
  });

  it('editing keeps fields the interview never asks', () => {
    const previous = buildCharter();
    const draft = prefillFromCharter(previous);
    const c = sign(build(completed(draft), previous));

    expect(c.supersedes).toBe(previous.charterVersion);
    expect(c.money.approvedSuppliers).toEqual(previous.money.approvedSuppliers);
    expect(c.money.paymentInstruments).toEqual(previous.money.paymentInstruments);
    expect(c.money.perActionClassCeilingMinor).toEqual(previous.money.perActionClassCeilingMinor);
    expect(c.operations.slaHours).toEqual(previous.operations.slaHours);
    expect(c.operations.meetingDefaults).toEqual(previous.operations.meetingDefaults);
    expect(c.counterparties.find((cp) => cp.match.entityId === 'c_812')).toEqual(
      previous.counterparties.find((cp) => cp.match.entityId === 'c_812'),
    );
    expect(c.identity.languages).toEqual(previous.identity.languages);
    expect(c.identity.locations).toEqual(previous.identity.locations);
    expect(c.voice.persona).toBe(previous.voice.persona);
    expect(c.voice.signOff['en']).toBe(previous.voice.signOff['en']);
    const principal = c.people.find((p) => p.isPrincipal);
    const before = previous.people.find((p) => p.isPrincipal);
    expect(principal?.id).toBe(before?.id);
    expect(principal?.approvalRights).toEqual(before?.approvalRights);
    expect(c.autonomy.provenanceCeiling).toEqual(previous.autonomy.provenanceCeiling);
    expect(c.data.subprocessorsAllowed).toEqual(
      expect.arrayContaining(previous.data.subprocessorsAllowed),
    );
    expect(c.forbidden.filter((r) => !r.id.startsWith('interview_')).map((r) => r.id)).toEqual(
      previous.forbidden.map((r) => r.id),
    );
    expect(() => compileCharter(c)).not.toThrow();
  });

  it('prefill round-trips an interview-built charter', () => {
    const a = completeAnswers();
    const draft = prefillFromCharter(sign(build(a)));
    const { autonomy: _autonomy, ...expected } = a;
    expect(draft.autonomy).toBeUndefined();
    expect(draft).toEqual({ ...expected, extra: { ...a.extra, pending: [] } });
  });

  it('prefill folds rules that live in other sections, and rebuilding is stable', () => {
    const a = completeAnswers();
    a.extra.accepted.push(
      { kind: 'do_not_contact', text: 'x', entry: { label: 'השכן', emailDomain: 'neighbour.co.il' } },
      { kind: 'never_say', text: 'y', phrase: 'בחינם' },
      { kind: 'guidance', text: 'לא מקבלים לקוחות בלי תור.' },
    );
    const first = build(a);
    const again = build(completed(prefillFromCharter(sign(first))));
    const { charterVersion: _v1, ...one } = first;
    const { charterVersion: _v2, ...two } = again;
    expect(canonicalHash(two)).toBe(canonicalHash(one));
  });

  it('prefill covers every interview row', () => {
    const draft = prefillFromCharter(buildCharter());
    expect(Object.keys(draft.actions ?? {}).sort()).toEqual([...INTERVIEW_ROWS].sort());
    // The fixture's crm.write is auto_notify (alone allowed); quote.issue is approve_required.
    expect(draft.actions?.['crm.write']).toBe('alone');
    expect(draft.actions?.['quote.issue']).toBe('approve');
    // whatWeDo does not match the interview template: business is left for the owner.
    expect(draft.business).toBeUndefined();
  });
});
