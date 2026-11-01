/**
 * The setup interview's answers → the unsigned charter the owner signs, and
 * back.
 *
 * `buildCharterFromInterview` is the ONLY source of the charter JSON the
 * interview produces (spec §6.2): the summary page renders its output and the
 * sign POST rebuilds and signs the same value. It is pure and deterministic —
 * `frozenAt` is frozen in the draft when the summary is shown, and the
 * version is a hash of the inputs, so a rebuild on POST is byte-identical.
 *
 * `prefillFromCharter` is the inverse used by "edit the rules" (§6.6). It is
 * deliberately lossy in one direction only: a Step-10 rule that lives in
 * another section once built (a do-not-contact entry, a never-say phrase, a
 * guidance line) comes back in that section, not under `extra.accepted` —
 * the charter does not record where an entry came from, and inventing a
 * marker for it would be a field nothing else reads. Rebuilding from the
 * prefill yields the same charter (the test pins this).
 *
 * Editing keeps everything the interview does not ask (§6.6). Resetting it
 * would silently drop authority and rules the owner signed.
 */
import type { ActionClass } from '../../domain/action.js';
import {
  CURRENT_SCHEMA_VERSION,
  type BusinessCharter,
  type CharterCounterparty,
  type CharterPerson,
  type ForbiddenRule,
  type UnsignedCharter,
} from '../../domain/charter.js';
import type { CharterConnection } from '../../domain/connection.js';
import { ACTION_CLASS_HE } from '../../domain/labels.js';
import type { AutonomyLevel } from '../../domain/trust.js';
import { MAILBOX_SYSTEM, type MailProvider } from '../../mail/mailbox.js';
import { canonicalHash } from '../../util/canonical.js';
import {
  MAILBOX_SUBPROCESSOR,
  mailboxConnection,
  signedMailboxProvider,
  splitConnections,
} from '../amend-mailbox.js';
import {
  CounterpartyEntry,
  InterviewAnswers,
  type AcceptedRule,
  type InterviewAnswersDraft,
  type InterviewLevel,
} from './answers.js';
import {
  DATA_DEFAULTS,
  DEFAULT_CURRENCY,
  DEFAULT_LANGUAGES,
  FIXED_BASE,
  FIXED_FORBIDDEN,
  INTERVIEW_PROVENANCE_CEILING,
  MEETING_DEFAULTS,
} from './defaults.js';
import { ALONE_ALLOWED, INTERVIEW_ROWS, MONEY_ROWS, ROW_DEFAULTS, type InterviewRow } from './rows.js';

/** Every forbidden rule the interview creates has an id in this namespace. */
export const INTERVIEW_RULE_PREFIX = 'interview_';
/** A row the owner set to "never". */
export const INTERVIEW_NEVER_PREFIX = `${INTERVIEW_RULE_PREFIX}never_`;
/** A Step-10 `forbid` rule. */
export const INTERVIEW_EXTRA_PREFIX = `${INTERVIEW_RULE_PREFIX}extra_`;

const PRINCIPAL_ID = 'p_principal';
const LEVEL_TO_BASE: Record<InterviewLevel, AutonomyLevel> = {
  never: 'draft_only',
  approve: 'approve_required',
  alone: 'auto_notify',
};

const INTERVIEW_ROW_SET: ReadonlySet<string> = new Set(INTERVIEW_ROWS);

function isInterviewRow(cls: string): cls is InterviewRow {
  return INTERVIEW_ROW_SET.has(cls);
}

/** Its inverse is `WHAT_WE_DO_PATTERN`; the two must change together. */
function composeWhatWeDo(b: InterviewAnswers['business']): string {
  return `${b.description} בעסק ${b.employees} עובדים. מה מצופה ממני: ${b.expectations}`;
}
const WHAT_WE_DO_PATTERN = /^([\s\S]*?) בעסק (\d+) עובדים\. מה מצופה ממני: ([\s\S]*)$/;

export interface BuildContext {
  businessId: string;
  frozenAt: Date;
  previous: BusinessCharter | null;
}

