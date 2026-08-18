import type { AgentId } from '../domain/audit.js';

/**
 * Per-agent tool allowlists — the coarse capability layer.
 *
 * This is enforced by the SDK before the model can even attempt a call, which
 * makes it the cheapest and most reliable control in the system: `ops.web`
 * simply does not have a mail tool in its list, so no prompt can make it send
 * email. There is nothing to inject *toward* (docs/08-risks.md, layer 3).
 *
 * The lists are static and identical for every business. They describe what an
 * agent *is*, not what a particular owner permits — that is the charter's job,
 * and it can only tighten from here, never widen.
 */
export const AGENT_ALLOWLISTS: Record<AgentId, string[]> = {
  // --- Front Office -------------------------------------------------------
  // The airlock. Touches the most hostile content, holds the least power.
  'intake.triage': ['memory.recall_shallow'],

  'comms.email': [
    'mail.draft',
    'mail.send',
    // Quotes and document delivery ride the mail channel. `prod.docs` produces
    // the artifact; handing it to a customer is a communications action and is
    // gated as one (docs/01-agents.md).
    'quote.issue',
    // A discount and a commitment are both made in correspondence, and both
    // are gated by the charter (maxDiscountPercent / commitment autonomy).
    'discount.grant',
    'commitment.make',
    'doc.deliver',
    'memory.recall',
    'charter.voice',
    'template.render',
    'agent.request_help',
  ],

  'comms.whatsapp': [
    'wa.send_message',
    'wa.can_send_freeform',
    'wa.conversation_state',
    'memory.recall',
    'escalate_to_human',
  ],

  'sched.meetings': [
    'calendar.read',
    'calendar.propose_slots',
    'calendar.write',
    'memory.recall',
    'agent.request_help',
  ],

  // --- Knowledge & Memory -------------------------------------------------
  // Reads untrusted content; holds zero capability by construction.
  'know.reader': ['doc.fetch', 'code_execution', 'memory.recall'],

  // The only agent permitted to write long-term memory.
  'know.memory': [
    'memory.write_entity',
    'memory.write_chunk',
    'memory.upsert_preference',
    'memory.retire',
    'memory.recall',
  ],

  // Receives a precomputed facts object; deliberately has no query tools.
  'know.digest': ['memory.recall', 'render.markdown', 'chart.render'],

  // --- Operations ---------------------------------------------------------
  'ops.tasks': [
    'tasks.read',
    'tasks.update_state',
    'followup.schedule',
    'memory.recall',
    'agent.request_help',
  ],

  // The most dangerous agent: hostile input *and* spend capability.
  // Note the absence of every communication tool — even fully hijacked, its
  // blast radius is purchases on one allowlisted domain, under a ceiling.
  'ops.web': [
    'browser.navigate',
    'browser.click',
    'browser.fill',
    'browser.snapshot',
    'browser.screenshot',
    // The one state-changing browser action. Every checkout goes through this
    // tool rather than a generic click, so the gate can bind it to an approval.
    'browser.submit_order',
    'credential.request_session',
    'recipe.load',
    'recipe.save',
  ],

  'ops.systems': [
    'crm.read',
    'crm.write',
    'accounting.read',
    'accounting.write',
    'refund.issue',
    'data.export',
    'schema.map',
    'memory.recall',
  ],

  // --- Production ---------------------------------------------------------
  // Produces an artifact; delivery is a separate gated action owned by comms.*
  'prod.docs': ['code_execution', 'file.write', 'memory.recall', 'template.load'],

  'prod.media': [
    'media.generate_image',
    'media.generate_video',
    'media.inspect',
    'brand.check',
    'media.publish',
    'file.write',
  ],

  // --- Governance ---------------------------------------------------------
  'gov.charter': ['charter.read', 'charter.propose_amendment', 'memory.recall'],
  'gov.risk': ['norms.query', 'charter.evaluate', 'memory.recall'],
  'gov.verify': ['artifact.read', 'assert.evaluate', 'memory.recall'],
};

