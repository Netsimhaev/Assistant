/**
 * The action rows of the setup interview's "what may I do" table.
 *
 * A row is an `ActionClass` the owner can set to never / ask / alone. This
 * module holds only the facts the table is built from: which rows exist,
 * their defaults, which may be set to "alone", whether the capability layer
 * can reach them at all, and whether they actually work today. All of it is
 * positive named sets — a row not listed here is not in the table.
 */
import { ActionClass } from '../../domain/action.js';
import type { AgentId } from '../../domain/audit.js';
import type { CharterConnection } from '../../domain/connection.js';
import { implementedLocalTools } from '../../orchestrator/local-tools.js';
import { classifiedToolNames, classifyAction } from '../../policy/classify.js';
import { AGENT_ALLOWLISTS, isToolPermitted } from '../capabilities.js';
import type { InterviewLevel } from './answers.js';

export const INTERVIEW_ROWS = [
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
  'refund.issue',
  'crm.write',
  'accounting.write',
  'doc.deliver',
  'media.publish',
] as const;
export type InterviewRow = (typeof INTERVIEW_ROWS)[number];

/** Rows where a mistake costs money; they default to "never". */
export const MONEY_ROWS: ReadonlySet<InterviewRow> = new Set<InterviewRow>([
  'quote.issue',
  'discount.grant',
  'commitment.make',
  'purchase.place',
  'refund.issue',
]);

/**
 * The only rows the owner may set to "alone". Named, never derived: none is
 * in NEVER_FULLY_AUTONOMOUS and none is an initiate class (first contact
 * always asks).
 */
export const ALONE_ALLOWED: ReadonlySet<InterviewRow> = new Set<InterviewRow>([
  'email.reply',
  'whatsapp.reply',
  'calendar.create',
  'calendar.move',
  'crm.write',
]);

const NEVER_DEFAULT: ReadonlySet<InterviewRow> = new Set<InterviewRow>([
  ...MONEY_ROWS,
  'accounting.write',
  'media.publish',
]);

function defaultFor(row: InterviewRow): InterviewLevel {
  if (row === 'email.reply') return 'alone';
  if (NEVER_DEFAULT.has(row)) return 'never';
  return 'approve';
}

export const ROW_DEFAULTS: Record<InterviewRow, InterviewLevel> = Object.fromEntries(
  INTERVIEW_ROWS.map((r) => [r, defaultFor(r)]),
) as Record<InterviewRow, InterviewLevel>;

export const ROW_EXAMPLES: Record<InterviewRow, string> = {
  'email.reply': 'למשל: לקוח שואל מתי נפתחים, והעוזרת עונה לו במייל.',
  'email.initiate': 'למשל: העוזרת פותחת שיחה חדשה עם מי שעוד לא כתב לך.',
  'whatsapp.reply': 'למשל: לקוח שואל בוואטסאפ אם יש מקום, והעוזרת עונה.',
  'whatsapp.initiate': 'למשל: העוזרת שולחת הודעת וואטסאפ ראשונה למי שלא פנה אליך.',
  'calendar.create': 'למשל: העוזרת קובעת פגישה חדשה ביומן.',
  'calendar.move': 'למשל: העוזרת מזיזה פגישה קיימת לשעה אחרת.',
  'calendar.cancel': 'למשל: העוזרת מבטלת פגישה שנקבעה.',
  'quote.issue': 'למשל: העוזרת שולחת ללקוח הצעת מחיר עם סכום.',
  'discount.grant': 'למשל: העוזרת מציעה ללקוח הנחה.',
  'commitment.make': 'למשל: העוזרת מתחייבת בשמך למועד אספקה.',
  'purchase.place': 'למשל: העוזרת מזמינה סחורה מספק.',
  'refund.issue': 'למשל: העוזרת מחזירה ללקוח כסף.',
  'crm.write': 'למשל: העוזרת מעדכנת פרטי לקוח ברשימת הלקוחות.',
  'accounting.write': 'למשל: העוזרת רושמת תנועה בהנהלת החשבונות.',
  'doc.deliver': 'למשל: העוזרת שולחת ללקוח חוזה או מסמך מוכן.',
  'media.publish': 'למשל: העוזרת מפרסמת פוסט בעמוד העסק.',
};

/**
 * Classes no tool names directly: the payload refines a base class into
 * them. Reachability and availability of such a row are those of its base.
 */
export const REFINES_FROM: Record<
  'email.initiate' | 'whatsapp.initiate' | 'calendar.move' | 'calendar.cancel',
  ActionClass
> = {
  'email.initiate': 'email.reply',
  'whatsapp.initiate': 'whatsapp.reply',
  'calendar.move': 'calendar.create',
  'calendar.cancel': 'calendar.create',
};

function baseClassOf(cls: ActionClass): ActionClass {
  // Object.hasOwn: a class name must not resolve through the prototype chain.
  return Object.hasOwn(REFINES_FROM, cls) ? REFINES_FROM[cls as keyof typeof REFINES_FROM] : cls;
}

/** Tools classified as `cls` (or its base) that some agent may call. */
function reachableTools(cls: ActionClass): string[] {
  const base = baseClassOf(cls);
  const agents = Object.keys(AGENT_ALLOWLISTS) as AgentId[];
  return classifiedToolNames().filter(
    (t) => classifyAction(t) === base && agents.some((a) => isToolPermitted(a, t)),
  );
}

export function isReachable(cls: ActionClass): boolean {
  return reachableTools(cls).length > 0;
}

/** Classes no agent can ever perform; the interview says so plainly. */
export function cannotAtAll(): ActionClass[] {
  return ActionClass.options.filter((c) => !isReachable(c)).sort();
}

export type Availability = 'works' | 'not_connected' | 'not_built';

/** Tools a real adapter (not the local executor) performs. */
export const ADAPTER_TOOLS: ReadonlySet<string> = new Set(['mail.send']);

export function availabilityOf(
  cls: ActionClass,
  connections: readonly CharterConnection[],
): Availability {
  const tools = reachableTools(cls);
  const local = new Set(implementedLocalTools());
  if (tools.some((t) => local.has(t))) return 'works';
  const adapterTools = tools.filter((t) => ADAPTER_TOOLS.has(t));
  if (adapterTools.some((t) => connections.some((c) => c.serves.includes(t)))) return 'works';
  if (adapterTools.length > 0) return 'not_connected';
  return 'not_built';
}
