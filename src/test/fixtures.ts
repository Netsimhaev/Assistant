import type { ActionClass } from '../domain/action.js';
import type { BusinessCharter, UnsignedCharter } from '../domain/charter.js';
import { BusinessCharter as CharterSchema } from '../domain/charter.js';
import type { AutonomyLevel, TrustLevel } from '../domain/trust.js';
import type { CharterConnection } from '../domain/connection.js';
import { signCharter } from '../charter/sign.js';

/**
 * Every action class must be declared — the schema has no implicit default,
 * because an undeclared class silently falling back to permissive is exactly
 * the failure mode the charter exists to prevent.
 */
const BASE_AUTONOMY: Record<ActionClass, AutonomyLevel> = {
  'email.reply': 'auto_notify',
  'email.initiate': 'approve_required',
  'whatsapp.reply': 'auto_notify',
  'whatsapp.initiate': 'approve_required',
  'calendar.create': 'auto_notify',
  'calendar.move': 'auto_notify',
  'calendar.cancel': 'approve_required',
  'quote.issue': 'approve_required',
  'discount.grant': 'approve_required',
  'commitment.make': 'approve_required',
  'purchase.place': 'approve_required',
  'payment.make': 'approve_required',
  'refund.issue': 'approve_required',
  'crm.write': 'auto_notify',
  'accounting.write': 'approve_required',
  'doc.deliver': 'approve_required',
  'media.publish': 'approve_required',
  // Clicking and typing in an already-approved session is ordinary work. The
  // control that matters is the provenance ceiling above it: a chain that has
  // read an untrusted page cannot reach `auto` no matter what this says.
  'browser.interact': 'auto',
  // Handing an agent a live authenticated session is not ordinary work.
  'browser.session': 'approve_required',
  // Producing a document is ordinary work; the control is the path scope and
  // the audit row, not an approval.
  'artifact.write': 'auto',
  'contract.sign': 'forbidden',
  'data.export': 'approve_required',
  'memory.write_longterm': 'auto',
  'charter.amend': 'draft_only',
};

/**
 * The layer that makes prompt injection structurally bounded: whatever the
 * baseline says, a chain originating from untrusted content cannot exceed this.
 */
const PROVENANCE_CEILING: Record<TrustLevel, AutonomyLevel> = {
  boss: 'auto',
  staff: 'auto_notify',
  known_counterparty: 'approve_required',
  unknown_external: 'draft_only',
  open_web: 'draft_only',
};

export interface CharterOverrides {
  version?: string;
  autonomyBase?: Partial<Record<ActionClass, AutonomyLevel>>;
  provenanceCeiling?: Partial<Record<TrustLevel, AutonomyLevel>>;
  singleActionCeilingMinor?: number;
  dailyCeilingMinor?: number;
  perActionClassCeilingMinor?: Partial<Record<ActionClass, number>>;
  doNotContactEntityId?: string;
  /** Adds a third counterparty blocked by email domain rather than by id. */
  doNotContactEmailDomain?: string;
  /** Adds a counterparty known (not blocked) by email domain, for risk scoring. */
  knownCounterpartyEmailDomain?: string;
  /** Connections the charter declares. Empty by default. */
  connections?: CharterConnection[];
}