/** The level of every row: the answer, or the row's (strict) default. */
function rowLevels(answers: InterviewAnswers): Record<InterviewRow, InterviewLevel> {
  for (const cls of Object.keys(answers.actions)) {
    if (!isInterviewRow(cls)) {
      throw new Error(`interview answer for "${cls}", which is not a row of the interview table`);
    }
  }
  const levels = {} as Record<InterviewRow, InterviewLevel>;
  for (const row of INTERVIEW_ROWS) {
    const level = answers.actions[row] ?? ROW_DEFAULTS[row];
    // Positive allow-set: "alone" exists only for the rows named in it.
    if (level === 'alone' && !ALONE_ALLOWED.has(row)) {
      throw new Error(`"${row}" may not be set to alone: it is not in ALONE_ALLOWED`);
    }
    levels[row] = level;
  }
  return levels;
}

function counterpartyFrom(
  entry: CounterpartyEntry,
  kind: 'known' | 'do_not_contact',
): CharterCounterparty {
  return {
    match: {
      ...(entry.emailDomain !== undefined ? { emailDomain: entry.emailDomain } : {}),
      ...(entry.phone !== undefined ? { phone: entry.phone } : {}),
    },
    label: entry.label,
    trust: kind === 'known' ? 'known_counterparty' : 'unknown_external',
    autonomyOverrides: {},
    doNotContact: kind === 'do_not_contact',
    notes: '',
  };
}

/**
 * Whether a counterparty is one the interview itself writes and can read
 * back: matched by domain or phone only, carrying nothing the interview does
 * not ask, in one of the two (trust, doNotContact) shapes it produces, and a
 * valid interview entry. Everything else is preserved untouched on edit.
 * Positive: a shape not listed here is kept, never rewritten.
 */
export function isInterviewCounterparty(cp: CharterCounterparty): boolean {
  const matchKeys = Object.keys(cp.match).filter(
    (k) => cp.match[k as keyof typeof cp.match] !== undefined,
  );
  if (!matchKeys.every((k) => k === 'emailDomain' || k === 'phone')) return false;
  if (Object.keys(cp.autonomyOverrides).length > 0) return false;
  if (cp.notes !== '') return false;
  if (
    cp.tone !== undefined ||
    cp.language !== undefined ||
    cp.priceListId !== undefined ||
    cp.paymentTermsDays !== undefined
  ) {
    return false;
  }
  const known = cp.trust === 'known_counterparty' && !cp.doNotContact;
  const blocked = cp.trust === 'unknown_external' && cp.doNotContact;
  if (!known && !blocked) return false;
  return CounterpartyEntry.safeParse(entryFrom(cp)).success;
}

