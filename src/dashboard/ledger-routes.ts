/**
 * Handlers for `/ledger` and `/ledger/settings`. Rendering is in
 * `ledger-views.ts`; this file reads, validates and writes.
 *
 * Every read and write is scoped to `businessId`. Every POST verifies CSRF
 * before anything else; an item that is not this business's is a 404 before
 * any write. Owner commands go through `applyLedgerCommand`, the single
 * applier shared with WhatsApp.
 *
 * `GET /ledger` marks the reminders it just showed as seen — a GET that
 * mutates, mirroring `/autonomy/actions` (the known issue in CLAUDE.md).
 */
import type { ServerResponse } from 'node:http';
import { loadActiveCharter } from '../charter/store.js';
import { getPool, withBusiness } from '../db/pool.js';
import { LedgerFamily, LedgerMode, isLedgerOverdue, type LedgerItem } from '../domain/ledger.js';
import {
  addCriticalRule,
  listCriticalRules,
  loadLedgerSettings,
  removeCriticalRule,
  saveLedgerSettings,
  REMIND_ONLY_FAMILIES,
  type LedgerSettings,
  type NewCriticalRule,
} from '../ledger/settings.js';
import { listLedgerEvents, listLedgerItems, loadLedgerItem, updateLedgerItem } from '../ledger/store.js';
import { UNSENT_DRAFT_MARK } from '../ledger/render.js';
import { applyLedgerCommand, type LedgerCommand } from '../ledger/whatsapp-command.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import {
  LEDGER_FILTERS,
  renderLedger,
  renderLedgerSettings,
  type LedgerFilter,
  type LedgerFollowup,
  type LedgerRowView,
  type LedgerSettingsFormValues,
} from './ledger-views.js';
import { renderForbidden, renderNotFound } from './views.js';

