/**
 * The setup interview's routes (spec §5, §6.1, §6.6): ten steps, the stage-10
 * rule proposal, the summary, the sign, and "edit the rules".
 *
 * All of them sit behind the session and the `mustChangePassword` check in
 * `route()`, and every POST verifies CSRF before it reads anything else.
 *
 * **Nothing here signs, builds or installs on its own terms.** A step POST
 * validates and calls `saveSection`, which validates again. The summary
 * freezes the draft, builds the unsigned charter with
 * `buildCharterFromInterview` and summarises THAT object; the form carries its
 * hash, and `signAndInstallInterview` rebuilds and compares before signing.
 * The `previous` charter both sides build against comes from one function,
 * `previousForDraft`.
 *
 * **Stage 10's rules never come from the form.** `POST /setup/rule/:i` names
 * an index; the rule moved is the server's `extra.pending[i]`. The proposer
 * only ever proposes — the owner chooses.
 *
 * **`probeActiveCharter` is called in exactly one route here, `/setup/edit`**
 * — an install path, one of the callers its docblock admits. Every other
 * question about the charter is `activeCharterVersion` (a column, no parse)
 * or `previousForDraft` (the draft's own base).
 */
import type { ServerResponse } from 'node:http';
import { InterviewAnswers, INTERVIEW_SECTIONS, type AcceptedRule } from '../charter/interview/answers.js';
import { buildCharterFromInterview, buildConnections, prefillFromCharter } from '../charter/interview/build.js';
import { freezeDraft, loadDraft, replaceDraft, saveSection, type InterviewDraft } from '../charter/interview/draft-store.js';
import { previousForDraft, signAndInstallInterview } from '../charter/interview/install.js';
import type { RuleProposer } from '../charter/interview/rule-proposal.js';
import { summarizeCharter } from '../charter/interview/summary.js';
import { signedMailboxProvider } from '../charter/amend-mailbox.js';
import { activeCharterVersion, probeActiveCharter } from '../charter/store.js';
import type { BusinessCharter } from '../domain/charter.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { MAILBOX_SYSTEM, type MailProvider } from '../mail/mailbox.js';
import { proposeRuleWithModel } from '../sdk/interview-rule.js';
import { canonicalHash } from '../util/canonical.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import { PREFLIGHT_REFUSAL_TITLE, preflightRefusalMessage } from './mailbox-connect.js';
import { oauthCeremonyPreflight } from './oauth-routes.js';
import {
  candidateFromForm,
  firstUnsavedStep,
  needsFollowUp,
  validateSection,
  type SectionName,
} from './setup-forms.js';
import { RULE_TEXT_MAX, renderStep, type StepView } from './setup-step-views.js';
import { STEP_COUNT, UNREADABLE_NOTICE, renderSetupRefusal, renderSummary } from './setup-views.js';

export interface SetupSession {
  sessionId: string;
  username: string;
}

