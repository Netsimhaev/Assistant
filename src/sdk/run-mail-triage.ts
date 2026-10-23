/**
 * Live run of the two quarantined mail calls — `intake.triage`
 * (`runMailTriage`) and the `comms.email` drafter (`runMailDrafter`) — over
 * one mail the poller already stored.
 *
 *   npm run sdk:mail-triage -- <mailId>
 *
 * A script and not a test, for the reason every `sdk:*` script here is: it
 * costs money and needs a key, and a suite that skips silently without one
 * reports green for work it did not do. Both calls refuse under
 * `NODE_ENV=test`, so this file is the only way the real calls happen.
 *
 * It writes nothing. It does not settle the mail, label it, raise a card or
 * curate memory — the poll pass (`pollMailbox`) owns all of that. What it
 * shows is exactly what the two models say, and what the drafter was given:
 * the triage summary, the gist and the subject — never the raw body, which is
 * the quarantine rule this script exists to let a person watch.
 */
import { config } from '../config.js';
import { loadActiveCharter } from '../charter/store.js';
import { closePool } from '../db/pool.js';
import { getMail } from '../mail/inbox-store.js';
import { isAutomatedSender } from '../mail/automated.js';
import { finalCategories } from '../domain/mail-triage.js';
import { runMailTriage } from './mail-triage.js';
import { runMailDrafter } from './mail-drafter.js';
import { attachmentEntries } from '../orchestrator/mail-poll.js';
import { ATTACHMENT_DOC_TYPE_LABELS } from '../domain/mail-triage.js';

const mailId = process.argv[2];

async function main(): Promise<void> {
  if (mailId === undefined) {
    console.error('שימוש: npm run sdk:mail-triage -- <mailId>');
    process.exitCode = 1;
    return;
  }

  const hasCredentials =
    process.env['ANTHROPIC_API_KEY'] !== undefined ||
    process.env['ANTHROPIC_AUTH_TOKEN'] !== undefined;
  if (!hasCredentials) {
    console.error(
      'אין ANTHROPIC_API_KEY בסביבה. ההרצה החיה דורשת מפתח; הלוגיקה עצמה מכוסה במבחנים.',
    );
    process.exitCode = 1;
    return;
  }

  const mail = await getMail(mailId, { businessId: config.businessId });
  if (mail === null) {
    console.error(`לא נמצא מייל במזהה ${mailId} בעסק ${config.businessId}.`);
    process.exitCode = 1;
    return;
  }

  // No fixture fallback: installing a charter would be a write, and this
  // script promises to write nothing.
  const active = await loadActiveCharter(config.businessId);
  if (active === null) {
    console.error(`אין תקנון פעיל לעסק ${config.businessId}. יש לחתום על תקנון לפני ההרצה; הסקריפט אינו כותב דבר.`);
    process.exitCode = 1;
    return;
  }
  const bundle = active.bundle;

  console.log(`מאת: ${mail.fromAddress || '(אין שולח)'}   נושא: ${mail.subject}`);
  if (mail.bodyText === '') console.log('(גוף ההודעה נמחק במדיניות השמירה — הסיווג רץ על הנושא בלבד)');

  // Reads the documents the poll pass already ingested; ingests nothing.
  const entries = await attachmentEntries(mail, new Map(), config.businessId);
  const outcome = await runMailTriage({ bundle, mail, attachments: entries.map((e) => e.brief) });
  if (outcome.status !== 'read') {
    console.log(`\n--- סיווג נכשל ---\n${outcome.reason}`);
    return;
  }
  const { triage } = outcome;
  const automated = isAutomatedSender(mail.headerFlags, mail.fromAddress);
  const final = finalCategories(triage, automated);

  console.log('\n--- סיווג (intake.triage) ---');
  console.log(`קטגוריות שהמודל אמר: ${triage.categories.join(', ')}`);
  console.log(
    `קטגוריות סופיות: ${final.categories.join(', ')}${automated ? '  (שולח אוטומטי — הקוד הוריד ל-other)' : ''}`,
  );
  console.log(`נכתב על ידי אדם: ${final.isPerson ? 'כן' : 'לא'}`);
  console.log(`תקציר: ${triage.summary}`);
  if (triage.invoice !== null) {
    console.log(
      `חשבונית (לא מאומת): מספר ${triage.invoice.number ?? '—'} · סכום ${triage.invoice.amountText ?? '—'} · תאריך ${triage.invoice.dateText ?? '—'}`,
    );
  }
  console.log(`מהות התשובה: ${triage.replyGist ?? '—'}`);
  for (const a of triage.attachments) {
    const name = entries[a.index]?.attachment.filename ?? '?';
    console.log(`צרופה ${a.index} (${name}): ${ATTACHMENT_DOC_TYPE_LABELS[a.docType]} — ${a.summary}`);
  }

  if (!final.categories.includes('question') || triage.replyGist === null) {
    console.log('\nאין שאלה לענות עליה — המנסח לא נקרא.');
    return;
  }

  const draft = await runMailDrafter({
    bundle,
    summary: triage.summary,
    replyGist: triage.replyGist,
    subject: mail.subject,
  });
  console.log('\n--- טיוטה (comms.email) ---');
  if (draft.status === 'drafted') {
    console.log(draft.body);
    console.log(`\nהנמען יהיה תמיד השולח המקורי: ${mail.fromAddress}`);
    if (mail.replyTo !== null && mail.replyTo !== mail.fromAddress) {
      console.log(`(Reply-To שונה מוצג בכרטיס ואינו בשימוש: ${mail.replyTo})`);
    }
  } else {
    console.log(`הניסוח נכשל: ${draft.reason}`);
  }
}

try {
  await main();
} finally {
  await closePool();
}
