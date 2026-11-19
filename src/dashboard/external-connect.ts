/**
 * The owner's pages for external systems (Stage D, Task 10): sign a system the
 * technician drafted in the panel, sign a change to a signed one, and remove
 * one. Each is a charter amendment signed on the owner's dashboard.
 *
 * Routes, all behind the owner session and (for POST) its CSRF token:
 * - `GET  /connections/external`                — the systems with a draft or a signed definition
 * - `GET  /connections/external/:system/sign`   — the amendment in Hebrew
 * - `POST /connections/external/:system/sign`
 * - `POST /connections/external/:system/remove`
 *
 * **What the page shows is what gets signed.** The sign page carries two
 * handles in hidden fields: `base` (the active charter version) and
 * `draftHash` (`canonicalHash` of the stored draft definition). The POST never
 * takes a definition from the form: inside one transaction it re-reads the
 * draft under `FOR UPDATE`, compares its hash with the one shown — a draft the
 * technician edited in between re-renders the NEW preview and signs nothing —
 * rebuilds the amendment from the then-active charter, and installs it with
 * the stale check under `FOR UPDATE` (`installSigned`).
 *
 * **One transaction.** `installSigned` and `upsertBinding` both join a
 * caller's transaction (`transaction(db, …)`), so install + its
 * `charter_change` audit row + the `ext:<id>` binding (`live`, credential ref
 * `EXT_<ID>_KEY`) + its `connection_binding` audit row + the draft delete
 * commit together or not at all. A refusal inside throws `Refusal`, which
 * rolls everything back before the page is sent.
 *
 * **Signing without the key is allowed** (plan ruling 7). The page says
 * "חסר סוד — הטכנאי צריך לשמור אותו"; until the secret exists every call fails
 * at `credential_unavailable`, which is not a widening of anything.
 *
 * **Removal** is a new signed amendment (`buildExternalRemoval`), allowed at
 * any time — it only reduces authority. The binding is set to `disconnected`
 * through `upsertBinding` rather than deleted, so the move is in the audit
 * chain like every other binding write; a binding for a system the charter no
 * longer declares routes nothing either way. The secrets are left in place
 * (the technician removes them in the panel), and the page says so. A pending
 * draft, if any, is left too — it is the technician's work, and signing it
 * again is a fresh signature.
 *
 * Removal asks for a confirm checkbox (plain HTML `required`, and checked
 * again on the server). The notice after it says whether a draft is left
 * (signing it brings the system back) or re-adding needs the technician; the
 * sign page for a draft whose system the owner removed says it re-adds one
 * (`wasRemoved`: a `disconnected` `ext:<id>` binding and no signed system).
 *
 * The gate needs none of this to deny: an operation of a system that is only
 * drafted is not in the active charter's `externalSystems`, so stage 3 refuses
 * it (`external_operation_unknown`) whatever the bindings say.
 */
import type { ServerResponse } from 'node:http';
import {
  buildExternalAmendment,
  buildExternalRemoval,
  describeExternalAmendment,
  externalHost,
  externalSubprocessor,
  type ExternalAmendmentDiff,
} from '../charter/amend-external.js';
import { signCharter } from '../charter/sign.js';
import { probeActiveCharter } from '../charter/store.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import { BusinessCharter, type UnsignedCharter } from '../domain/charter.js';
import {
  EXTERNAL_SYSTEM_ID,
  ExternalSystem,
  externalConnectionSystem,
  externalSecretRefs,
  unrecognisedKeyPaths,
} from '../domain/external-system.js';
import { describeExternalSystem } from '../external/describe.js';
import { deleteDraft, loadDrafts, lockDraft, type DraftRecord } from '../external/store.js';
import { listSecretRefs } from '../governance/credential-store.js';
import { loadBindings, upsertBinding } from '../orchestrator/bindings.js';
import { canonicalHash } from '../util/canonical.js';
import { verifyCsrfToken } from './csrf.js';
import {
  STALE_MESSAGE,
  errorPage,
  installSigned,
  page,
  seeOther,
  sendHtml,
  type MailboxSession,
} from './mailbox-connect.js';
import { escLabel, escapeHtml as esc } from './views.js';

