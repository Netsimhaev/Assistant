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
 *
 * **These arrays are deliberately NOT frozen, and must stay that way.** The
 * final review of the delegation branch proposed `Object.freeze` on the
 * grounds that they are handed out by reference after compile — a fair reading
 * with no production mutator behind it. But the invariant at
 * `policy/positive-controls.test.ts` ("refuses an unowned tool even when an
 * allowlist names it") *pushes* `contract.sign` onto `ops.systems` and pops it
 * again, because asserting today's tables passes with or without the control:
 * the defect it locks is the ONE LINE someone adds later. Freezing would
 * silently convert that test into one that proves nothing — exactly the class
 * of failure this branch caught three times. A speculative hardening is not
 * worth a proven test.
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
    'agent.request_help',
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
  // `code_execution` was here and is gone. It is classified now
  // (`src/policy/classify.ts`), and the quarantine rule is that this agent
  // holds zero classified tools — it reads untrusted documents, so anything it
  // holds is something injected text can ask it to do.
  'know.reader': ['doc.fetch', 'memory.recall'],

  // The only agent permitted to write long-term memory.
  'know.memory': [
    'memory.write_entity',
    'memory.write_chunk',
    'memory.upsert_preference',
    'memory.retire',
    'memory.recall',
    'agent.request_help',
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
    'agent.request_help',
  ],

  // --- Production ---------------------------------------------------------
  // Produces an artifact; delivery is a separate gated action owned by comms.*
  'prod.docs': [
    'code_execution',
    'file.write',
    'memory.recall',
    'template.load',
    'agent.request_help',
  ],

  'prod.media': [
    'media.generate_image',
    'media.generate_video',
    'media.inspect',
    'brand.check',
    'media.publish',
    'file.write',
    'agent.request_help',
  ],

  // --- Governance ---------------------------------------------------------
  'gov.charter': ['charter.read', 'charter.propose_amendment', 'memory.recall'],
  'gov.risk': ['norms.query', 'charter.evaluate', 'memory.recall', 'agent.request_help'],
  'gov.verify': ['artifact.read', 'assert.evaluate', 'memory.recall', 'agent.request_help'],
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
/**
 * Every tool that writes long-term memory, named rather than matched.
 *
 * `memory.write_*` is a *prefix* pattern (`matchesPattern`), so it covered
 * `memory.write_entity` and `memory.write_chunk` and silently missed
 * `memory.upsert_preference` and `memory.retire` — two tools of the same action
 * class, left standing on allowlist absence alone. That is exactly the case
 * this table exists to double-cover, and for half of the class it did not. The
 * list is derived from nothing and written by hand on purpose: a wildcard is
 * what failed here, and the invariant in `capabilities.test.ts` fails loudly
 * if `memory.write_longterm` ever gains a fifth tool that is not added here.
 */
const LONGTERM_MEMORY_WRITES = [
  'memory.write_*',
  'memory.upsert_preference',
  'memory.retire',
] as const;

export const AGENT_DENYLISTS: Record<AgentId, string[]> = {
  'intake.triage': ['mail.send', 'wa.send_message', 'browser.*', ...LONGTERM_MEMORY_WRITES],
  'comms.email': ['browser.*', ...LONGTERM_MEMORY_WRITES],
  'comms.whatsapp': ['browser.*', ...LONGTERM_MEMORY_WRITES],
  'sched.meetings': ['mail.send', 'browser.*', ...LONGTERM_MEMORY_WRITES],
  'know.reader': [
    'mail.send',
    'wa.send_message',
    'browser.*',
    ...LONGTERM_MEMORY_WRITES,
    'file.write',
  ],
  'know.memory': ['mail.send', 'wa.send_message', 'browser.*'],
  'know.digest': ['mail.send', 'wa.send_message', 'browser.*', ...LONGTERM_MEMORY_WRITES],
  'ops.tasks': ['browser.*', ...LONGTERM_MEMORY_WRITES],
  'ops.web': ['mail.*', 'wa.*', ...LONGTERM_MEMORY_WRITES, 'crm.write', 'accounting.write'],
  'ops.systems': ['mail.send', 'wa.send_message', 'browser.*', ...LONGTERM_MEMORY_WRITES],
  'prod.docs': ['mail.*', 'wa.*', 'browser.*', ...LONGTERM_MEMORY_WRITES],
  'prod.media': ['mail.*', 'wa.*', 'browser.*', ...LONGTERM_MEMORY_WRITES],
  'gov.charter': ['mail.*', 'wa.*', 'browser.*', ...LONGTERM_MEMORY_WRITES],
  'gov.risk': ['mail.*', 'wa.*', 'browser.*', ...LONGTERM_MEMORY_WRITES],
  'gov.verify': ['mail.*', 'wa.*', 'browser.*', ...LONGTERM_MEMORY_WRITES],
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
