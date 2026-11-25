/**
 * `/settings/whatsapp-contacts/topics` — the topics a known client or supplier
 * may be answered on, which sources may feed the answer, and whether the
 * assistant may answer alone. Nothing here grants anything by itself: the gate
 * and the send-time checks decide. POST is behind the session (the router) and
 * CSRF (checked before any field is read). Topic text is owner text and goes
 * through `escLabel` all the same.
 */
import type { ServerResponse } from 'node:http';
import type { BusinessDb } from '../db/pool.js';
import {
  createTopic,
  listTopics,
  retireTopic,
  setTopicAutoReply,
  TIER2_SOURCE_NAMES,
  TOPIC_NOT_FOUND,
  TopicInputError,
  TopicNotFoundError,
  updateTopic,
  type ContactTopic,
  type Tier2SourceName,
  type TopicAppliesTo,
} from '../whatsapp/contact-topics.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import { escLabel, escapeHtml as esc, page, renderForbidden } from './views.js';

export const CONTACT_TOPICS_PATH = '/settings/whatsapp-contacts/topics';

export const TIER2_SOURCE_LABEL_HE: Record<Tier2SourceName, string> = {
  uploaded_invoices: 'חשבוניות שהעלית',
  sent_invoices: 'חשבוניות שנשלחו במייל',
  accounting_invoices: 'חשבוניות מהנהלת החשבונות',
  calendar_busy: 'יומן (פנוי/תפוס)',
  ledger_of_sender: 'הפנקס — רשומות של איש הקשר',
  meetings_of_sender: 'פגישות של איש הקשר',
  external_of_sender: 'מערכת חיצונית — רשומות של איש הקשר',
  public: 'מסמכים ציבוריים',
};
const APPLIES_LABEL_HE: Record<TopicAppliesTo, string> = { client: 'לקוחות', supplier: 'ספקים', both: 'לקוחות וספקים' };

export const CONTACT_TOPICS_INTRO =
  'נושא הוא סוג שאלה שמותר לענות עליה לאיש קשר מוכר. לכל נושא בוחרים אילו מקורות מידע משמשים אותו, ואם העוזרת רשאית לענות עליו בעצמה. מענה אוטומטי חל רק על שאלה, ולא על בקשה או התחייבות.';
export const CONTACT_TOPICS_SAVED = 'הנושא נשמר.';
const APPLIES_ERROR = 'הנושא חייב להתאים ללקוחות, לספקים או לשניהם.';

