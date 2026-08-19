import { z } from 'zod';
import { ActionClass } from './action.js';
import { AutonomyLevel, TrustLevel } from './trust.js';
import { CharterConnection } from './connection.js';

export const Channel = z.enum([
  'email',
  'whatsapp',
  'sms',
  'phone',
  'dashboard',
]);
export type Channel = z.infer<typeof Channel>;

export const Weekday = z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
export type Weekday = z.infer<typeof Weekday>;

export const DataClass = z.enum([
  'public',
  'internal',
  'customer_pii',
  'financial',
  'health',
  'legal',
  'credentials',
]);
export type DataClass = z.infer<typeof DataClass>;

const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM in 24-hour form');

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * Can the runtime actually resolve this zone?
 *
 * Checked at signing rather than at send time. `Intl` throws on an unknown
 * zone, and the quiet-hours reader caught that and fell back to UTC — which
 * does not widen the window, it *shifts* it, so a message the owner promised
 * would not go out at 22:30 went out. A zone we cannot resolve should fail the
 * charter, not the promise.
 */
function isResolvableTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Rejects a redaction pattern the engine could not compile. */
function isCompilableRegex(source: string): boolean {
  try {
    new RegExp(source, 'g');
    return true;
  } catch {
    return false;
  }
}

/** Minor units (agorot / cents). Integer so no float rounding ever applies to money. */
const MinorAmount = z.number().int().nonnegative();

/**
 * Every tool name the policy layer classifies, plus every tool it treats as
 * read-only. Generated from `classifiedToolNames()` and `READ_ONLY_TOOLS` in
 * `src/policy/classify.ts` — not imported from there, because that would make
 * `src/domain` depend on `src/policy`, which is a layering cycle. The
 * structural test in Task 8 asserts the two lists agree, so this duplication
 * cannot drift silently.
 */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'accounting.read', 'accounting.write', 'agent.request_help', 'artifact.read',
  'assert.evaluate', 'brand.check', 'browser.click', 'browser.fill',
  'browser.navigate', 'browser.screenshot', 'browser.snapshot',
  'browser.submit_order', 'calendar.propose_slots', 'calendar.read',
  'calendar.write', 'chart.render', 'charter.apply_amendment',
  'charter.evaluate', 'charter.propose_amendment', 'charter.read',
  'charter.voice', 'code_execution', 'commitment.make', 'contract.sign',
  'credential.request_session', 'crm.read', 'crm.write', 'data.export',
  'discount.grant', 'doc.deliver', 'doc.fetch', 'escalate_to_human',
  'file.write', 'followup.schedule', 'mail.draft', 'mail.send',
  'media.generate_image', 'media.generate_video', 'media.inspect',
  'media.publish', 'memory.recall', 'memory.recall_shallow', 'memory.retire',
  'memory.upsert_preference', 'memory.write_chunk', 'memory.write_entity',
  'norms.query', 'payment.charge', 'quote.issue', 'recipe.load',
  'recipe.save', 'refund.issue', 'render.markdown', 'schema.map',
  'tasks.read', 'tasks.update_state', 'template.load', 'template.render',
  'wa.can_send_freeform', 'wa.conversation_state', 'wa.send_message',
]);

/**
 * Is this a tool the policy layer knows?
 *
 * Duplicated deliberately rather than imported from `src/policy/classify.ts`:
 * domain must not depend on policy. The structural test in Task 8 asserts the
 * two lists agree, so the duplication cannot drift silently.
 */
function isKnownToolName(tool: string): boolean {
  return KNOWN_TOOL_NAMES.has(tool);
}

// ---------------------------------------------------------------------------

export const CharterIdentity = z.object({
  legalName: z.string().min(1),
  tradeName: z.string().min(1),
  vertical: z.string().min(1),
  /** Ordered by preference, e.g. ['he', 'en', 'ar']. */
  languages: z.array(z.string().min(2)).min(1),
  timezone: z
    .string()
    .min(1)
    .refine(isResolvableTimeZone, 'unknown IANA time zone'),
  locations: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        address: z.string().min(1),
      }),
    )
    .default([]),
  /** One paragraph, injected into agent prompts. */
  whatWeDo: z.string().min(1),
  /** Explicit non-services. This is what stops the assistant overpromising. */
  whatWeDoNotDo: z.array(z.string().min(1)).default([]),
  /** Questions the assistant may answer as fact without checking. */
  keyFacts: z
    .array(z.object({ q: z.string().min(1), a: z.string().min(1) }))
    .default([]),
});

