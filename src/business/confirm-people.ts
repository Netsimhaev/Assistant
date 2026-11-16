/**
 * The technician's contacts and colleagues meet the owner (admin-panel spec,
 * interview integration).
 *
 * **Everything takes effect at signature, nothing before it.** Step 8's
 * "אשר את הרשימה" (`confirmSetupPeople`) records a SNAPSHOT of the package's
 * people in the interview draft (`answers.setupPeople`) — never indices into
 * the package, so a technician editing the package after the owner confirmed
 * cannot change who the signature adds — and appends the contacts the owner
 * ticked as known to the draft's `counterparties.known`, so they reach the
 * summary and are signed. `signAndInstallInterview` then calls
 * `applySetupPeople` inside the install transaction, right after
 * `installCharter`: a job needs a charter version (`jobs.charter_version`
 * has a foreign key to `charter_versions`), and before the first signature
 * there is none.
 *
 * **The memories are the owner's word.** `applySetupPeople` opens its own job
 * with `provenance: 'boss'` as a literal — the shape `recordCorrection` keeps —
 * and `writeMemory` reads the provenance from that job, never from here.
 *
 * **Subject key: the canonical phone** (`+<digits>`, the package's own form,
 * parsed by `authorityNumberKey`). Contact entities are keyed by an entity id
 * or a lowercased email (`listContacts`); a setup contact has neither, and the
 * phone is the one stable identifier the technician typed. It also lets
 * contact erasure by phone find the row by its key.
 *
 * Colleagues are never charter counterparties and never give instructions —
 * nothing here grants authority to anyone.
 */
import type { InterviewAnswers, SetupPeopleSnapshot, CounterpartyEntry } from '../charter/interview/answers.js';
import { loadDraft, saveSection } from '../charter/interview/draft-store.js';
import { activeCharterVersion } from '../charter/store.js';
import { transaction, type BusinessDb } from '../db/pool.js';
import { authorityNumberKey } from '../governance/principal-number.js';
import { writeMemory } from '../memory/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { canonicalHash } from '../util/canonical.js';
import { addColleague, listColleagues } from './colleagues.js';
import { loadSetupPackage, type SetupPackage } from './setup-package.js';

export const CONFIRM_PEOPLE_JOB_TITLE = 'אישור אנשי קשר מההקמה';
/** The `memories.source_ref` that marks a contact confirmed from the setup package. */
export const SETUP_PACKAGE_SOURCE_REF = 'setup_package';

export class SetupPeopleInputError extends Error {
  constructor(messageHe: string) {
    super(messageHe);
    this.name = 'SetupPeopleInputError';
  }
}

export interface ConfirmPeopleResult {
  contacts: number;
  colleagues: number;
  known: number;
}

const samePhone = (a: string | undefined, b: string): boolean =>
  a !== undefined && authorityNumberKey(a) !== null && authorityNumberKey(a) === authorityNumberKey(b);

/** The label `confirmSetupPeople` gives a known contact it appends to `counterparties.known`. */
const knownLabel = (c: { name: string; role: string }): string => `${c.name} — ${c.role}`;

/**
 * A handle on the package's people exactly as step 8 rendered them: the form
 * carries it, and `confirmSetupPeople` recomputes it under the lock. Indices
 * are positions in that list — a technician edit between the render and the
 * POST would shift them onto other people, and a ✓ makes a signed known
 * counterparty, so a changed list is refused rather than reinterpreted.
 */
export function setupPeopleListHash(pkg: SetupPackage | null): string {
  return canonicalHash({ contacts: pkg?.contacts ?? [], colleagues: pkg?.colleagues ?? [] });
}

const LIST_CHANGED = 'הרשימה השתנתה או שהבחירה אינה תקינה. לא בוצעה כל פעולה — יש לרענן ולבחור שוב.';

/**
 * Step 8: record what the owner confirmed. Idempotent — a package with no
 * people returns zeros and writes nothing; a second confirm replaces the
 * snapshot and never appends a known entry twice, and a contact un-ticked on
 * a re-confirm loses the entry this function appended for it (same phone and
 * label — an entry the owner typed on step 8 is left alone). Serialised with
 * the install (and with a concurrent confirm) on the install's advisory lock,
 * so two posts at once cannot both append, and no confirm lands between the
 * install's checks and its commit. `listHash` must be `setupPeopleListHash`
 * of the package as the owner saw it; otherwise `SetupPeopleInputError`, and
 * nothing is written.
 */