export interface LedgerSession {
  sessionId: string;
  username: string;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

const BAD_VALUES = 'יש לבחור ערכים תקינים';
const BAD_DATE = 'התאריך אינו תקין — יש להזין תאריך אמיתי בפורמט שנה-חודש-יום.';
const NOT_APPLICABLE = 'לא ניתן לבצע את הפעולה הזו על השורה הזו במצבה הנוכחי.';
const LOST_RACE = 'השורה השתנתה בינתיים — לא עדכנתי. אפשר לנסות שוב.';
const BAD_ACTION = 'הפעולה שנבחרה אינה מוכרת.';
const EVENTS_SHOWN = 5;

/** The charter's own zone and currency; stated stand-ins (`UTC`, `ILS`) only when no readable charter exists. */
async function charterContext(businessId: string): Promise<{ timeZone: string; currency: string }> {
  try {
    const active = await withBusiness(businessId, (bdb) => loadActiveCharter(bdb)); // TENANCY-TODO(task 10)
    if (active !== null) {
      return { timeZone: active.charter.identity.timezone, currency: active.bundle.ceilings.currency };
    }
  } catch {
    // an unreadable charter costs the zone, not the page
  }
  return { timeZone: 'UTC', currency: 'ILS' };
}

function parseFilter(raw: string | null): LedgerFilter {
  return (LEDGER_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as LedgerFilter) : 'open';
}

function matchesFilter(item: LedgerItem, filter: LedgerFilter, now: Date, timeZone: string): boolean {
  const live = item.status === 'open' || item.status === 'stuck';
  switch (filter) {
    case 'open':
      return live;
    case 'overdue':
      return isLedgerOverdue(item, now, timeZone);
    case 'stuck':
      return item.status === 'stuck';
    case 'evidence':
      return item.status === 'closed_by_evidence';
    case 'critical':
      return live && item.importance === 'critical';
    case 'all':
      return true;
  }
}

/** The draft lines of a fallback reminder body: everything after its draft head line. */
function draftOf(body: string): string | null {
  const lines = body.split('\n');
  const head = lines.findIndex((l) => l.startsWith(UNSENT_DRAFT_MARK));
  if (head === -1) return null;
  const draft = lines.slice(head + 1).join('\n');
  return draft.trim() === '' ? null : draft;
}

/**
 * Each item's follow-up line (spec F-I3), from the nudge's own record and
 * never from owner-delivery columns: a linked nudge job is in flight; else
 * the newer of the latest `nudged` and the latest `nudge_fallback` decides —
 * sent, or the fallback reminder's draft (job fallback: its
 * `nudge_fallback:<job>` row; an open-time fallback: the claimed `nudge` row).
 */
async function followups(businessId: string, itemIds: string[]): Promise<Map<string, LedgerFollowup>> {
  const out = new Map<string, LedgerFollowup>();
  if (itemIds.length === 0) return out;
  const db = getPool();
  const { rows: flight } = await db.query<{ item_id: string }>(
    `SELECT item_id FROM ledger_items
      WHERE business_id = $1 AND item_id = ANY($2) AND nudge_job_id IS NOT NULL`,
    [businessId, itemIds],
  );
  for (const r of flight) out.set(r.item_id, { kind: 'pending' });
  const { rows: latest } = await db.query<{ item_id: string; kind: string; job_id: string | null; at: Date }>(
    `SELECT DISTINCT ON (item_id, kind) item_id, kind, job_id, at FROM ledger_events
      WHERE business_id = $1 AND item_id = ANY($2) AND kind IN ('nudged', 'nudge_fallback')
      ORDER BY item_id, kind, at DESC, event_id DESC`,
    [businessId, itemIds],
  );
  const byItem = new Map<string, { sent?: Date; fallback?: { jobId: string | null; at: Date } }>();
  for (const r of latest) {
    const entry = byItem.get(r.item_id) ?? {};
    if (r.kind === 'nudged') entry.sent = r.at;
    else entry.fallback = { jobId: r.job_id, at: r.at };
    byItem.set(r.item_id, entry);
  }
  for (const [itemId, e] of byItem) {
    if (out.has(itemId)) continue;
    if (e.sent !== undefined && (e.fallback === undefined || e.sent.getTime() >= e.fallback.at.getTime())) {
      out.set(itemId, { kind: 'sent', at: e.sent });
      continue;
    }
    if (e.fallback === undefined) continue;
    const { rows } =
      e.fallback.jobId !== null
        ? await db.query<{ body: string }>(
            `SELECT body FROM ledger_reminders WHERE business_id = $1 AND item_id = $2 AND slot = $3`,
            [businessId, itemId, `nudge_fallback:${e.fallback.jobId}`],
          )
        : await db.query<{ body: string }>(
            `SELECT body FROM ledger_reminders
              WHERE business_id = $1 AND item_id = $2 AND kind = 'nudge' AND NOT starts_with(slot, 'nudge_fallback:')
              ORDER BY created_at DESC, reminder_id DESC LIMIT 1`,
            [businessId, itemId],
          );
    const draft = rows[0] === undefined ? null : draftOf(rows[0].body);
    if (draft !== null) out.set(itemId, { kind: 'unsent', draft });
  }
  return out;
}

async function renderListPage(
  res: ServerResponse,
  businessId: string,
  session: LedgerSession,
  options: { status: number; filter: LedgerFilter; error?: string; markSeen: boolean },
): Promise<void> {
  const now = new Date();
  const { timeZone, currency } = await charterContext(businessId);
  const all = await listLedgerItems({ businessId });
  const shown = all.filter((i) => matchesFilter(i, options.filter, now, timeZone));
  const follow = await followups(
    businessId,
    shown.filter((i) => i.status === 'open' || i.status === 'stuck').map((i) => i.itemId),
  );
  const rows: LedgerRowView[] = [];
  for (const item of shown) {
    const events = await listLedgerEvents(item.itemId, { businessId });
    rows.push({ item, events: events.slice(-EVENTS_SHOWN), followup: follow.get(item.itemId) ?? null });
  }
  const body = renderLedger({
    rows,
    filter: options.filter,
    csrf: issueCsrfToken(session.sessionId),
    timeZone,
    currency,
    now,
    ...(options.error !== undefined ? { error: options.error } : {}),
  });
  if (options.markSeen) {
    await getPool().query(
      `UPDATE ledger_reminders SET seen_at = now() WHERE business_id = $1 AND seen_at IS NULL`,
      [businessId],
    );
  }
  html(res, options.status, body);
}

export async function handleLedgerGet(
  res: ServerResponse,
  businessId: string,
  session: LedgerSession,
  url: URL,
): Promise<void> {
  await renderListPage(res, businessId, session, {
    status: 200,
    filter: parseFilter(url.searchParams.get('filter')),
    markSeen: true,
  });
}

const SIMPLE_ACTIONS = ['done', 'cancel', 'reopen', 'held', 'not_held', 'save_stages', 'confirm_address'] as const;
type SimpleAction = (typeof SIMPLE_ACTIONS)[number];

function isSimpleAction(value: string): value is SimpleAction {
  return (SIMPLE_ACTIONS as readonly string[]).includes(value);
}

/** `YYYY-MM-DD` that names a real calendar day. */
function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export async function handleLedgerAction(
  res: ServerResponse,
  businessId: string,
  session: LedgerSession,
  itemId: string,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());

