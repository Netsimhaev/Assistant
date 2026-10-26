/**
 * How much the assistant has learned — the top of `/autonomy` (shadow mode,
 * spec §5.3, the layout the owner chose in `learning-layout-v2.html`): one
 * overall score, then one card per action class.
 *
 * **Every number here is read the way the promotion pass reads it, never a
 * second way.** The agreement rate is `agreementFor` measured from
 * `lastEventAt`, the demotion count is `demotionCount`, and the ramp level is
 * `loadRampLevel` — the CLAMPED level the gate sees, after the dial's bounds.
 * All three are the exports `orchestrator/promote.ts` itself uses. A screen
 * that measured from another moment, or read the raw ramp row, would say
 * "ready" while the pass does not promote (or "acting alone" while the dial
 * at `off` stops her), which is the one failure this screen must not have.
 *
 * Imports `escapeHtml` from `views.ts`, which in turn imports `renderLearning`
 * from here. The cycle is safe because only hoisted function declarations
 * cross it — nothing here reads a `const` from `views.ts` at module load.
 */
import { getPool, type Queryable } from '../db/pool.js';
import { ActionClass, NEVER_FULLY_AUTONOMOUS } from '../domain/action.js';
import type { AutonomyLevel } from '../domain/trust.js';
import { actionClassLabel } from '../domain/labels.js';
import { loadActiveCharter } from '../charter/store.js';
import {
  AGREEMENT_WINDOW_DAYS,
  MIN_SAMPLES,
  agreementFor,
  isLearned,
  type Agreement,
} from '../governance/agreement.js';
import type { WrongReason } from '../governance/agreement-verdict.js';
import { loadAutonomyMode, type AutonomyMode } from '../governance/autonomy-mode.js';
import { loadRampLevel } from '../orchestrator/ramp.js';
import {
  DEMOTIONS_BEFORE_STOP,
  demotionCount,
  lastEventAt,
  lastPromotionAt,
} from '../orchestrator/promote.js';
import { escapeHtml } from './views.js';

export type ClassStatus =
  | 'shadow'
  | 'acting_alone'
  | 'charter_requires_approval'
  | 'always_approval'
  | 'ready_but_dial_not_learn'
  | 'stopped_after_demotions';

export interface ClassCard {
  actionClass: ActionClass;
  agreement: Agreement;
  status: ClassStatus;
  /** When the class was promoted, for `acting_alone`; `null` otherwise or when no promote event exists. */
  since: Date | null;
}

export interface LearningSnapshot {
  overall: { right: number; counted: number } | null;
  cards: ClassCard[];
  /** The charter's own zone, for the "acting alone since" date. */
  timeZone: string;
}

/**
 * Which statuses count toward the overall score, named positively and
 * exhaustively: a status added to `ClassStatus` is a compile error here until
 * someone decides. The two excluded ones are classes that can never act
 * alone whatever the owner does on this screen — counting them would let a
 * class that is never measured drag the score toward zero, or one the
 * charter fixes lift it.
 */
const COUNTS_TOWARD_SCORE: Record<ClassStatus, boolean> = {
  shadow: true,
  acting_alone: true,
  ready_but_dial_not_learn: true,
  stopped_after_demotions: true,
  charter_requires_approval: false,
  always_approval: false,
};

/**
 * The charter bases under which a class may act alone at all. Positive:
 * anything else — `approve_required`, `draft_only`, `forbidden` — is the
 * charter requiring the owner, and a stricter base the enum grows later lands
 * on that side by default.
 */
const CHARTER_PERMITS_ALONE: ReadonlySet<AutonomyLevel> = new Set<AutonomyLevel>(['auto_notify', 'auto']);

/** The clamped ramp levels at which she runs without a card. */
const ACTING_ALONE_LEVELS: ReadonlySet<AutonomyLevel> = new Set<AutonomyLevel>(['auto_notify', 'auto']);