export async function confirmSetupPeople(
  db: BusinessDb,
  input: { knownIndices: readonly number[]; listHash: string },
): Promise<ConfirmPeopleResult> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('charter-install:' || $1))", [tx.businessId]);
    const pkg = await loadSetupPackage(tx);
    if (pkg === null || (pkg.contacts.length === 0 && pkg.colleagues.length === 0)) {
      return { contacts: 0, colleagues: 0, known: 0 };
    }
    if (setupPeopleListHash(pkg) !== input.listHash) throw new SetupPeopleInputError(LIST_CHANGED);

    for (const i of input.knownIndices) {
      if (!Number.isInteger(i) || i < 0 || i >= pkg.contacts.length) throw new SetupPeopleInputError(LIST_CHANGED);
    }
    const known = new Set(input.knownIndices);

    const snapshot: SetupPeopleSnapshot = {
      contacts: pkg.contacts.map((c, i) => ({ name: c.name, role: c.role, phone: c.phone, known: known.has(i) })),
      colleagues: pkg.colleagues.map((c) => ({ name: c.name, role: c.role, phone: c.phone })),
    };

    const draft = await loadDraft(tx);
    // Only the first save may create the draft, and only it carries the base
    // version: a draft that starts now starts from whatever charter is active
    // now (the rule `handleSetupStepPost` keeps); a later save never moves it.
    let options: { baseCharterVersion?: string | null } =
      draft === null ? { baseCharterVersion: await activeCharterVersion(tx) } : {};

    const before = draft?.answers.counterparties ?? { known: [], doNotContact: [] };
    const section: InterviewAnswers['counterparties'] = structuredClone(before);
    // Un-ticked: drop the entry this function appended (phone AND label).
    section.known = section.known.filter(
      (k) => !snapshot.contacts.some((c) => !c.known && samePhone(k.phone, c.phone) && k.label === knownLabel(c)),
    );
    const knownContacts = snapshot.contacts.filter((c) => c.known);
    for (const c of knownContacts) {
      if (section.known.some((k) => samePhone(k.phone, c.phone))) continue;
      const entry: CounterpartyEntry = { label: knownLabel(c), phone: c.phone };
      section.known.push(entry);
    }
    // Saved only when it changed: an untouched step 8 stays unsaved.
    if (canonicalHash(section) !== canonicalHash(before)) {
      await saveSection(tx, 'counterparties', section, options);
      options = {};
    }
    await saveSection(tx, 'setupPeople', snapshot, options);

    return { contacts: snapshot.contacts.length, colleagues: snapshot.colleagues.length, known: knownContacts.length };
  });
}

/**
 * How many people in the package the snapshot does not hold — never
 * confirmed, or added by a technician after the owner confirmed. The
 * signature clears the whole package, so the summary tells the owner these
 * will not be added. Matched by phone, per list (a contact is not a colleague).
 */
export function unconfirmedSetupPeople(
  pkg: SetupPackage | null,
  snapshot: SetupPeopleSnapshot | undefined,
): number {
  if (pkg === null) return 0;
  const missing = (list: readonly { phone: string }[], confirmed: readonly { phone: string }[]) =>
    list.filter((p) => !confirmed.some((c) => samePhone(c.phone, p.phone))).length;
  return missing(pkg.contacts, snapshot?.contacts ?? []) + missing(pkg.colleagues, snapshot?.colleagues ?? []);
}

/**
 * At signature, inside the install transaction (`tx`), after
 * `installCharter(…charterVersion)`: write the confirmed contacts to memory,
 * insert the colleagues (a phone already in `business_colleagues` is not
 * inserted twice), and close the job. No snapshot, or an empty one, does
 * nothing. Emptying the package is the install's (`clearSetupPeople`), for
 * every person in it, confirmed or not.
 */
export async function applySetupPeople(
  tx: BusinessDb,
  snapshot: SetupPeopleSnapshot | undefined,
  charterVersion: string,
): Promise<void> {
  if (!tx.inTransaction) throw new Error('applySetupPeople: must run inside the install transaction');
  if (snapshot === undefined || (snapshot.contacts.length === 0 && snapshot.colleagues.length === 0)) return;

  // The owner's own act: the provenance is a literal, never a parameter.
  const job = await createJob(tx, { charterVersion, provenance: 'boss', title: CONFIRM_PEOPLE_JOB_TITLE });
  for (const c of snapshot.contacts) {
    await writeMemory(tx, {
      jobId: job.jobId,
      kind: 'entity',
      subjectKey: c.phone,
      body: { name: c.name, role: c.role, phone: c.phone },
      sourceRef: SETUP_PACKAGE_SOURCE_REF,
    });
  }
  const existing = await listColleagues(tx);
  for (const c of snapshot.colleagues) {
    if (existing.some((e) => samePhone(e.phone, c.phone))) continue;
    await addColleague(tx, { name: c.name, role: c.role, phone: c.phone });
  }

  const reason = 'אנשי הקשר והקולגות שאושרו בהקמה נרשמו בחתימה';
  for (const to of ['understand', 'plan', 'closed'] as const) {
    await transition(tx, job.jobId, { to, actor: 'human', reason });
  }

}