/** A realistic small-business charter: an Israeli firm working Sun–Thu. */
export function buildCharter(overrides: CharterOverrides = {}): BusinessCharter {
  const unsigned: UnsignedCharter = {
    schemaVersion: '1.1',
    charterVersion: overrides.version ?? '2026-08-15.1',
    effectiveFrom: '2026-08-15T00:00:00.000Z',

    identity: {
      legalName: 'דוגמה שירותי הנדסה בע"מ',
      tradeName: 'דוגמה הנדסה',
      vertical: 'engineering_services',
      languages: ['he', 'en'],
      timezone: 'Asia/Jerusalem',
      locations: [{ id: 'hq', label: 'המשרד', address: 'תל אביב' }],
      whatWeDo: 'ייעוץ והנדסת מבנים לפרויקטים מסחריים.',
      whatWeDoNotDo: ['ייעוץ משפטי', 'תכנון אדריכלי'],
      keyFacts: [{ q: 'שעות פעילות', a: 'ראשון–חמישי 08:00–18:00' }],
    },

    voice: {
      persona: 'את מאיה, מנהלת המשרד של דוגמה הנדסה.',
      register: 'professional',
      signOff: { he: 'בברכה,\nמאיה', en: 'Best regards,\nMaya' },
      mustSay: [],
      mustNeverSay: ['מובטח', 'אין שום בעיה'],
      emojiPolicy: 'never',
      responseLength: 'normal',
      exemplars: [],
    },

    operations: {
      workweek: ['sun', 'mon', 'tue', 'wed', 'thu'],
      businessHours: [
        { day: 'sun', open: '08:00', close: '18:00' },
        { day: 'mon', open: '08:00', close: '18:00' },
        { day: 'tue', open: '08:00', close: '18:00' },
        { day: 'wed', open: '08:00', close: '18:00' },
        { day: 'thu', open: '08:00', close: '18:00' },
      ],
      holidays: [],
      quietHours: { from: '20:00', to: '07:00', appliesTo: ['email', 'whatsapp'] },
      slaHours: { email: 4, whatsapp: 2 },
      meetingDefaults: {
        defaultDurationMin: 30,
        bufferBeforeMin: 15,
        bufferAfterMin: 15,
        maxPerDay: 6,
        noMeetingBlocks: [{ day: 'thu', from: '14:00', to: '16:00' }],
        defaultLocationId: 'hq',
        videoProvider: 'meet',
      },
    },

    people: [
      {
        id: 'p_boss',
        displayName: 'יוסי כהן',
        role: 'בעלים',
        isPrincipal: true,
        channels: { whatsapp: '+972500000000', email: 'yossi@example.co.il' },
        approvalRights: [
          { actionClass: 'purchase.place', maxAmountMinor: 500_000 },
          { actionClass: 'quote.issue', maxAmountMinor: 2_000_000 },
        ],
        canAmendCharter: true,
        canTripKillSwitch: true,
        notify: { digest: true, approvals: true, incidents: true },
        escalationOrder: 0,
      },
    ],

    counterparties: [
      {
        match: { entityId: 'c_812' },
        label: 'לקוח ותיק',
        trust: 'known_counterparty',
        autonomyOverrides: {},
        tone: 'warm',
        language: 'he',
        doNotContact: false,
        notes: 'מעדיף פגישות בבוקר.',
      },
      {
        match: { entityId: overrides.doNotContactEntityId ?? 'c_blocked' },
        label: 'לא ליצור קשר',
        trust: 'known_counterparty',
        autonomyOverrides: {},
        doNotContact: true,
        notes: 'ביקש להפסיק כל קשר.',
      },
      // Only present when a test asks for it, so the default charter keeps the
      // shape every other test was written against.
      ...(overrides.doNotContactEmailDomain === undefined
        ? []
        : [
            {
              match: { emailDomain: overrides.doNotContactEmailDomain },
              label: 'חברה חסומה',
              trust: 'unknown_external' as const,
              autonomyOverrides: {},
              doNotContact: true,
              notes: 'עורכי דין של הצד השני — כל פנייה עוברת דרך הבוס.',
            },
          ]),
      ...(overrides.knownCounterpartyEmailDomain === undefined
        ? []
        : [
            {
              match: { emailDomain: overrides.knownCounterpartyEmailDomain },
              label: 'שותף מוכר',
              trust: 'known_counterparty' as const,
              autonomyOverrides: {},
              doNotContact: false,
              notes: 'שותף עסקי קבוע.',
            },
          ]),
    ],

    connections: overrides.connections ?? [],

    money: {
      currency: 'ILS',
      singleActionCeilingMinor: overrides.singleActionCeilingMinor ?? 300_000, // ₪3,000
      dailyCeilingMinor: overrides.dailyCeilingMinor ?? 1_000_000, // ₪10,000
      monthlyCeilingMinor: 10_000_000, // ₪100,000
      perActionClassCeilingMinor: {
        'quote.issue': 500_000, // ₪5,000
        ...overrides.perActionClassCeilingMinor,
      },
      maxDiscountPercent: 10,
      paymentInstruments: [
        { id: 'virtual_card', label: 'כרטיס וירטואלי', perTxnCeilingMinor: 250_000 },
      ],
      approvedSuppliers: [
        { entityId: 'supplier_a', categories: ['materials'], autoOrderCeilingMinor: 250_000 },
      ],
    },

    autonomy: {
      base: { ...BASE_AUTONOMY, ...overrides.autonomyBase },
      provenanceCeiling: { ...PROVENANCE_CEILING, ...overrides.provenanceCeiling },
      maxNudgesPerThread: 2,
      preferenceConfidenceThreshold: 0.7,
    },

    data: {
      retentionDays: { customer_pii: 730, financial: 2555 },
      redactBeforeSending: ['\\b\\d{9}\\b'],
      mayShareExternally: { health: 'never', legal: 'never', credentials: 'never' },
      subprocessorsAllowed: ['anthropic', 'google-workspace'],
    },

    forbidden: [
      // Reachable: ops.systems owns `data.export`, so this rule is genuinely
      // enforced by the charter layer rather than pre-empted by the allowlist.
      {
        id: 'no_customer_data_export',
        description: 'לעולם לא לייצא נתוני לקוחות אל מחוץ למערכת.',
        actionClasses: ['data.export'],
      },
      // Belt-and-braces: no agent owns a tool for either class, so the
      // capability layer denies these first. Stated anyway because the charter
      // is also a document the owner reads.
      {
        id: 'no_contract_signing',
        description: 'לעולם לא לחתום על חוזה או מסמך מחייב.',
        actionClasses: ['contract.sign'],
      },
      {
        id: 'no_payments_to_new_payees',
        description: 'לא לבצע תשלום לנמען שאינו ספק מאושר.',
        actionClasses: ['payment.make'],
      },
    ],
  };

  const signed = signCharter(unsigned, {
    signedByPersonId: 'p_boss',
    method: 'dashboard_click',
    signedAt: new Date('2026-08-15T09:00:00.000Z'),
  });

  // Parse so the fixture is validated the same way a real charter would be —
  // a fixture that could not survive the schema is not a useful fixture.
  return CharterSchema.parse(signed);
}