export type ExternalSession = MailboxSession;

const TITLE = 'מערכות חיצוניות';
export const EXTERNAL_MISSING_SECRET = 'חסר סוד — הטכנאי צריך לשמור אותו';
export const EXTERNAL_REPLACE_HEADING = 'שינוי במערכת חתומה';
export const EXTERNAL_SECRETS_KEPT =
  'הסודות של המערכת נשארו שמורים — הסרה מהתקנון אינה מוחקת אותם. הטכנאי יכול למחוק אותם בפאנל.';
const REMOVE_NOTE =
  'הסרה מוציאה את המערכת מהתקנון: מאותו רגע העוזרת לא תפנה אליה ולא תקבל ממנה התראות. ' +
  'גם ההסרה נחתמת בשמך. הסודות של המערכת נשארים שמורים — הטכנאי יכול למחוק אותם בפאנל.';
export const EXTERNAL_READD_FROM_DRAFT = 'נשארה טיוטה של הטכנאי — חתימה עליה תחזיר את המערכת.';
export const EXTERNAL_READD_NEEDS_TECHNICIAN =
  'כדי להחזיר את המערכת בעתיד, הטכנאי צריך להכין לה טיוטה חדשה בפאנל, ואז לחתום עליה כאן.';
export const EXTERNAL_READD_HEADING = 'החזרת מערכת שהסרת';
const REMOVE_CONFIRM_LABEL = 'אני מבין/ה שהמערכת תוסר מהתקנון והעוזרת תפסיק לפנות אליה';
const REMOVE_NOT_CONFIRMED = 'כדי להסיר את המערכת יש לסמן את תיבת האישור ולשלוח שוב. לא בוצעה כל פעולה.';
const CHARTER_UNREADABLE = 'לא ניתן לקרוא את התקנון הפעיל של העסק — יש לפנות למי שמחזיק את ההתקנה. לא בוצעה כל פעולה.';
const CHARTER_MISSING = 'לא הותקן עדיין תקנון פעיל לעסק הזה, ולכן אין לאן להוסיף מערכת.';
const CSRF_REFUSAL = 'הטופס פג תוקף. רענן/י ונסה/י שוב. לא בוצעה כל פעולה.';
const NO_DRAFT = 'אין טיוטה של המערכת הזו לחתימה. הטכנאי מכין אותה בפאנל.';
const DRAFT_INVALID = 'הטיוטה של המערכת הזו אינה תקינה — הטכנאי צריך לתקן אותה בפאנל. לא בוצעה כל פעולה.';
const DRAFT_CHANGED = 'הטיוטה השתנתה מאז שהדף הוצג. זו הגרסה החדשה — קרא/י אותה וחתום/חתמי שוב. דבר לא נחתם.';
const NOT_SIGNED = 'המערכת הזו אינה חתומה בתקנון, ולכן אין מה להסיר. לא בוצעה כל פעולה.';
const CANNOT_SIGN = 'לא ניתן לחתום על המערכת כפי שהיא מוגדרת. הטכנאי צריך לתקן את הטיוטה:';

type CharterRead = { ok: true; charter: BusinessCharter } | { ok: false; message: string };

async function readCharter(db: BusinessDb): Promise<CharterRead> {
  const probe = await probeActiveCharter(db);
  if (!probe.ok) {
    console.error('external connect: could not read the active charter:', probe.reason);
    return { ok: false, message: CHARTER_UNREADABLE };
  }
  if (probe.active === null) return { ok: false, message: CHARTER_MISSING };
  return { ok: true, charter: probe.active.charter };
}

/** A refusal raised inside the signing transaction: rolls it back, then is sent. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly html: string,
  ) {
    super('external connect refusal');
  }
}

type DraftCheck = { ok: true; def: ExternalSystem; hash: string } | { ok: false };

/**
 * A draft is signable only when it parses, has no key the schema did not keep
 * (ruling T9-a — a dropped key would be signed as absent), and names the
 * system the route names. Positive: anything else is refused.
 */
