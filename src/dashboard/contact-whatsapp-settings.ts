/**
 * `/settings/whatsapp-contacts` — which signed read operation of the owner's
 * accounting system supplies a contact's invoices for WhatsApp answers.
 *
 * The owner only CHOOSES among things already signed in the active charter:
 * the system, one of its `read` operations, the parameter that carries the
 * customer id and the declared response field that carries it per row (the
 * ownership check reads that field). Every choice is re-validated by
 * `saveInvoiceSettings`; nothing here grants anything. POST is behind the
 * session (the router) and CSRF (checked before any field is read). Labels and
 * ids come from a charter a technician wrote, so they go through `escLabel`/`esc`.
 */
import type { ServerResponse } from 'node:http';
import { autoReplySigned } from '../charter/amend-whatsapp-auto-reply.js';
import { loadActiveCharter } from '../charter/store.js';
import type { BusinessDb } from '../db/pool.js';
import type { ExternalSystem } from '../domain/external-system.js';
import {
  loadContactWaSettings,
  loadInvoiceSettings,
  removeExternalSource,
  saveAutoReplyEnabled,
  saveExternalSources,
  saveInvoiceSettings,
  type ExternalSenderSource,
} from '../whatsapp/sources/invoice-settings.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import { escLabel, escapeHtml as esc, page, renderForbidden } from './views.js';

export const CONTACT_WHATSAPP_SETTINGS_PATH = '/settings/whatsapp-contacts';

export const CONTACT_WHATSAPP_INTRO =
  'כשלקוח או ספק כותבים בוואטסאפ, העוזרת יכולה לצרף חשבוניות שלו ממערכת הנהלת החשבונות. כאן בוחרים איזו פעולת קריאה חתומה מביאה אותן, באיזה פרמטר נשלח המזהה של איש הקשר, ובאיזה שדה בתשובה כתוב המזהה של כל שורה. שורה שהמזהה שלה שונה מזה של איש הקשר לא נמסרת לעולם.';
export const CONTACT_WHATSAPP_SAVED = 'ההגדרה נשמרה.';
export const CONTACT_WHATSAPP_SOURCES_INTRO =
  'מקורות נוספים: כל פעולת קריאה חתומה שמוסיפים כאן תשמש את העוזרת להביא רשומות של איש הקשר עצמו ממערכת חיצונית, לפי המזהה שלו באותה מערכת. כמו בחשבוניות, שורה שהמזהה שלה שונה ממנו מבטלת את כל התשובה מהמקור הזה.';
export const AUTO_REPLY_MISSING_SIGNATURE =
  'המענה האוטומטי עדיין לא חתום בתקנון — העוזרת לא תענה לבד עד שתחתום עליו בעמוד החיבור לוואטסאפ.';
export const AUTO_REPLY_MISSING_TOGGLE = 'המענה האוטומטי כבוי במתג ההגדרות — העוזרת לא תענה לבד עד שתסמן „מענה אוטומטי”.';
export const CONTACT_WHATSAPP_NO_SYSTEMS = 'אין מערכת חיצונית חתומה בתקנון הפעיל.';

