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
  'code_execution',
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
  'file.write',
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

export function classifyAction(toolName: string): ActionClass | null {
  return TOOL_ACTION_CLASS[toolName] ?? null;
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
  return toolName in TOOL_ACTION_CLASS || READ_ONLY_TOOLS.has(toolName);
}

/**
 * Whether a tool call causes something to leave the instance.
 *
 * Drives the `outbound` kill-switch scope and the data-sensitivity dimension.
 * Browser navigation counts: it reaches a third-party host, and under an
 * outbound stop we do not want a session touching a supplier portal either.
 */
const OUTBOUND_TOOLS: ReadonlySet<string> = new Set([
  'mail.send',
  'wa.send_message',
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
    case 'email.reply':
      return hasThreadRef(input['inReplyTo']) ? 'email.reply' : 'email.initiate';
    case 'whatsapp.reply':
      return hasThreadRef(input['conversationId'])
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
      const op = input['operation'];
      if (op === 'move') return 'calendar.move';
      if (op === 'cancel') return 'calendar.cancel';
      return 'calendar.create';
    }
    default:
      return base;
  }
}