function checkDraft(systemId: string, draft: DraftRecord): DraftCheck {
  const parsed = ExternalSystem.safeParse(draft.definition);
  if (!parsed.success) return { ok: false };
  if (unrecognisedKeyPaths(draft.definition, parsed.data).length > 0) return { ok: false };
  if (parsed.data.id !== systemId) return { ok: false };
  return { ok: true, def: parsed.data, hash: canonicalHash(draft.definition) };
}

/**
 * The amendment's cross-field problems (pairing, subprocessor, the money
 * currency against the charter's) — run by parsing what would be signed, so
 * the page never offers a signature `installCharter` would then refuse.
 */
function amendmentProblems(unsigned: UnsignedCharter): string[] {
  try {
    const parsed = BusinessCharter.safeParse(
      signCharter(unsigned, { signedByPersonId: 'preview', method: 'dashboard_click' }),
    );
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * Whether the owner removed this system earlier: its `ext:<id>` binding is
 * `disconnected` (what removal writes) and the active charter does not
 * declare it. Wording only — it grants nothing.
 */
async function wasRemoved(db: BusinessDb, charter: BusinessCharter, systemId: string): Promise<boolean> {
  if (charter.externalSystems.some((s) => s.id === systemId)) return false;
  const name = externalConnectionSystem(systemId);
  return (await loadBindings(db)).some((b) => b.system === name && b.status === 'disconnected');
}

async function hasKeySecret(db: BusinessDb, systemId: string): Promise<boolean> {
  const { key } = externalSecretRefs(systemId);
  return (await listSecretRefs(db)).some((s) => s.ref === key);
}

// --- GET /connections/external ---------------------------------------------

export async function handleExternalStatus(
  res: ServerResponse,
  db: BusinessDb,
  csrf: string,
  query: URLSearchParams,
): Promise<void> {
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 200, errorPage(TITLE, read.message));
  const charter = read.charter;
  // One after the other: both run on this request's one connection.
  const drafts = await loadDrafts(db);
  const secrets = new Set((await listSecretRefs(db)).map((s) => s.ref));

  const signed = new Map(charter.externalSystems.map((s) => [s.id, s] as const));
  const drafted = new Map(drafts.map((d) => [d.systemId, d] as const));
  const ids = [...new Set([...signed.keys(), ...drafted.keys()])]
    .filter((id) => EXTERNAL_SYSTEM_ID.test(id))
    .sort();

  const removed = query.get('removed');
  const removedNotice =
    removed !== null && EXTERNAL_SYSTEM_ID.test(removed)
      ? `<div class="card"><p>המערכת <code>${esc(removed)}</code> הוסרה מהתקנון.</p><p>${esc(EXTERNAL_SECRETS_KEPT)}</p><p>${esc(
          drafted.has(removed) ? EXTERNAL_READD_FROM_DRAFT : EXTERNAL_READD_NEEDS_TECHNICIAN,
        )}</p></div>`
      : '';

  const cards = ids.map((id) => {
    const def = signed.get(id);
    const draft = drafted.get(id);
    const draftCheck = draft === undefined ? null : checkDraft(id, draft);
    const label = def?.label ?? (draftCheck?.ok === true ? draftCheck.def.label : id);
    // A draft identical to the signed definition is not a pending change.
    const draftDiffers =
      draft !== undefined &&
      !(def !== undefined && draftCheck?.ok === true && canonicalHash(draftCheck.def) === canonicalHash(def));
    const state =
      def !== undefined && draftDiffers
        ? 'חתומה בתקנון — טיוטת שינוי ממתינה לחתימה'
        : def !== undefined
          ? 'חתומה בתקנון'
          : 'טיוטה ממתינה לחתימה';
    const key = secrets.has(externalSecretRefs(id).key) ? '✓ שמור' : EXTERNAL_MISSING_SECRET;
    const signLink = !draftDiffers ? '' : `<p><a href="/connections/external/${esc(id)}/sign">לקריאה ולחתימה</a></p>`;
    const removeForm =
      def === undefined
        ? ''
        : `<form method="post" action="/connections/external/${esc(id)}/remove">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="base" value="${esc(charter.charterVersion)}">
  <p class="muted">${esc(REMOVE_NOTE)}</p>
  <p><label><input type="checkbox" name="confirm" value="yes" required> ${esc(REMOVE_CONFIRM_LABEL)}</label></p>
  <button type="submit">הסרת המערכת מהתקנון</button>
</form>`;
    return `<div class="card">
<h2>${escLabel(label)} <span class="muted">(<code>${esc(id)}</code>)</span></h2>
<p>מצב: <b>${esc(state)}</b></p>
<p>מפתח הגישה: ${esc(key)}</p>
${signLink}
${removeForm}
</div>`;
  });

  sendHtml(
    res,
    200,
    page(
      TITLE,
      `<h1>${esc(TITLE)}</h1>
${removedNotice}
<p>מערכת חיצונית (למשל מערכת לקוחות או הנהלת חשבונות) נכנסת לשימוש רק אחרי שאתה חותם על תוספת לתקנון שמתארת בדיוק מה העוזרת תוכל לעשות בה. הטכנאי מכין את ההגדרה; החתימה שלך.</p>
${cards.length === 0 ? '<p>אין מערכות חיצוניות שממתינות לחתימה או חתומות בתקנון.</p>' : cards.join('\n')}`,
    ),
  );
}

// --- The sign page ---------------------------------------------------------

function nameList(names: readonly string[]): string {
  return names.map((n) => `<code>${esc(n)}</code>`).join(', ');
}

function diffCard(diff: ExternalAmendmentDiff): string {
  if (!diff.replaces) return '';
  const items: string[] = [];
  if (diff.added.length > 0) items.push(`<li>פעולות שנוספות: ${nameList(diff.added)}</li>`);
  if (diff.removed.length > 0) items.push(`<li>פעולות שמוסרות: ${nameList(diff.removed)}</li>`);
  if (diff.changed.length > 0) items.push(`<li>פעולות שמשתנות: ${nameList(diff.changed)}</li>`);
  if (diff.host !== null) {
    items.push(`<li>כתובת המערכת משתנה: מ-<code>${escLabel(diff.host.before)}</code> אל <code>${escLabel(diff.host.after)}</code></li>`);
  }
  if (diff.otherChanged) items.push('<li>פרטים נוספים בהגדרה משתנים (שם, התחברות, התראות או סריקה) — ראה את התיאור המלא למטה.</li>');
  if (items.length === 0) items.push('<li>ההגדרה זהה לחתומה.</li>');
  return `<div class="card">
<h2>${esc(EXTERNAL_REPLACE_HEADING)}</h2>
<p>המערכת כבר חתומה בתקנון. החתימה הזו מחליפה את ההגדרה החתומה בהגדרה החדשה:</p>
<ul>${items.join('')}</ul>
</div>`;
}

export function renderExternalSignPage(options: {
  charter: BusinessCharter;
  def: ExternalSystem;
  draftHash: string;
  csrf: string;
  keyStored: boolean;
  /** The owner removed this system earlier (a `disconnected` `ext:<id>` binding, not in the active charter). */
  previouslyRemoved: boolean;
  notice?: string;
}): { status: number; html: string } {
  const { charter, def, draftHash, csrf } = options;
  const diff = describeExternalAmendment(charter, def);
  const lines = describeExternalSystem(def, charter.money.currency);
  const problems = amendmentProblems(buildExternalAmendment(charter, def, new Date()));
  const host = externalHost(def);
  const subprocessorAdded = !charter.data.subprocessorsAllowed.includes(externalSubprocessor(def.id));
  const readd =
    !diff.replaces && options.previouslyRemoved
      ? `<div class="card"><h2>${esc(EXTERNAL_READD_HEADING)}</h2><p>הסרת את המערכת הזו מהתקנון בעבר. החתימה הזו מחזירה אותה לפי הטיוטה שהטכנאי הכין — קרא/י את התיאור המלא למטה.</p></div>`
      : '';
  const hostLine =
    diff.host !== null
      ? `<p>החברה שהנתונים יוצאים אליה משתנה: <code>${escLabel(diff.host.before)}</code> → <code>${escLabel(diff.host.after)}</code></p>`
      : '';

  const form =
    problems.length > 0
      ? `<div class="card"><p class="error">${esc(CANNOT_SIGN)}</p><ul>${problems.map((p) => `<li>${escLabel(p)}</li>`).join('')}</ul></div>`
      : `<form method="post" action="/connections/external/${esc(def.id)}/sign">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="base" value="${esc(charter.charterVersion)}">
  <input type="hidden" name="draftHash" value="${esc(draftHash)}">
  <button type="submit">חתימה על התוספת לתקנון</button>
</form>`;

  const html = page(
    'חתימה: מערכת חיצונית',
    `<h1>${diff.replaces ? 'שינוי' : options.previouslyRemoved ? 'החזרת' : 'הוספת'} מערכת חיצונית: ${escLabel(def.label)}</h1>
${options.notice === undefined ? '' : `<p class="error">${esc(options.notice)}</p>`}
${readd}
${diffCard(diff)}
<div class="card">
<h2>מה החתימה מתירה</h2>
<ul>${lines.map((line) => `<li>${escLabel(line)}</li>`).join('')}</ul>
<p>כל פעולה אחרת במערכת הזו — אסורה.</p>
</div>
<div class="card">
<h2>לאן המידע עובר</h2>
${hostLine}
<p>המידע עובר אל: <b><code>${escLabel(host)}</code></b> — החברה שמפעילה את המערכת.${
    subprocessorAdded ? ' היא תתווסף לרשימת הגורמים שמותר להם לעבד את המידע של העסק.' : ''
  }</p>
</div>
${options.keyStored ? '' : `<p class="error">${esc(EXTERNAL_MISSING_SECRET)}</p><p class="muted">אפשר לחתום כבר עכשיו; העוזרת לא תוכל לפנות למערכת עד שהסוד יישמר.</p>`}
<p>שאר התקנון נשאר בדיוק כפי שנחתם.</p>
${form}`,
  );
  return { status: problems.length > 0 ? 409 : 200, html };
}

// --- GET /connections/external/:system/sign --------------------------------

export async function handleExternalSignGet(
  res: ServerResponse,
  db: BusinessDb,
  csrf: string,
  systemId: string,
): Promise<void> {
  if (!EXTERNAL_SYSTEM_ID.test(systemId)) return sendHtml(res, 404, errorPage('לא נמצא', NO_DRAFT));
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לחתום', read.message));
  const draft = (await loadDrafts(db)).find((d) => d.systemId === systemId);
  if (draft === undefined) return sendHtml(res, 404, errorPage('אין טיוטה', NO_DRAFT));
  const check = checkDraft(systemId, draft);
  if (!check.ok) return sendHtml(res, 409, errorPage('הטיוטה אינה תקינה', DRAFT_INVALID));
  const keyStored = await hasKeySecret(db, systemId);
  const previouslyRemoved = await wasRemoved(db, read.charter, systemId);
  const rendered = renderExternalSignPage({
    charter: read.charter, def: check.def, draftHash: check.hash, csrf, keyStored, previouslyRemoved,
  });
  sendHtml(res, rendered.status, rendered.html);
}

// --- POST /connections/external/:system/sign -------------------------------

export async function handleExternalSignPost(
  res: ServerResponse,
  db: BusinessDb,
  session: ExternalSession,
  csrf: string,
  systemId: string,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, errorPage('הבקשה נדחתה', CSRF_REFUSAL));
  }
  if (!EXTERNAL_SYSTEM_ID.test(systemId)) return sendHtml(res, 404, errorPage('לא נמצא', NO_DRAFT));
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן לחתום', read.message));
  const active = read.charter;
  const keyStored = await hasKeySecret(db, systemId);
  const previouslyRemoved = await wasRemoved(db, active, systemId);

  try {
    await transaction(db, async (tx) => {
      const draft = await lockDraft(tx, systemId);
      if (draft === null) throw new Refusal(404, errorPage('אין טיוטה', NO_DRAFT));
      const check = checkDraft(systemId, draft);
      if (!check.ok) throw new Refusal(409, errorPage('הטיוטה אינה תקינה', DRAFT_INVALID));
      if (check.hash !== form.get('draftHash')) {
        const rendered = renderExternalSignPage({
          charter: active, def: check.def, draftHash: check.hash, csrf, keyStored, previouslyRemoved, notice: DRAFT_CHANGED,
        });
        throw new Refusal(409, rendered.html);
      }
      const base = form.get('base');
      if (base !== active.charterVersion) throw new Refusal(409, errorPage('התקנון השתנה', STALE_MESSAGE));

      const unsigned = buildExternalAmendment(active, check.def, new Date());
      const problems = amendmentProblems(unsigned);
      if (problems.length > 0) throw new Refusal(409, errorPage('לא ניתן לחתום', `${CANNOT_SIGN} ${problems.join(' · ')}`));

      const replaces = active.externalSystems.some((s) => s.id === systemId);
      const outcome = await installSigned(
        tx,
        session.username,
        base,
        unsigned,
        `charter amendment signed in the dashboard by ${session.username}: ` +
          `${replaces ? 'replaced' : 'added'} the external system "${systemId}" ` +
          `(draft ${check.hash}), superseding ${active.charterVersion}`,
      );
      if (outcome === 'stale') throw new Refusal(409, errorPage('התקנון השתנה', STALE_MESSAGE));
      await upsertBinding(
        tx,
        {
          system: externalConnectionSystem(systemId),
          status: 'live',
          endpoint: null,
          credentialRef: externalSecretRefs(systemId).key,
          provider: null,
          lastOkAt: null,
          lastError: null,
        },
        { charterVersion: unsigned.charterVersion, by: session.username },
      );
      await deleteDraft(tx, systemId);
    });
  } catch (error) {
    if (error instanceof Refusal) return sendHtml(res, error.status, error.html);
    throw error;
  }
  seeOther(res, '/connections/external');
}

