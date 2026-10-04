/**
 * The owner's WhatsApp conversation, on the dashboard.
 *
 * The owner's own requirement: "כל הודעה תיכנס גם לדשבורד באתר, גם שם יוכל
 * המשתמש לראות הודעות ולהגיב משם גם כן" — every message should land in the
 * dashboard too, and the owner should be able to see messages and reply from
 * there as well.
 *
 * **The compose box at the bottom of this screen gives the ASSISTANT an
 * instruction. It is never an outbound message to a customer, and nothing on
 * this page may suggest otherwise.** The tempting misreading of "reply from
 * there" is "send a WhatsApp to this customer" — that would violate decision
 * 4 (a message from anyone who is not the principal is recorded and never
 * acted on or answered) and it is structurally impossible by design:
 * `createBossMessenger` fixes `contactId` at construction, so there is no
 * parameter anywhere through which the assistant could be told to address a
 * stranger. "Reply from there" means typing in this box is EXACTLY as
 * powerful as typing in WhatsApp, and no more: both are instructions to the
 * assistant. The box therefore posts to the existing `POST /instruct` — this
 * screen is a view onto that door, not a second one — and the next person
 * adding a feature here must keep it that way: no per-message reply button,
 * no "answer this" link, nothing that implies a row can be addressed
 * directly. A row from someone who is not the principal is labelled as such
 * (`senderLabel` below) and carries no control of its own for exactly this
 * reason.
 *
 * Self-contained rather than built on top of `views.ts`'s private `page`/
 * `logoutForm` helpers (not exported, and the brief's only mandated change to
 * `views.ts` is exporting `escLabel`) — `views.ts` is already 1,667 lines and
 * this screen does not need to grow it further.
 */
import type { MessageState, StoredMessage } from '../whatsapp/store.js';
import { escapeHtml, escLabel } from './views.js';