export interface SetupOptions {
  /** Test seam: the stage-10 proposer. Production leaves it unset and the model proposes. */
  ruleProposer?: RuleProposer;
  /**
   * The master-key file the mailbox preflight loads — the same value the
   * connections screen's mailbox sign receives (`OAuthRouteOptions`).
   */
  credentialKeyPath?: string | undefined;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

/** 303, so a POST is followed with a GET. */
export function seeOther(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

const CSRF_REFUSAL = 'הטופס פג תוקף. רענן/י ונסה/י שוב. לא בוצעה כל פעולה.';
const TO_SUMMARY = { href: '/setup/summary', label: 'חזרה לסיכום' } as const;

function refuseCsrf(res: ServerResponse): void {
  sendHtml(res, 403, renderSetupRefusal('הבקשה נדחתה', CSRF_REFUSAL, TO_SUMMARY));
}

/** `1`–`10`, or `null`. */
export function parseStep(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= STEP_COUNT ? n : null;
}

function sectionOf(step: number): SectionName {
  const section = INTERVIEW_SECTIONS[step - 1];
  if (section === undefined) throw new Error(`no section for step ${step}`);
  return section;
}

/** The base charter of the draft, for the two steps that depend on it; unreadable or gone → none. */
async function baseOf(draft: InterviewDraft | null, businessId: string): Promise<BusinessCharter | null> {
  if (draft === null) return null;
  const base = await previousForDraft(draft, businessId);
  return base.ok ? base.previous : null;
}

function mailboxPinnedBy(previous: BusinessCharter | null): MailProvider | null {
  const connection = previous?.connections.find((c) => c.system === MAILBOX_SYSTEM);
  return connection === undefined ? null : signedMailboxProvider(connection);
}

async function stepView(
  businessId: string,
  session: SetupSession,
  step: number,
  draft: InterviewDraft | null,
  extra: Partial<StepView> = {},
): Promise<StepView> {
  const answers = draft?.answers ?? {};
  const view: StepView = {
    step,
    draft: answers,
    value: answers[sectionOf(step)] ?? null,
    issues: [],
    csrf: issueCsrfToken(session.sessionId),
    ...extra,
  };
  if (step === 5 || step === 6) {
    const previous = await baseOf(draft, businessId);
    view.pinnedMailbox = mailboxPinnedBy(previous);
    const provider = answers.reading?.mailbox ?? 'none';
    view.connections = buildConnections(provider === 'none' ? null : provider, previous).connections;
  }
  // Step 9 preselects the dial as it is now: on an edit, the live position.
  if (step === 9) view.currentMode = await loadAutonomyMode({ businessId });
  return view;
}

// --- GET /setup --------------------------------------------------------------

export async function handleSetupIndex(res: ServerResponse, businessId: string): Promise<void> {
  const draft = await loadDraft(businessId);
  // A charter is active and no interview is in flight: "edit the rules" is
  // the door that fills the draft from it.
  if (draft === null && (await activeCharterVersion(businessId)) !== null) return seeOther(res, '/setup/edit');
  const next = firstUnsavedStep(draft?.answers ?? null);
  seeOther(res, next === null ? '/setup/summary' : `/setup/step/${next}`);
}

// --- GET/POST /setup/step/:n -------------------------------------------------

/**
 * A charter is active and no interview is in flight: an edit must start from
 * the prefill (`/setup/edit`), never from an empty draft a step would create —
 * a sign from there would drop everything the owner signed that was not
 * re-typed. The same rule `handleSetupIndex` applies, at every door that can
 * create a draft.
 */
async function editMustStartFromPrefill(draft: InterviewDraft | null, businessId: string): Promise<boolean> {
  return draft === null && (await activeCharterVersion(businessId)) !== null;
}

export async function handleSetupStepGet(
  res: ServerResponse,
  businessId: string,
  session: SetupSession,
  step: number,
  query: URLSearchParams,
): Promise<void> {
  const draft = await loadDraft(businessId);
  if (await editMustStartFromPrefill(draft, businessId)) return seeOther(res, '/setup/edit');
  const view = await stepView(businessId, session, step, draft, step === 1 && query.get('more') === '1' ? { followUp: true } : {});
  sendHtml(res, 200, renderStep(view));
}

export async function handleSetupStepPost(
  res: ServerResponse,
  businessId: string,
  session: SetupSession,
  step: number,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const section = sectionOf(step);
  const draft = await loadDraft(businessId);
  if (await editMustStartFromPrefill(draft, businessId)) return seeOther(res, '/setup/edit');
  let candidate = candidateFromForm(section, form, draft?.answers ?? {});

  // Step 5: a mailbox the base charter already declares is not the form's to
  // change (spec §6.6) — pinned server-side, whatever was posted.
  if (section === 'reading') {
    const pinned = mailboxPinnedBy(await baseOf(draft, businessId));
    if (pinned !== null) candidate = { ...(candidate as object), mailbox: pinned };
  }

  const issues = validateSection(section, candidate);
  if (issues.length > 0) {
    const view = await stepView(businessId, session, step, draft, { value: candidate, issues });
    return sendHtml(res, 400, renderStep(view));
  }

  // The draft's base is the charter active when the interview started; a
  // draft that starts now starts from whatever is active now.
  const baseCharterVersion = draft === null ? await activeCharterVersion(businessId) : undefined;
  await saveSection(businessId, section, candidate, baseCharterVersion === undefined ? {} : { baseCharterVersion });

  if (step === 1 && form.get('followed') !== '1' && needsFollowUp(candidate)) {
    return seeOther(res, '/setup/step/1?more=1');
  }
  if (form.get('stay') === '1') return seeOther(res, `/setup/step/${step}`);
  seeOther(res, step === STEP_COUNT ? '/setup/summary' : `/setup/step/${step + 1}`);
}

// --- stage 10 ----------------------------------------------------------------

function extraOf(draft: InterviewDraft | null): { accepted: AcceptedRule[]; pending: AcceptedRule[] } {
  const extra = draft?.answers.extra;
  return { accepted: [...(extra?.accepted ?? [])], pending: [...(extra?.pending ?? [])] };
}

async function renderStep10(
  res: ServerResponse,
  status: number,
  businessId: string,
  session: SetupSession,
  extra: Partial<StepView>,
): Promise<void> {
  const draft = await loadDraft(businessId);
  sendHtml(res, status, renderStep(await stepView(businessId, session, 10, draft, extra)));
}

/**
 * `POST /setup/rule` — one sentence → one proposal, appended to `pending`.
 * The 500-character cap (`AcceptedRule.text`) is checked HERE, before the
 * proposer is called: a sentence the schema would refuse must not cost a
 * model call, and a rule built from it would fall back to guidance and then
 * fail the same cap on save.
 */
export async function handleRulePost(
  res: ServerResponse,
  businessId: string,
  session: SetupSession,
  form: URLSearchParams,
  options: SetupOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const text = (form.get('text') ?? '').trim();
  if (text.length === 0) {
    return renderStep10(res, 400, businessId, session, { ruleError: 'יש לכתוב משפט לפני שמבקשים הצעה.' });
  }
  if (text.length > RULE_TEXT_MAX) {
    return renderStep10(res, 400, businessId, session, {
      ruleText: text,
      ruleError: `המשפט ארוך מדי — עד ${RULE_TEXT_MAX} תווים. אפשר לפצל אותו לכמה משפטים.`,
    });
  }
  if (await editMustStartFromPrefill(await loadDraft(businessId), businessId)) return seeOther(res, '/setup/edit');
  const proposer = options.ruleProposer ?? proposeRuleWithModel;
  const proposal = await proposer(text);
  const draft = await loadDraft(businessId);
  const extra = extraOf(draft);
  extra.pending.push(proposal);
  const baseCharterVersion = draft === null ? await activeCharterVersion(businessId) : undefined;
  await saveSection(businessId, 'extra', extra, baseCharterVersion === undefined ? {} : { baseCharterVersion });
  seeOther(res, '/setup/step/10');
}

const RULE_CHOICES = new Set(['accept', 'guidance', 'delete', 'fix', 'remove']);

/**
 * `POST /setup/rule/:i` — the owner's choice on proposal `i`. The rule moved
 * is the server's `pending[i]`, never anything from the form — and only if it
 * still hashes to the `ruleHash` the button was rendered with: after any
 * splice the index names a different rule, and a double click or a stale tab
 * must be refused (409), not applied to the neighbour. `fix` ("תקן")
 * deletes the proposal and shows its sentence back in the box to re-submit;
 * `remove` takes back an accepted rule.
 */
export async function handleRuleChoice(
  res: ServerResponse,
  businessId: string,
  session: SetupSession,
  index: number,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const choice = form.get('choice') ?? '';
  if (!RULE_CHOICES.has(choice)) {
    return renderStep10(res, 400, businessId, session, { ruleError: 'בחירה לא מוכרת. לא בוצעה כל פעולה.' });
  }
  const draft = await loadDraft(businessId);
  const extra = extraOf(draft);
  const list = choice === 'remove' ? extra.accepted : extra.pending;
  const rule = list[index];
  // The index is only a position; the hash says WHICH rule the owner saw.
  if (rule === undefined || canonicalHash(rule) !== form.get('ruleHash')) {
    return renderStep10(res, 409, businessId, session, {
      ruleError: 'ההצעה הזו כבר השתנתה או לא קיימת — אולי כבר החלטת עליה. לא בוצעה כל פעולה; זו הרשימה כפי שהיא עכשיו.',
    });
  }
  list.splice(index, 1);
  if (choice === 'accept') extra.accepted.push(rule);
  if (choice === 'guidance') extra.accepted.push({ kind: 'guidance', text: rule.text });
  await saveSection(businessId, 'extra', extra);
  if (choice === 'fix') return renderStep10(res, 200, businessId, session, { ruleText: rule.text });
  seeOther(res, '/setup/step/10');
}

// --- summary and sign --------------------------------------------------------

export async function handleSummaryGet(res: ServerResponse, businessId: string, session: SetupSession): Promise<void> {
  const draft = await loadDraft(businessId);
  const parsed = InterviewAnswers.safeParse(draft?.answers);
  if (draft === null || !parsed.success) return seeOther(res, '/setup');
  if (parsed.data.extra.pending.length > 0) return seeOther(res, '/setup/step/10');
  const base = await previousForDraft(draft, businessId);
  if (!base.ok) {
    return sendHtml(
      res,
      409,
      renderSetupRefusal(
        'הכללים השתנו',
        'הכללים שהראיון נפתח מהם כבר לא קיימים. יש לפתוח את „ערוך את הכללים” מחדש. לא בוצעה כל פעולה.',
        { href: '/setup/edit', label: 'ערוך את הכללים' },
      ),
    );
  }
  const frozenAt = await freezeDraft(businessId, new Date());
  const unsigned = buildCharterFromInterview(parsed.data, { businessId, frozenAt, previous: base.previous });
  const summary = summarizeCharter(unsigned, { previous: base.previous, documentsWanted: parsed.data.reading.documents });
  sendHtml(
    res,
    200,
    renderSummary({
      draft: draft.answers,
      summary,
      shownHash: canonicalHash(unsigned),
      csrf: issueCsrfToken(session.sessionId),
      business: {
        legalName: unsigned.identity.legalName,
        tradeName: unsigned.identity.tradeName,
        principal: unsigned.people.find((p) => p.isPrincipal)?.displayName ?? null,
      },
      mode: parsed.data.autonomy.mode,
    }),
  );
}

const REFUSAL: Readonly<Record<'incomplete' | 'not_frozen' | 'hash_mismatch' | 'stale', [string, string]>> = {
  incomplete: ['הראיון לא הושלם', 'חסרות תשובות באחד השלבים, ולכן אין על מה לחתום. לא בוצעה כל פעולה.'],
  not_frozen: ['הסיכום לא הוצג', 'יש לפתוח את עמוד הסיכום ולקרוא אותו לפני החתימה. לא בוצעה כל פעולה.'],
  hash_mismatch: [
    'הסיכום השתנה',
    'התשובות השתנו מאז שהסיכום הוצג, ולכן מה שהוצג אינו מה שהיה נחתם. לא בוצעה כל פעולה — יש לקרוא את הסיכום מחדש.',
  ],
  stale: [
    'הכללים השתנו בינתיים',
    'מישהו אחר חתם על כללים לעסק מאז שהראיון התחיל, ולכן החתימה הזו הייתה דורסת אותם. לא בוצעה כל פעולה.',
  ],
};

/**
 * A charter that adds the mailbox is preflighted exactly as the connections
 * screen's mailbox sign is (`oauthCeremonyPreflight`, same key path): the
 * signature moves `mail.send` to the mailbox, and a ceremony that cannot
 * start would leave the business with no outgoing mail. A refusal changes
 * nothing.
 */
export async function handleSignPost(
  res: ServerResponse,
  businessId: string,
  session: SetupSession,
  form: URLSearchParams,
  options: SetupOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const outcome = await signAndInstallInterview({
    businessId,
    username: session.username,
    shownHash: form.get('shownHash') ?? '',
    mailboxPreflight: (provider) => oauthCeremonyPreflight(businessId, provider, options.credentialKeyPath),
  });
  if (outcome.outcome === 'installed') return seeOther(res, outcome.modeApplied ? '/' : '/?mode=failed');
  if (outcome.outcome === 'preflight_failed') {
    return sendHtml(
      res,
      409,
      renderSetupRefusal(PREFLIGHT_REFUSAL_TITLE, preflightRefusalMessage(outcome.reason), TO_SUMMARY),
    );
  }
  const [title, message] = REFUSAL[outcome.outcome];
  sendHtml(res, 409, renderSetupRefusal(title, message, TO_SUMMARY));
}

// --- GET /setup/edit ---------------------------------------------------------

/**
 * "Edit the rules" (spec §6.6). An install path, and therefore one of the
 * callers `probeActiveCharter` admits:
 *   - a readable active charter and no draft started from it → the draft is
 *     REPLACED by the prefill (a draft started from anything else is stale);
 *   - an unreadable one → the draft is emptied against that version (unless
 *     one already started from it) and step 1 opens with the notice; the
 *     signature replaces the charter nobody can read;
 *   - none → the first-time interview.
 */
export async function handleSetupEdit(res: ServerResponse, businessId: string, session: SetupSession): Promise<void> {
  const probe = await probeActiveCharter(businessId);
  const draft = await loadDraft(businessId);
  if (probe.ok) {
    if (probe.active === null) return seeOther(res, '/setup');
    const version = probe.active.charter.charterVersion;
    if (draft === null || draft.baseCharterVersion !== version) {
      await replaceDraft(businessId, prefillFromCharter(probe.active.charter), version);
    }
    return seeOther(res, '/setup/step/1');
  }
  console.error('setup edit: the active charter does not parse:', probe.reason);
  const version = await activeCharterVersion(businessId);
  const current =
    draft !== null && draft.baseCharterVersion === version ? draft : await replaceDraft(businessId, {}, version);
  sendHtml(res, 200, renderStep(await stepView(businessId, session, 1, current, { notice: UNREADABLE_NOTICE })));
}
