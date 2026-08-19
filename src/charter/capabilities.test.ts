import { describe, expect, it } from 'vitest';
import {
  AGENT_ALLOWLISTS,
  AGENT_DENYLISTS,
  COLLABORATION_GRAPH,
  UNOWNED_TOOLS,
  isToolPermitted,
} from './capabilities.js';
import {
  READ_ONLY_TOOLS,
  REFINEMENT_ONLY_CLASSES,
  classifiedToolNames,
  directlyMappedActionClasses,
} from '../policy/classify.js';
import { ACTION_ADDRESSEE, ActionClass, HOST_ADDRESSED_CLASSES } from '../domain/action.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileCharter } from './compile.js';
import { buildCharter } from '../test/fixtures.js';
import type { AgentId } from '../domain/audit.js';

const AGENTS = Object.keys(AGENT_ALLOWLISTS) as AgentId[];

/**
 * These are structural invariants, not behaviour tests. Each one encodes a way
 * the capability table can drift out of step with the policy layer and produce
 * either a dead rule or a silent hole.
 */
describe('capability table invariants', () => {
  it('every allowlisted tool is either classified or explicitly read-only', () => {
    const classified = new Set(classifiedToolNames());
    const unknown: string[] = [];

    for (const agent of AGENTS) {
      for (const tool of AGENT_ALLOWLISTS[agent]) {
        if (!classified.has(tool) && !READ_ONLY_TOOLS.has(tool)) {
          unknown.push(`${agent} → ${tool}`);
        }
      }
    }

    // An unclassified tool in an allowlist would be treated as read-only and
    // skip the gate entirely — a silent hole, not a loud failure.
    expect(unknown).toEqual([]);
  });

  it('every side-effecting tool is reachable by some agent, or deliberately unowned', () => {
    const owned = new Set(AGENTS.flatMap((agent) => AGENT_ALLOWLISTS[agent]));
    const orphaned = classifiedToolNames().filter(
      (tool) => !owned.has(tool) && !UNOWNED_TOOLS.includes(tool),
    );

    // An orphaned tool makes every charter rule about its action class dead
    // code: the capability layer denies first, so the rule is never consulted.
    expect(orphaned).toEqual([]);
  });

  it('every action class is reachable — no class the policy layer can never see', () => {
    const reachable = new Set<string>([
      ...directlyMappedActionClasses(),
      ...REFINEMENT_ONLY_CLASSES,
    ]);
    const orphaned = ActionClass.options.filter((cls) => !reachable.has(cls));

    // An orphaned class silently disables every rule written about it. The
    // charter can declare a ceiling, budget.ts can enforce it, and the whole
    // chain still never runs because no tool produces the class — which is
    // exactly what happened to discount.grant before this test existed.
    expect(orphaned).toEqual([]);
  });

  it('no tool appears in both an allowlist and its own denylist', () => {
    const contradictions: string[] = [];
    for (const agent of AGENTS) {
      for (const tool of AGENT_ALLOWLISTS[agent]) {
        if (!isToolPermitted(agent, tool)) {
          contradictions.push(`${agent} → ${tool}`);
        }
      }
    }
    expect(contradictions).toEqual([]);
  });

  it('the quarantine agents hold no side-effecting capability at all', () => {
    const classified = new Set(classifiedToolNames());
    for (const agent of ['intake.triage', 'know.reader'] as const) {
      const sideEffecting = AGENT_ALLOWLISTS[agent].filter((t) => classified.has(t));
      expect(sideEffecting, `${agent} must stay a pure reader`).toEqual([]);
    }
  });

  it('the browser operator cannot communicate, directly or by delegation', () => {
    for (const tool of ['mail.send', 'wa.send_message', 'doc.deliver', 'quote.issue']) {
      expect(isToolPermitted('ops.web', tool), tool).toBe(false);
    }
    // Nor indirectly: a hijacked session must not reach a comms agent by proxy.
    expect(COLLABORATION_GRAPH['ops.web']).toEqual([]);
  });

  it('every agent appears in the denylist and collaboration tables', () => {
    for (const agent of AGENTS) {
      expect(AGENT_DENYLISTS[agent], agent).toBeDefined();
      expect(COLLABORATION_GRAPH[agent], agent).toBeDefined();
    }
  });

  it('collaboration is one level deep — no agent can delegate to itself', () => {
    for (const agent of AGENTS) {
      expect(COLLABORATION_GRAPH[agent], agent).not.toContain(agent);
    }
  });
});

