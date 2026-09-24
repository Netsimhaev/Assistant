/**
 * Server-rendered HTML. No client framework, no build step — every screen is
 * a template literal returned as a complete document.
 *
 * `escapeHtml` is the one place any value coming from anywhere other than
 * this file's own literal strings is allowed to reach the page. Approval
 * payloads are attacker-influenced content — an email body, a supplier's
 * product name, a document a stranger sent — and this module is where that
 * text reaches a browser. Every interpolated value goes through it, without
 * exception; nothing here is "safe enough" to skip it, including values that
 * happen to come from a closed enum today, because a card is exactly the
 * kind of file where "this one's always safe" quietly stops being true.
 */
import type { ApprovalRequest } from '../governance/approvals.js';
import type { DocumentRecord } from '../documents/types.js';
import type { ErasureAnchor, ErasureItem, ErasurePlan } from '../governance/erasure-plan.js';
import type { ErasureOutcome } from '../governance/erasure.js';
import type { KeptItem } from '../governance/kept-items.js';
import type { IntentName } from '../domain/reading.js';
import type { MemoryRecord } from '../memory/store.js';
import { AutonomyMode } from '../governance/autonomy-mode.js';
import type { AutonomousAction } from './autonomous-actions.js';
import type { ReadingSummary } from './readings-list.js';
import { isDocumentDecisionIntent } from './signable-intents.js';
import { formatMinor } from '../util/money.js';