export const CharterVoice = z.object({
  persona: z.string().min(1),
  register: z.enum(['formal', 'professional', 'warm', 'casual']),
  /** Sign-off per language code. */
  signOff: z.record(z.string(), z.string()).default({}),
  mustSay: z
    .array(z.object({ channel: Channel, text: z.string().min(1) }))
    .default([]),
  /**
   * Banned phrases. NOTE: this is a string match and therefore a *weak* control.
   * Anything that genuinely matters must also map to an ActionClass with a
   * restrictive autonomy level — see docs/04-charter.md.
   */
  mustNeverSay: z.array(z.string().min(1)).default([]),
  emojiPolicy: z.enum(['never', 'sparingly', 'match_counterparty']).default('never'),
  responseLength: z.enum(['terse', 'normal', 'detailed']).default('normal'),
  exemplars: z
    .array(
      z.object({
        channel: Channel,
        good: z.array(z.string()).default([]),
        bad: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export const CharterOperations = z.object({
  /** An Israeli business week is Sun–Thu. Never hard-code Mon–Fri. */
  workweek: z.array(Weekday).min(1),
  businessHours: z
    .array(z.object({ day: Weekday, open: TimeOfDay, close: TimeOfDay }))
    .default([]),
  holidays: z
    .array(z.object({ date: IsoDate, label: z.string().min(1) }))
    .default([]),
  quietHours: z
    .object({
      from: TimeOfDay,
      to: TimeOfDay,
      appliesTo: z.array(Channel).default([]),
    })
    .optional(),
  /** Response-time commitment per channel, in hours. */
  slaHours: z.partialRecord(Channel, z.number().positive()).default({}),
  meetingDefaults: z.object({
    defaultDurationMin: z.number().int().positive().default(30),
    bufferBeforeMin: z.number().int().nonnegative().default(0),
    bufferAfterMin: z.number().int().nonnegative().default(0),
    maxPerDay: z.number().int().positive().default(8),
    noMeetingBlocks: z
      .array(z.object({ day: Weekday, from: TimeOfDay, to: TimeOfDay }))
      .default([]),
    defaultLocationId: z.string().optional(),
    videoProvider: z.enum(['meet', 'zoom', 'teams']).optional(),
  }),
});

export const CharterPerson = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  role: z.string().min(1),
  /** "The boss". Exactly one person must carry this. */
  isPrincipal: z.boolean().default(false),
  channels: z.partialRecord(Channel, z.string()).default({}),
  approvalRights: z
    .array(
      z.object({
        actionClass: ActionClass,
        maxAmountMinor: MinorAmount.optional(),
      }),
    )
    .default([]),
  canAmendCharter: z.boolean().default(false),
  canTripKillSwitch: z.boolean().default(false),
  notify: z
    .object({
      digest: z.boolean().default(true),
      approvals: z.boolean().default(true),
      incidents: z.boolean().default(true),
    })
    .default({ digest: true, approvals: true, incidents: true }),
  escalationOrder: z.number().int().nonnegative().default(0),
});

export const CharterCounterparty = z.object({
  match: z
    .object({
      entityId: z.string().optional(),
      emailDomain: z.string().optional(),
      phone: z.string().optional(),
      tag: z.string().optional(),
    })
    .refine(
      (m) => Boolean(m.entityId ?? m.emailDomain ?? m.phone ?? m.tag),
      'a counterparty rule needs at least one match key, otherwise it matches nothing',
    ),
  label: z.string().min(1),
  trust: TrustLevel,
  autonomyOverrides: z.partialRecord(ActionClass, AutonomyLevel).default({}),
  tone: z.enum(['formal', 'warm']).optional(),
  language: z.string().optional(),
  doNotContact: z.boolean().default(false),
  priceListId: z.string().optional(),
  paymentTermsDays: z.number().int().nonnegative().optional(),
  notes: z.string().default(''),
});

export const CharterMoney = z.object({
  currency: z.string().length(3),
  singleActionCeilingMinor: MinorAmount,
  dailyCeilingMinor: MinorAmount,
  monthlyCeilingMinor: MinorAmount,
  perActionClassCeilingMinor: z.partialRecord(ActionClass, MinorAmount).default({}),
  maxDiscountPercent: z.number().min(0).max(100).default(0),
  paymentInstruments: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        perTxnCeilingMinor: MinorAmount,
      }),
    )
    .default([]),
  approvedSuppliers: z
    .array(
      z.object({
        entityId: z.string().min(1),
        categories: z.array(z.string()).default([]),
        autoOrderCeilingMinor: MinorAmount,
      }),
    )
    .default([]),
});