export interface StatusInputs {
  actionClass: ActionClass;
  charterBase: AutonomyLevel;
  /** `loadRampLevel`'s answer — after the dial's clamp, never the stored row. */
  clampedRamp: AutonomyLevel;
  demotions: number;
  agreement: Agreement;
  mode: AutonomyMode;
}

/** First match wins, in this order (task 6 decisions). */
export function classStatus(i: StatusInputs): ClassStatus {
  if (NEVER_FULLY_AUTONOMOUS.has(i.actionClass)) return 'always_approval';
  if (!CHARTER_PERMITS_ALONE.has(i.charterBase)) return 'charter_requires_approval';
  if (ACTING_ALONE_LEVELS.has(i.clampedRamp)) return 'acting_alone';
  if (i.demotions >= DEMOTIONS_BEFORE_STOP) return 'stopped_after_demotions';
  if (isLearned(i.agreement) && i.mode !== 'learn') return 'ready_but_dial_not_learn';
  return 'shadow';
}

/** Σright / Σcounted over the classes that count; `null` when nothing was counted. */
export function overallScore(cards: readonly ClassCard[]): { right: number; counted: number } | null {
  let right = 0;
  let counted = 0;
  for (const card of cards) {
    if (!COUNTS_TOWARD_SCORE[card.status]) continue;
    right += card.agreement.right;
    counted += card.agreement.counted;
  }
  return counted === 0 ? null : { right, counted };
}

/**
 * Eligible cards by verdicts counted, descending, then the ineligible ones.
 * Ties keep `ActionClass.options` order (`Array.prototype.sort` is stable),
 * so the page does not reshuffle between loads.
 */
export function orderCards(cards: readonly ClassCard[]): ClassCard[] {
  return [...cards].sort((a, b) => {
    const ea = COUNTS_TOWARD_SCORE[a.status];
    const eb = COUNTS_TOWARD_SCORE[b.status];
    if (ea !== eb) return ea ? -1 : 1;
    return b.agreement.counted - a.agreement.counted;
  });
}

/**
 * Reads everything the screen shows for one business.
 *
 * Throws when no charter is installed or the active one cannot be read — the
 * handler catches and says so, rather than showing every class as "the
 * charter requires approval", which would be a claim about a charter nobody
 * read.
 */
export async function learningSnapshot(o: { businessId: string; db?: Queryable }): Promise<LearningSnapshot> {
  const db = o.db ?? getPool();
  const businessId = o.businessId;
  const active = await loadActiveCharter(businessId, db);
  if (active === null) throw new Error('learningSnapshot: no active charter');
  const mode = await loadAutonomyMode({ businessId, db });

  const cards: ClassCard[] = [];
  for (const actionClass of ActionClass.options) {
    const agreement = await agreementFor(actionClass, {
      businessId,
      since: await lastEventAt(actionClass, businessId, db),
      db,
    });
    const status = classStatus({
      actionClass,
      charterBase: active.bundle.autonomyBase[actionClass],
      clampedRamp: await loadRampLevel(actionClass, { businessId, db }),
      demotions: await demotionCount(actionClass, businessId, db),
      agreement,
      mode,
    });
    const since = status === 'acting_alone' ? await lastPromotionAt(actionClass, businessId, db) : null;
    cards.push({ actionClass, agreement, status, since });
  }

  return { overall: overallScore(cards), cards: orderCards(cards), timeZone: active.charter.identity.timezone };
}

// --- Rendering -------------------------------------------------------------

const esc = (value: unknown): string => escapeHtml(value);

/**
 * The most common reason she was wrong, one phrase each (spec §5.3). A
 * `Record` over the union, so a reason added to `WrongReason` is a compile
 * error here until it has Hebrew.
 */
const WRONG_REASON_HE: Record<WrongReason, string> = {
  recipient: 'הנמען',
  number: 'סכום או מספר',
  date: 'תאריך או שעה',
  too_many_words: 'יותר משלוש מילים',
  denied: 'דחית את ההצעה',
};

