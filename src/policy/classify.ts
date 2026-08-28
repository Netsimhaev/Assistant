import type { ActionClass } from '../domain/action.js';

/**
 * Map a tool call to the action class the policy layer reasons about.
 *
 * Returning `null` means "read-only" and the gate short-circuits to allow. That
 * makes this table security-relevant in one direction: a side-effecting tool
 * missing from it would be waved through. New write tools must be added here in
 * the same change that introduces them — the test suite asserts that every tool
 * in an agent allowlist is either classified or explicitly listed as read-only.
 */
const TOOL_ACTION_CLASS: Record<string, ActionClass> = {
  'mail.send': 'email.reply',
  'wa.send_message': 'whatsapp.reply',
  'calendar.write': 'calendar.create',
  'crm.write': 'crm.write',
  'accounting.write': 'accounting.write',
  'browser.submit_order': 'purchase.place',
  // Previously read-only. A hijacked session could therefore complete a
  // checkout with ordinary clicks and never touch the gated submit_order.
  'browser.click': 'browser.interact',
  'browser.fill': 'browser.interact',
  'credential.request_session': 'browser.session',
  'payment.charge': 'payment.make',
  'refund.issue': 'refund.issue',
  'quote.issue': 'quote.issue',
  'discount.grant': 'discount.grant',
  'commitment.make': 'commitment.make',
  'contract.sign': 'contract.sign',
  'data.export': 'data.export',
  'media.publish': 'media.publish',
  // Was read-only. A tool that writes to the filesystem is not a read, and
  // "read-only" here means "skips the gate entirely and leaves no audit row" —
  // so a write landing in `.git/hooks/pre-commit` or a shell rc file was
  // unrecorded code execution. It is classified now, which costs an agent
  // nothing it should have had.
  'file.write': 'artifact.write',
  // Same argument as `file.write` above, one step stronger. `code_execution`
  // sat in `READ_ONLY_TOOLS`, which does not mean "harmless" — it means the
  // call skips gate steps 5–10 and leaves no audit row at all, because steps
  // 1–4 do not log. It was also allowlisted for `know.reader`, the agent whose
  // input is untrusted by construction; the quarantine invariant passed only
  // because an unclassified tool is invisible to it. Classified here and
  // removed from that allowlist, so the invariant now actually covers it.
  'code_execution': 'artifact.write',
  'doc.deliver': 'doc.deliver',
  'memory.write_entity': 'memory.write_longterm',
  'memory.write_chunk': 'memory.write_longterm',
  'memory.upsert_preference': 'memory.write_longterm',
  'memory.retire': 'memory.write_longterm',
  'charter.apply_amendment': 'charter.amend',
};

/**
 * Tools that are known read-only. Listed explicitly rather than inferred, so
 * that a tool which is neither here nor in the class table is a *test failure*
 * rather than a silent allow.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'memory.recall',
  'memory.recall_shallow',
  'mail.draft',
  'charter.voice',
  'charter.read',
  'charter.evaluate',
  'charter.propose_amendment',
  'template.render',
  'template.load',
  'calendar.read',
  'calendar.propose_slots',
  'wa.can_send_freeform',
  'wa.conversation_state',
  'doc.fetch',
  'render.markdown',
  'chart.render',
  'tasks.read',
  'tasks.update_state',
  'followup.schedule',
  'crm.read',
  'accounting.read',
  'schema.map',
  'norms.query',
  'artifact.read',
  'assert.evaluate',
  'recipe.load',
  'recipe.save',
  'browser.navigate',
  'browser.snapshot',
  'browser.screenshot',
  'media.generate_image',
  'media.generate_video',
  'media.inspect',
  'brand.check',
  'escalate_to_human',
  'agent.request_help',
]);

/**
 * Tools that pull content from outside the instance's trust boundary into the
 * agent's context, where it could influence a later action.
 *
 * This is the input to the first-contact exemption: a job that has run any of
 * these can no longer claim its instruction came from the boss alone, because
 * the recipient or the wording may have been chosen by whoever wrote the
 * content. See `docs/superpowers/specs/2026-08-24-boss-provenance-chain-design.md`
 * §5.1 for the per-tool reasoning.
 *
 * A `Record<string, boolean>` and not a `Set`, for the reason
 * `NEVER_FULLY_AUTONOMOUS_TABLE` gives: a `Set` is maintained by hand and says
 * nothing when the tool list grows, so a newly added reader would land
 * silently outside the check. Every tool is written down with an explicit
 * answer.
 */