// --- POST /connections/external/:system/remove -----------------------------

export async function handleExternalRemovePost(
  res: ServerResponse,
  db: BusinessDb,
  session: ExternalSession,
  systemId: string,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, errorPage('הבקשה נדחתה', CSRF_REFUSAL));
  }
  if (!EXTERNAL_SYSTEM_ID.test(systemId)) return sendHtml(res, 404, errorPage('לא נמצא', NOT_SIGNED));
  const read = await readCharter(db);
  if (!read.ok) return sendHtml(res, 409, errorPage('לא ניתן להסיר', read.message));
  const active = read.charter;
  if (!active.externalSystems.some((s) => s.id === systemId)) {
    return sendHtml(res, 409, errorPage('אין מה להסיר', NOT_SIGNED));
  }
  // The confirm step, enforced here and not only by the checkbox's `required`.
  if (form.get('confirm') !== 'yes') return sendHtml(res, 400, errorPage('לא אושר', REMOVE_NOT_CONFIRMED));
  const base = form.get('base');
  if (base !== active.charterVersion) return sendHtml(res, 409, errorPage('התקנון השתנה', STALE_MESSAGE));

  try {
    await transaction(db, async (tx) => {
      const unsigned = buildExternalRemoval(active, systemId, new Date());
      const outcome = await installSigned(
        tx,
        session.username,
        base,
        unsigned,
        `charter amendment signed in the dashboard by ${session.username}: removed the external system ` +
          `"${systemId}", superseding ${active.charterVersion}`,
      );
      if (outcome === 'stale') throw new Refusal(409, errorPage('התקנון השתנה', STALE_MESSAGE));
      await upsertBinding(
        tx,
        {
          system: externalConnectionSystem(systemId),
          status: 'disconnected',
          endpoint: null,
          credentialRef: externalSecretRefs(systemId).key,
          provider: null,
          lastOkAt: null,
          lastError: null,
        },
        { charterVersion: unsigned.charterVersion, by: session.username },
      );
    });
  } catch (error) {
    if (error instanceof Refusal) return sendHtml(res, error.status, error.html);
    throw error;
  }
  seeOther(res, `/connections/external?removed=${encodeURIComponent(systemId)}`);
}
