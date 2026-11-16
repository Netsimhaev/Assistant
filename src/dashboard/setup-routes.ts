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
 * **`probeActiveCharter` is called in exactly one function here,
 * `prepareEditDraft`** (behind `ensureEditDraft`, `/setup/edit` and the settings screen's
 * description save) — an install path, one of the callers its docblock admits. Every other
 * question about the charter is `activeCharterVersion` (a column, no parse)
 * or `previousForDraft` (the draft's own base).
 */
import type { ServerResponse } from 'node:http';
import { InterviewAnswers, INTERVIEW_SECTIONS, type AcceptedRule } from '../charter/interview/answers.js';
import { buildCharterFromInterview, buildConnections, prefillFromCharter } from '../charter/interview/build.js';
import { freezeDraft, loadDraft, replaceDraft, saveSection, type InterviewDraft } from '../charter/interview/draft-store.js';
import { previousForDraft, signAndInstallInterview, summaryHash } from '../charter/interview/install.js';
import {
  SetupPeopleInputError,
  confirmSetupPeople,
  setupPeopleListHash,
  unconfirmedSetupPeople,
} from '../business/confirm-people.js';
import { loadProfile, readLogo } from '../business/profile.js';
import { loadSetupPackage } from '../business/setup-package.js';
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
import type { BusinessDb } from '../db/pool.js';
import { parseDescriptionProposals, type DescriptionProposer } from '../business/description-proposals.js';
import {
  DESCRIPTION_PROPOSAL_RUNS_PER_DAY,
  loadActiveDescription,
  proposalRunsInLastDay,
  recordRejectedSentence,
  rejectedSentenceHashes,
  saveDescription,
} from '../business/description-store.js';
import { proposeFromDescriptionWithModel } from '../sdk/description-rules.js';

export interface SetupSession {
  sessionId: string;
  username: string;
}

export interface SetupOptions {
  /** Test seam: the stage-10 proposer. Production leaves it unset and the model proposes. */
  ruleProposer?: RuleProposer;
  /** Test seam: the description proposer. Production leaves it unset and the model proposes. */
  descriptionProposer?: DescriptionProposer;
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
async function baseOf(draft: InterviewDraft | null, db: BusinessDb): Promise<BusinessCharter | null> {
  if (draft === null) return null;
  const base = await previousForDraft(db, draft);
  return base.ok ? base.previous : null;
}

function mailboxPinnedBy(previous: BusinessCharter | null): MailProvider | null {
  const connection = previous?.connections.find((c) => c.system === MAILBOX_SYSTEM);
  return connection === undefined ? null : signedMailboxProvider(connection);
}

async function stepView(
  db: BusinessDb,
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
    const previous = await baseOf(draft, db);
    view.pinnedMailbox = mailboxPinnedBy(previous);
    const provider = answers.reading?.mailbox ?? 'none';
    view.connections = buildConnections(provider === 'none' ? null : provider, previous).connections;
  }
  // Step 1 shows the address and logo the technician entered, read-only.
  if (step === 1) {
    const profile = await loadProfile(db);
    view.profile = { address: profile.address, hasLogo: profile.logo !== null };
  }
  // Step 2: the package's boss number fills an empty field, until the draft
  // has a number of its own. Not on a refused POST — that shows what was typed.
  if (step === 2 && extra.value === undefined && (answers.principal?.whatsapp ?? null) === null) {
    const boss = (await loadSetupPackage(db))?.bossWhatsapp ?? null;
    if (boss !== null) {
      view.value = { ...(answers.principal ?? {}), whatsapp: boss };
      view.bossPrefilled = true;
    }
  }
  // Step 8 lists the package's people, and what a recorded confirmation chose.
  if (step === 8) {
    const pkg = await loadSetupPackage(db);
    const snapshot = answers.setupPeople;
    view.setupPeople = {
      contacts: pkg?.contacts ?? [],
      colleagues: pkg?.colleagues ?? [],
      knownPhones: (snapshot?.contacts ?? []).filter((c) => c.known).map((c) => c.phone),
      confirmed: snapshot !== undefined,
      listHash: setupPeopleListHash(pkg),
    };
  }
  // Step 9 preselects the dial as it is now: on an edit, the live position.
  if (step === 9) view.currentMode = await loadAutonomyMode(db);
  // Step 10's description box shows the active description unless a refused
  // POST is re-rendering what the owner typed.
  if (step === 10 && view.descriptionText === undefined) {
    view.descriptionText = (await loadActiveDescription(db))?.text ?? '';
  }
  return view;
}

// --- GET /setup --------------------------------------------------------------

export async function handleSetupIndex(res: ServerResponse, db: BusinessDb): Promise<void> {
  const draft = await loadDraft(db);
  // A charter is active and no interview is in flight: "edit the rules" is
  // the door that fills the draft from it.
  if (draft === null && (await activeCharterVersion(db)) !== null) return seeOther(res, '/setup/edit');
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
async function editMustStartFromPrefill(draft: InterviewDraft | null, db: BusinessDb): Promise<boolean> {
  return draft === null && (await activeCharterVersion(db)) !== null;
}

export async function handleSetupStepGet(
  res: ServerResponse,
  db: BusinessDb,
  session: SetupSession,
  step: number,
  query: URLSearchParams,
): Promise<void> {
  const draft = await loadDraft(db);
  if (await editMustStartFromPrefill(draft, db)) return seeOther(res, '/setup/edit');
  const view = await stepView(db, session, step, draft, step === 1 && query.get('more') === '1' ? { followUp: true } : {});
  sendHtml(res, 200, renderStep(view));
}

export async function handleSetupStepPost(
  res: ServerResponse,
  db: BusinessDb,
  session: SetupSession,
  step: number,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const section = sectionOf(step);
  const draft = await loadDraft(db);
  if (await editMustStartFromPrefill(draft, db)) return seeOther(res, '/setup/edit');
  let candidate = candidateFromForm(section, form, draft?.answers ?? {});

  // Step 5: a mailbox the base charter already declares is not the form's to
  // change (spec §6.6) — pinned server-side, whatever was posted.
  if (section === 'reading') {
    const pinned = mailboxPinnedBy(await baseOf(draft, db));
    if (pinned !== null) candidate = { ...(candidate as object), mailbox: pinned };
  }

  const issues = validateSection(section, candidate);
  if (issues.length > 0) {
    const view = await stepView(db, session, step, draft, { value: candidate, issues });
    return sendHtml(res, 400, renderStep(view));
  }

  // The draft's base is the charter active when the interview started; a
  // draft that starts now starts from whatever is active now.
  const baseCharterVersion = draft === null ? await activeCharterVersion(db) : undefined;
  await saveSection(db, section, candidate, baseCharterVersion === undefined ? {} : { baseCharterVersion });

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
  db: BusinessDb,
  session: SetupSession,
  extra: Partial<StepView>,
): Promise<void> {
  const draft = await loadDraft(db);
  sendHtml(res, status, renderStep(await stepView(db, session, 10, draft, extra)));
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
  db: BusinessDb,
  session: SetupSession,
  form: URLSearchParams,
  options: SetupOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const text = (form.get('text') ?? '').trim();
  if (text.length === 0) {
    return renderStep10(res, 400, db, session, { ruleError: 'יש לכתוב משפט לפני שמבקשים הצעה.' });
  }
  if (text.length > RULE_TEXT_MAX) {
    return renderStep10(res, 400, db, session, {
      ruleText: text,
      ruleError: `המשפט ארוך מדי — עד ${RULE_TEXT_MAX} תווים. אפשר לפצל אותו לכמה משפטים.`,
    });
  }
  if (await editMustStartFromPrefill(await loadDraft(db), db)) return seeOther(res, '/setup/edit');
  const proposer = options.ruleProposer ?? proposeRuleWithModel;
  const proposal = await proposer(text);
  const draft = await loadDraft(db);
  const extra = extraOf(draft);
  extra.pending.push(proposal);
  const baseCharterVersion = draft === null ? await activeCharterVersion(db) : undefined;
  await saveSection(db, 'extra', extra, baseCharterVersion === undefined ? {} : { baseCharterVersion });
  seeOther(res, '/setup/step/10');
}

// --- the business description (step 10) ------------------------------------

export type DescriptionProposalsOutcome = { added: number } | { added: 0; reason: 'cap' | 'no_draft' };

/**
 * Ask the model for rules from the owner's description and append the ones
 * that survive `parseDescriptionProposals` to `extra.pending` — proposals
 * only; the owner still chooses each one on step 10.
 *
 * The daily cap counts description versions (`proposalRunsInLastDay`) and is
 * read AFTER the caller saved, so the save just made is in the count: more
 * than `DESCRIPTION_PROPOSAL_RUNS_PER_DAY` versions in 24 hours means this
 * one does not call the model — the tenth save of the day still proposes,
 * the eleventh does not.
 *
 * `'interview'` writes to the interview draft, creating it as `handleRulePost`
 * does; with an active charter and no draft, an edit must start from the
 * prefill, so nothing is proposed (`no_draft`). `'edit'` (the settings screen,
 * after setup) gets its draft from `ensureEditDraft` — the open edit draft,
 * or a fresh prefill of the active charter — and proposes nothing when the
 * active charter is unreadable (`no_draft`). A proposer that throws
 * propagates — the description is already saved, and the caller says so.
 */
export async function addDescriptionProposals(
  db: BusinessDb,
  description: string,
  proposer: DescriptionProposer,
  draftSource: 'interview' | 'edit',
): Promise<DescriptionProposalsOutcome> {
  if (draftSource === 'edit') {
    if ((await ensureEditDraft(db)) === null) return { added: 0, reason: 'no_draft' };
  } else if (await editMustStartFromPrefill(await loadDraft(db), db)) {
    return { added: 0, reason: 'no_draft' };
  }
  if ((await proposalRunsInLastDay(db)) > DESCRIPTION_PROPOSAL_RUNS_PER_DAY) return { added: 0, reason: 'cap' };

  const raw = await proposer(description);
  // Read the draft after the model call: the owner may have acted meanwhile
  // (on the edit path, even signed — the draft is then prefilled anew).
  let draft: InterviewDraft | null;
  if (draftSource === 'edit') {
    draft = await ensureEditDraft(db);
    if (draft === null) return { added: 0, reason: 'no_draft' };
  } else {
    draft = await loadDraft(db);
  }
  const extra = extraOf(draft);
  const proposals = parseDescriptionProposals(raw, description, {
    rejectedHashes: await rejectedSentenceHashes(db),
    existingTexts: [...extra.pending, ...extra.accepted].map((r) => r.text),
  });
  if (proposals.length === 0) return { added: 0 };
  extra.pending.push(...proposals);
  const baseCharterVersion = draft === null ? await activeCharterVersion(db) : undefined;
  await saveSection(db, 'extra', extra, baseCharterVersion === undefined ? {} : { baseCharterVersion });
  return { added: proposals.length };
}

/**
 * The two notices after a save that proposed nothing. Both say what is true:
 * saving the same text again is `unchanged` and never re-runs the proposer,
 * so proposals come only with the next CHANGED save. Task 6 reuses them.
 */
export const DESCRIPTION_CAP_NOTICE =
  'התיאור נשמר. להיום כבר הצעתי כללים מספיק פעמים — הצעות יופיעו בפעם הבאה שתשנה את התיאור ותשמור.';
/** After a save from the settings screen over an unreadable active charter (`no_draft`). */
export const DESCRIPTION_NO_DRAFT_NOTICE =
  'התיאור נשמר. לא הצעתי כללים, כי לא הצלחתי לקרוא את הכללים הנוכחיים — אפשר לעדכן אותם ב"ערוך את הכללים".';
export const DESCRIPTION_PROPOSER_FAILED =
  'התיאור נשמר, אבל לא הצלחתי להציע ממנו כללים כרגע. הצעות יופיעו בפעם הבאה שתשנה את התיאור ותשמור.';

/**
 * `POST /setup/about` — save the business description, then (on a real
 * change, non-empty, under the cap) propose rules from it. The description is
 * not charter input: it is saved now, independently of the draft and of any
 * charter, and never reaches the summary or the signed hash.
 */
export async function handleAboutPost(
  res: ServerResponse,
  db: BusinessDb,
  session: SetupSession,
  form: URLSearchParams,
  options: SetupOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const text = form.get('description') ?? '';
  const saved = await saveDescription(db, { text, createdBy: session.username });
  if (!saved.saved) {
    if (saved.reason === 'too_long') {
      return renderStep10(res, 400, db, session, { descriptionText: text, descriptionError: saved.messageHe });
    }
    return seeOther(res, '/setup/step/10');
  }
  // A cleared description has nothing to propose from.
  if (saved.description.text === '') return seeOther(res, '/setup/step/10');

  const proposer = options.descriptionProposer ?? proposeFromDescriptionWithModel;
  let outcome: DescriptionProposalsOutcome;
  try {
    outcome = await addDescriptionProposals(db, saved.description.text, proposer, 'interview');
  } catch (err) {
    console.error(`description proposals failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    return renderStep10(res, 200, db, session, { descriptionNotice: DESCRIPTION_PROPOSER_FAILED });
  }
  if ('reason' in outcome && outcome.reason === 'cap') {
    return renderStep10(res, 200, db, session, { descriptionNotice: DESCRIPTION_CAP_NOTICE });
  }
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
  db: BusinessDb,
  session: SetupSession,
  index: number,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const choice = form.get('choice') ?? '';
  if (!RULE_CHOICES.has(choice)) {
    return renderStep10(res, 400, db, session, { ruleError: 'בחירה לא מוכרת. לא בוצעה כל פעולה.' });
  }
  const draft = await loadDraft(db);
  const extra = extraOf(draft);
  const list = choice === 'remove' ? extra.accepted : extra.pending;
  const rule = list[index];
  // The index is only a position; the hash says WHICH rule the owner saw.
  if (rule === undefined || canonicalHash(rule) !== form.get('ruleHash')) {
    return renderStep10(res, 409, db, session, {
      ruleError: 'ההצעה הזו כבר השתנתה או לא קיימת — אולי כבר החלטת עליה. לא בוצעה כל פעולה; זו הרשימה כפי שהיא עכשיו.',
    });
  }
  list.splice(index, 1);
  // A deleted proposal's sentence is never proposed again from the description.
  if (choice === 'delete') await recordRejectedSentence(db, rule.text);
  if (choice === 'accept') extra.accepted.push(rule);
  if (choice === 'guidance') extra.accepted.push({ kind: 'guidance', text: rule.text });
  await saveSection(db, 'extra', extra);
  if (choice === 'fix') return renderStep10(res, 200, db, session, { ruleText: rule.text });
  seeOther(res, '/setup/step/10');
}

// --- step 8: the technician's people -----------------------------------------

const PEOPLE_BAD_INPUT = 'הבחירה אינה תקינה. לא בוצעה כל פעולה — יש לרענן ולבחור שוב.';

/**
 * `POST /setup/people` — record which of the setup package's people the owner
 * confirms (`confirmSetupPeople`). Each `known` value must be a plain
 * non-negative integer; the range is checked against the package as read
 * under the lock. Nothing recorded takes effect before the signature.
 */
export async function handlePeoplePost(
  res: ServerResponse,
  db: BusinessDb,
  session: SetupSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const raw = form.getAll('known');
  const draft = await loadDraft(db);
  const refuse = async (message: string) =>
    sendHtml(res, 400, renderStep(await stepView(db, session, 8, draft, { setupPeopleError: message })));
  if (!raw.every((v) => /^\d{1,3}$/.test(v))) return refuse(PEOPLE_BAD_INPUT);
  if (await editMustStartFromPrefill(draft, db)) return seeOther(res, '/setup/edit');
  try {
    await confirmSetupPeople(db, { knownIndices: [...new Set(raw.map(Number))], listHash: form.get('listHash') ?? '' });
  } catch (err) {
    if (err instanceof SetupPeopleInputError) return refuse(err.message);
    throw err;
  }
  seeOther(res, '/setup/step/8');
}

/**
 * `GET /setup/logo` — the stored logo, for step 1's read-only card.
 * `readLogo` re-hashes the file and refuses a mismatch; the type is the
 * sniffed one, never guessed, and `nosniff` keeps the browser to it.
 */
export async function handleSetupLogo(res: ServerResponse, db: BusinessDb, documentRoot: string): Promise<void> {
  const logo = await readLogo(db, documentRoot);
  if (logo === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('אין לוגו');
    return;
  }
  res.writeHead(200, {
    'Content-Type': logo.mediaType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(logo.bytes.length),
    ...SECURITY_HEADERS,
  });
  res.end(logo.bytes);
}

// --- summary and sign --------------------------------------------------------

export async function handleSummaryGet(res: ServerResponse, db: BusinessDb, session: SetupSession): Promise<void> {
  const businessId = db.businessId;
  const draft = await loadDraft(db);
  const parsed = InterviewAnswers.safeParse(draft?.answers);
  if (draft === null || !parsed.success) return seeOther(res, '/setup');
  if (parsed.data.extra.pending.length > 0) return seeOther(res, '/setup/step/10');
  const base = await previousForDraft(db, draft);
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
  const frozenAt = await freezeDraft(db, new Date());
  const unsigned = buildCharterFromInterview(parsed.data, { businessId, frozenAt, previous: base.previous });
  const summary = summarizeCharter(unsigned, { previous: base.previous, documentsWanted: parsed.data.reading.documents });
  sendHtml(
    res,
    200,
    renderSummary({
      draft: draft.answers,
      summary,
      shownHash: summaryHash(unsigned, parsed.data.setupPeople),
      setupPeople: parsed.data.setupPeople,
      unconfirmedSetupPeople: unconfirmedSetupPeople(await loadSetupPackage(db), parsed.data.setupPeople),
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
  db: BusinessDb,
  session: SetupSession,
  form: URLSearchParams,
  options: SetupOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return refuseCsrf(res);
  const outcome = await signAndInstallInterview(db, { username: session.username, shownHash: form.get('shownHash') ?? '', mailboxPreflight: (provider) => oauthCeremonyPreflight(db, provider, options.credentialKeyPath) });
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
export async function handleSetupEdit(res: ServerResponse, db: BusinessDb, session: SetupSession): Promise<void> {
  const prepared = await prepareEditDraft(db);
  if (prepared.kind === 'draft') return seeOther(res, '/setup/step/1');
  if (prepared.kind === 'none') return seeOther(res, '/setup');
  console.error('setup edit: the active charter does not parse:', prepared.reason);
  const draft = await loadDraft(db);
  const version = await activeCharterVersion(db);
  const current =
    draft !== null && draft.baseCharterVersion === version ? draft : await replaceDraft(db, {}, version);
  sendHtml(res, 200, renderStep(await stepView(db, session, 1, current, { notice: UNREADABLE_NOTICE })));
}

/**
 * The edit draft over the readable active charter: the open draft when it
 * started from that charter, otherwise one REPLACED by its prefill (a draft
 * started from anything else is stale — the rule `/setup/edit` has always
 * applied). `null` when there is no readable active charter — none, or one
 * that does not parse; the caller decides what that means.
 *
 * It calls `probeActiveCharter` and is therefore an install path in the sense
 * that function's docblock admits: it prepares the draft a signature installs.
 * Its callers are `/setup/edit` and the settings screen's description save.
 */
export async function ensureEditDraft(db: BusinessDb): Promise<InterviewDraft | null> {
  const prepared = await prepareEditDraft(db);
  return prepared.kind === 'draft' ? prepared.draft : null;
}

type PreparedEditDraft =
  | { kind: 'draft'; draft: InterviewDraft }
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: string };

async function prepareEditDraft(db: BusinessDb): Promise<PreparedEditDraft> {
  const probe = await probeActiveCharter(db);
  if (!probe.ok) return { kind: 'unreadable', reason: probe.reason };
  if (probe.active === null) return { kind: 'none' };
  const version = probe.active.charter.charterVersion;
  const draft = await loadDraft(db);
  if (draft !== null && draft.baseCharterVersion === version) return { kind: 'draft', draft };
  return { kind: 'draft', draft: await replaceDraft(db, prefillFromCharter(probe.active.charter), version) };
}