  const item = await loadLedgerItem(itemId, { businessId });
  if (item === null) return html(res, 404, renderNotFound());

  const refuse = (status: number, error: string): Promise<void> =>
    renderListPage(res, businessId, session, { status, filter: 'open', error, markSeen: false });

  const action = form.get('action') ?? '';
  if (action === 'critical') {
    if (item.status !== 'open' && item.status !== 'stuck') return refuse(409, NOT_APPLICABLE);
    await updateLedgerItem(
      itemId,
      { importance: 'critical', importanceManual: true },
      { kind: 'updated', by: session.username, note: 'importance=critical' },
      { businessId },
    );
    return redirect(res, '/ledger');
  }

  let command: LedgerCommand;
  if (action === 'snooze') {
    const date = (form.get('date') ?? '').trim();
    if (!isRealDate(date)) return refuse(400, BAD_DATE);
    command = { kind: 'snooze', n: null, to: { date } };
  } else if (isSimpleAction(action)) {
    command = { kind: action, n: null };
  } else {
    return refuse(400, BAD_ACTION);
  }

  const { timeZone } = await charterContext(businessId);
  const outcome = await applyLedgerCommand(itemId, command, {
    businessId,
    by: session.username,
    now: new Date(),
    timeZone,
  });
  if (outcome === 'not_applicable') return refuse(409, NOT_APPLICABLE);
  if (outcome === 'lost_race') return refuse(409, LOST_RACE);
  redirect(res, '/ledger');
}

// -------------------------------------------------------------- settings

function valuesFromSettings(s: LedgerSettings): LedgerSettingsFormValues {
  return {
    modes: { ...s.modes },
    toWhatsApp: s.toWhatsApp,
    toEmail: s.toEmail,
    toScreen: s.toScreen,
    meetingLeadMinutes: String(s.meetingLeadMinutes),
    meetingLeadMinutesCritical: s.meetingLeadMinutesCritical.join(','),
    dueLeadDaysCritical: String(s.dueLeadDaysCritical),
    nudgeAfterBusinessDays: String(s.nudgeAfterBusinessDays),
    checkinEveryDays: String(s.checkinEveryDays),
    checkinEveryDaysCritical: String(s.checkinEveryDaysCritical),
    dailyHour: String(s.dailyHour),
  };
}

async function renderSettingsPage(
  res: ServerResponse,
  businessId: string,
  session: LedgerSession,
  status: number,
  values?: LedgerSettingsFormValues,
  error?: string,
): Promise<void> {
  const { currency } = await charterContext(businessId);
  const shown = values ?? valuesFromSettings(await loadLedgerSettings({ businessId }));
  html(
    res,
    status,
    renderLedgerSettings({
      values: shown,
      rules: await listCriticalRules({ businessId }),
      csrf: issueCsrfToken(session.sessionId),
      currency,
      ...(error !== undefined ? { error } : {}),
    }),
  );
}

export async function handleLedgerSettingsGet(
  res: ServerResponse,
  businessId: string,
  session: LedgerSession,
): Promise<void> {
  await renderSettingsPage(res, businessId, session, 200);
}

function wholeNumber(raw: string | null): number {
  const s = (raw ?? '').trim();
  return /^\d{1,5}$/.test(s) ? Number(s) : Number.NaN;
}