const esc = escapeHtml;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 1rem; flex-wrap: wrap; }
  .card { border: 1px solid #8884; border-radius: 0.5rem; padding: 0.6rem 0.9rem; margin-bottom: 0.6rem; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  textarea { width: 100%; box-sizing: border-box; padding: 0.4rem; margin-top: 0.2rem; }
  button { margin-top: 0.75rem; padding: 0.5rem 1.2rem; cursor: pointer; }
`;

/**
 * Who sent a row, by a positive, exhaustive check — never "everyone who is
 * not the owner". `direction` decides first (an outbound row is always the
 * assistant's own message, and `recordOutbound` never sets `senderKind`, so
 * it would otherwise read as unresolved); only an inbound row consults
 * `senderKind`. `null` on an inbound row should not happen in production —
 * `recordInbound` requires the field — but a value that could not be read is
 * never treated as the safer case (the principal); it is labelled unknown.
 */
function senderLabel(m: StoredMessage): string {
  if (m.direction === 'outbound') return 'העוזרת';
  if (m.senderKind === 'principal') return 'אתה (בעל העסק)';
  if (m.senderKind === 'other') return 'שולח אחר';
  return 'שולח לא מזוהה';
}

/**
 * Six states, handled by a positive, exhaustive switch — never a default
 * branch that means "done". `received`, `claimed` and `reported_interim`
 * still owe the owner something (an interim notice is, by its own name, not
 * the real answer — see migration 038's docblock) and carry `unfinished:
 * true`. **`unfinished` no longer decides whether the label is shown at
 * all** (fix round 1, Important 1): `failed` is reachable for the owner's
 * OWN instruction — a daily-cap refusal, a planner refusal, a crash
 * (`whatsapp-door.ts`) — and rendering it with no state text made it
 * indistinguishable from an instruction that actually ran. The same
 * argument that forbids `reported_interim` from reading as finished forbids
 * `failed` from reading as succeeded, one state over. Every row now shows
 * its own label, always; `unfinished` only ever meant "the owner is still
 * owed something", never "worth mentioning".
 *
 * The `default` branch is the exhaustiveness check: if `MessageState` ever
 * grows a seventh member, `state` narrows to a type that is not assignable
 * to `never` inside it, and this file fails to typecheck at that exact line
 * — not at a call site, and not by passing tests for the wrong reason. The
 * same branch is also the runtime fallback for a value that bypassed the
 * type system (a stored CHECK constraint widened without the TypeScript
 * union keeping pace): it renders as unknown and unfinished, never as
 * silently finished, because a status this code cannot explain is not one it
 * can promise is settled.
 */
function stateInfo(state: MessageState): { label: string; unfinished: boolean } {
  switch (state) {
    case 'received':
      return { label: 'התקבלה — עדיין לא טופלה', unfinished: true };
    case 'claimed':
      return { label: 'בטיפול כרגע', unfinished: true };
    case 'reported_interim':
      return { label: 'עודכנת בביניים — התשובה הסופית עדיין בדרך', unfinished: true };
    case 'handled':
      return { label: 'טופלה', unfinished: false };
    case 'failed':
      return { label: 'נכשלה', unfinished: false };
    case 'reported':
      return { label: 'דווחה', unfinished: false };
    default: {
      const unreachable: never = state;
      return { label: `מצב לא מוכר (${String(unreachable)})`, unfinished: true };
    }
  }
}

/**
 * Body, then transcript, then an explicit sentence — never an empty cell.
 * A row can legitimately carry neither (audio too long, or a transcription
 * that failed; task 6's territory): that is an answer about what happened to
 * THIS message, not nothing to say, so it is rendered as a sentence rather
 * than left blank, which would read as "nothing was said" instead of "we
 * don't have readable content for this one".
 *
 * `escLabel`, not `esc`, on both `body` and `transcript`: either can be
 * stranger-authored text (an inbound message, or a voice note a
 * transcription model turned into text from a stranger's audio — the same
 * class as a message body and arguably wider, since the model can render
 * anything), and a bidi override in it would change what the owner reads
 * rather than merely how it looks.
 *
 * A field counts as present only when it is a NON-EMPTY string (fix round
 * 1, Minor 3) — `refineActionClass`'s own lesson (`policy/classify.ts`):
 * `'' !== null` is true, so a bare `!== null` check let an empty string
 * through to a bare `<p></p>`, the exact "empty cell reads as nothing was
 * said" ruling 4 exists to forbid. `''` is covered by the same sentence as
 * `null`.
 */
function hasText(value: string | null): value is string {
  return value !== null && value !== '';
}

function contentLine(m: StoredMessage): string {
  if (hasText(m.body)) return escLabel(m.body);
  if (hasText(m.transcript)) return `<em>תמלול:</em> ${escLabel(m.transcript)}`;
  const kindNote = m.mediaKind !== null ? ` (${esc(m.mediaKind)})` : '';
  return `<span class="muted">הודעה בלי תוכן טקסטואלי לקריאה${kindNote} — ייתכן שההקלטה הייתה ארוכה מדי או שהתמלול נכשל.</span>`;
}

/** One row. No form, no button, no link — see this module's own docblock. */
function messageRow(m: StoredMessage): string {
  const who = senderLabel(m);
  const when = esc(m.providerTimestamp);
  // `escLabel`, not `esc`: the number is provider-supplied, not ours.
  const number = m.senderNumber !== null ? ` <span class="muted">${escLabel(m.senderNumber)}</span>` : '';
  // Always shown (fix round 1, Important 1) — a `failed` instruction must
  // not read identically to a `handled` one, and `unfinished` here only ever
  // meant "the owner is still owed something", not "worth mentioning".
  const info = stateInfo(m.state);
  const badge = ` <span class="muted">· ${esc(info.label)}</span>`;

  return `
    <article class="card">
      <div class="muted">${esc(who)}${number} · ${when}${badge}</div>
      <p>${contentLine(m)}</p>
    </article>`;
}

/**
 * `truncated` (fix round 1, Important 2): this screen calls itself the
 * owner's full record, and past the loaded window it quietly stops being
 * one unless something says so. The decision of WHICH messages were cut —
 * asking the store for one more row than the limit and checking whether it
 * came back — belongs to the caller (`handleConversation` in `server.ts`),
 * which is the only place that knows the limit; this function only renders
 * the one Hebrew sentence when told to. Optional and defaulted to `false`
 * so every existing call site that has nothing to report need not pass it.
 */
export function renderConversation(options: {
  messages: readonly StoredMessage[];
  csrf: string;
  truncated?: boolean;
}): string {
  const truncated = options.truncated ?? false;
  const rows =
    options.messages.length === 0
      ? '<p class="muted">עדיין לא התקבלה אף הודעה בשיחה הזו.</p>'
      : options.messages.map(messageRow).join('\n');
  const truncationNote = truncated
    ? '<p class="muted">מוצגות ההודעות האחרונות בלבד — היסטוריה מוקדמת יותר אינה מוצגת כאן.</p>'
    : '';

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>שיחת הוואטסאפ</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>שיחת הוואטסאפ</h1>
</header>
<p class="muted">
  מה שתכתוב בתיבה שבתחתית העמוד הוא הוראה לעוזרת, באותה סמכות ובאותה דלת
  כמו הודעת וואטסאפ שהיית שולח לה — אך הוא לא יופיע כהודעה בשיחה שלמעלה.
  היא אינה יכולה לענות מכאן למי ששלח הודעה; ההוראה הולכת רק לעוזרת.
</p>
${truncationNote}
${rows}
<form method="POST" action="/instruct">
  <input type="hidden" name="csrf" value="${esc(options.csrf)}">
  <textarea name="text" rows="3" maxlength="4000" required placeholder="כתוב הוראה לעוזרת, בדיוק כמו בוואטסאפ"></textarea>
  <button>שלח</button>
</form>
<p><a href="/">לכרטיסי האישור</a> · <a href="/instruct">מה לעשות</a> · <a href="/readings">מה קראתי</a></p>
</body>
</html>`;
}