const INGESTS_EXTERNAL_CONTENT: Record<string, boolean> = {
  // — reads that bring in someone else's words —
  'doc.fetch': true,
  'browser.navigate': true,
  'browser.snapshot': true,
  'browser.screenshot': true,
  'browser.click': true,
  'browser.fill': true,
  'browser.submit_order': true,
  'crm.read': true,
  'accounting.read': true,
  'calendar.read': true,
  'calendar.propose_slots': true,
  'memory.recall': true,
  'memory.recall_shallow': true,
  'tasks.read': true,
  'artifact.read': true,
  'recipe.load': true,
  'media.inspect': true,
  'code_execution': true,
  // Delegates to another agent and returns its summary. `COLLABORATION_GRAPH`
  // routes comms.email, comms.whatsapp, prod.docs, prod.media and gov.verify
  // to know.reader, whose provenance defaults to unknown_external (it exists
  // to read content the business did not write) — so what comes back is, by
  // construction, a summary of content this job did not author.
  'agent.request_help': true,

  // — local composition, owner-authored data, and outbound writes —
  'mail.draft': false,
  'charter.voice': false,
  'charter.read': false,
  'charter.evaluate': false,
  'charter.propose_amendment': false,
  'template.render': false,
  'template.load': false,
  'wa.can_send_freeform': false,
  'wa.conversation_state': false,
  'render.markdown': false,
  'chart.render': false,
  'tasks.update_state': false,
  'followup.schedule': false,
  'schema.map': false,
  'norms.query': false,
  'assert.evaluate': false,
  'recipe.save': false,
  'media.generate_image': false,
  'media.generate_video': false,
  'brand.check': false,
  'escalate_to_human': false,
  'mail.send': false,
  'wa.send_message': false,
  'calendar.write': false,
  'crm.write': false,
  'accounting.write': false,
  'credential.request_session': false,
  'payment.charge': false,
  'refund.issue': false,
  'quote.issue': false,
  'discount.grant': false,
  'commitment.make': false,
  'contract.sign': false,
  'data.export': false,
  'media.publish': false,
  'file.write': false,
  'doc.deliver': false,
  'memory.write_entity': false,
  'memory.write_chunk': false,
  'memory.upsert_preference': false,
  'memory.retire': false,
  'charter.apply_amendment': false,
};

/**
 * Whether running this tool means the job has touched outside content.
 *
 * **An unknown tool answers `true`.** A name nobody classified is a name
 * nobody reasoned about, and the exemption this feeds must read that as "we
 * cannot vouch for this chain" — never as "nothing was read". The `?? true`
 * is the whole fail-safe.
 */
export function ingestsExternalContent(toolName: string): boolean {
  return INGESTS_EXTERNAL_CONTENT[toolName] ?? true;
}

/**
 * The tool names the table decides explicitly.
 *
 * Exists so the completeness invariant can be asserted without exporting the
 * record itself — a caller holding the raw table could mutate it and leave
 * `ingestsExternalContent` disagreeing with it. Mirrors `classifiedToolNames`.
 */
export function toolsWithIngestDecision(): string[] {
  return Object.keys(INGESTS_EXTERNAL_CONTENT);
}

export function classifyAction(toolName: string): ActionClass | null {
  // Own key only. `TOOL_ACTION_CLASS` is an object literal, so a bare index on
  // `'constructor'` returns the `Object` constructor — a function that would
  // then travel onward as if it were an `ActionClass`. See
  // `src/sdk/tool-name-lookup.test.ts`.
  return Object.hasOwn(TOOL_ACTION_CLASS, toolName) ? (TOOL_ACTION_CLASS[toolName] ?? null) : null;
}

/** Every tool that maps to an action class. Used by the reachability invariant. */
export function classifiedToolNames(): string[] {
  return Object.keys(TOOL_ACTION_CLASS);
}

/** Action classes a tool maps to directly. */
export function directlyMappedActionClasses(): ActionClass[] {
  return [...new Set(Object.values(TOOL_ACTION_CLASS))];
}

/**
 * Classes no tool names directly — `refineActionClass` derives them from the
 * payload. Listed explicitly so the reachability test can tell 'reached by
 * refinement' apart from 'orphaned', instead of treating both as fine.
 */
export const REFINEMENT_ONLY_CLASSES: readonly ActionClass[] = [
  'email.initiate',
  'whatsapp.initiate',
  'calendar.move',
  'calendar.cancel',
];

export function isKnownTool(toolName: string): boolean {
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so
  // `'constructor' in TOOL_ACTION_CLASS` is true and an inherited name counted
  // as a tool the policy knows.
  return Object.hasOwn(TOOL_ACTION_CLASS, toolName) || READ_ONLY_TOOLS.has(toolName);
}

