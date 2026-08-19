import { describe, expect, it } from 'vitest';
import { buildCharter } from '../test/fixtures.js';
import { compileCharter } from './compile.js';
import { verifyCharterSignature } from './sign.js';
import {
  BusinessCharter,
  KNOWN_TOOL_NAMES,
  UNOWNED_TOOL_NAMES,
  matchesToolPattern,
} from '../domain/charter.js';
import { classifiedToolNames, READ_ONLY_TOOLS } from '../policy/classify.js';
import { UNOWNED_TOOLS } from './capabilities.js';

describe('charter signing', () => {
  it('verifies a charter that has not been touched', () => {
    expect(verifyCharterSignature(buildCharter()).valid).toBe(true);
  });

  it('detects a raised money ceiling', () => {
    const charter = buildCharter();
    const tampered = {
      ...charter,
      money: { ...charter.money, dailyCeilingMinor: 99_000_000 },
    };

    const result = verifyCharterSignature(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/does not match its signature/);
  });

  it('detects a loosened autonomy level', () => {
    const charter = buildCharter();
    const tampered = {
      ...charter,
      autonomy: {
        ...charter.autonomy,
        base: { ...charter.autonomy.base, 'payment.make': 'auto' as const },
      },
    };

    expect(verifyCharterSignature(tampered).valid).toBe(false);
  });

  it('refuses to compile an unverified charter', () => {
    const charter = buildCharter();
    const tampered = {
      ...charter,
      forbidden: [],
    };

    expect(() => compileCharter(tampered)).toThrow(/refusing to compile an unverified charter/);
  });
});

describe('charter compilation', () => {
  it('carries the signed hash into the bundle so the gate can bind to it', () => {
    const charter = buildCharter();
    const bundle = compileCharter(charter);

    expect(bundle.charterVersion).toBe(charter.charterVersion);
    expect(bundle.contentHash).toBe(charter.signature.contentHash);
  });

  it('compiles forbidden rules into denials the gate can cite', () => {
    const bundle = compileCharter(buildCharter());
    const forbidden = bundle.rules.filter((r) => r.kind === 'forbidden');

    expect(forbidden.map((r) => r.id)).toContain('forbidden:no_customer_data_export');
    expect(forbidden.every((r) => r.description.length > 0)).toBe(true);
  });

  it('sorts doNotContact by match key instead of flattening it', () => {
    const bundle = compileCharter(buildCharter());
    expect(bundle.doNotContact.entityIds).toContain('c_blocked');
    expect(bundle.doNotContact.entityIds).not.toContain('c_812');
  });

  it('compiles a domain block into the bucket the gate can actually match', () => {
    // The flattened form put every match key into one list compared against
    // `counterpartyId`, so this entry compiled and then matched nothing at all.
    const bundle = compileCharter(
      buildCharter({ doNotContactEmailDomain: 'Rival-Legal.CO.il' }),
    );

    expect(bundle.doNotContact.emailDomains).toEqual(['rival-legal.co.il']);
    // Normalised at compile time, because the gate normalises the payload the
    // same way — a block defeated by capitalisation is not a block.
    expect(bundle.doNotContact.entityIds).not.toContain('rival-legal.co.il');
  });

  it('lists known counterparties so the risk layer need not trust the payload', () => {
    const bundle = compileCharter(buildCharter());
    expect(bundle.knownCounterparties.entityIds).toContain('c_812');
    // Split by key, so an id the payload supplies cannot match a *tag* and buy
    // a resolved-counterparty score it has not earned.
    expect(bundle.knownCounterparties.tags).not.toContain('c_812');
  });

  it('renders plain language stating the daily exposure in one sentence', () => {
    const bundle = compileCharter(buildCharter());
    // The owner signs this, so the number that bounds their worst day must be
    // in it, in words, not buried in JSON.
    expect(bundle.plainLanguage).toContain('₪10,000');
    expect(bundle.plainLanguage).toMatch(/החשיפה הכספית המקסימלית/);
  });

  it('gives every agent a prompt fragment carrying the business identity', () => {
    const bundle = compileCharter(buildCharter());
    for (const [agent, fragment] of Object.entries(bundle.promptFragments)) {
      expect(fragment, agent).toContain('דוגמה הנדסה');
    }
    // The quarantine agents must be told their input is data, not instructions.
    expect(bundle.promptFragments['intake.triage']).toMatch(/אינו אמין/);
    expect(bundle.promptFragments['know.reader']).toMatch(/אינו אמין/);
  });
});