export async function handleLedgerSettingsPost(
  res: ServerResponse,
  businessId: string,
  session: LedgerSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());

  const field = (name: string): string => (form.get(name) ?? '').trim();
  // A disabled radio is not submitted, so a missing remind-only family
  // (money_out, meetings, projects — M3) reads as the locked value.
  const modes = {} as Record<LedgerFamily, string>;
  for (const family of LedgerFamily.options) {
    const raw = form.get(`mode_${family}`);
    modes[family] = raw ?? (REMIND_ONLY_FAMILIES.includes(family) ? 'remind' : '');
  }
  const values: LedgerSettingsFormValues = {
    modes,
    toWhatsApp: form.get('toWhatsApp') === 'on',
    toEmail: form.get('toEmail') === 'on',
    toScreen: form.get('toScreen') === 'on',
    meetingLeadMinutes: field('meetingLeadMinutes'),
    meetingLeadMinutesCritical: field('meetingLeadMinutesCritical'),
    dueLeadDaysCritical: field('dueLeadDaysCritical'),
    nudgeAfterBusinessDays: field('nudgeAfterBusinessDays'),
    checkinEveryDays: field('checkinEveryDays'),
    checkinEveryDaysCritical: field('checkinEveryDaysCritical'),
    dailyHour: field('dailyHour'),
  };

  // `saveLedgerSettings` coerces an unknown mode to the default instead of
  // refusing it, so each submitted mode is validated here.
  const parsedModes = {} as Record<LedgerFamily, LedgerMode>;
  for (const family of LedgerFamily.options) {
    const parsed = LedgerMode.safeParse(modes[family]);
    if (!parsed.success) return renderSettingsPage(res, businessId, session, 400, values, BAD_VALUES);
    parsedModes[family] = parsed.data;
  }

  const criticalLeads = values.meetingLeadMinutesCritical.split(',').map((p) => wholeNumber(p));
  const settings: LedgerSettings = {
    modes: parsedModes,
    toWhatsApp: values.toWhatsApp,
    toEmail: values.toEmail,
    toScreen: values.toScreen,
    meetingLeadMinutes: wholeNumber(values.meetingLeadMinutes),
    meetingLeadMinutesCritical: criticalLeads,
    dueLeadDaysCritical: wholeNumber(values.dueLeadDaysCritical),
    nudgeAfterBusinessDays: wholeNumber(values.nudgeAfterBusinessDays),
    checkinEveryDays: wholeNumber(values.checkinEveryDays),
    checkinEveryDaysCritical: wholeNumber(values.checkinEveryDaysCritical),
    dailyHour: wholeNumber(values.dailyHour),
  };
  try {
    await saveLedgerSettings(settings, { businessId, updatedBy: session.username });
  } catch (err) {
    return renderSettingsPage(res, businessId, session, 400, values, err instanceof Error ? err.message : BAD_VALUES);
  }
  redirect(res, '/ledger/settings');
}

// ----------------------------------------------------------------- rules

const AMOUNT_FORMAT = 'הסכום חייב להיות מספר, למשל 1500 או 1500.50.';
const AMOUNT_AGOROT = 'אין אגורות חלקיות — אפשר עד שתי ספרות אחרי הנקודה.';

/** Major units with up to two decimals to integer minor units, by string parsing; no float multiply. */
export function parseMajorToMinor(raw: string): { ok: true; minor: number } | { ok: false; message: string } {
  const s = raw.trim();
  if (!/^\d{1,12}(\.\d+)?$/.test(s)) return { ok: false, message: AMOUNT_FORMAT };
  const [whole = '0', fraction = ''] = s.split('.');
  if (fraction.length > 2) return { ok: false, message: AMOUNT_AGOROT };
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return { ok: false, message: AMOUNT_FORMAT };
  return { ok: true, minor };
}

export async function handleLedgerRulePost(
  res: ServerResponse,
  businessId: string,
  session: LedgerSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());

  const refuse = (message: string): Promise<void> => renderSettingsPage(res, businessId, session, 400, undefined, message);
  const kind = form.get('kind');
  let rule: NewCriticalRule;
  if (kind === 'family') {
    const family = LedgerFamily.safeParse(form.get('family'));
    if (!family.success) return refuse(BAD_VALUES);
    rule = { kind: 'family', family: family.data };
  } else if (kind === 'amount_over') {
    const amount = parseMajorToMinor(form.get('amount') ?? '');
    if (!amount.ok) return refuse(amount.message);
    rule = { kind: 'amount_over', amountMinor: amount.minor };
  } else if (kind === 'counterparty') {
    rule = { kind: 'counterparty', match: form.get('match') ?? '' };
  } else {
    return refuse(BAD_VALUES);
  }
  try {
    await addCriticalRule(rule, { businessId, by: session.username });
  } catch (err) {
    return refuse(err instanceof Error ? err.message : BAD_VALUES);
  }
  redirect(res, '/ledger/settings');
}

export async function handleLedgerRuleDelete(
  res: ServerResponse,
  businessId: string,
  session: LedgerSession,
  ruleId: string,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  await removeCriticalRule(ruleId, { businessId });
  redirect(res, '/ledger/settings');
}