export interface ContactWhatsappSession {
  sessionId: string;
  username: string;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

async function render(
  res: ServerResponse,
  status: number,
  db: BusinessDb,
  session: ContactWhatsappSession,
  message?: { error?: string; notice?: string },
): Promise<void> {
  const csrf = esc(issueCsrfToken(session.sessionId));
  const current = await loadInvoiceSettings(db);
  const waSettings = await loadContactWaSettings(db);
  const sources = waSettings.externalSources;
  let systems: readonly ExternalSystem[] = [];
  let signed = false;
  try {
    const active = await loadActiveCharter(db);
    if (active !== null) {
      systems = active.bundle.externalSystems;
      signed = autoReplySigned(active.charter);
    }
  } catch {
    // An unreadable charter shows no systems; saving is refused by the store.
  }

  const cards = systems
    .map((system) => {
      const reads = system.operations.filter((op) => op.kind === 'read');
      return reads
        .map((op) => {
          const selected = current?.systemId === system.id && current.operation === op.name;
          const paramOptions = op.params
            .map(
              (p) =>
                `<option value="${esc(p.name)}"${selected && current?.customerParam === p.name ? ' selected' : ''}>${esc(p.name)}</option>`,
            )
            .join('');
          const fieldOptions = op.fields
            .map(
              (f) =>
                `<option value="${esc(f.path)}"${selected && current?.customerField === f.path ? ' selected' : ''}>${escLabel(f.label)} (${esc(f.path)})</option>`,
            )
            .join('');
          return `<div class="card">
<p><strong>${escLabel(system.label)}</strong> — ${escLabel(op.label)}${selected ? ' <em>(נבחרה)</em>' : ''}</p>
<form method="post" action="${CONTACT_WHATSAPP_SETTINGS_PATH}">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="invoice">
  <input type="hidden" name="system" value="${esc(system.id)}">
  <input type="hidden" name="operation" value="${esc(op.name)}">
  <label>פרמטר שנושא את המזהה של איש הקשר <select name="param">${paramOptions}</select></label>
  <label>שדה בתשובה שנושא את המזהה בכל שורה <select name="field">${fieldOptions}</select></label>
  <button type="submit">בחר</button>
</form>
</div>`;
        })
        .join('');
    })
    .join('');

  const label = (src: ExternalSenderSource): string => {
    const system = systems.find((x) => x.id === src.systemId);
    const op = system?.operations.find((o) => o.name === src.operation);
    return `${system === undefined ? esc(src.systemId) : escLabel(system.label)} — ${op === undefined ? esc(src.operation) : escLabel(op.label)}`;
  };
  const sourceList = sources
    .map(
      (src) => `<li>${label(src)} <small>(${esc(src.param)} ← ${esc(src.field)})</small>
<form method="post" action="${CONTACT_WHATSAPP_SETTINGS_PATH}" style="display:inline">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="remove_source">
  <input type="hidden" name="system" value="${esc(src.systemId)}">
  <input type="hidden" name="operation" value="${esc(src.operation)}">
  <button type="submit">הסר</button>
</form></li>`,
    )
    .join('');
  const sourceCards = systems
    .map((system) =>
      system.operations
        .filter((op) => op.kind === 'read')
        .map((op) => {
          const paramOptions = op.params.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
          const fieldOptions = op.fields
            .map((f) => `<option value="${esc(f.path)}">${escLabel(f.label)} (${esc(f.path)})</option>`)
            .join('');
          return `<div class="card">
<p><strong>${escLabel(system.label)}</strong> — ${escLabel(op.label)}</p>
<form method="post" action="${CONTACT_WHATSAPP_SETTINGS_PATH}">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="add_source">
  <input type="hidden" name="system" value="${esc(system.id)}">
  <input type="hidden" name="operation" value="${esc(op.name)}">
  <label>פרמטר שנושא את המזהה של איש הקשר <select name="param">${paramOptions}</select></label>
  <label>שדה בתשובה שנושא את המזהה בכל שורה <select name="field">${fieldOptions}</select></label>
  <button type="submit">הוסף כמקור</button>
</form>
</div>`;
        })
        .join(''),
    )
    .join('');

  html(
    res,
    status,
    page(
      'וואטסאפ לאנשי קשר',
      `<nav><a href="/">לכרטיסי האישור</a> · <a href="/settings/people">אנשים</a></nav>
<h1>וואטסאפ לאנשי קשר</h1>
<p>${esc(CONTACT_WHATSAPP_INTRO)}</p>
${message?.error === undefined ? '' : `<p class="error">${esc(message.error)}</p>`}
${message?.notice === undefined ? '' : `<p>${esc(message.notice)}</p>`}
${cards === '' ? `<p class="muted">${esc(CONTACT_WHATSAPP_NO_SYSTEMS)}</p>` : cards}
<h2>מענה אוטומטי</h2>
<form method="post" action="${CONTACT_WHATSAPP_SETTINGS_PATH}">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="auto_reply">
  <label><input type="checkbox" name="enabled" value="1"${waSettings.autoReplyEnabled ? ' checked' : ''}> מענה אוטומטי</label>
  <button type="submit">שמור</button>
</form>
${signed ? '' : `<p class="muted">${esc(AUTO_REPLY_MISSING_SIGNATURE)}</p>`}
${waSettings.autoReplyEnabled ? '' : `<p class="muted">${esc(AUTO_REPLY_MISSING_TOGGLE)}</p>`}
<h2>מקורות נוספים</h2>
<p>${esc(CONTACT_WHATSAPP_SOURCES_INTRO)}</p>
${sourceList === '' ? '' : `<ul>${sourceList}</ul>`}
${sourceCards}`,
    ),
  );
}

/** `GET /settings/whatsapp-contacts`. */
export async function handleContactWhatsappGet(
  res: ServerResponse,
  db: BusinessDb,
  session: ContactWhatsappSession,
): Promise<void> {
  await render(res, 200, db, session);
}

/** `POST /settings/whatsapp-contacts`. */
export async function handleContactWhatsappPost(
  res: ServerResponse,
  db: BusinessDb,
  session: ContactWhatsappSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  const action = form.get('action') ?? 'invoice';
  if (action === 'auto_reply') {
    await saveAutoReplyEnabled(db, form.get('enabled') === '1', session.username);
    return render(res, 200, db, session, { notice: CONTACT_WHATSAPP_SAVED });
  }
  if (action === 'remove_source') {
    await removeExternalSource(db, form.get('system') ?? '', form.get('operation') ?? '');
    return render(res, 200, db, session, { notice: CONTACT_WHATSAPP_SAVED });
  }
  if (action === 'add_source') {
    const systemId = form.get('system') ?? '';
    const operation = form.get('operation') ?? '';
    const rest = (await loadContactWaSettings(db)).externalSources.filter(
      (x) => !(x.systemId === systemId && x.operation === operation),
    );
    const next = [...rest, { systemId, operation, param: form.get('param') ?? '', field: form.get('field') ?? '' }];
    const saved = await saveExternalSources(db, next);
    if (!saved.ok) return render(res, 400, db, session, { error: saved.error });
    return render(res, 200, db, session, { notice: CONTACT_WHATSAPP_SAVED });
  }
  const result = await saveInvoiceSettings(db, {
    systemId: form.get('system') ?? '',
    operation: form.get('operation') ?? '',
    customerParam: form.get('param') ?? '',
    customerField: form.get('field') ?? '',
  });
  if (!result.ok) return render(res, 400, db, session, { error: result.error });
  return render(res, 200, db, session, { notice: CONTACT_WHATSAPP_SAVED });
}