export const CharterAutonomy = z.object({
  /** Baseline per action class. Every class must be declared — no implicit default. */
  base: z.record(ActionClass, AutonomyLevel),
  /**
   * The hard cap a chain of a given provenance may reach, whatever the baseline
   * says. This is the layer that makes prompt injection structurally bounded.
   */
  provenanceCeiling: z.record(TrustLevel, AutonomyLevel),
  maxNudgesPerThread: z.number().int().nonnegative().default(2),
  /** A learned preference below this confidence may inform a draft but never drive an action. */
  preferenceConfidenceThreshold: z.number().min(0).max(1).default(0.7),
});

export const CharterData = z.object({
  retentionDays: z.partialRecord(DataClass, z.number().int().positive()).default({}),
  /**
   * Regex patterns redacted at retrieval time, not just at send time.
   *
   * Compiled here so an unusable pattern cannot be signed. Without this the
   * runtime skipped it and carried on, which meant a typo silently disabled a
   * redaction the owner had put their name to.
   */
  redactBeforeSending: z.array(z.string().refine(isCompilableRegex, 'not a valid regular expression')).default([]),
  mayShareExternally: z
    .partialRecord(DataClass, z.enum(['never', 'with_approval', 'yes']))
    .default({}),
  /** An MCP server not on this list is not loaded at all. */
  subprocessorsAllowed: z.array(z.string()).default([]),
});

/**
 * A hard prohibition, compiled into a predicate that denies before anything
 * else runs. Not overridable — not by an approval, not by the boss.
 */
export const ForbiddenRule = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /** Action classes this rule forbids outright. */
  actionClasses: z.array(ActionClass).min(1),
  /** Optional narrowing: only forbid when the counterparty carries this tag. */
  whenCounterpartyTag: z.string().optional(),
});

export const CharterSignature = z.object({
  signedByPersonId: z.string().min(1),
  signedAt: z.string().datetime(),
  method: z.enum(['dashboard_click', 'e_sign', 'signed_pdf']),
  /** sha256 over the canonical JSON of the charter *excluding* this block. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest'),
});

const BusinessCharterShape = z.object({
  schemaVersion: z.literal('1.0'),
  charterVersion: z.string().min(1),
  effectiveFrom: z.string().datetime(),
  supersedes: z.string().optional(),
  signature: CharterSignature,

  identity: CharterIdentity,
  voice: CharterVoice,
  operations: CharterOperations,
  people: z.array(CharterPerson).min(1),
  counterparties: z.array(CharterCounterparty).default([]),
  connections: z.array(CharterConnection).default([]),
  money: CharterMoney,
  autonomy: CharterAutonomy,
  data: CharterData,
  forbidden: z.array(ForbiddenRule).default([]),
});

export const BusinessCharter = BusinessCharterShape.superRefine((charter, ctx) => {
  for (const [index, connection] of charter.connections.entries()) {
    // A connection serving a tool that does not exist is dead policy: it
    // compiles, appears in the signed document, and can never be selected.
    for (const tool of connection.serves) {
      if (!isKnownToolName(tool)) {
        ctx.addIssue({
          code: 'custom',
          path: ['connections', index, 'serves'],
          message: `unknown tool "${tool}"`,
        });
      }
    }
    // Every intermediary sees the payload, which is customer correspondence.
    if (
      connection.subprocessor !== null &&
      !charter.data.subprocessorsAllowed.includes(connection.subprocessor)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['connections', index, 'subprocessor'],
        message: `subprocessor "${connection.subprocessor}" is not in data.subprocessorsAllowed`,
      });
    }
  }
});

export type BusinessCharter = z.infer<typeof BusinessCharter>;
export type CharterPerson = z.infer<typeof CharterPerson>;
export type CharterCounterparty = z.infer<typeof CharterCounterparty>;
export type ForbiddenRule = z.infer<typeof ForbiddenRule>;

/**
 * An unsigned charter — what the onboarding flow assembles before the owner
 * signs. Signing computes the hash over exactly this shape.
 *
 * Built from `BusinessCharterShape` rather than `BusinessCharter` because zod
 * does not support `.omit()` on a refined schema. Nothing is lost: connections
 * validation is a signing-time concern, so it runs when the *signed* charter
 * is parsed, not when the unsigned draft is assembled.
 */
export const UnsignedCharter = BusinessCharterShape.omit({ signature: true });
export type UnsignedCharter = z.infer<typeof UnsignedCharter>;

/** Exactly one principal, or the escalation chain has no root. */
export function assertExactlyOnePrincipal(people: readonly CharterPerson[]): void {
  const principals = people.filter((p) => p.isPrincipal);
  if (principals.length !== 1) {
    throw new Error(
      `charter must declare exactly one principal, found ${principals.length}`,
    );
  }
}