/**
 * Deliberately owned by no agent: `contract.sign`, `payment.charge` and
 * `charter.apply_amendment`.
 *
 * These are unreachable by construction — there is no allowlist to remove them
 * from, so no charter edit, prompt, or approval can make them callable. A
 * charter `forbidden` rule naming one of them is therefore belt-and-braces
 * rather than the control: the capability layer denies first, which is why the
 * gate reports `tool_not_allowlisted` and not `forbidden` for them.
 */
export const UNOWNED_TOOLS: readonly string[] = [
  'contract.sign',
  'payment.charge',
  'charter.apply_amendment',
];

/**
 * Explicit denials, belt-and-braces over the allowlist.
 *
 * An allowlist already excludes everything absent from it. These entries exist
 * so that a future edit which widens an allowlist by accident still trips a
 * second, louder control for the cases where the consequence is severe.
 */
export const AGENT_DENYLISTS: Record<AgentId, string[]> = {
  'intake.triage': ['mail.send', 'wa.send_message', 'browser.*', 'memory.write_*'],
  'comms.email': ['browser.*', 'memory.write_*'],
  'comms.whatsapp': ['browser.*', 'memory.write_*'],
  'sched.meetings': ['mail.send', 'browser.*'],
  'know.reader': ['mail.send', 'wa.send_message', 'browser.*', 'memory.write_*', 'file.write'],
  'know.memory': ['mail.send', 'wa.send_message', 'browser.*'],
  'know.digest': ['mail.send', 'wa.send_message', 'browser.*', 'memory.write_*'],
  'ops.tasks': ['browser.*', 'memory.write_*'],
  'ops.web': ['mail.*', 'wa.*', 'memory.write_*', 'crm.write', 'accounting.write'],
  'ops.systems': ['mail.send', 'wa.send_message', 'browser.*', 'memory.write_*'],
  'prod.docs': ['mail.*', 'wa.*', 'browser.*', 'memory.write_*'],
  'prod.media': ['mail.*', 'wa.*', 'browser.*', 'memory.write_*'],
  'gov.charter': ['mail.*', 'wa.*', 'browser.*', 'memory.write_*'],
  'gov.risk': ['mail.*', 'wa.*', 'browser.*', 'memory.write_*'],
  'gov.verify': ['mail.*', 'wa.*', 'browser.*', 'memory.write_*'],
};

/**
 * Which agent may ask which for help. A static directed graph — an agent
 * cannot reach a capability indirectly that it cannot reach directly, because
 * constraints tighten monotonically down a delegation chain.
 */
export const COLLABORATION_GRAPH: Record<AgentId, AgentId[]> = {
  'intake.triage': [],
  'comms.email': ['know.reader', 'gov.charter'],
  'comms.whatsapp': ['know.reader', 'gov.charter'],
  'sched.meetings': ['comms.email', 'gov.charter'],
  'know.reader': [],
  'know.memory': ['gov.charter'],
  'know.digest': [],
  'ops.tasks': ['comms.email', 'comms.whatsapp', 'gov.charter'],
  // Deliberately empty: the browser operator delegates to nobody. A hijacked
  // session must not be able to reach a communication tool by proxy.
  'ops.web': [],
  'ops.systems': ['gov.charter'],
  'prod.docs': ['know.reader'],
  'prod.media': ['know.reader'],
  'gov.charter': [],
  'gov.risk': ['gov.charter'],
  'gov.verify': ['know.reader'],
};

/** Wildcard-aware match: `browser.*` matches `browser.click`. */
export function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}

/**
 * Coarse capability check. Denylist wins over allowlist — a tool named in both
 * is denied, because the safer reading of a contradiction is the restrictive one.
 */
export function isToolPermitted(agent: AgentId, toolName: string): boolean {
  // Enforced positively rather than by absence from every allowlist. The
  // comment said these were "unreachable by construction"; the only code that
  // read the list was a test *exemption*, so one line added to an allowlist
  // would have made contract.sign reachable with every invariant still green.
  if (UNOWNED_TOOLS.some((pattern) => matchesPattern(toolName, pattern))) return false;

  const denied = AGENT_DENYLISTS[agent].some((p) => matchesPattern(toolName, p));
  if (denied) return false;
  return AGENT_ALLOWLISTS[agent].some((p) => matchesPattern(toolName, p));
}