function entryFrom(cp: CharterCounterparty): CounterpartyEntry {
  return {
    label: cp.label,
    ...(cp.match.emailDomain !== undefined ? { emailDomain: cp.match.emailDomain } : {}),
    ...(cp.match.phone !== undefined ? { phone: cp.match.phone } : {}),
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The forbidden list: the fixed rules, then every rule the previous charter
 * carries outside the interview's namespace (deduped by id against the fixed
 * ones), then the interview's own — regenerated from the answers every time,
 * so a row moved off "never" loses its rule.
 */
function buildForbidden(
  levels: Record<InterviewRow, InterviewLevel>,
  accepted: readonly AcceptedRule[],
  previous: BusinessCharter | null,
): ForbiddenRule[] {
  const rules: ForbiddenRule[] = structuredClone([...FIXED_FORBIDDEN]);
  const ids = new Set(rules.map((r) => r.id));
  for (const rule of previous?.forbidden ?? []) {
    if (rule.id.startsWith(INTERVIEW_RULE_PREFIX) || ids.has(rule.id)) continue;
    rules.push(structuredClone(rule));
    ids.add(rule.id);
  }
  for (const row of INTERVIEW_ROWS) {
    if (levels[row] !== 'never') continue;
    rules.push({
      id: `${INTERVIEW_NEVER_PREFIX}${row}`,
      description: `לעולם לא: ${ACTION_CLASS_HE[row]}`,
      actionClasses: [row],
    });
  }
  let extra = 0;
  for (const rule of accepted) {
    if (rule.kind !== 'forbid') continue;
    rules.push({
      id: `${INTERVIEW_EXTRA_PREFIX}${extra}`,
      description: rule.text,
      actionClasses: [...rule.actionClasses],
    });
    extra += 1;
  }
  return rules;
}

function buildPrincipal(answers: InterviewAnswers, previous: CharterPerson | undefined): CharterPerson {
  // Channels the interview does not ask (sms, phone, dashboard) are kept.
  const otherChannels = Object.fromEntries(
    Object.entries(previous?.channels ?? {}).filter(([k]) => k !== 'whatsapp' && k !== 'email'),
  );
  return {
    // The previous principal's id is kept: other records name the person by
    // it, and an edit is not a change of who the principal is.
    id: previous?.id ?? PRINCIPAL_ID,
    isPrincipal: true,
    displayName: answers.principal.displayName,
    role: answers.principal.role,
    channels: {
      ...otherChannels,
      ...(answers.principal.whatsapp !== null ? { whatsapp: answers.principal.whatsapp } : {}),
      ...(answers.principal.email !== null ? { email: answers.principal.email } : {}),
    },
    approvalRights: structuredClone(previous?.approvalRights ?? []),
    canAmendCharter: true,
    canTripKillSwitch: true,
    notify: structuredClone(previous?.notify ?? { digest: true, approvals: true, incidents: true }),
    escalationOrder: previous?.escalationOrder ?? 0,
  };
}

/**
 * The connections and the subprocessors they need. A mailbox the previous
 * charter declares is kept whatever the answer (removing a live mailbox goes
 * through the connections screen's revert, §6.6); otherwise a chosen provider
 * applies the same change `buildMailboxAmendment` does.
 */
/** Exported so the interview's action table labels availability against the same connections the build will sign. */
export function buildConnections(
  provider: MailProvider | null,
  previous: BusinessCharter | null,
): { connections: CharterConnection[]; addedSubprocessors: string[] } {
  const before = previous?.connections ?? [];
  const hasMailbox = before.some((c) => c.system === MAILBOX_SYSTEM);
  if (hasMailbox || provider === null) {
    return { connections: structuredClone([...before]), addedSubprocessors: [] };
  }
  const { kept } = splitConnections(before);
  return {
    connections: [...kept, mailboxConnection(provider)],
    addedSubprocessors: [MAILBOX_SUBPROCESSOR[provider]],
  };
}

export function buildCharterFromInterview(answers: InterviewAnswers, ctx: BuildContext): UnsignedCharter {
  const { previous } = ctx;
  const levels = rowLevels(answers);
  const accepted = answers.extra.accepted;

  // Base autonomy: the non-row classes are not asked, so an edit keeps what
  // the owner signed for them; a first charter takes the fixed defaults.
  const nonRowBase = Object.fromEntries(
    (Object.keys(FIXED_BASE) as (keyof typeof FIXED_BASE)[]).map((cls) => [
      cls,
      previous?.autonomy.base[cls] ?? FIXED_BASE[cls],
    ]),
  );
  const base = {
    ...nonRowBase,
    ...Object.fromEntries(INTERVIEW_ROWS.map((row) => [row, LEVEL_TO_BASE[levels[row]]])),
  } as Record<ActionClass, AutonomyLevel>;

  const noMoney = [...MONEY_ROWS].every((row) => levels[row] === 'never');

  const principalBefore = previous?.people.find((p) => p.isPrincipal);
  const others = (previous?.people ?? []).filter((p) => !p.isPrincipal);

  const counterparties: CharterCounterparty[] = [
    ...structuredClone((previous?.counterparties ?? []).filter((cp) => !isInterviewCounterparty(cp))),
    ...answers.counterparties.known.map((e) => counterpartyFrom(e, 'known')),
    ...answers.counterparties.doNotContact.map((e) => counterpartyFrom(e, 'do_not_contact')),
    ...accepted.flatMap((r) => (r.kind === 'do_not_contact' ? [counterpartyFrom(r.entry, 'do_not_contact')] : [])),
  ];

  const provider = answers.reading.mailbox === 'none' ? null : answers.reading.mailbox;
  const { connections, addedSubprocessors } = buildConnections(provider, previous);

  const data = structuredClone(previous?.data ?? DATA_DEFAULTS);
  data.subprocessorsAllowed = dedupe([
    ...DATA_DEFAULTS.subprocessorsAllowed,
    ...(previous?.data.subprocessorsAllowed ?? []),
    ...addedSubprocessors,
  ]);

  const { hours } = answers;
  const charterVersion = `${ctx.frozenAt.toISOString()}.iv-${canonicalHash({
    businessId: ctx.businessId,
    answers,
    previous: previous?.charterVersion ?? null,
  }).slice(0, 12)}`;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    charterVersion,
    effectiveFrom: ctx.frozenAt.toISOString(),
    ...(previous !== null ? { supersedes: previous.charterVersion } : {}),

    identity: {
      legalName: answers.business.legalName,
      tradeName: answers.business.tradeName,
      vertical: answers.business.vertical,
      languages: [...(previous?.identity.languages ?? DEFAULT_LANGUAGES)],
      timezone: hours.timezone,
      locations: structuredClone(previous?.identity.locations ?? []),
      whatWeDo: composeWhatWeDo(answers.business),
      whatWeDoNotDo: dedupe([
        ...answers.business.notDone,
        ...accepted.flatMap((r) => (r.kind === 'guidance' ? [r.text] : [])),
      ]),
      keyFacts: structuredClone(answers.business.keyFacts),
    },

    voice: {
      persona: previous?.voice.persona ?? `את העוזרת של ${answers.business.tradeName}.`,
      register: answers.voice.register,
      // `signOff.he` is the asked one; other languages the owner signed stay.
      signOff: {
        ...Object.fromEntries(Object.entries(previous?.voice.signOff ?? {}).filter(([k]) => k !== 'he')),
        ...(answers.voice.signOff !== '' ? { he: answers.voice.signOff } : {}),
      },
      mustSay: structuredClone(previous?.voice.mustSay ?? []),
      mustNeverSay: dedupe([
        ...answers.voice.mustNeverSay,
        ...accepted.flatMap((r) => (r.kind === 'never_say' ? [r.phrase] : [])),
      ]),
      emojiPolicy: answers.voice.emojiPolicy,
      responseLength: previous?.voice.responseLength ?? 'normal',
      exemplars: structuredClone(previous?.voice.exemplars ?? []),
    },

    operations: {
      workweek: [...hours.workweek],
      businessHours: hours.workweek.map((day) => ({ day, open: hours.open, close: hours.close })),
      holidays: structuredClone(previous?.operations.holidays ?? []),
      ...(hours.quietHours !== null
        ? {
            quietHours: {
              from: hours.quietHours.from,
              to: hours.quietHours.to,
              appliesTo: ['email' as const, 'whatsapp' as const],
            },
          }
        : {}),
      slaHours: structuredClone(previous?.operations.slaHours ?? {}),
      meetingDefaults: structuredClone(previous?.operations.meetingDefaults ?? MEETING_DEFAULTS),
    },

    people: [buildPrincipal(answers, principalBefore), ...structuredClone(others)],
    counterparties,
    connections,

    money: {
      currency: previous?.money.currency ?? DEFAULT_CURRENCY,
      // Every money row "never": no ceiling the owner typed earlier survives.
      singleActionCeilingMinor: noMoney ? 0 : answers.money.singleMinor,
      dailyCeilingMinor: noMoney ? 0 : answers.money.dailyMinor,
      monthlyCeilingMinor: noMoney ? 0 : answers.money.monthlyMinor,
      perActionClassCeilingMinor: structuredClone(previous?.money.perActionClassCeilingMinor ?? {}),
      maxDiscountPercent: noMoney ? 0 : answers.money.maxDiscountPercent,
      paymentInstruments: structuredClone(previous?.money.paymentInstruments ?? []),
      approvedSuppliers: structuredClone(previous?.money.approvedSuppliers ?? []),
    },

    autonomy: {
      base,
      provenanceCeiling: structuredClone(previous?.autonomy.provenanceCeiling ?? INTERVIEW_PROVENANCE_CEILING),
      maxNudgesPerThread: previous?.autonomy.maxNudgesPerThread ?? 2,
      preferenceConfidenceThreshold: previous?.autonomy.preferenceConfidenceThreshold ?? 0.7,
    },

    data,
    forbidden: buildForbidden(levels, accepted, previous),
  };
}

