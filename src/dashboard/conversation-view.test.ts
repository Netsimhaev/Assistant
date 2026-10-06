import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../whatsapp/store.js';
import { renderConversation } from './conversation-view.js';

function msg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'WA-1',
    providerMessageId: 'wamid.1',
    direction: 'inbound',
    senderNumber: '+972501234567',
    senderKind: 'principal',
    body: 'שלום',
    transcript: null,
    mediaKind: null,
    providerTimestamp: '2026-10-03T09:00:00.000Z',
    state: 'handled',
    jobId: null,
    createdAt: '2026-10-03T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * The HTML of each `<article class="card">...</article>` row, in order.
 * Fix round 1, item 5: the task's central boundary ("no per-row reply
 * affordance") had no test that would actually catch a per-row `<a>` or
 * `<button>` — only a page-wide `<form>` count, which an anchor or button
 * sails straight past. Isolating each row's own markup is what lets a test
 * assert "this row carries no interactive element of its own" rather than
 * "the page has exactly one form", which is a different and weaker claim.
 */
function rowsOf(html: string): string[] {
  return [...html.matchAll(/<article class="card">[\s\S]*?<\/article>/g)].map((m) => m[0]);
}

/**
 * Fix round 2, item 2: a denylist of forbidden attributes (`onclick`,
 * `role`, `tabindex`, ...) is exactly the shape this repo's own rule warns
 * against — "everything that is not X" grows a hole for whatever nobody
 * listed yet. The positive version asks a different question: what is the
 * COMPLETE, small set of tags a row is allowed to contain at all? Every
 * literal opening/closing tag `messageRow` can ever emit is here, once; a
 * row containing anything outside this set — a new attribute on an
 * existing tag, a wholly new tag, in any position — fails the check,
 * including shapes nobody has thought of yet.
 */
const ALLOWED_ROW_TAGS = new Set([
  '<article class="card">',
  '</article>',
  '<div class="muted">',
  '</div>',
  '<span class="muted">',
  '</span>',
  '<p>',
  '</p>',
  '<em>',
  '</em>',
]);

function tagsIn(html: string): string[] {
  return [...html.matchAll(/<[^>]+>/g)].map((m) => m[0]);
}

function disallowedTags(tags: readonly string[], allowed: ReadonlySet<string>): string[] {
  return tags.filter((t) => !allowed.has(t));
}

/** Every opening tag named `name`, exactly as rendered (attributes included). */
function openTags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => m[0]);
}

/** Every `href` on an `<a>` anywhere in `html`, in document order. */
function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>/g)].map((m) => m[1] ?? '');
}