describe('charter connections', () => {
  it('accepts a connection that names a known tool and no subprocessor', () => {
    const charter = buildCharter({
      connections: [
        {
          system: 'office-mail',
          label: 'תיבת המשרד',
          channel: 'api',
          serves: ['mail.send'],
          target: null,
          subprocessor: null,
        },
      ],
    });
    expect(BusinessCharter.safeParse(charter).success).toBe(true);
  });

  it('refuses a connection that serves a tool the registry does not know', () => {
    const charter = buildCharter();
    const broken = {
      ...charter,
      connections: [
        {
          system: 'ghost',
          label: 'לא קיים',
          channel: 'api' as const,
          serves: ['mail.teleport'],
          target: null,
          subprocessor: null,
        },
      ],
    };
    // Otherwise a connection can declare a tool that does not exist, and the
    // whole entry is dead policy.
    expect(BusinessCharter.safeParse(broken).success).toBe(false);
  });

  it('refuses a subprocessor the owner did not sign for', () => {
    const charter = buildCharter();
    const broken = {
      ...charter,
      connections: [
        {
          system: 'crm-via-zapier',
          label: 'CRM דרך Zapier',
          channel: 'api' as const,
          serves: ['crm.write'],
          target: null,
          subprocessor: 'zapier',
        },
      ],
      data: { ...charter.data, subprocessorsAllowed: ['anthropic'] },
    };
    // Every intermediary sees the payloads. Rejected at signing, not at run
    // time, for the same reason an unresolvable timezone is.
    expect(BusinessCharter.safeParse(broken).success).toBe(false);
  });

  it('refuses a connection serving a tool no agent can ever hold', () => {
    const charter = buildCharter();
    const broken = {
      ...charter,
      connections: [
        {
          system: 'sign-portal',
          label: 'פורטל חתימות',
          channel: 'api' as const,
          // Known to the policy layer but owned by no agent — reachable in
          // name only, which is the same dead-policy shape as an unknown tool.
          serves: ['contract.sign'],
          target: null,
          subprocessor: null,
        },
      ],
    };
    expect(BusinessCharter.safeParse(broken).success).toBe(false);
  });

  it('refuses two connections that share a system name', () => {
    const charter = buildCharter();
    const broken = {
      ...charter,
      connections: [
        {
          system: 'office-mail',
          label: 'תיבת המשרד',
          channel: 'api' as const,
          serves: ['mail.send'],
          target: null,
          subprocessor: null,
        },
        {
          system: 'office-mail',
          label: 'תיבת המשרד (שוב)',
          channel: 'browser' as const,
          serves: ['mail.draft'],
          target: null,
          subprocessor: null,
        },
      ],
    };
    expect(BusinessCharter.safeParse(broken).success).toBe(false);
  });

  it('refuses two connections serving the same tool for the same target', () => {
    const charter = buildCharter();
    const broken = {
      ...charter,
      connections: [
        {
          system: 'crm-a',
          label: 'CRM א',
          channel: 'api' as const,
          serves: ['crm.write'],
          target: 'supplier_a',
          subprocessor: null,
        },
        {
          system: 'crm-b',
          label: 'CRM ב',
          channel: 'api' as const,
          serves: ['crm.write'],
          target: 'supplier_a',
          subprocessor: null,
        },
      ],
    };
    expect(BusinessCharter.safeParse(broken).success).toBe(false);
  });

  it('accepts a specific target sitting beside a null catch-all for the same tool', () => {
    // Not an authoring mistake: the resolver prefers the specific connection
    // and falls back to the catch-all for every other target.
    const charter = buildCharter({
      connections: [
        {
          system: 'crm-a',
          label: 'CRM א',
          channel: 'api',
          serves: ['crm.write'],
          target: 'supplier_a',
          subprocessor: null,
        },
        {
          system: 'crm-default',
          label: 'CRM ברירת מחדל',
          channel: 'api',
          serves: ['crm.write'],
          target: null,
          subprocessor: null,
        },
      ],
    });
    expect(BusinessCharter.safeParse(charter).success).toBe(true);
  });

  it('the charter tool list agrees with the policy layer', () => {
    // charter.ts cannot import from policy/ without a layering cycle, so the
    // list is duplicated. This is what stops it drifting.
    const policy = new Set([...classifiedToolNames(), ...READ_ONLY_TOOLS]);
    expect([...policy].filter((t) => !KNOWN_TOOL_NAMES.has(t))).toEqual([]);
    expect([...KNOWN_TOOL_NAMES].filter((t) => !policy.has(t))).toEqual([]);
  });

  it('the unowned-tool list agrees with the capability layer', () => {
    expect([...UNOWNED_TOOL_NAMES].sort()).toEqual([...UNOWNED_TOOLS].sort());
  });

  it('matches unowned-tool patterns the same way the capability layer does', () => {
    // UNOWNED_TOOLS entries are patterns read through `matchesPattern` in
    // src/charter/capabilities.ts, where a trailing `*` is a prefix match.
    // The three entries today are literal, so the string-equality invariant
    // above would stay green even if this matching logic used plain
    // `Set.has()` — this proves the wildcard semantics themselves are
    // honoured, so a future wildcard entry (e.g. 'charter.*') cannot widen
    // what `serves` accepts on this side without widening it on the other.
    expect(matchesToolPattern('charter.apply_amendment', 'charter.*')).toBe(true);
    expect(matchesToolPattern('charter.read', 'charter.*')).toBe(true);
    expect(matchesToolPattern('crm.write', 'charter.*')).toBe(false);
    expect(matchesToolPattern('contract.sign', 'contract.sign')).toBe(true);
    expect(matchesToolPattern('contract.sign.v2', 'contract.sign')).toBe(false);
  });

  it('refuses a tool listed twice in the same connection with a message naming the mistake, not another connection', () => {
    const charter = buildCharter();
    const broken = {
      ...charter,
      connections: [
        {
          system: 'crm-a',
          label: 'CRM א',
          channel: 'api' as const,
          serves: ['crm.write', 'crm.write'],
          target: 'supplier_a',
          subprocessor: null,
        },
      ],
    };

    const result = BusinessCharter.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('serves'));
      expect(issue?.message).toMatch(/listed twice in this connection/);
      expect(issue?.message).not.toMatch(/another connection/);
    }
  });
});

describe('charter schema version', () => {
  it('refuses a charter still carrying the pre-connections schema version', () => {
    const charter = buildCharter();
    const stale = { ...charter, schemaVersion: '1.0' as const };

    // `BusinessCharter.parse` would otherwise fill in `connections: []` for a
    // charter that never signed over that field, changing the content hash
    // and failing as "does not match its signature" — the alarm meant for a
    // malicious edit, not a schema migration. The literal bump makes this
    // failure legible as a version mismatch instead.
    const result = BusinessCharter.safeParse(stale);
    expect(result.success).toBe(false);
    if (!result.success) {
      const versionIssue = result.error.issues.find(
        (issue) => issue.path[0] === 'schemaVersion',
      );
      expect(versionIssue).toBeDefined();
    }
  });
});