export interface ContactTopicsSession {
  sessionId: string;
  username: string;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

function sourceBoxes(selected: readonly string[]): string {
  return TIER2_SOURCE_NAMES.map(
    (s) =>
      `<label><input type="checkbox" name="sources" value="${esc(s)}"${selected.includes(s) ? ' checked' : ''}> ${esc(TIER2_SOURCE_LABEL_HE[s])}</label>`,
  ).join(' ');
}

function appliesSelect(current: TopicAppliesTo): string {
  return `<select name="appliesTo">${(['client', 'supplier', 'both'] as const)
    .map((a) => `<option value="${a}"${a === current ? ' selected' : ''}>${esc(APPLIES_LABEL_HE[a])}</option>`)
    .join('')}</select>`;
}

function topicCard(t: ContactTopic, csrf: string): string {
  const hidden = (action: string): string =>
    `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="topicId" value="${esc(t.topicId)}">`;
  return `<div class="card">
<p><strong>${escLabel(t.name)}</strong> — ${esc(APPLIES_LABEL_HE[t.appliesTo])} — מענה אוטומטי: ${t.autoReply ? 'פעיל' : 'כבוי'}</p>
<p>${escLabel(t.description)}</p>
<p>מקורות: ${t.sources.length === 0 ? 'אין' : t.sources.map((s) => esc(TIER2_SOURCE_LABEL_HE[s])).join(', ')}</p>
<form method="post" action="${CONTACT_TOPICS_PATH}">${hidden('edit')}
  <label>שם <input name="name" value="${esc(t.name)}"></label>
  <label>תיאור <input name="description" value="${esc(t.description)}"></label>
  <label>חל על ${appliesSelect(t.appliesTo)}</label>
  <div>${sourceBoxes(t.sources)}</div>
  <button type="submit">עדכן</button>
</form>
<form method="post" action="${CONTACT_TOPICS_PATH}" style="display:inline">${hidden('toggle')}
  <input type="hidden" name="on" value="${t.autoReply ? '0' : '1'}">
  <button type="submit">${t.autoReply ? 'כבה מענה אוטומטי' : 'הפעל מענה אוטומטי'}</button>
</form>
<form method="post" action="${CONTACT_TOPICS_PATH}" style="display:inline">${hidden('retire')}
  <button type="submit">הסר נושא</button>
</form>
</div>`;
}

async function render(
  res: ServerResponse,
  status: number,
  db: BusinessDb,
  session: ContactTopicsSession,
  message?: { error?: string; notice?: string },
): Promise<void> {
  const csrf = esc(issueCsrfToken(session.sessionId));
  const topics = await listTopics(db);
  html(
    res,
    status,
    page(
      'נושאים לוואטסאפ',
      `<nav><a href="/settings/whatsapp-contacts">וואטסאפ לאנשי קשר</a> · <a href="/documents/public">מסמכים ציבוריים</a></nav>
<h1>נושאים שמותר לענות עליהם</h1>
<p>${esc(CONTACT_TOPICS_INTRO)}</p>
${message?.error === undefined ? '' : `<p class="error">${esc(message.error)}</p>`}
${message?.notice === undefined ? '' : `<p>${esc(message.notice)}</p>`}
${topics.length === 0 ? '<p class="muted">אין נושאים עדיין.</p>' : topics.map((t) => topicCard(t, csrf)).join('')}
<h2>נושא חדש</h2>
<form method="post" action="${CONTACT_TOPICS_PATH}">
  <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="create">
  <label>שם <input name="name"></label>
  <label>תיאור <input name="description"></label>
  <label>חל על ${appliesSelect('both')}</label>
  <div>${sourceBoxes([])}</div>
  <label><input type="checkbox" name="autoReply" value="1"> מענה אוטומטי</label>
  <button type="submit">צור</button>
</form>`,
    ),
  );
}

export async function handleContactTopicsGet(res: ServerResponse, db: BusinessDb, session: ContactTopicsSession): Promise<void> {
  await render(res, 200, db, session);
}

function parseSources(form: URLSearchParams): Tier2SourceName[] {
  const allowed = TIER2_SOURCE_NAMES as readonly string[];
  return form.getAll('sources').filter((s): s is Tier2SourceName => allowed.includes(s));
}

function parseApplies(raw: string | null): TopicAppliesTo | null {
  return raw === 'client' || raw === 'supplier' || raw === 'both' ? raw : null;
}

export async function handleContactTopicsPost(
  res: ServerResponse,
  db: BusinessDb,
  session: ContactTopicsSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  const action = form.get('action');
  const topicId = form.get('topicId') ?? '';
  try {
    if (action === 'create') {
      const appliesTo = parseApplies(form.get('appliesTo'));
      if (appliesTo === null) return render(res, 400, db, session, { error: APPLIES_ERROR });
      await createTopic(db, {
        name: form.get('name') ?? '',
        description: form.get('description') ?? '',
        appliesTo,
        sources: parseSources(form),
        autoReply: form.get('autoReply') === '1',
        by: session.username,
      });
      return render(res, 200, db, session, { notice: CONTACT_TOPICS_SAVED });
    }
    if (action === 'edit') {
      const appliesTo = parseApplies(form.get('appliesTo'));
      if (appliesTo === null) return render(res, 400, db, session, { error: APPLIES_ERROR });
      await updateTopic(
        db,
        topicId,
        { name: form.get('name') ?? '', description: form.get('description') ?? '', appliesTo, sources: parseSources(form) },
        session.username,
      );
      return render(res, 200, db, session, { notice: CONTACT_TOPICS_SAVED });
    }
    if (action === 'toggle') {
      const ok = await setTopicAutoReply(db, topicId, form.get('on') === '1', session.username);
      if (!ok) return render(res, 404, db, session, { error: 'הנושא לא נמצא.' });
      return render(res, 200, db, session, { notice: CONTACT_TOPICS_SAVED });
    }
    if (action === 'retire') {
      const ok = await retireTopic(db, topicId, session.username);
      if (!ok) return render(res, 404, db, session, { error: 'הנושא לא נמצא.' });
      return render(res, 200, db, session, { notice: CONTACT_TOPICS_SAVED });
    }
  } catch (err) {
    if (err instanceof TopicNotFoundError) return render(res, 404, db, session, { error: TOPIC_NOT_FOUND });
    if (err instanceof TopicInputError) return render(res, 400, db, session, { error: err.message });
    throw err;
  }
  return render(res, 400, db, session, { error: 'פעולה לא מוכרת.' });
}