const STATUS_HE: Record<ClassStatus, string> = {
  shadow: 'מצב צל',
  acting_alone: 'עובדת לבד',
  charter_requires_approval: 'התקנון שלך מחייב אישור · לא נכלל בציון',
  always_approval: 'תמיד באישורך · לא נכלל בציון',
  ready_but_dial_not_learn: "מוכנה, אבל רמת החופש לא על 'לומדת'",
  stopped_after_demotions: 'נעצרה אחרי שתי טעויות — מחכה להחלטתך',
};

const GOOD = '#3a7';
const MIXED = '#e93';
const EARLY = '#999';

function percent(right: number, counted: number): number {
  return Math.round((100 * right) / counted);
}

function formatDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(at);
}

function bar(widthPercent: number, color: string): string {
  const width = Math.max(0, Math.min(100, widthPercent));
  return `<div style="background:#8883;height:10px;border-radius:5px"><div style="background:${color};width:${esc(width)}%;height:10px;border-radius:5px"></div></div>`;
}

function statusLine(card: ClassCard, timeZone: string): string {
  if (card.status === 'acting_alone') {
    const since = card.since === null ? '' : ` מאז ${esc(formatDate(card.since, timeZone))}`;
    return `<div style="color:${GOOD}"><strong>${esc(STATUS_HE.acting_alone)}</strong>${since}</div>`;
  }
  if (card.status === 'shadow' && isLearned(card.agreement)) {
    return `<div style="color:${GOOD}">✓ ${esc(STATUS_HE.shadow)} · מוכנה לשלב הבא</div>`;
  }
  return `<div class="muted">${esc(STATUS_HE[card.status])}</div>`;
}

function renderCard(card: ClassCard, timeZone: string): string {
  const title = `<div><strong>${esc(actionClassLabel(card.actionClass))}</strong></div>`;
  if (!COUNTS_TOWARD_SCORE[card.status]) {
    return `<div class="card" style="background:#8881">${title}<div class="muted">${esc(STATUS_HE[card.status])}</div></div>`;
  }

  const { right, counted, topWrongReason } = card.agreement;
  let measure: string;
  if (card.status === 'acting_alone' && counted === 0) {
    // Promotion starts the measurement again, and a class acting alone raises
    // no cards — "early to tell" would read as doubt about a class that has
    // already earned its step.
    measure = '';
  } else if (counted < MIN_SAMPLES) {
    measure = `${bar((100 * counted) / MIN_SAMPLES, EARLY)}
      <div class="muted">עוד מוקדם לדעת (${esc(counted)} מתוך ${esc(MIN_SAMPLES)})</div>`;
  } else {
    const pct = percent(right, counted);
    measure = `${bar(pct, isLearned(card.agreement) ? GOOD : MIXED)}
      <div class="muted">${esc(pct)}% · ${esc(counted)} הכרעות</div>`;
  }
  const reason =
    topWrongReason === null
      ? ''
      : `<div style="color:${MIXED}">בדרך כלל, כשהיא טועה: ${esc(WRONG_REASON_HE[topWrongReason])}</div>`;

  return `<div class="card">${title}${measure}${statusLine(card, timeZone)}${reason}</div>`;
}

export function renderLearning(s: LearningSnapshot): string {
  const overall =
    s.overall === null
      ? `<div style="font-size:1.6em;font-weight:bold">עוד אין מספיק נתונים</div>`
      : `<div style="font-size:2.8em;font-weight:bold;color:${GOOD}">${esc(percent(s.overall.right, s.overall.counted))}%</div>
    <div><strong>היא מכירה את העסק שלך</strong></div>
    <div class="muted">מבוסס על ${esc(s.overall.counted)} הכרעות ב-${esc(AGREEMENT_WINDOW_DAYS)} הימים האחרונים</div>`;

  return `<section>
  <h2>רמת הלימוד של העוזרת</h2>
  <div style="text-align:center;padding:0.75rem 0;border-bottom:1px solid #8884;margin-bottom:1rem">
    ${overall}
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:0.75rem">
    ${s.cards.map((card) => renderCard(card, s.timeZone)).join('\n')}
  </div>
</section>`;
}
