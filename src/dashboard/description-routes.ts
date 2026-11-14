/**
 * `/settings/description` — the business description after setup (spec
 * decision 3). The owner edits the text here; a real change saves a new
 * version and, under the daily cap, asks the model for rules.
 *
 * **Nothing here approves or signs.** Proposals go into the edit draft's
 * `extra.pending` (prefilled from the active charter by `ensureEditDraft`),
 * and this page only lists them with one link to step 10, where the owner
 * chooses each one exactly as in the interview, and then signs through the
 * unchanged summary/sign path. Until then the active charter is untouched.
 *
 * The textarea is HTML-escaped only (`esc`), never `escLabel`: it is the
 * owner's own text in an input, and stripping bidi controls would make an
 * unchanged resubmit a new version — and a paid proposer call. The proposal
 * sentences shown as labels go through `escLabel`.
 */
import type { ServerResponse } from 'node:http';
import type { AcceptedRule } from '../charter/interview/answers.js';
import { loadDraft } from '../charter/interview/draft-store.js';
import { activeCharterVersion } from '../charter/store.js';
import type { DescriptionProposer } from '../business/description-proposals.js';
import { BUSINESS_DESCRIPTION_MAX_CHARS, loadActiveDescription, saveDescription } from '../business/description-store.js';
import type { BusinessDb } from '../db/pool.js';
import { proposeFromDescriptionWithModel } from '../sdk/description-rules.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import {
  DESCRIPTION_CAP_NOTICE,
  DESCRIPTION_NO_DRAFT_NOTICE,
  DESCRIPTION_PROPOSER_FAILED,
  addDescriptionProposals,
  type DescriptionProposalsOutcome,
} from './setup-routes.js';
import { DESCRIPTION_HINTS } from './setup-step-views.js';
import { escLabel, escapeHtml as esc, page, renderForbidden } from './views.js';

export const DESCRIPTION_SETTINGS_PATH = '/settings/description';

export interface DescriptionSession {
  sessionId: string;
  username: string;
}

export interface DescriptionOptions {
  /** Test seam: the description proposer. Production leaves it unset and the model proposes. */
  descriptionProposer?: DescriptionProposer;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

function seeOther(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

interface DescriptionView {
  text: string;
  csrf: string;
  pending: readonly AcceptedRule[];
  error?: string;
  notice?: string;
}

/**
 * The pending proposals of the edit draft — only a draft started from the
 * active charter: a stale draft is replaced the next time the edit opens, and
 * listing its proposals would point the owner at rules that are about to go.
 */
async function editPending(db: BusinessDb): Promise<readonly AcceptedRule[]> {
  const draft = await loadDraft(db);
  if (draft === null) return [];
  const active = await activeCharterVersion(db);
  if (active === null || draft.baseCharterVersion !== active) return [];
  return draft.answers.extra?.pending ?? [];
}

function renderDescriptionPage(view: DescriptionView): string {
  const proposals =
    view.pending.length === 0
      ? ''
      : `<div class="card">
<h3>הצעות לכללים מהתיאור</h3>
<ul>${view.pending.map((r) => `<li>${escLabel(r.text)}</li>`).join('')}</ul>
<p>הכללים עדיין לא השתנו — הם ישתנו רק אחרי שתעבור על ההצעות ותחתום.</p>
<p><a href="/setup/step/10">עבור על ההצעות וחתום</a></p>
</div>`;
  return page(
    'תיאור העסק',
    `<nav><a href="/">לכרטיסי האישור</a> · <a href="/setup/edit">ערוך את הכללים</a></nav>
<h1>תיאור העסק</h1>
<div class="card">
<form method="post" action="${DESCRIPTION_SETTINGS_PATH}">
  <input type="hidden" name="csrf" value="${esc(view.csrf)}">
  <p class="muted">ספר לי על העסק. מהתיאור אציע כללים — הם נכנסים לתוקף רק אחרי שתאשר ותחתום.</p>
  <ul class="muted">${DESCRIPTION_HINTS.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
  <label>תיאור העסק <span class="muted">(עד ${BUSINESS_DESCRIPTION_MAX_CHARS.toLocaleString('en-US')} תווים)</span>
    <textarea name="description" rows="10">${esc(view.text)}</textarea>
  </label>
  ${view.error === undefined ? '' : `<p class="error">${esc(view.error)}</p>`}
  ${view.notice === undefined ? '' : `<p class="muted">${esc(view.notice)}</p>`}
  <button type="submit">שמור את התיאור</button>
</form>
</div>
${proposals}`,
  );
}

async function render(
  res: ServerResponse,
  status: number,
  db: BusinessDb,
  session: DescriptionSession,
  extra: { text?: string; error?: string; notice?: string } = {},
): Promise<void> {
  const view: DescriptionView = {
    text: extra.text ?? (await loadActiveDescription(db))?.text ?? '',
    csrf: issueCsrfToken(session.sessionId),
    pending: await editPending(db),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
    ...(extra.notice !== undefined ? { notice: extra.notice } : {}),
  };
  html(res, status, renderDescriptionPage(view));
}

/** `GET /settings/description`. */
export async function handleDescriptionGet(res: ServerResponse, db: BusinessDb, session: DescriptionSession): Promise<void> {
  await render(res, 200, db, session);
}

const NOTICE: Readonly<Record<'cap' | 'no_draft', string>> = {
  cap: DESCRIPTION_CAP_NOTICE,
  no_draft: DESCRIPTION_NO_DRAFT_NOTICE,
};

/**
 * `POST /settings/description` — save, then (on a real change, non-empty,
 * under the cap, over a readable charter) propose into the edit draft. Every
 * outcome after the save says the description was saved.
 */
export async function handleDescriptionPost(
  res: ServerResponse,
  db: BusinessDb,
  session: DescriptionSession,
  form: URLSearchParams,
  options: DescriptionOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  const text = form.get('description') ?? '';
  const saved = await saveDescription(db, { text, createdBy: session.username });
  if (!saved.saved) {
    if (saved.reason === 'too_long') return render(res, 400, db, session, { text, error: saved.messageHe });
    return seeOther(res, DESCRIPTION_SETTINGS_PATH);
  }
  // A cleared description has nothing to propose from.
  if (saved.description.text === '') return seeOther(res, DESCRIPTION_SETTINGS_PATH);

  const proposer = options.descriptionProposer ?? proposeFromDescriptionWithModel;
  let outcome: DescriptionProposalsOutcome;
  try {
    outcome = await addDescriptionProposals(db, saved.description.text, proposer, 'edit');
  } catch (err) {
    console.error(`description proposals failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    return render(res, 200, db, session, { notice: DESCRIPTION_PROPOSER_FAILED });
  }
  if ('reason' in outcome) return render(res, 200, db, session, { notice: NOTICE[outcome.reason] });
  seeOther(res, DESCRIPTION_SETTINGS_PATH);
}
