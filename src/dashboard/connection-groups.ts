/**
 * Which heading a connection appears under on the `/connections` screen —
 * derived from the tool names it serves, never from a field the charter
 * carries.
 *
 * The charter has no "kind" for a connection: `CharterConnection`
 * (`domain/connection.ts`) carries `system`, `label`, `channel`, `serves`,
 * `target` and `subprocessor` — nothing that names a category. It must not
 * grow one just to put a heading over a list. `serves` is part of the
 * SIGNED, hashed charter (`compileCharter`, `verifyCharterSignature`), so
 * adding a field to it is a schema-version bump that forces every existing
 * signed charter to be re-signed before it can load again — a price this
 * project paid two days ago for the `connections` array itself (see
 * `domain/charter.ts`'s `schemaVersion` history) and does not want to pay a
 * second time for a screen's own display grouping.
 *
 * **Display only, and it must stay that way.** Nothing under `src/policy/`
 * imports this module, and nothing ever should. A group computed here from
 * `serves` reads exactly like a real classification —
 * `groupForServes(['wa.send_message'])` returning `'whatsapp'` looks the same
 * shape as `classifyAction('wa.send_message')` returning `'whatsapp.reply'`
 * — but it carries no charter version, no signature and no autonomy ceiling
 * behind it. A gate check that read this value would be trusting a label a
 * screen invented for a legend, not a rule the owner signed. That is the
 * exact shape of convenience this project already names and refuses twice
 * over: `BROWSER_ADDRESSED_CLASSES` and `ENTAILED_INTERNAL_CLASSES` are both
 * positive, hand-maintained lists for precisely this reason ("a label that
 * becomes a permission is how convenience turns into a bypass"). This module
 * is a third instance of the same rule, one layer further from policy than
 * either of them: it never reaches `evaluateToolCall` at all, and it must
 * not start.
 *
 * The mapping is **positive**: a recognised tool-name prefix names a group,
 * and a connection whose tools match none of them falls under `'other'` —
 * explicitly, never by omission and never hidden. A negative rule ("anything
 * that is not mail/calendar/crm/accounting/whatsapp is a CRM", say) would
 * silently reclassify a connection nobody has thought about yet into
 * whichever bucket happened to be the fallthrough; `'other'` says plainly "we
 * could not name this," which is the honest answer and never a concealment
 * (`CLAUDE.md`, "בקרה נכתבת בחיוב, לעולם לא בשלילה" — three prior incidents
 * in this codebase from writing a control as "everything that is not X").
 *
 * `'other'` is reached only by a real, known, owned tool whose prefix simply
 * has no heading of its own (`browser.click`, `payment.charge`,
 * `data.export`, ...) — never by a made-up tool name. `BusinessCharter`'s own
 * `superRefine` (`domain/charter.ts`) already refuses a `serves` entry naming
 * a tool that does not exist (`isKnownToolName`) or one owned by no agent
 * (`isUnownedToolName`) before a charter can even be signed, so this module
 * never has to reject anything on that account — `serves` in a charter this
 * code will ever read is guaranteed to be real tool names, some of which
 * simply are not one of the five families with a heading.
 */

export type ConnectionGroup = 'mail' | 'calendar' | 'crm' | 'accounting' | 'whatsapp' | 'other';

/** The heading text for each group, as the owner reads it on the screen. */
export const GROUP_LABELS: Record<ConnectionGroup, string> = {
  mail: 'חיבור דואר',
  calendar: 'חיבור יומן',
  crm: 'חיבור CRM',
  accounting: 'חיבור הנהלת חשבונות',
  whatsapp: 'חיבור וואטסאפ',
  other: 'אחר',
};

/**
 * Display order for the screen. `Record` key order is not something this
 * codebase treats as load-bearing anywhere else (`renderCatalogue` sorts
 * explicitly for the identical reason), so the order the headings appear in
 * is fixed here once rather than left to rely on `GROUP_LABELS`'s own
 * insertion order.
 */
export const CONNECTION_GROUP_ORDER: readonly ConnectionGroup[] = [
  'mail',
  'calendar',
  'crm',
  'accounting',
  'whatsapp',
  'other',
];

/**
 * Tool-name prefix (the segment before the first `.`) → group. Matches the
 * tool families this codebase's own classifier already carries for these
 * systems (`src/policy/classify.ts`'s `TOOL_ACTION_CLASS`: `mail.send`,
 * `wa.send_message`, `calendar.write`/`calendar.read`,
 * `crm.write`/`crm.read`, `accounting.write`/`accounting.read`). A prefix
 * absent from this table is not a gap to fill in by guessing — it is every
 * OTHER tool family this project has (`browser.*`, `memory.*`, `payment.*`,
 * `media.*`, ...), none of which has a connection heading of its own, and
 * all of which belong under `'other'`.
 */
const PREFIX_TO_GROUP: Readonly<Record<string, ConnectionGroup>> = {
  mail: 'mail',
  calendar: 'calendar',
  crm: 'crm',
  accounting: 'accounting',
  wa: 'whatsapp',
};

/**
 * The group a connection's tools put it under.
 *
 * The first `serves` entry whose prefix is recognised decides it. A
 * connection realistically serves tools from one family — the charter's own
 * `serves: z.array(...).min(1)` groups related tool names together already
 * — so requiring every entry to agree would only make one stray, unrelated
 * tool name in the list capable of pushing an otherwise-ordinary connection
 * into `'other'`.
 *
 * `Object.hasOwn`, not a bare index lookup with a truthiness check — the
 * same guard this codebase already requires everywhere a missing key must
 * mean "not recognised" (`SDK_TO_INTERNAL`, `TOOL_ACTION_CLASS`,
 * `isKnownTool`): a tool literally named `constructor` or `toString` must
 * not resolve through the prototype chain to something that looks like a
 * match.
 */
export function groupForServes(serves: readonly string[]): ConnectionGroup {
  for (const tool of serves) {
    const prefix = tool.split('.')[0] ?? '';
    if (Object.hasOwn(PREFIX_TO_GROUP, prefix)) {
      const group = PREFIX_TO_GROUP[prefix];
      if (group !== undefined) return group;
    }
  }
  return 'other';
}