/**
 * Whether a tool call causes something to leave the instance.
 *
 * Drives four things, which is why a tool missing from here is expensive:
 * the `outbound` kill-switch scope, the data-sensitivity dimension, whether
 * `evaluateToolCall` applies quiet hours, and whether it redacts the payload
 * at all — `redactedInput` is the untouched `toolInput` for a tool that is
 * not on this list. Since `runPlan` now hands `redactedInput` to a real
 * adapter, an omission here is a raw payload leaving the instance.
 *
 * Browser navigation counts: it reaches a third-party host, and under an
 * outbound stop we do not want a session touching a supplier portal either.
 *
 * `positive-controls.test.ts` locks the invariant that every classified tool
 * whose action class addresses a `person` or a `browser` is on this list. That
 * is what caught `calendar.write` and `credential.request_session`, both of
 * which sat in `TOOL_ACTION_CLASS` and not here — so a calendar invitation
 * reached an attendee, and a session request reached a host, with neither
 * redacted nor held out of quiet hours.
 */
const OUTBOUND_TOOLS: ReadonlySet<string> = new Set([
  'mail.send',
  'wa.send_message',
  // An invitation is delivered to attendees who are not the business.
  'calendar.write',
  // Opening an authenticated session reaches the host it is opened against.
  'credential.request_session',
  'crm.write',
  'accounting.write',
  'browser.navigate',
  'browser.click',
  'browser.fill',
  'browser.submit_order',
  'payment.charge',
  'refund.issue',
  'quote.issue',
  'discount.grant',
  'commitment.make',
  'contract.sign',
  'data.export',
  'media.publish',
  'doc.deliver',
  'media.generate_image',
  'media.generate_video',
]);

export function isOutbound(toolName: string): boolean {
  return OUTBOUND_TOOLS.has(toolName);
}

/**
 * Does the payload actually reference an existing thread?
 *
 * Tested positively — a non-empty string — rather than by excluding `undefined`.
 * The excluding form treated `inReplyTo: null` and `inReplyTo: ""` as a real
 * thread and downgraded `email.initiate` (approve_required) to `email.reply`
 * (auto_notify), which is precisely the wrong direction to be wrong in. Any
 * shape we do not recognise now yields the *stricter* class.
 */
function hasThreadRef(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Refine a base class using the payload.
 *
 * `mail.send` is `email.reply` by default but `email.initiate` when there is no
 * thread to reply to — a materially different risk profile, since a first
 * contact with an unknown party is exactly what the sensitive band is for.
 */
export function refineActionClass(
  base: ActionClass,
  input: Record<string, unknown>,
): ActionClass {
  switch (base) {
    // `Object.hasOwn` on both: a thread reference is the one field here whose
    // presence makes the class GENTLER — `email.reply` carries `auto_notify`
    // in the reference charter where `email.initiate` carries
    // `approve_required`. An inherited value must not buy that downgrade. The
    // amount and operation branches below deliberately keep reading through
    // the chain, because there presence makes the class stricter.
    case 'email.reply':
      return Object.hasOwn(input, 'inReplyTo') && hasThreadRef(input['inReplyTo'])
        ? 'email.reply'
        : 'email.initiate';
    case 'whatsapp.reply':
      return Object.hasOwn(input, 'conversationId') && hasThreadRef(input['conversationId'])
        ? 'whatsapp.reply'
        : 'whatsapp.initiate';
    case 'browser.interact': {
      // A click on a commit surface is a purchase, and is classified as one.
      //
      // The trigger is the amount the caller carries, never the button's label
      // or any other text from the page: the page is written by whoever
      // controls the site, so matching on "Buy now" would be reading the
      // attacker's own input as policy. The orchestrator reads the live total
      // from the DOM and puts it here, which is also what binds it to the
      // approved plan (docs/08-risks.md, control 4).
      const amount = input['amountMinor'];
      return typeof amount === 'number' && amount > 0 ? 'purchase.place' : 'browser.interact';
    }
    case 'calendar.create': {
      // An unrecognised operation yields the *strictest* class, matching the
      // rule stated for thread references above. The previous order fell
      // through to `calendar.create` — reversibility 20 instead of 60 — so
      // `operation: 'Cancel'` or `['cancel']` bought a gentler class than the
      // action deserved.
      const op = input['operation'];
      if (op === undefined || op === null || op === 'create') return 'calendar.create';
      if (op === 'move') return 'calendar.move';
      return 'calendar.cancel';
    }
    default:
      return base;
  }
}