describe('renderConversation', () => {
  /**
   * Stranger-authored text on the owner's screen. `escLabel` exists because
   * a filename chosen by a sender can rearrange what the owner reads; a
   * message body is the same class and wider.
   */
  it('strips directionality characters from a message body', () => {
    const html = renderConversation({ messages: [msg({ body: 'שלום‮גרר' })], csrf: 'c' });
    expect(html).not.toContain('‮');
    expect(html).toContain('שלום');
  });

  // Fix round 1: an absence-only assertion here would go quiet if the body
  // stopped rendering at all — paired with a positive check that the
  // escaped text actually made it onto the page.
  it('escapes HTML in a message body', () => {
    const html = renderConversation({ messages: [msg({ body: '<script>alert(1)</script>' })], csrf: 'c' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  // Ruling 1: `transcript` is the same class as `body` (a transcription
  // model's output from a stranger's audio) and `senderNumber` comes from
  // the provider, not from us. Both go through `escLabel` too.
  it('strips directionality characters from a transcript', () => {
    const html = renderConversation({
      messages: [msg({ body: null, transcript: 'הגעתי‮בשעה תשע' })],
      csrf: 'c',
    });
    expect(html).not.toContain('‮');
    expect(html).toContain('הגעתי');
  });

  it('strips directionality characters from the sender number', () => {
    const html = renderConversation({
      messages: [msg({ senderKind: 'other', senderNumber: '+97250000000‮0' })],
      csrf: 'c',
    });
    expect(html).not.toContain('‮');
    // Fix round 1: paired positive check — the digits survive, only the
    // override character is gone, so this is not also quietly true of a
    // number that stopped rendering altogether.
    expect(html).toContain('+972500000000');
  });

  it('shows a transcript where there is one, and marks it as a transcript', () => {
    const html = renderConversation({
      messages: [msg({ body: null, transcript: 'הגעתי בשעה תשע' })],
      csrf: 'c',
    });
    expect(html).toContain('הגעתי בשעה תשע');
    expect(html).toContain('תמלול');
  });

  // Decision 5: every message in the conversation is shown, labelled by who
  // sent it — the principal, a stranger, and the assistant's own outbound
  // replies all appear, and only the assistant's own compose box (one form
  // on the whole page) can originate anything new.
  it('shows messages from everyone, labelled by who sent them', () => {
    const html = renderConversation({
      messages: [
        msg({ id: 'WA-1', direction: 'inbound', senderKind: 'principal', body: 'הודעה מהבעלים' }),
        msg({
          id: 'WA-2',
          direction: 'inbound',
          senderKind: 'other',
          senderNumber: '+972500000000',
          body: 'הודעה משולח אחר',
        }),
        msg({ id: 'WA-3', direction: 'outbound', senderKind: null, senderNumber: null, body: 'תשובת העוזרת' }),
      ],
      csrf: 'c',
    });
    expect(html).toContain('הודעה מהבעלים');
    expect(html).toContain('אתה (בעל העסק)');
    expect(html).toContain('הודעה משולח אחר');
    expect(html).toContain('שולח אחר');
    expect(html).toContain('תשובת העוזרת');
    expect(html).toContain('העוזרת');

    // No per-message reply control, for a stranger's row or anyone else's:
    // the only form on the page is the single compose box.
    expect((html.match(/<form/g) ?? []).length).toBe(1);
  });

  it('labels an inbound message with no resolved sender kind as unknown, never as the principal', () => {
    // The existing "everyone" test above short-circuits on `direction`
    // before `senderKind` is even consulted for the outbound case — this
    // exercises the inbound-but-unresolved branch on its own (fix round 1).
    const html = renderConversation({
      messages: [msg({ direction: 'inbound', senderKind: null, body: 'הודעה ממקור לא ידוע' })],
      csrf: 'c',
    });
    expect(html).toContain('הודעה ממקור לא ידוע');
    expect(html).toContain('שולח לא מזוהה');
    expect(html).not.toContain('בעל העסק');
  });

  // Fix round 1, item 5: the central boundary this task exists to guarantee
  // — no row can be addressed directly — had no test that would catch a
  // per-row control, only a page-wide `<form>` count that an `<a>` or
  // `<button>` sails past. Fix round 2 replaced the denylist shape (a list
  // of forbidden tags) with a positive whitelist: a row may contain ONLY
  // the tags in `ALLOWED_ROW_TAGS`, so anything else — known or not yet
  // thought of — fails this check by construction.
  it('renders only its own small whitelist of tags inside any message row, never a new one', () => {
    const html = renderConversation({
      messages: [
        msg({ id: 'WA-1', senderKind: 'principal', body: 'הודעה מהבעלים' }),
        msg({ id: 'WA-2', senderKind: 'other', senderNumber: '+972500000000', body: 'הודעה משולח אחר' }),
        msg({ id: 'WA-3', direction: 'outbound', senderKind: null, senderNumber: null, body: null, transcript: 'תמלול תשובה' }),
        msg({ id: 'WA-4', body: null, transcript: null, mediaKind: null }),
      ],
      csrf: 'c',
    });
    const rows = rowsOf(html);
    expect(rows).toHaveLength(4);
    const tagsAcrossRows = rows.flatMap(tagsIn);
    expect(disallowedTags(tagsAcrossRows, ALLOWED_ROW_TAGS)).toEqual([]);
  });

  // Fix round 2, item 2's second positive assertion. The row whitelist
  // above closes what a ROW may contain; it cannot, by definition, see a
  // control placed just outside a row's `</article>` — the review's own
  // named realistic regression, where the row count stays unchanged and
  // nothing in the row check notices. This closes what the PAGE may
  // contain instead: the one compose form, its own three fields, and the
  // three fixed nav links — nothing else, anywhere, regardless of how many
  // rows are rendered or what they contain.
  it("limits the page's entire interactive inventory to the compose form, its own fields, and the fixed nav links", () => {
    const csrf = 'tok-123';
    const html = renderConversation({
      messages: [
        msg({ id: 'WA-1', senderKind: 'principal', body: 'הודעה 1' }),
        msg({ id: 'WA-2', senderKind: 'other', senderNumber: '+972500000000', body: 'הודעה 2' }),
      ],
      csrf,
    });

    expect(openTags(html, 'form')).toEqual(['<form method="POST" action="/instruct">']);
    expect(openTags(html, 'input')).toEqual([`<input type="hidden" name="csrf" value="${csrf}">`]);
    expect(openTags(html, 'textarea')).toEqual([
      '<textarea name="text" rows="3" maxlength="4000" required placeholder="כתוב הוראה לעוזרת, בדיוק כמו בוואטסאפ">',
    ]);
    expect(openTags(html, 'button')).toEqual(['<button>']);
    // Every link on the page, wherever it sits, is one of the three fixed
    // nav destinations — never a per-row address, and never a fourth link
    // smuggled in anywhere, including just outside a row.
    expect(hrefsOf(html)).toEqual(['/', '/instruct', '/readings']);
    // No other kind of interactive element exists anywhere on the page.
    expect(openTags(html, 'select')).toEqual([]);
    expect(openTags(html, 'label')).toEqual([]);
    expect(openTags(html, 'details')).toEqual([]);
    expect(openTags(html, 'summary')).toEqual([]);
    expect(openTags(html, 'area')).toEqual([]);
  });

  it('marks a claimed-but-unsettled message as unfinished rather than hiding it', () => {
    const html = renderConversation({ messages: [msg({ state: 'claimed', body: 'תזכורת לפגישה' })], csrf: 'c' });
    expect(html).toContain('תזכורת לפגישה');
    expect(html).toContain('בטיפול');
  });

  // Ruling 2: `reported_interim` means the owner was told something once but
  // the job has not reached a terminal phase — a real report is still owed.
  // Rendering it as finished would re-create, one surface over, the exact
  // silence task 8 exists to prevent.
  it('marks a reported_interim message as unfinished, not as a closed report', () => {
    const html = renderConversation({
      messages: [msg({ state: 'reported_interim', body: 'בדיקת תקציב' })],
      csrf: 'c',
    });
    expect(html).toContain('בדיקת תקציב');
    expect(html).toContain('עודכנת בביניים');
  });

  it('shows a terminal state its own label, never another state\'s label', () => {
    const html = renderConversation({ messages: [msg({ state: 'reported', body: 'כבר דווח' })], csrf: 'c' });
    expect(html).toContain('כבר דווח');
    // Fix round 1, Important 1: a terminal state is no longer hidden — it
    // shows its OWN label, not no label at all.
    //
    // Task 12 fix round 1 changed this label from 'דווחה'. The state has two
    // writers and only one of them sends a report: `reportWhatsAppJobs` does,
    // and `retireOpenInstruction` claims it precisely to STOP one being sent,
    // for an instruction the owner closed or answered himself. The label now
    // says what is true for both — nothing further is owed — rather than
    // asserting a report that for one writer never happened.
    expect(html).toContain('אין לי יותר מה לדווח');
    expect(html).not.toContain('· דווחה');
    expect(html).not.toContain('עודכנת בביניים');
    expect(html).not.toContain('בטיפול');
    expect(html).not.toContain('עדיין לא טופלה');
  });

  // Fix round 1, Important 1: `failed` is reachable for the owner's OWN
  // instruction (a daily-cap refusal, a planner refusal, a crash), and
  // rendering it with no state text at all made it indistinguishable from
  // an instruction that actually succeeded. The same argument that forbids
  // `reported_interim` from reading as finished forbids `failed` from
  // reading as succeeded.
  it('shows a failed instruction as failed, never identical to one that succeeded', () => {
    const failed = renderConversation({ messages: [msg({ state: 'failed', body: 'ניסיון שליחה' })], csrf: 'c' });
    // `jobId: null` on the fixture, which is what makes 'טופלה' the right
    // label here — see the task-12 pair below: `handled` means "finished"
    // only for a message that opened no job.
    const handled = renderConversation({ messages: [msg({ state: 'handled', body: 'ניסיון שליחה' })], csrf: 'c' });
    expect(failed).toContain('ניסיון שליחה');
    expect(failed).toContain('נכשלה');
    expect(failed).not.toContain('טופלה');
    expect(handled).toContain('טופלה');
    expect(handled).not.toContain('נכשלה');
    expect(failed).not.toEqual(handled);
  });

  /**
   * Task 12 (the final review's Minor 11), and the owner's own rule behind
   * it: "ההוראה לא נסגרה עד שאחד הצדדים אמר במפורש". `'handled'` means the
   * door finished with the MESSAGE — for a message that opened a job it says
   * nothing at all about what became of that job, which may still be
   * planning, executing or waiting on an approval card. Labelling it 'טופלה'
   * was a statement of closure the record does not support.
   *
   * Both halves in one test, on purpose: a "still running" assertion alone
   * would survive deleting the distinction entirely if the other label
   * happened to contain the same words, and a "finished" assertion alone
   * would survive labelling everything unfinished.
   */
  it('distinguishes a message that opened a live job from one that is genuinely finished', () => {
    const working = renderConversation({
      messages: [msg({ state: 'handled', jobId: 'JOB-1', body: 'תשלחי לדנה' })],
      csrf: 'c',
    });
    const finished = renderConversation({
      messages: [msg({ state: 'handled', jobId: null, body: 'תשלחי לדנה' })],
      csrf: 'c',
    });

    expect(working).toContain('תשלחי לדנה');
    expect(working).toContain('טרם דיווחתי');
    // The claim this label used to make, and must not: `'טופלה'` on its own.
    expect(working).not.toContain('· טופלה');
    expect(finished).toContain('· טופלה');
    expect(finished).not.toContain('טרם דיווחתי');
    expect(working).not.toEqual(finished);
  });

  /**
   * `'reported'` is the only state that says the owner was told the real
   * outcome, so it must not read the same as a job still running — the
   * same argument `reported_interim` already carries one state over.
   */
  it('does not let a live job read the same as one the owner has already been told about', () => {
    const working = renderConversation({
      messages: [msg({ state: 'handled', jobId: 'JOB-1', body: 'תשלחי לדנה' })],
      csrf: 'c',
    });
    const reported = renderConversation({
      messages: [msg({ state: 'reported', jobId: 'JOB-1', body: 'תשלחי לדנה' })],
      csrf: 'c',
    });
    expect(working).not.toContain('אין לי יותר מה לדווח');
    expect(reported).toContain('אין לי יותר מה לדווח');
    expect(reported).not.toContain('טרם דיווחתי');
  });

  // Ruling 4: a row can legitimately carry neither body nor transcript
  // (audio too long, or a transcription that failed). That is an answer, not
  // an empty cell that reads as "nothing was said".
  it('says plainly what happened when a message has neither body nor transcript', () => {
    const html = renderConversation({
      messages: [msg({ body: null, transcript: null, mediaKind: 'audio' })],
      csrf: 'c',
    });
    expect(html).toContain('בלי תוכן טקסטואלי');
  });

  // Fix round 1, Minor 3: `refineActionClass`'s own lesson — a field counts
  // as present only when it is a NON-EMPTY string. `'' !== null` is true, so
  // a bare `!== null` check let an empty body through to a bare `<p></p>`,
  // exactly the empty cell ruling 4 forbids.
  it('treats an empty-string body the same as no body at all', () => {
    const html = renderConversation({ messages: [msg({ body: '', transcript: null })], csrf: 'c' });
    expect(html).toContain('בלי תוכן טקסטואלי');
    expect(html).not.toContain('<p></p>');
  });

  it('treats an empty-string transcript the same as no transcript at all', () => {
    const html = renderConversation({ messages: [msg({ body: null, transcript: '' })], csrf: 'c' });
    expect(html).toContain('בלי תוכן טקסטואלי');
    expect(html).not.toContain('<p></p>');
  });

  // Ruling 3: a state the type system never anticipated (a widened CHECK
  // constraint running ahead of this file) must render as unknown, never as
  // silently finished — the runtime half of the compile-time exhaustiveness
  // check in `stateLabel`.
  it('renders an unrecognised state as unknown, never as silently finished', () => {
    const html = renderConversation({
      messages: [msg({ state: 'some_future_state' as unknown as StoredMessage['state'], body: 'מצב עתידי' })],
      csrf: 'c',
    });
    expect(html).toContain('מצב עתידי');
    expect(html).toContain('מצב לא מוכר');
  });

  it('says so plainly when there is no conversation yet', () => {
    const html = renderConversation({ messages: [], csrf: 'c' });
    expect(html).toContain('לא התקבלה אף הודעה');
  });

  it('posts the compose box to the existing /instruct door, never a second one', () => {
    const html = renderConversation({ messages: [], csrf: 'the-csrf-token' });
    expect(html).toContain('action="/instruct"');
    expect(html).toContain('value="the-csrf-token"');
  });

  // Fix round 1, Minor 4: the on-page copy must claim what the code
  // actually honours — the box is as POWERFUL as a WhatsApp message (same
  // authority, same door), never that it appears as one in the record
  // above, which it does not (the behavioural version is a parked product
  // decision, not implemented here).
  it('tells the owner the compose box is as powerful as WhatsApp, never that it appears in the record', () => {
    const html = renderConversation({ messages: [], csrf: 'c' });
    expect(html).toContain('באותה סמכות ובאותה דלת');
    expect(html).toContain('לא יופיע כהודעה בשיחה');
  });

  // Fix round 1, Important 2: the screen calls itself the full record, and
  // past the loaded window it must say so rather than silently stop being
  // one. `renderConversation` itself only renders the sentence when told
  // to — detecting truncation honestly (asking for one more row than the
  // limit) is the caller's job, covered in `server.test.ts`.
  //
  // Fix round 2, item 3: the "not truncated" half used to be its own test,
  // which would survive deletion of the entire truncation feature — nothing
  // in that half alone depends on the feature existing. Folded into one
  // test so the "nothing extra by default" half is anchored by its own
  // paired "something when told to" half: deleting the feature fails the
  // second assertion, not just leaves the first one vacuously true.
  it('shows the truncation note only when told the record was cut, never by default', () => {
    const notTruncated = renderConversation({ messages: [msg()], csrf: 'c' });
    const truncated = renderConversation({ messages: [msg()], csrf: 'c', truncated: true });
    expect(notTruncated).not.toContain('מוצגות ההודעות האחרונות בלבד');
    expect(truncated).toContain('מוצגות ההודעות האחרונות בלבד');
  });
});
