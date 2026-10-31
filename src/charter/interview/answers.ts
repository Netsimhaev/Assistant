import { z } from 'zod';
import { ActionClass } from '../../domain/action.js';
import {
  CharterVoice,
  TimeOfDay,
  Weekday,
  emailDomainProblem,
  isResolvableTimeZone,
} from '../../domain/charter.js';
import { AutonomyMode } from '../../governance/autonomy-mode.js';
import { authorityNumberKey } from '../../governance/principal-number.js';

/**
 * The owner's answers to the setup interview. This is the single shape a
 * charter is later built from; every section is saved whole, so a draft is the
 * full schema with each top-level section optional.
 */

/** How much freedom the owner gives one action row. */
export const InterviewLevel = z.enum(['never', 'approve', 'alone']);
export type InterviewLevel = z.infer<typeof InterviewLevel>;

/**
 * A person or company named by the owner. The domain is checked with the
 * charter's own validator (same message), and the phone must survive
 * `authorityNumberKey` — a form that merely "normalises to something" would be
 * signed and then never match anything.
 */
export const CounterpartyEntry = z
  .object({
    label: z.string().min(1),
    emailDomain: z.string().optional(),
    phone: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.emailDomain === undefined && entry.phone === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'יש למלא דומיין מייל או מספר טלפון',
      });
    }
    if (entry.emailDomain !== undefined) {
      const problem = emailDomainProblem(entry.emailDomain);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', path: ['emailDomain'], message: problem });
      }
    }
    if (entry.phone !== undefined && authorityNumberKey(entry.phone) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['phone'],
        message:
          'מספר הטלפון אינו בצורה בינלאומית מלאה — יש לכתוב אותו עם קידומת מדינה ובלי הספרה המקומית המובילה, לדוגמה "+972541234567"',
      });
    }
  });
export type CounterpartyEntry = z.infer<typeof CounterpartyEntry>;

const RuleText = z.string().min(1).max(500);

export const AcceptedRule = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('forbid'),
    text: RuleText,
    actionClasses: z.array(ActionClass).min(1),
  }),
  z.object({ kind: z.literal('do_not_contact'), text: RuleText, entry: CounterpartyEntry }),
  z.object({ kind: z.literal('never_say'), text: RuleText, phrase: z.string().min(1) }),
  z.object({ kind: z.literal('guidance'), text: RuleText }),
]);
export type AcceptedRule = z.infer<typeof AcceptedRule>;

export const InterviewAnswers = z.object({
  business: z.object({
    description: z.string(),
    legalName: z.string(),
    tradeName: z.string(),
    vertical: z.string(),
    employees: z.number().int().min(1),
    expectations: z.string(),
    notDone: z.array(z.string()),
    keyFacts: z.array(z.object({ q: z.string(), a: z.string() })),
  }),
  principal: z.object({
    displayName: z.string(),
    role: z.string(),
    whatsapp: z
      .string()
      .nullable()
      .refine((v) => v === null || authorityNumberKey(v) !== null, {
        message:
          'מספר הוואטסאפ של הבעלים אינו בצורה בינלאומית מלאה — יש לכתוב אותו עם קידומת מדינה ובלי הספרה המקומית המובילה, לדוגמה "+972541234567"',
      }),
    email: z.string().nullable(),
  }),
  voice: z.object({
    register: CharterVoice.shape.register,
    signOff: z.string(),
    emojiPolicy: CharterVoice.shape.emojiPolicy,
    mustNeverSay: z.array(z.string()),
  }),
  hours: z.object({
    workweek: z.array(Weekday).min(1),
    open: TimeOfDay,
    close: TimeOfDay,
    quietHours: z.object({ from: TimeOfDay, to: TimeOfDay }).nullable(),
    timezone: z.string().refine(isResolvableTimeZone, 'unknown IANA time zone'),
  }),
  reading: z.object({
    mailbox: z.enum(['none', 'google', 'microsoft']),
    documents: z.boolean(),
  }),
  /** Missing rows take the row defaults (Task 3), never a permissive value. */
  actions: z.partialRecord(ActionClass, InterviewLevel),
  money: z.object({
    singleMinor: z.number().int().min(0),
    dailyMinor: z.number().int().min(0),
    monthlyMinor: z.number().int().min(0),
    maxDiscountPercent: z.number().min(0).max(100),
  }),
  counterparties: z.object({
    known: z.array(CounterpartyEntry),
    doNotContact: z.array(CounterpartyEntry),
  }),
  autonomy: z.object({ mode: AutonomyMode }),
  extra: z.object({
    accepted: z.array(AcceptedRule),
    pending: z.array(AcceptedRule),
  }),
});
export type InterviewAnswers = z.infer<typeof InterviewAnswers>;

/** A section is always saved whole, so a draft is just sections-or-nothing. */
export const InterviewAnswersDraft = InterviewAnswers.partial();
export type InterviewAnswersDraft = z.infer<typeof InterviewAnswersDraft>;

/** Step order; step n is index n - 1. */
export const INTERVIEW_SECTIONS: readonly (keyof InterviewAnswers)[] = [
  'business',
  'principal',
  'voice',
  'hours',
  'reading',
  'actions',
  'money',
  'counterparties',
  'autonomy',
  'extra',
];