/** The one escaping helper. Stringifies first (so numbers, booleans, `null` are safe to pass too), then escapes. */
export function escapeHtml(value: unknown): string {
  const str =
    typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const esc = escapeHtml;

/**
 * Unicode's bidirectional formatting controls, removed from a value before it
 * is escaped and rendered.
 *
 * `escapeHtml` neutralises markup and nothing else, which is correct for
 * every other field on these pages. It is not enough for a document's
 * `original_name`: that string is stored verbatim from whoever sent the file
 * (by design — it is inert as a path), and it is the label the owner reads
 * when deciding whether to sign. On an RTL page a right-to-left override can
 * make `invoice‮gpj.exe` render as `invoiceexe.jpg`, so a name that
 * *looks* like the document the owner is expecting can be a different one.
 * Stripping the controls does not make the name trustworthy — nothing can —
 * which is why the sign form shows a prefix of the file's own hash beside it.
 *
 * `esc` itself is deliberately left alone: many call sites depend on it, and
 * a display field is the only place where dropping characters is the right
 * trade. The erasure screen's prefilled inputs count as display fields for
 * the same reason: they are filled from the query string — a link, not
 * necessarily something the owner typed — and they show the identifier the
 * owner is about to authorise a destruction against.
 *
 * The set: U+061C ALM, U+200E/U+200F LRM/RLM, U+202A-U+202E (the embedding
 * and override family), U+2066-U+2069 (the isolate family).
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

function escLabel(value: string): string {
  return esc(value.replace(BIDI_CONTROLS, ''));
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
  .card { border: 1px solid #8884; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  .error { color: #c0392b; font-weight: bold; }
  pre { white-space: pre-wrap; word-break: break-word; background: #8881; padding: 0.75rem; border-radius: 0.4rem; }
  label { display: block; margin-top: 0.75rem; }
  input[type="text"], input[type="password"], textarea { width: 100%; box-sizing: border-box; padding: 0.4rem; margin-top: 0.2rem; }
  button { margin-top: 1rem; padding: 0.5rem 1.2rem; cursor: pointer; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
  .row form { flex: 1 1 16rem; }
  .edit-form textarea[name="input"] { font-family: ui-monospace, monospace; font-size: 0.9em; }
  .band-routine { color: #2e7d32; }
  .band-sensitive { color: #ef6c00; }
  .band-anomalous, .band-blocked { color: #c0392b; }
  /* The one control on any screen here that cannot be undone. It sits beside
     three buttons that only ask for a preview, and it must not look like them. */
  button.danger { background: #c0392b; color: #fff; border: 1px solid #8e2a20; font-weight: bold; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function logoutForm(csrf: string): string {
  return `<form method="post" action="/logout" style="display:inline">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit">התנתקות</button>
</form>`;
}

export function renderLogin(options: { error?: string } = {}): string {
  const errorBlock = options.error ? `<p class="error">${esc(options.error)}</p>` : '';
  return page(
    'התחברות',
    `<h1>עוזרת אישית — כניסה</h1>
${errorBlock}
<div class="card">
<h2>סיסמה</h2>
<form method="post" action="/login">
  <label>שם משתמש<input type="text" name="username" autocomplete="username" required></label>
  <label>סיסמה<input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">כניסה</button>
</form>
</div>
<div class="card">
<h2>קוד שחזור</h2>
<p class="muted">איבדת את הסיסמה? קוד שחזור חד-פעמי נכנס כאן במקומה, ומחייב קביעת סיסמה חדשה מיד.</p>
<form method="post" action="/login">
  <label>שם משתמש<input type="text" name="username" autocomplete="username" required></label>
  <label>קוד שחזור<input type="text" name="code" autocomplete="off" required></label>
  <button type="submit">כניסה עם קוד</button>
</form>
</div>`,
  );
}

/**
 * `requireCurrent` is false on exactly one path: the forced change right
 * after a recovery-code login, where by definition the owner does not have a
 * current password to type. Everywhere else the field is mandatory — see
 * `verifyCurrentPassword` for why.
 */
export function renderPasswordChange(options: {
  csrf: string;
  requireCurrent: boolean;
  error?: string;
}): string {
  const errorBlock = options.error ? `<p class="error">${esc(options.error)}</p>` : '';
  const intro = options.requireCurrent
    ? '<p class="muted">להחלפת הסיסמה יש להזין את הסיסמה הנוכחית.</p>'
    : '<p class="muted">הכניסה בוצעה עם קוד שחזור. יש לקבוע סיסמה חדשה לפני שאפשר להמשיך.</p>';
  const currentField = options.requireCurrent
    ? '<label>סיסמה נוכחית<input type="password" name="current" autocomplete="current-password" required></label>'
    : '';
  return page(
    'קביעת סיסמה חדשה',
    `<h1>${options.requireCurrent ? 'החלפת סיסמה' : 'נדרשת סיסמה חדשה'}</h1>
${intro}
${errorBlock}
<form method="post" action="/password">
  <input type="hidden" name="csrf" value="${esc(options.csrf)}">
  ${currentField}
  <label>סיסמה חדשה<input type="password" name="password" autocomplete="new-password" required></label>
  <label>אימות סיסמה<input type="password" name="confirm" autocomplete="new-password" required></label>
  <button type="submit">קביעת סיסמה</button>
</form>`,
  );
}

function bandLabel(band: string): string {
  const labels: Record<string, string> = {
    routine: 'שגרתי',
    sensitive: 'רגיש',
    anomalous: 'חריג',
    blocked: 'חסום',
  };
  return labels[band] ?? band;
}

function summaryRow(approval: ApprovalRequest): string {
  const amount = formatMinor(approval.risk.dimensions.money.amountMinor, 'ILS');
  return `<div class="card">
  <div class="row" style="justify-content:space-between">
    <strong><a href="/a/${esc(approval.approvalId)}">${esc(approval.summary)}</a></strong>
    <span class="band-${esc(approval.risk.band)}">${esc(bandLabel(approval.risk.band))}</span>
  </div>
  <div class="muted">${esc(approval.actionClass)} · ${esc(amount)} · פג תוקף ${esc(approval.expiresAt)}</div>
</div>`;
}

export function renderPendingList(options: {
  approvals: ApprovalRequest[];
  remainingCodes: number;
  csrf: string;
}): string {
  const list =
    options.approvals.length === 0
      ? '<p class="muted">אין בקשות ממתינות.</p>'
      : options.approvals.map(summaryRow).join('\n');

  return page(
    'בקשות ממתינות',
    `<header>
  <h1>בקשות ממתינות</h1>
  ${logoutForm(options.csrf)}
</header>
<p class="muted">קודי שחזור שנותרו: ${esc(options.remainingCodes)}</p>
<p><a href="/instruct">מה לעשות</a> · <a href="/readings">מה קראתי</a> · <a href="/autonomy">כמה חופש לתת</a></p>
${list}`,
  );
}

const STANCE_LABEL: Record<string, string> = {
  act: 'מציעה לפעול',
  advise_against: 'ממליצה שלא',
  ask: 'יש לי שאלה',
  no_action: 'אין מה לעשות',
};

/**
 * What the assistant read, and what it concluded — every reading, whether or
 * not its proposal carries an action.
 *
 * Read-only. No form, no button that decides anything: deciding lives on the
 * approval card, which carries expiry, decision, signing and audit. A second
 * screen that decided would be a second path to the same table.
 *
 * `escLabel` on the filename for the same reason the approval card uses it:
 * `original_name` is stored verbatim from whoever sent the file, and bidi
 * control characters make a name render as something other than what it is.
 */
export function renderReadings(rows: ReadingSummary[], csrf: string): string {
  const items = rows
    .map((r) => {
      const stance = r.stance === null ? '' : (STANCE_LABEL[r.stance] ?? r.stance);
      const reasons = r.reasons.map((t) => `<li>${esc(t)}</li>`).join('');
      // M2: three cases, not two. A missing card because the stance proposed
      // nothing is an ordinary outcome; a missing card for a proposal that
      // DID propose something is a gap the owner should be told about
      // instead of being assured there was nothing to approve.
      const link =
        r.approvalId !== null
          ? `<a href="/a/${esc(r.approvalId)}">לכרטיס האישור</a>`
          : r.hasAction
            ? '<span class="muted">הוצעה פעולה, אך לא נוצר עבורה כרטיס אישור.</span>'
            : '<span class="muted">אין כרטיס — אין פעולה לאשר</span>';
      return `
        <article class="card">
          <h3>${escLabel(r.originalName)} <span class="hash">${esc(r.sha256.slice(0, HASH_PREFIX_LENGTH))}</span></h3>
          <p class="when">${esc(r.readAt)}</p>
          <p>${esc(r.summary)}</p>
          ${stance === '' ? '' : `<p class="stance"><strong>${esc(stance)}</strong>${r.headline === null ? '' : ` — ${esc(r.headline)}`}</p>`}
          ${reasons === '' ? '' : `<ul>${reasons}</ul>`}
          <p>${link}</p>
        </article>`;
    })
    .join('');

  return page(
    'מה קראתי',
    `<header>
  <h1>מה קראתי</h1>
  ${logoutForm(csrf)}
</header>
<p><a href="/">&rarr; חזרה לרשימה</a></p>
<p class="muted">כל מסמך שנקלט ונקרא, ומה שהוסק ממנו. המסך הזה מציג בלבד — הכרעה נעשית בכרטיס האישור.</p>
${rows.length === 0 ? '<p>עדיין לא נקרא אף מסמך.</p>' : items}`,
  );
}

const MEMORY_KIND_LABEL: Record<string, string> = {
  entity: 'ישות',
  preference: 'העדפה',
  chunk: 'קטע',
};

/** Hebrew label for a memory's provenance — the trust level of the job that wrote it. */
const PROVENANCE_LABEL: Record<string, string> = {
  boss: 'הבעלים',
  staff: 'צוות',
  known_counterparty: 'צד ידוע',
  unknown_external: 'גורם חיצוני לא מזוהה',
  open_web: 'אינטרנט פתוח',
};

/** What one memory's value column shows — the preference's key beside its value, or the raw body otherwise. */
/**
 * `escLabel`, not `esc` — this screen exists so the owner can audit what the
 * assistant believes, and much of what it shows here is text a stranger
 * wrote: a `chunk`'s body is exactly where an external claim lands verbatim
 * (`memory/store.ts`'s own reason for stamping every row with `provenance`).
 * A bidirectional override inside that text would make a line render as
 * something other than what is actually stored, on the one screen whose
 * whole job is to show that faithfully. `esc` neutralises markup; it leaves
 * the override family untouched (see `escLabel`'s docblock).
 */
function memoryValue(memory: MemoryRecord): string {
  if (memory.attribute !== null) {
    return `${escLabel(memory.attribute)}: ${escLabel(JSON.stringify(memory.body))}`;
  }
  return escLabel(JSON.stringify(memory.body));
}

/**
 * What the assistant has recorded on its own initiative (`memory/store.ts`),
 * one row per memory, sorted by subject.
 *
 * **Read-only, deliberately.** No form, no delete button: the erasure screen
 * already deletes, with a counted preview and a confirmation step, and a
 * second, casual path next to a plain list would be the dangerous kind of
 * convenience.
 *
 * **`escLabel`, not `esc`, on `subjectKey` and `sourceRef`.** Both are text
 * somebody else chose — a memory's subject can be an address that arrived
 * inside a document a stranger wrote, and `esc` alone leaves a
 * bidirectional-override character intact (see `escLabel`'s docblock).
 *
 * **A row whose `provenance` is not `boss` reads as a loaded claim, never as
 * a fact.** That is the whole reason `memory/store.ts` stamps every row with
 * the trust level of the job that wrote it and never strips it on recall: a
 * supplier's document that says "our new bank account is X" is a claim that
 * supplier made, and showing it here the same way a preference the owner
 * typed is shown would be exactly the laundering that module's docblock warns
 * about.
 */
export function renderMemory(memories: MemoryRecord[], csrf: string): string {
  const sorted = [...memories].sort((a, b) => a.subjectKey.localeCompare(b.subjectKey));
  const rows = sorted
    .map((m) => {
      const kind = MEMORY_KIND_LABEL[m.kind] ?? m.kind;
      const source = m.sourceRef === null ? '—' : escLabel(m.sourceRef);
      const label =
        m.provenance === 'boss'
          ? esc(PROVENANCE_LABEL['boss'] ?? 'boss')
          : `<strong>נטען</strong> — ${esc(PROVENANCE_LABEL[m.provenance] ?? m.provenance)}`;
      return `<tr>
        <td>${escLabel(m.subjectKey)}</td>
        <td>${esc(kind)}</td>
        <td>${memoryValue(m)}</td>
        <td>${source}</td>
        <td>${label}</td>
      </tr>`;
    })
    .join('');

  return page(
    'מה נזכר',
    `<header>
  <h1>מה נזכר</h1>
  ${logoutForm(csrf)}
</header>
<p><a href="/">&rarr; חזרה לרשימה</a></p>
<p class="muted">מה שהעוזרת רשמה מיוזמתה. המסך הזה מציג בלבד — אין כאן מחיקה; מחיקה נעשית במסך המחיקה.</p>
${
  memories.length === 0
    ? '<p>עדיין לא נרשם דבר.</p>'
    : `<table><tr><th>נושא</th><th>סוג</th><th>ערך</th><th>מקור</th><th>סטטוס</th></tr>${rows}</table>`
}
<p><a href="/autonomy">כמה חופש לתת</a> · <a href="/autonomy/actions">מה נעשה בלעדיך</a></p>`,
  );
}

// --- The owner's dial, and what she did on her own (spec §8.4, §8.5). ------
//
// Two screens, and the reason they exist together. The dial (`renderAutonomy`)
// sets how much freedom a class of action may earn; the list
// (`renderAutonomousActions`) is what makes that freedom accountable — the
// owner does not get a notification for every autonomous step (his own
// choice, `docs/05-approvals.md`), so this screen is the only place he can
// ever see what ran without him and say "that one was wrong."

/**
 * One plain-Hebrew sentence per position of the dial, said as what that
 * position DOES rather than left for the owner to infer from a single word.
 * `rampBoundsForMode` (`governance/autonomy-mode.ts`) is the mechanism these
 * describe; the sentences exist so a screen with three unexplained words does
 * not become a screen that gets clicked wrongly.
 */
const AUTONOMY_MODE_LABEL: Record<AutonomyMode, string> = {
  off: 'כבוי — כל פעולה יוצאת נשמרת כטיוטה בלבד; שום דבר לא נשלח מבלי שתאשר.',
  ask: 'שאלי תמיד — כל פעולה יוצאת מגיעה אליך לאישור, גם כזו שכבר אושרה כמה פעמים בעבר.',
  learn: 'למידה — פעולה שהוכיחה את עצמה שוב ושוב יכולה לעבור לביצוע עצמאי; טעות אחת מורידה אותה בחזרה מיד.',
};

const AUTONOMY_MODE_NAME: Record<AutonomyMode, string> = {
  off: 'כבוי',
  ask: 'שאלי תמיד',
  learn: 'למידה',
};

/**
 * The owner's dial. A form with the three positions `AutonomyMode` allows,
 * each with its own sentence, and the current one both checked AND named in
 * plain text — a radio button alone is easy to glance past.
 */
export function renderAutonomy(mode: AutonomyMode, csrf: string, error?: string): string {
  const errorBlock = error === undefined ? '' : `<p class="error">${esc(error)}</p>`;

  const options = AutonomyMode.options
    .map((option) => {
      const checked = option === mode ? ' checked' : '';
      return `<label>
        <input type="radio" name="mode" value="${esc(option)}"${checked}>
        ${esc(AUTONOMY_MODE_LABEL[option])}
      </label>`;
    })
    .join('\n');

  return page(
    'כמה חופש לתת',
    `<header>
  <h1>כמה חופש לתת</h1>
  ${logoutForm(csrf)}
</header>
<p><a href="/">&rarr; חזרה לרשימה</a></p>
${errorBlock}
<p class="muted">המצב הנוכחי: <strong>${esc(AUTONOMY_MODE_NAME[mode])}</strong>.</p>
<form method="post" action="/autonomy/mode">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  ${options}
  <button type="submit">שמירה</button>
</form>
<p><a href="/autonomy/actions">מה נעשה בלעדיך</a></p>`,
  );
}

/**
 * What the assistant did entirely on its own — `listAutonomousActions`'s own
 * docblock explains why a step that went through a card never reaches here.
 *
 * **Every value that came from a message reaches this table through
 * `escLabel`, never `esc`.** `jobTitle`, `recipient` and `subject` can each
 * originate in content a stranger wrote (a document a stranger sent, an
 * address a supplier's own reply carried) reaching the assistant's own
 * outbound step, and `esc` alone leaves a bidirectional-override character
 * intact — see `escLabel`'s docblock for the exact incident that taught this
 * codebase to check content fields against it. `actionClass` and `toolName`
 * are read through `esc` instead: both are values drawn from the closed
 * `ActionClass`/tool-name vocabulary the gate itself classified the step
 * under, not text anyone outside the system chose.
 *
 * **The button does not undo anything.** The action already left the
 * building — a mail already sent, a memory already written — and marking it
 * only records that it was wrong; the sentence saying so sits once at the
 * top of the page rather than being skipped because the button's own label
 * ("זו הייתה טעות") might be read as an undo control.
 */
export function renderAutonomousActions(actions: readonly AutonomousAction[], csrf: string, error?: string): string {
  const errorBlock = error === undefined ? '' : `<p class="error">${esc(error)}</p>`;

  const rows = actions
    .map((action) => {
      const title = action.jobTitle === null ? '—' : escLabel(action.jobTitle);
      const recipient = action.recipient === null ? '—' : escLabel(action.recipient);
      const subject = action.subject === null ? '—' : escLabel(action.subject);
      const markPath = `/autonomy/actions/${esc(action.jobId)}/${esc(action.stepId)}/mark`;

      return `<tr>
        <td>${esc(action.completedAt.toISOString())}</td>
        <td>${title}</td>
        <td>${esc(action.actionClass)}</td>
        <td>${esc(action.toolName)}</td>
        <td>${recipient}</td>
        <td>${subject}</td>
        <td>
          <form method="post" action="${markPath}">
            <input type="hidden" name="csrf" value="${esc(csrf)}">
            <textarea name="note" rows="2" required placeholder="מה היה לא בסדר?"></textarea>
            <button type="submit">זו הייתה טעות</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  return page(
    'מה נעשה בלעדיך',
    `<header>
  <h1>מה נעשה בלעדיך</h1>
  ${logoutForm(csrf)}
</header>
<p><a href="/">&rarr; חזרה לרשימה</a> · <a href="/autonomy">כמה חופש לתת</a></p>
${errorBlock}
<p class="muted">
  כל פעולה שהעוזרת ביצעה מיוזמתה, בלי כרטיס אישור. סימון "זו הייתה טעות"
  אינו מבטל ואינו מתקן את הפעולה עצמה — היא כבר יצאה — הוא רק רושם
  שהיא הייתה שגויה, וזה עשוי להוריד את רמת החופש של סוג הפעולה הזה.
</p>
${
  actions.length === 0
    ? '<p>עדיין לא בוצעה אף פעולה מיוזמת העוזרת.</p>'
    : `<table><tr><th>מתי</th><th>משימה</th><th>סוג פעולה</th><th>כלי</th><th>נמען</th><th>נושא</th><th></th></tr>${rows}</table>`
}`,
  );
}

/**
 * `editValue` is the raw text to put back in the textarea — used only when a
 * submitted edit failed to parse, so the owner sees exactly what they typed
 * (not the reformatted original) alongside the error. Absent, it defaults to
 * the stored payload pretty-printed. Either way it goes through `esc()`
 * before it reaches a `<textarea>`: element content has different escaping
 * needs than an attribute value, but the one escaper here handles both —
 * what matters is that nothing skips it.
 *
 * `noteValue` mirrors the same reasoning: a 400 that resets the note the
 * owner already typed, right next to the payload it took such care to
 * preserve, is losing their work by half.
 */
/**
 * How much of `documents.sha256` the card shows. Twelve hex characters is
 * 48 bits — far past what anyone will collide by accident among one
 * business's documents, and short enough that the owner can actually compare
 * it against a hash they were sent.
 */
const HASH_PREFIX_LENGTH = 12;

/**
 * The document behind this card, shown for what it is.
 *
 * Rendered whenever a document resolves, whether or not the card may be
 * signed. A card raised about a document should say which document — and
 * before this the only place that information appeared was inside the sign
 * form, so removing the form on a non-signable card would have taken the
 * document off the page along with it.
 *
 * `originalName` is a sender-chosen string, and the one field on these pages
 * that goes through `escLabel` rather than `esc`: it is the label the owner
 * reads, and `esc` alone leaves bidi overrides intact (see `escLabel`).
 * Beside it goes a prefix of `documents.sha256` — the re-hash at signing time
 * proves the bytes did not change, but without this nothing on the card is
 * derived from those bytes at all, so the owner is told "unchanged" about a
 * document identified only by a name its sender chose.
 */
function documentBlock(document: DocumentRecord): string {
  return `<div class="card">
  <h3>המסמך שהבקשה נוגעת אליו</h3>
  <p>${escLabel(document.originalName)}</p>
  <p class="muted">טביעת האצבע של הקובץ (12 התווים הראשונים): <code>${esc(document.sha256.slice(0, HASH_PREFIX_LENGTH))}</code></p>
</div>`;
}

/**
 * A third form, posting to `/a/:id/sign`.
 *
 * Rendered only when a document resolves **and** the proposal's intent is one
 * of `DOCUMENT_DECISION_INTENTS` — an allowlist, defaulting to no form. See
 * `signable-intents.ts` for why each member is on it and why the other nine
 * are not; the short version is that this form's own text asserts the document
 * was accepted as binding, and the row it writes cannot be undone, so it may
 * not ride along on a card whose real subject is an email.
 *
 * `documentId` travels as a hidden field so the route can refuse a sign
 * whose form named a different document than the one it is about to verify
 * and stamp — the card resolves the document once when it renders, and the
 * POST resolves it again; without this, the two resolutions could disagree.
 *
 * `noteValue` mirrors the approve form's own reasoning: a refusal that
 * resets what the owner typed is losing their work by half.
 *
 * `signError` is deliberately NOT a parameter here. Three of the route's sign
 * refusals — the approval is already decided, no document is behind it at
 * all, or the proposal is not a document decision — have no form to render a
 * message inside, so an error block living in here would silently vanish
 * exactly on those (a regression caught in round-2 review: the "no document"
 * case used to render, misplaced, in the approve form — after this file's
 * first pass it rendered nowhere at all). `renderApprovalCard` renders
 * `signError` itself, unconditionally, before deciding whether `signForm`
 * exists.
 */
function signForm(
  approvalId: string,
  csrf: string,
  document: DocumentRecord,
  noteValue: string,
): string {
  return `<form method="post" action="/a/${esc(approvalId)}/sign">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="documentId" value="${esc(document.documentId)}">
    <p class="muted">חתימה מאשרת את הבקשה וקובעת שהמסמך "${escLabel(document.originalName)}" נתקבל כמחייב.</p>
    <label>הערה (רשות)<textarea name="note" rows="2">${esc(noteValue)}</textarea></label>
    <button type="submit">חתום ואשר</button>
  </form>`;
}

export function renderApprovalCard(options: {
  approval: ApprovalRequest;
  csrf: string;
  document?: DocumentRecord;
  /**
   * The intent of the proposal action behind `document`, when one resolved.
   *
   * Only a member of `DOCUMENT_DECISION_INTENTS` gets the sign form. Absent,
   * `null`, or a value the enum does not know all mean no form — which is the
   * whole point of writing this as an allowlist: the safe answer is the
   * default, not a case somebody has to remember to handle.
   */
  documentIntent?: IntentName | null;
  editValue?: string;
  noteValue?: string;
  error?: string;
  /**
   * A refusal that belongs to the sign action, not the approve form (see
   * `signForm`'s docblock). Rendered at card level, unconditionally — NOT
   * inside `signForm`, because two of the route's sign refusals (already
   * decided; no document at all) have no document to render that form with,
   * and this text must still reach the owner when they don't.
   */
  signError?: string;
}): string {
  const { approval } = options;
  const editValue = options.editValue ?? JSON.stringify(approval.proposedInput, null, 2);
  const noteValue = options.noteValue ?? '';
  const errorBlock = options.error ? `<p class="error">${esc(options.error)}</p>` : '';
  const signErrorBlock = options.signError ? `<p class="error">${esc(options.signError)}</p>` : '';
  const risk = approval.risk;

  return page(
    approval.summary,
    `<header>
  <h1>בקשה לאישור</h1>
  ${logoutForm(options.csrf)}
</header>
<p><a href="/">&rarr; חזרה לרשימה</a></p>
<div class="card">
  <h2>${esc(approval.summary)}</h2>
  <p>${esc(approval.detail)}</p>
  <table>
    <tr><td class="muted">כלי</td><td>${esc(approval.proposedTool)}</td></tr>
    <tr><td class="muted">סוג פעולה</td><td>${esc(approval.actionClass)}</td></tr>
    <tr><td class="muted">סיכון</td><td class="band-${esc(risk.band)}">${esc(bandLabel(risk.band))} (${esc(risk.total)}) — ${esc(risk.explanation)}</td></tr>
    <tr><td class="muted">סכום</td><td>${esc(formatMinor(risk.dimensions.money.amountMinor, 'ILS'))}</td></tr>
    <tr><td class="muted">נוצר</td><td>${esc(approval.createdAt)}</td></tr>
    <tr><td class="muted">פג תוקף</td><td>${esc(approval.expiresAt)}</td></tr>
  </table>
</div>
${options.document ? documentBlock(options.document) : ''}
${signErrorBlock}
<div class="row">
  <form method="post" action="/a/${esc(approval.approvalId)}/approve" class="edit-form">
    <input type="hidden" name="csrf" value="${esc(options.csrf)}">
    <label>תוכן מוצע (ניתן לעריכה לפני אישור)
      <textarea name="input" rows="12" spellcheck="false">${esc(editValue)}</textarea>
    </label>
    <p class="muted">עריכת התוכן לפני האישור מריצה את הגרסה הערוכה. השארה כפי שהיא מאשרת את מה שתוכנן. שים לב: חלק מהערכים (כגון פרטי התחברות) מוסתרים לפני שהפעולה יוצאת החוצה, גם אם הם מוצגים כאן במלואם — עריכה שלהם לא תשפיע על מה שבפועל יישלח.</p>
    ${errorBlock}
    <label>הערה (רשות)<textarea name="note" rows="2">${esc(noteValue)}</textarea></label>
    <button type="submit">אישור</button>
  </form>
  <form method="post" action="/a/${esc(approval.approvalId)}/deny">
    <input type="hidden" name="csrf" value="${esc(options.csrf)}">
    <label>הערה (רשות)<textarea name="note" rows="2"></textarea></label>
    <button type="submit">דחייה</button>
  </form>
  ${options.document && isDocumentDecisionIntent(options.documentIntent ?? null) ? signForm(approval.approvalId, options.csrf, options.document, noteValue) : ''}
</div>`,
  );
}

/**
 * The instruction box.
 *
 * One field and one button. The note under it is not decoration: an
 * instruction is its own approval, and the owner should know that before they
 * type, not discover it afterwards.
 *
 * `grantNote` is `runInstruction`'s explanation for exactly one situation: a
 * plan spanning more than one action class, which authorises nothing at all
 * (see `grantForPlan` in `instruct.ts`). Without showing it, the owner is
 * bounced to the pending list and later meets an approval card for something
 * they believed the instruction already covered, with no sentence anywhere
 * saying why the shortcut did not apply — so it renders beside the error, not
 * folded into it, since the two can never occur together (a `grantNote` only
 * ever accompanies a `planned` outcome, an `error` only ever a `refused` one).
 *
 * `identityNote` is the second of the two notes and answers a different
 * question: a name in the instruction still fitted more than one contact
 * after the owner had already been asked once, so the instruction went ahead
 * with none of that person's memory (spec §7.2). Both can be true of one
 * instruction, so both render.
 *
 * The clarifying question goes through `escLabel`, not `esc`: it is
 * model-composed text reaching an RTL page, the same category `escLabel` was
 * written for (see its own docblock). Every instruction is owner-typed today,
 * so the exposure is low, but it is the second model-authored string to reach
 * a screen and the cheap decision is to treat it that way from the start.
 */
/**
 * One instruction still waiting on the owner's answer.
 *
 * `question` is nullable because migration 023 is what gave it a home: a job
 * parked before that migration has no stored question and cannot be given
 * one. Such a row is still listed — the owner can answer it, and an answer
 * box with no question is far better than an orphaned job nothing shows.
 */
export interface PendingQuestion {
  jobId: string;
  question: string | null;
  /** The owner's own words, so a question with no stored text still has context. */
  text: string;
}

/** Shown in place of a question that predates migration 023. */
const QUESTION_UNAVAILABLE = 'נשאלה שאלה שלא נשמרה. אפשר לענות כאן בכל זאת.';

function pendingCard(item: PendingQuestion, csrf: string): string {
  return `<article class="card">
           <h3>שאלה לפני שאמשיך</h3>
           <p class="muted">${escLabel(item.text)}</p>
           <p>${item.question === null ? esc(QUESTION_UNAVAILABLE) : escLabel(item.question)}</p>
           <form method="POST" action="/instruct/${esc(item.jobId)}/answer">
             <input type="hidden" name="csrf" value="${esc(csrf)}">
             <textarea name="answer" rows="2" required></textarea>
             <button>לענות ולהמשיך</button>
           </form>
         </article>`;
}

export function renderInstruct(options: {
  csrf: string;
  error?: string;
  pending?: PendingQuestion[] | null;
  grantNote?: string | null;
  identityNote?: string | null;
}): string {
  const error =
    options.error === undefined ? '' : `<p class="error">${esc(options.error)}</p>`;

  const grantNote =
    options.grantNote == null ? '' : `<p class="muted">${esc(options.grantNote)}</p>`;

  // Through `escLabel`, not `esc`: this note quotes the owner's own words
  // back at them — the name token exactly as it was typed — and a quoted
  // fragment reaching an RTL page is the category `escLabel` was written
  // for. It renders beside `grantNote` rather than replacing it, because the
  // two answer different questions and one instruction can raise both.
  const identityNote =
    options.identityNote == null ? '' : `<p class="muted">${escLabel(options.identityNote)}</p>`;

  const pending =
    options.pending == null
      ? ''
      : options.pending.map((item) => pendingCard(item, options.csrf)).join('\n');

  return page(
    'מה לעשות',
    `<h1>מה לעשות</h1>
     ${error}
     ${grantNote}
     ${identityNote}
     ${pending}
     <form method="POST" action="/instruct">
       <input type="hidden" name="csrf" value="${esc(options.csrf)}">
       <textarea name="text" rows="4" maxlength="4000" required
                 placeholder="למשל: תשלחי לדנה dana@example.com את ההצעה"></textarea>
       <button>שלח</button>
     </form>
     <p class="muted">
       מה שתכתוב כאן נרשם כהוראה שלך, ואני נשענת עליה במקום לשאול שוב על אותו דבר.
       בשלב הנוכחי זה עדיין לא משנה בפועל מה קורה: פעולה שיוצאת החוצה לא מתבצעת
       היום בכלל — היא נעצרת עוד לפני שלב האישור, כי כל סוג פעולה יוצאת נמצא
       בתחתית סולם האוטונומיה. זה ישתנה רק כששני התנאים יתקיימו יחד: הסולם יעלה
       מעל "טעון אישור" עבור אותו סוג פעולה, והתקנון החתום שלך ייתן לו תקרה
       גבוהה יותר.
       פעולה שנוגעת בכסף, חתימה על חוזה, או נמען שלא נקבת בכתובתו — תיעצר תמיד.
     </p>
     <p><a href="/">לכרטיסי האישור</a> · <a href="/readings">מה קראתי</a> · <a href="/memory">מה נזכר</a> · <a href="/autonomy">כמה חופש לתת</a> · <a href="/erase">מה לשכוח</a></p>
     ${logoutForm(options.csrf)}`,
  );
}

export function renderNotFound(): string {
  return page('לא נמצא', '<h1>404</h1><p>הדף המבוקש אינו קיים.</p>');
}

export function renderForbidden(): string {
  return page('אסור', '<h1>403</h1><p>הבקשה נדחתה.</p>');
}

export function renderServerError(): string {
  return page('שגיאה', '<h1>500</h1><p>אירעה שגיאה. נסה שוב.</p>');
}

// --- The erasure screen (spec §6, §7). ------------------------------------
//
// The one place in the system where a human authorises an irreversible
// destruction. Two rules shape every line below.
//
// **The preview is the truth.** `executeErasure` deletes exactly what its
// plan lists, so this page must name every table that will be touched and
// how many rows, before the confirm control is offered at all. A screen that
// summarised ("a few things about Ronit") would make the owner approve a
// number they never saw.
//
// **Nothing is skipped silently.** A kept item is rendered as kept, with the
// date it was kept and a one-click revoke, and a refusal replaces the confirm
// control rather than sitting beside it. An erasure that quietly passed over
// something would be exactly the silence this codebase keeps stamping out.

/** Hebrew names for the tables, so the owner reads what they are losing. */
const TABLE_LABELS: Record<string, string> = {
  memories: 'זיכרונות',
  documents: 'מסמכים',
  document_artifacts: 'טקסט שחולץ ממסמכים',
  document_readings: 'סיכומים',
  proposals: 'הצעות',
  approval_requests: 'כרטיסי אישור',
  boss_instructions: 'לשון הוראות',
  job_plans: 'תוכניות',
  job_authorizations: 'הרשאות',
  jobs: 'כותרות משימה',
  job_steps: 'שורות מעבר',
  job_step_results: 'מזהי הודעה מהספק',
};

/**
 * What will happen to a row, per `ErasureItem.action` — future tense for the
 * preview, past tense for the done screen. A third `'fail'` disposition
 * (fix round 2, item 1): a job parked on a delegation whose own
 * `agent_envelopes` row is about to be deleted, moved to a terminal `failed`
 * phase as part of the erasure rather than left pointing at nothing. Keyed by
 * `ErasureItem['action']` so a fourth action added later fails to compile
 * here instead of silently falling through a two-branch ternary — the exact
 * shape that would have shown "ינוקה מתוכן" (cleaned) for a job the erasure
 * actually failed.
 */
const DISPOSITION_LABEL_FUTURE: Record<ErasureItem['action'], string> = {
  delete: 'יימחק',
  scrub: 'ינוקה מתוכן',
  fail: 'משימה תלויה תיכשל, כי הפנייה שהיא ממתינה לה נמחקת',
};

const DISPOSITION_LABEL_PAST: Record<ErasureItem['action'], string> = {
  delete: 'נמחק',
  scrub: 'נוקה מתוכן',
  fail: 'המשימה נכשלה, כי הפנייה שהמתינה לה נמחקה',
};

/**
 * The "מה" column's label — keyed by table normally, but `TABLE_LABELS.jobs`
 * ("כותרות משימה") was chosen for the TITLE scrub and is the wrong name for a
 * `'fail'` row, which is not about titles at all (fix round 3, item 5). Given
 * its own label rather than folded into `TABLE_LABELS`, which stays keyed by
 * table alone for every disposition that really is about that table's
 * content.
 */
function rowLabel(item: ErasureItem): string {
  if (item.action === 'fail') return 'משימות שנעצרו בעקבות המחיקה';
  return TABLE_LABELS[item.table] ?? item.table;
}

/** Hebrew names for what a kept item or a plan entry actually is. */
const ITEM_KIND_LABELS: Record<string, string> = {
  document: 'מסמך',
  memory: 'זיכרון',
  job: 'משימה',
};

/**
 * What the owner typed but has not previewed yet — the entry form's starting
 * values. A forget command carries an address or a date into this screen
 * (spec §4.1); nothing else on the page depends on it.
 */
export interface ErasurePrefill {
  identifier?: string;
  fromIso?: string;
  toIso?: string;
  documentId?: string;
}

export interface ErasureViewModel {
  csrf: string;
  anchorLabel: string;
  /** `null` before an anchor has been chosen: the entry form, and nothing else. */
  plan: ErasurePlan | null;
  /**
   * A fingerprint of the plan shown below, carried into the confirm form.
   *
   * Spec §4.4 makes the plan — not the anchor — the unit of authorisation:
   * the executor removes exactly what the plan lists, and that is what makes
   * the preview the truth rather than a decoration. The confirm route
   * rebuilds the plan server-side and compares fingerprints, so a world that
   * moved between the preview and the click is re-shown rather than
   * destroyed. Computed by the caller, because deciding what counts as "the
   * same plan" is logic, not presentation.
   *
   * Absent means no confirm is authorised: the form still renders with an
   * empty hash and the route refuses it, which is the fail-closed direction.
   */
  planHash?: string;
  error?: string;
  prefill?: ErasurePrefill;
  /**
   * Everything the owner has ever said to keep — for the screen that has no
   * plan and therefore no `plan.excluded` to render.
   *
   * Spec §6 says every erasure screen shows what is kept. `plan.excluded`
   * only holds the kept items THIS anchor happened to reach, so on the entry
   * screen it says nothing at all, and a keep set last month stayed invisible
   * until the owner happened to build a preview that reached it. Supplied by
   * the route from `listKept`, which until now was computed nowhere and read
   * by nothing outside its own test.
   */
  kept?: readonly KeptItem[];
}

/**
 * The anchor, carried through every form on the page as one JSON field.
 *
 * It is deliberately the *anchor* that travels and never the plan: the
 * confirm route rebuilds the plan from this, so a browser that edited the
 * field can only ask for a different preview — never for a deletion of rows
 * the resolver never selected.
 */
function anchorField(anchor: ErasureAnchor): string {
  return `<input type="hidden" name="anchor" value="${esc(JSON.stringify(anchor))}">`;
}

/** One "keep this out of the erasure" button for a single item in the plan. */
function keepControl(
  model: ErasureViewModel,
  anchor: ErasureAnchor,
  kind: string,
  itemId: string,
): string {
  return `<li>${esc(ITEM_KIND_LABELS[kind] ?? kind)} ${escLabel(itemId)}
           <form method="post" action="/erase/keep" style="display:inline">
             <input type="hidden" name="csrf" value="${esc(model.csrf)}">
             ${anchorField(anchor)}
             <input type="hidden" name="kind" value="${esc(kind)}">
             <input type="hidden" name="itemId" value="${esc(itemId)}">
             <input type="text" name="note" size="20" placeholder="למה לשמור? (לא חובה)">
             <button type="submit">שמור את זה</button>
           </form></li>`;
}

/** At most this many ids per kind get their own control; the rest are counted. */
const MAX_LISTED_ITEMS = 25;

function keepSection(
  model: ErasureViewModel,
  anchor: ErasureAnchor,
  kind: string,
  ids: readonly string[],
): string {
  if (ids.length === 0) return '';
  const shown = ids.slice(0, MAX_LISTED_ITEMS);
  const rest =
    ids.length > shown.length
      ? `<li class="muted">ועוד ${ids.length - shown.length} פריטים מאותו סוג.</li>`
      : '';
  return `<ul>${shown.map((id) => keepControl(model, anchor, kind, id)).join('')}${rest}</ul>`;
}

/**
 * The entry form — three shapes, three forms, one per anchor kind (spec §4.2).
 *
 * Rendered on the preview page too, so changing the anchor never means going
 * back to an empty screen. Its submit buttons say "show me", never "delete":
 * the only control on this page that destroys anything is the one below the
 * counts the owner has actually read.
 */
function erasureEntry(model: ErasureViewModel): string {
  const prefill = model.prefill ?? {};
  const token = `<input type="hidden" name="csrf" value="${esc(model.csrf)}">`;
  return `<div class="card">
    <h2>מה לשכוח</h2>
    <form method="post" action="/erase/preview">
      ${token}
      <input type="hidden" name="kind" value="contact">
      <label>כתובת מייל או מספר טלפון
        <input type="text" name="identifier" value="${escLabel(prefill.identifier ?? '')}" required></label>
      <button type="submit">הצג מה יימחק</button>
    </form>
    <form method="post" action="/erase/preview">
      ${token}
      <input type="hidden" name="kind" value="window">
      <label>משימות שרצו מ־
        <input type="text" name="fromIso" value="${escLabel(prefill.fromIso ?? '')}" placeholder="2026-09-03T00:00" required></label>
      <label>ועד
        <input type="text" name="toIso" value="${escLabel(prefill.toIso ?? '')}" placeholder="2026-09-03T23:59" required></label>
      <button type="submit">הצג מה יימחק</button>
    </form>
    <form method="post" action="/erase/preview">
      ${token}
      <input type="hidden" name="kind" value="document">
      <label>מזהה מסמך
        <input type="text" name="documentId" value="${escLabel(prefill.documentId ?? '')}" required></label>
      <button type="submit">הצג מה יימחק</button>
    </form>
  </div>`;
}

/** One kept item, however the screen came by it. */
interface KeptRowView {
  itemKind: string;
  itemId: string;
  /** `YYYY-MM-DD`; the screen never shows a time. */
  keptOn: string;
  note: string | null;
}

/**
 * The kept list, with its revoke control, for both erasure screens.
 *
 * `anchor` is `null` on the entry screen, and the revoke form then simply
 * carries no anchor field — `handleEraseKeep` already treats a missing anchor
 * as "revoke and show the entry screen again", so the control works in both
 * places without a second route. Written once so the two screens cannot drift
 * on what "kept" looks like or on whether it can be undone.
 */
function keptList(
  model: ErasureViewModel,
  anchor: ErasureAnchor | null,
  rows: readonly KeptRowView[],
): string {
  return rows
    .map(
      (k) =>
        `<li>${esc(ITEM_KIND_LABELS[k.itemKind] ?? k.itemKind)} ${escLabel(k.itemId)} — נשמר ב-${esc(k.keptOn)}` +
        (k.note === null ? '' : ` (${escLabel(k.note)})`) +
        ` <form method="post" action="/erase/keep" style="display:inline">` +
        `<input type="hidden" name="csrf" value="${esc(model.csrf)}">` +
        (anchor === null ? '' : anchorField(anchor)) +
        `<input type="hidden" name="revoke" value="1">` +
        `<input type="hidden" name="kind" value="${esc(k.itemKind)}">` +
        `<input type="hidden" name="itemId" value="${esc(k.itemId)}">` +
        `<button type="submit">בטל שמירה</button></form></li>`,
    )
    .join('');
}

export function renderErasure(model: ErasureViewModel): string {
  const { plan } = model;
  const error = model.error === undefined ? '' : `<p class="error">${esc(model.error)}</p>`;

  if (plan === null) {
    // Spec §6: what is kept is shown on EVERY erasure screen, not only on the
    // one whose anchor happened to reach it.
    const keptHere = keptList(
      model,
      null,
      (model.kept ?? []).map((k) => ({
        itemKind: k.kind,
        itemId: k.itemId,
        keptOn: k.keptAt.toISOString().slice(0, 10),
        note: k.note,
      })),
    );
    return page(
      'מחיקה',
      `<h1>מחיקה</h1>${error}${erasureEntry(model)}` +
        (keptHere === '' ? '' : `<h2>יישמרו לפי הוראתך</h2><ul>${keptHere}</ul>`) +
        `<p><a href="/">לכרטיסי האישור</a></p>`,
    );
  }

  const rows = plan.items
    .filter((item) => item.count > 0)
    .map(
      (item) =>
        `<tr><td>${esc(rowLabel(item))}</td>` +
        `<td>${item.count}</td>` +
        `<td>${DISPOSITION_LABEL_FUTURE[item.action]}</td></tr>`,
    )
    .join('');

  const nothing = rows === '' ? '<p class="muted">לא נמצא שום דבר שמתאים לעוגן הזה.</p>' : '';

  const refusals = plan.refusals.map((r) => `<p class="error">${escLabel(r.detail)}</p>`).join('');

  const kept = keptList(
    model,
    plan.anchor,
    plan.excluded.map((k) => ({
      itemKind: k.itemKind,
      itemId: k.itemId,
      keptOn: k.keptAt.slice(0, 10),
      note: k.note,
    })),
  );

  // The confirm control exists only when nothing refuses. Offering it beside
  // a refusal would invite the click the refusal is there to prevent — and
  // `executeErasure` would throw on it anyway.
  const confirm =
    plan.refusals.length > 0
      ? '<p class="error">המחיקה חסומה עד שהסיבות שלמעלה ייפתרו.</p>'
      : `<form method="post" action="/erase/confirm">
           <input type="hidden" name="csrf" value="${esc(model.csrf)}">
           ${anchorField(plan.anchor)}
           <input type="hidden" name="planHash" value="${esc(model.planHash ?? '')}">
           <button type="submit" class="danger">מחק לצמיתות</button>
         </form>`;

  const excludable =
    plan.memoryIds.length + plan.documentIds.length + plan.jobIds.length === 0
      ? ''
      : `<h2>להוציא פריט מהמחיקה</h2>
         ${keepSection(model, plan.anchor, 'memory', plan.memoryIds)}
         ${keepSection(model, plan.anchor, 'document', plan.documentIds)}
         ${keepSection(model, plan.anchor, 'job', plan.jobIds)}`;

  return page(
    'מחיקה',
    `<h1>מחיקה — ${escLabel(model.anchorLabel)}</h1>
     ${error}
     ${refusals}
     <table><tr><th>מה</th><th>כמה</th><th>מה יקרה</th></tr>${rows}</table>
     ${nothing}
     ${plan.filePaths.length > 0 ? `<p>${plan.filePaths.length} קבצים יימחקו מהדיסק.</p>` : ''}
     ${kept === '' ? '' : `<h2>יישמרו לפי הוראתך</h2><ul>${kept}</ul>`}
     ${excludable}
     <p class="muted">מסלול הביקורת יישמר — הוא אינו מחזיק שמות, כתובות או תוכן.</p>
     ${confirm}
     ${erasureEntry(model)}
     <p><a href="/">ביטול — חזרה לכרטיסי האישור</a></p>`,
  );
}

export interface ErasureDoneViewModel {
  anchorLabel: string;
  /**
   * How many files the plan named — the denominator.
   *
   * Without it the page can show `filesRemoved` and nothing else, and "there
   * were no files to delete" reads exactly like "we failed to delete every
   * file we named". That second state is the one spec §7 says must be loud,
   * and it is the shape the relative-path defect took: rows destroyed, bytes
   * retained, screen clean.
   */
  plannedFiles: number;
  outcome: ErasureOutcome;
  /**
   * The erasure committed and the audit row recording it did not. True here
   * means it HAPPENED — reported as loudly as a failure, and never as one.
   */
  auditUnrecorded: boolean;
}

/**
 * What was actually destroyed, from the statements' own row counts.
 *
 * `filesFailed` is shown in full and in red: those rows are gone and those
 * files are still on disk, which is the one repairable half of the two
 * failure modes spec §7 weighs — and it is only repairable if the owner is
 * told the paths.
 */
export function renderErasureDone(model: ErasureDoneViewModel): string {
  const rows = model.outcome.deleted
    .filter((item) => item.count > 0)
    .map(
      (item) =>
        `<tr><td>${esc(rowLabel(item))}</td>` +
        `<td>${item.count}</td>` +
        `<td>${DISPOSITION_LABEL_PAST[item.action]}</td></tr>`,
    )
    .join('');

  const gone = model.outcome.filesAlreadyGone;

  // The accounting, always, even when it is all zeros: a number the owner can
  // check against the preview they just read.
  const files =
    `<p>מתוך ${model.plannedFiles} קבצים שהתוכנית מנתה: ` +
    `${model.outcome.filesRemoved} נמחקו מהדיסק, ` +
    `${gone.length} כבר לא היו שם, ` +
    `${model.outcome.filesFailed.length} נכשלו.</p>` +
    (gone.length === 0
      ? ''
      : `<ul class="muted">${gone.map((path) => `<li>${escLabel(path)}</li>`).join('')}</ul>`);

  // Every file the plan named was already missing. Tolerated one at a time;
  // as a whole run it means the paths were resolved against something other
  // than where the bytes live, and nothing was actually destroyed on disk.
  const nothingDeleted =
    model.plannedFiles > 0 && model.outcome.filesRemoved === 0 && model.outcome.filesFailed.length === 0
      ? `<p class="error">אף קובץ לא נמחק בפועל — כולם כבר לא היו במקום שהתוכנית ציינה.
         זה חריג: שורות בסיס הנתונים נמחקו, וכדאי לוודא שהקבצים באמת אינם.</p>`
      : '';

  const failed =
    model.outcome.filesFailed.length === 0
      ? ''
      : `<p class="error">${model.outcome.filesFailed.length} קבצים נשארו על הדיסק ואיש כבר אינו מצביע עליהם.
         המחיקה מבסיס הנתונים הושלמה; את הקבצים האלה צריך למחוק ידנית:</p>
         <ul>${model.outcome.filesFailed.map((path) => `<li>${escLabel(path)}</li>`).join('')}</ul>`;

  const audit = model.auditUnrecorded
    ? `<p class="error">המחיקה בוצעה במלואה, אבל שורת הביקורת שמתעדת אותה לא נכתבה.
       המחיקה אינה הפיכה ואינה "לא קרתה" — צריך לשחזר את הרישום ידנית.</p>`
    : '';

  return page(
    'נמחק',
    `<h1>נמחק — ${escLabel(model.anchorLabel)}</h1>
     ${audit}
     <table><tr><th>מה</th><th>כמה</th><th>מה קרה</th></tr>${rows}</table>
     ${files}
     ${nothingDeleted}
     ${failed}
     <p class="muted">מה שכבר יצא החוצה — מייל שנשלח, הודעה שהתקבלה — נמחק מכאן ועדיין קיים
     אצל הספק ואצל הנמען. המערכת אינה יכולה למחוק אותו שם.</p>
     <p class="muted">מסלול הביקורת נשמר, עם מספרים בלבד: בלי שמות, בלי כתובות ובלי תוכן.</p>
     <p><a href="/erase">מחיקה נוספת</a> · <a href="/">לכרטיסי האישור</a></p>`,
  );
}