/**
 * Four of the defects found in review were the same defect: a charter field
 * that compiled into the bundle and was then read by nobody. The owner signs a
 * sentence, the compiler emits a number, and no gate step ever compares it.
 *
 * Type-checking cannot catch this — the field exists and is well-typed. So the
 * invariant is asserted against the source of the modules that make decisions:
 * every ceiling the compiler produces must be mentioned somewhere a decision is
 * made. A crude check, deliberately: it is looking for total absence, which is
 * what "compiled but unenforced" actually looks like.
 */
describe('compiled policy has a reader', () => {
  const GATE_SOURCES = ['../policy/budget.ts', '../policy/engine.ts', '../policy/risk.ts'].map(
    (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'),
  );

  it('every compiled ceiling is named somewhere in the gate', () => {
    const ceilings = compileCharter(buildCharter()).ceilings;
    const unread = Object.keys(ceilings).filter(
      (field) => !GATE_SOURCES.some((src) => src.includes(field)),
    );

    // `approvedSupplierCeilingMinor` sat here unread: the owner could sign
    // "auto-order up to X from this supplier" and nothing compared X to
    // anything.
    expect(unread).toEqual([]);
  });

  it('every do-not-contact match key is read by the gate', () => {
    const buckets = Object.keys(compileCharter(buildCharter()).doNotContact);
    const engine = GATE_SOURCES[1] ?? '';
    const unread = buckets.filter((bucket) => !engine.includes(bucket));

    // Three of these four used to compile into a flat list compared against
    // `counterpartyId` alone, so a block by domain, phone or tag matched
    // nothing at all while appearing in the signed document.
    expect(unread).toEqual([]);
  });
});

/**
 * The first-contact escalation is what forces a human onto any outbound action
 * whose counterparty the charter cannot resolve: `scoreVisibility` returns
 * `one_unknown`, `bandFor` turns that into `sensitive`, and `sensitive` forces
 * an approval regardless of the risk total.
 *
 * That escalation was briefly expressed as "every class except the ones that
 * address a person", which quietly swept in `crm.write` — an outbound write to
 * a system of record dropped from `sensitive` to `routine` and stopped needing
 * a human. The exemption is now an explicit two-element allowlist, and this
 * test is what keeps it that size.
 */
describe('the first-contact escalation covers everything it should', () => {
  it('exempts only the two browser classes, by name', () => {
    expect([...HOST_ADDRESSED_CLASSES].sort()).toEqual([
      'browser.interact',
      'browser.session',
    ]);
  });

  it('leaves every other action class inside the escalation', () => {
    const exempt = ActionClass.options.filter((cls) => HOST_ADDRESSED_CLASSES.has(cls));
    // A class added to the enum later must not fall out of the sensitive band
    // by omission — which is exactly how crm.write escaped it.
    expect(exempt).toHaveLength(2);
  });
});

describe('ACTION_ADDRESSEE stays total and the host bucket stays exactly the browser classes', () => {
  it('has an entry for every action class', () => {
    // `ACTION_ADDRESSEE` is a `Record<ActionClass, Addressee>`, so a missing
    // class is already a compile error — this assertion is the runtime
    // mirror of that, and it is what would catch the enum and the record
    // going out of sync via an `as` cast or a stale build.
    for (const cls of ActionClass.options) {
      expect(ACTION_ADDRESSEE[cls]).toBeDefined();
    }
    expect(Object.keys(ACTION_ADDRESSEE)).toHaveLength(ActionClass.options.length);
  });

  it('marks only the two browser classes as host-addressed', () => {
    const hostAddressed = ActionClass.options.filter(
      (cls) => ACTION_ADDRESSEE[cls] === 'host',
    );
    expect(hostAddressed.sort()).toEqual(['browser.interact', 'browser.session']);
  });
});