// ---------------------------------------------------------------------------
// Back: a signed charter → the interview draft that edits it.

function levelOf(row: InterviewRow, charter: BusinessCharter): InterviewLevel {
  if (charter.forbidden.some((r) => r.id === `${INTERVIEW_NEVER_PREFIX}${row}`)) return 'never';
  const base = charter.autonomy.base[row];
  if (base === 'approve_required') return 'approve';
  if (base === 'auto_notify' || base === 'auto') return ALONE_ALLOWED.has(row) ? 'alone' : 'approve';
  // draft_only / forbidden without an interview rule: the strictest reading.
  return 'never';
}

/**
 * The draft that opens "edit the rules". `autonomy` is not in the charter and
 * stays unset; `extra.pending` is empty. A section that cannot be recovered
 * whole — `business` when `whatWeDo` is not in the interview's template,
 * `hours` when no business hours are declared — or that does not parse as an
 * interview section is left unset, for the owner to answer again: a draft is
 * sections-or-nothing, and an invented value would be signed as theirs.
 */
export function prefillFromCharter(charter: BusinessCharter): InterviewAnswersDraft {
  const draft: Record<string, unknown> = {};

  const match = WHAT_WE_DO_PATTERN.exec(charter.identity.whatWeDo);
  if (match !== null) {
    draft['business'] = {
      description: match[1] ?? '',
      legalName: charter.identity.legalName,
      tradeName: charter.identity.tradeName,
      vertical: charter.identity.vertical,
      employees: Number(match[2]),
      expectations: match[3] ?? '',
      notDone: [...charter.identity.whatWeDoNotDo],
      keyFacts: structuredClone(charter.identity.keyFacts),
    };
  }

  const principal = charter.people.find((p) => p.isPrincipal);
  if (principal !== undefined) {
    draft['principal'] = {
      displayName: principal.displayName,
      role: principal.role,
      whatsapp: principal.channels['whatsapp'] ?? null,
      email: principal.channels['email'] ?? null,
    };
  }

  draft['voice'] = {
    register: charter.voice.register,
    signOff: charter.voice.signOff['he'] ?? '',
    emojiPolicy: charter.voice.emojiPolicy,
    mustNeverSay: [...charter.voice.mustNeverSay],
  };

  const firstHours = charter.operations.businessHours[0];
  if (firstHours !== undefined) {
    const quiet = charter.operations.quietHours;
    draft['hours'] = {
      workweek: [...charter.operations.workweek],
      open: firstHours.open,
      close: firstHours.close,
      quietHours: quiet === undefined ? null : { from: quiet.from, to: quiet.to },
      timezone: charter.identity.timezone,
    };
  }

  const mailbox = charter.connections.find((c) => c.system === MAILBOX_SYSTEM);
  draft['reading'] = {
    mailbox: mailbox === undefined ? 'none' : (signedMailboxProvider(mailbox) ?? 'none'),
    // Not in the charter (it is the installer's DOCUMENT_INBOX, spec §5 step
    // 5); the owner re-confirms it.
    documents: false,
  };

  draft['actions'] = Object.fromEntries(INTERVIEW_ROWS.map((row) => [row, levelOf(row, charter)]));

  draft['money'] = {
    singleMinor: charter.money.singleActionCeilingMinor,
    dailyMinor: charter.money.dailyCeilingMinor,
    monthlyMinor: charter.money.monthlyCeilingMinor,
    maxDiscountPercent: charter.money.maxDiscountPercent,
  };

  const own = charter.counterparties.filter(isInterviewCounterparty);
  draft['counterparties'] = {
    known: own.filter((cp) => !cp.doNotContact).map(entryFrom),
    doNotContact: own.filter((cp) => cp.doNotContact).map(entryFrom),
  };

  const extras = charter.forbidden
    .filter((r) => r.id.startsWith(INTERVIEW_EXTRA_PREFIX))
    .map((r) => ({ rule: r, n: Number(r.id.slice(INTERVIEW_EXTRA_PREFIX.length)) }))
    .sort((a, b) => a.n - b.n);
  draft['extra'] = {
    accepted: extras.map(({ rule }) => ({
      kind: 'forbid' as const,
      text: rule.description,
      actionClasses: [...rule.actionClasses],
    })),
    pending: [],
  };

  const result: InterviewAnswersDraft = {};
  for (const [section, value] of Object.entries(draft)) {
    const key = section as keyof InterviewAnswers;
    const parsed = InterviewAnswers.shape[key].safeParse(value);
    if (parsed.success) (result as Record<string, unknown>)[key] = parsed.data;
  }
  return result;
}
