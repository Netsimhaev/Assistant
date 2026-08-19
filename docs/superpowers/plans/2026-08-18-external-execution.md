# External Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the system the ability to perform real actions in external systems, with a signed registry in code — never the model — deciding which channel each action goes through.

**Architecture:** The charter gains a signed `connections` list saying which systems are connected, on which channel (`api` or `browser`), and which tools they serve. A `connection_bindings` table says only whether a connection currently works — it can narrow, never widen. `resolveChannel` maps (toolName, targetId) to a system, and `runPlan` builds the step's `perform` callback from that system's `ExternalAdapter`. The first adapter sends mail over SMTP; the browser adapter is registered from day one and returns `browser_not_implemented`.

**Tech Stack:** TypeScript (NodeNext ESM), zod v4, PostgreSQL 17, vitest, nodemailer (new).

**Spec:** [docs/superpowers/specs/2026-08-18-external-execution-design.md](../specs/2026-08-18-external-execution-design.md)

## Global Constraints

- **`.js` extension on every relative import**, including from `.ts` files. Required by `NodeNext` + `"type": "module"`.
- **Three tsconfig flags bite:** `noUncheckedIndexedAccess` (forces `rows[0]?.x`), `exactOptionalPropertyTypes` (forces conditional spread: `x !== undefined ? { x } : {}`), `verbatimModuleSyntax` (forces `import type` for type-only imports).
- **Hebrew for humans, English for code.** Denial reasons and docs in Hebrew; identifiers, comments and internal errors in English.
- **Tests require real Postgres.** No mocks. `npm test` uses `TEST_DATABASE_URL`; run `npm run migrate:test` after adding a migration.
- **A zod schema and its inferred type share one name:** `export const X = z.object({...}); export type X = z.infer<typeof X>;`
- **DB row convention:** private `interface XRow` (snake_case) + a `toX(row)` mapper (camelCase) in every module that reads rows.
- **Every new guard must be verified to fail against the code without it.** A test that passes both before and after protects nothing.
- **Money is always an integer in minor units.**
- **New write tool = two edits:** `TOOL_ACTION_CLASS` in `src/policy/classify.ts` AND an agent allowlist in `src/charter/capabilities.ts`. This plan adds no new tools, but touching either table requires both.

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `src/domain/connection.ts` | `CharterConnection`, `ConnectionBinding`, `ChannelResolution`, `CONNECTION_CHANNELS` |
| `src/db/migrations/003_connection_bindings.sql` | The operational table |
| `src/orchestrator/bindings.ts` | Read/write `connection_bindings` |
| `src/orchestrator/channels.ts` | `resolveChannel`, `deriveTargetId` |
| `src/orchestrator/adapters/types.ts` | `ExternalAdapter`, `AdapterCall`, `AdapterResult` |
| `src/orchestrator/adapters/registry.ts` | `AdapterRegistry` — lookup by system, injectable |
| `src/orchestrator/adapters/browser.ts` | Placeholder returning `browser_not_implemented` |
| `src/orchestrator/adapters/mail.ts` | SMTP adapter for `mail.send` |
| `src/orchestrator/credentials.ts` | `CredentialSource` + env-backed implementation |
| `src/orchestrator/adapters/contract.ts` | Shared contract suite every adapter must pass |
| `src/orchestrator/channels.test.ts` | Resolver tests (pure, no DB) |
| `src/orchestrator/adapters/adapters.test.ts` | Contract suite applied to each adapter |
| `src/orchestrator/external.test.ts` | End-to-end plan → gate → adapter, plus structural invariants |

**Modify**

| File | Change |
|---|---|
| `src/domain/charter.ts` | `connections` key + signing-time validation |
| `src/domain/policy.ts` | `connections` in `PolicyBundle` |
| `src/charter/compile.ts` | Compile `connections` |
| `src/test/fixtures.ts` | `connections` override |
| `src/orchestrator/run-plan.ts` | Channel feasibility at plan validation; build `perform` from the adapter |
| `src/orchestrator/execute.ts` | Wrap adapter throw; map `retryable` to `followup` |
| `src/test/db.ts` | Truncate the new table |
| `CLAUDE.md` | The narrowing invariant and the three interface decisions |

---

## Task 1: Charter declares connections

**Files:**
- Modify: `src/domain/charter.ts`
- Create: `src/domain/connection.ts`
- Modify: `src/test/fixtures.ts`
- Test: `src/charter/sign.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `CharterConnection` (type + schema), `CONNECTION_CHANNELS`, and `BusinessCharter.connections: CharterConnection[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/charter/sign.test.ts`:

```ts
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
});
```

Add the import at the top of the file:

```ts
import { BusinessCharter } from '../domain/charter.js';
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/charter/sign.test.ts -t "charter connections"`
Expected: FAIL — `buildCharter` does not accept `connections`.

- [ ] **Step 3: Create the domain types**

Create `src/domain/connection.ts`:

```ts
import { z } from 'zod';

/** The two ways an action can reach the outside world. */
export const CONNECTION_CHANNELS = ['api', 'browser'] as const;

/**
 * A connection the owner has signed for.
 *
 * `channel` is the load-bearing field. "Use the browser when there is no API"
 * is a decision about how much authority to hand out, and it is signed here
 * per system rather than made at run time — a page an attacker wrote must not
 * be able to argue the system into the stronger channel.
 */
export const CharterConnection = z.object({
  system: z.string().min(1),
  /** What the owner reads in the plain-language charter. */
  label: z.string().min(1),
  channel: z.enum(CONNECTION_CHANNELS),
  /** Internal tool names this connection serves. */
  serves: z.array(z.string().min(1)).min(1),
  /** A specific counterparty or supplier, or null for every target. */
  target: z.string().nullable(),
  /** Third party that processes the payload on the way out; null is direct. */
  subprocessor: z.string().nullable(),
});
export type CharterConnection = z.infer<typeof CharterConnection>;

/** The operational half: whether a permitted connection currently works. */
export const ConnectionBinding = z.object({
  system: z.string().min(1),
  status: z.enum(['live', 'disconnected', 'error']),
  endpoint: z.string().nullable(),
  /** A POINTER to a secret. Never the secret. */
  credentialRef: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type ConnectionBinding = z.infer<typeof ConnectionBinding>;
```

- [ ] **Step 4: Add the key to the charter with signing-time validation**

In `src/domain/charter.ts`, add the import at the top:

```ts
import { CharterConnection } from './connection.js';
```

Add to the `BusinessCharter` object, after `counterparties`:

```ts
  connections: z.array(CharterConnection).default([]),
```

Then wrap the whole object with a refinement. Replace the closing `});` of `BusinessCharter` with:

```ts
})
  .superRefine((charter, ctx) => {
    for (const [index, connection] of charter.connections.entries()) {
      // A connection serving a tool that does not exist is dead policy: it
      // compiles, appears in the signed document, and can never be selected.
      for (const tool of connection.serves) {
        if (!isKnownToolName(tool)) {
          ctx.addIssue({
            code: 'custom',
            path: ['connections', index, 'serves'],
            message: `unknown tool "${tool}"`,
          });
        }
      }
      // Every intermediary sees the payload, which is customer correspondence.
      if (
        connection.subprocessor !== null &&
        !charter.data.subprocessorsAllowed.includes(connection.subprocessor)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['connections', index, 'subprocessor'],
          message: `subprocessor "${connection.subprocessor}" is not in data.subprocessorsAllowed`,
        });
      }
    }
  });
```

`src/domain/charter.ts` must not import from `src/policy/`, which would create a
cycle. Add a small local predicate near the top of the file instead:

```ts
/**
 * Is this a tool the policy layer knows?
 *
 * Duplicated deliberately rather than imported from `src/policy/classify.ts`:
 * domain must not depend on policy. The structural test in Task 8 asserts the
 * two lists agree, so the duplication cannot drift silently.
 */
function isKnownToolName(tool: string): boolean {
  return KNOWN_TOOL_NAMES.has(tool);
}
```

And export the set so the structural test can compare it:

```ts
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mail.send', 'mail.draft', 'wa.send_message', 'calendar.write', 'calendar.read',
  'crm.read', 'crm.write', 'accounting.read', 'accounting.write',
  'browser.navigate', 'browser.click', 'browser.fill', 'browser.snapshot',
  'browser.screenshot', 'browser.submit_order', 'credential.request_session',
  'payment.charge', 'refund.issue', 'quote.issue', 'discount.grant',
  'commitment.make', 'contract.sign', 'data.export', 'media.publish',
  'doc.deliver', 'doc.fetch', 'file.write', 'code_execution',
  'memory.recall', 'memory.recall_shallow', 'memory.write_entity',
  'memory.write_chunk', 'memory.upsert_preference', 'memory.retire',
  'charter.apply_amendment', 'charter.read', 'charter.evaluate',
  'charter.propose_amendment', 'charter.voice', 'template.render',
  'template.load', 'calendar.propose_slots', 'wa.can_send_freeform',
  'wa.conversation_state', 'render.markdown', 'chart.render', 'tasks.read',
  'tasks.update_state', 'followup.schedule', 'schema.map', 'norms.query',
  'artifact.read', 'assert.evaluate', 'recipe.load', 'recipe.save',
  'media.generate_image', 'media.generate_video', 'media.inspect',
  'brand.check', 'escalate_to_human', 'agent.request_help',
]);
```

- [ ] **Step 5: Add the fixture override**

In `src/test/fixtures.ts`, add to `CharterOverrides`:

```ts
  /** Connections the charter declares. Empty by default. */
  connections?: CharterConnection[];
```

Add the import:

```ts
import type { CharterConnection } from '../domain/connection.js';
```

Add to the `unsigned` object, after `counterparties`:

```ts
    connections: overrides.connections ?? [],
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx vitest run src/charter/sign.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 7: Run the full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/domain/connection.ts src/domain/charter.ts src/test/fixtures.ts src/charter/sign.test.ts
git commit -m "Charter declares external connections, validated at signing

The channel is signed per system rather than chosen at run time: deciding
between an API and a browser is deciding how much authority to hand out, and
a page an attacker wrote must not be able to argue for the stronger one.

Two things are refused at signing rather than at run time, for the same
reason an unresolvable timezone is: a connection serving a tool the registry
does not know (dead policy), and a subprocessor the owner did not sign for
(an intermediary that would see customer correspondence)."
```

---

## Task 2: Compile connections into the bundle

**Files:**
- Modify: `src/domain/policy.ts`
- Modify: `src/charter/compile.ts`
- Test: `src/charter/sign.test.ts`

**Interfaces:**
- Consumes: `CharterConnection` from Task 1
- Produces: `PolicyBundle.connections: CharterConnection[]`

- [ ] **Step 1: Write the failing test**

Append to the `charter compilation` describe block in `src/charter/sign.test.ts`:

```ts
  it('carries connections into the bundle the gate and planner read', () => {
    const bundle = compileCharter(
      buildCharter({
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
      }),
    );

    expect(bundle.connections).toHaveLength(1);
    expect(bundle.connections[0]?.channel).toBe('api');
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/charter/sign.test.ts -t "carries connections"`
Expected: FAIL — `bundle.connections` is undefined.

- [ ] **Step 3: Add the field to the bundle schema**

In `src/domain/policy.ts`, add the import:

```ts
import { CharterConnection } from './connection.js';
```

Add to the `PolicyBundle` object, after `knownCounterparties`:

```ts
  /**
   * Systems this business is connected to, and on which channel.
   *
   * Carried into the bundle rather than read from the charter document so the
   * resolver reads the same artefact the gate does — a run holding a stale
   * bundle resolves channels from the same stale policy it is judged against.
   */
  connections: z.array(CharterConnection),
```

- [ ] **Step 4: Compile it**

In `src/charter/compile.ts`, add to the returned object, after `knownCounterparties`:

```ts
    connections: charter.connections,
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/domain/policy.ts src/charter/compile.ts src/charter/sign.test.ts
git commit -m "Compile connections into the policy bundle

Read from the bundle rather than the charter document so a run holding a
stale bundle resolves channels from the same stale policy it is judged
against."
```

---

## Task 3: The operational table

**Files:**
- Create: `src/db/migrations/003_connection_bindings.sql`
- Create: `src/orchestrator/bindings.ts`
- Modify: `src/test/db.ts`
- Test: `src/orchestrator/channels.test.ts`

**Interfaces:**
- Consumes: `ConnectionBinding` from Task 1
- Produces: `upsertBinding(binding, options)`, `loadBindings(options): Promise<ConnectionBinding[]>`

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/003_connection_bindings.sql`:

```sql
-- Whether a connection the charter permits currently works.
--
-- Deliberately has NO channel column. The charter is the only source of truth
-- for what is permitted and on which channel; this table can narrow a
-- permitted connection to unusable, and can do nothing else. Adding a channel
-- here would create a second, unsigned place where authority is decided.
--
-- No foreign key to charter_versions: a connection survives a charter
-- replacement, and whether it matches a declared system is checked when the
-- channel is resolved rather than when the row is written.

CREATE TABLE connection_bindings (
    business_id     TEXT        NOT NULL,
    system          TEXT        NOT NULL,
    status          TEXT        NOT NULL,
    endpoint        TEXT,
    -- A POINTER to a secret. Never the secret itself.
    credential_ref  TEXT,
    last_ok_at      TIMESTAMPTZ,
    last_error      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, system),
    CONSTRAINT connection_status_known
        CHECK (status IN ('live', 'disconnected', 'error'))
);
```

- [ ] **Step 2: Add the table to the test reset**

In `src/test/db.ts`, add `connection_bindings,` to the `TRUNCATE TABLE` list.

- [ ] **Step 3: Write the failing test**

Create `src/orchestrator/channels.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { loadBindings, upsertBinding } from './bindings.js';

const BUSINESS = 'test-business';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('connection bindings', () => {
  it('stores a binding and reads it back', async () => {
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: 'smtp.example.com:587',
        credentialRef: 'OFFICE_MAIL',
        lastOkAt: null,
        lastError: null,
      },
      { businessId: BUSINESS },
    );

    const bindings = await loadBindings({ businessId: BUSINESS });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.status).toBe('live');
    expect(bindings[0]?.credentialRef).toBe('OFFICE_MAIL');
  });

  it('replaces a binding for the same system rather than duplicating it', async () => {
    const base = {
      system: 'office-mail',
      status: 'live' as const,
      endpoint: null,
      credentialRef: null,
      lastOkAt: null,
      lastError: null,
    };
    await upsertBinding(base, { businessId: BUSINESS });
    await upsertBinding({ ...base, status: 'error', lastError: 'auth failed' }, {
      businessId: BUSINESS,
    });

    const bindings = await loadBindings({ businessId: BUSINESS });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.status).toBe('error');
  });

  it('keeps one business out of another business bindings', async () => {
    await upsertBinding(
      {
        system: 'office-mail',
        status: 'live',
        endpoint: null,
        credentialRef: null,
        lastOkAt: null,
        lastError: null,
      },
      { businessId: 'other-business' },
    );
    expect(await loadBindings({ businessId: BUSINESS })).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test and verify it fails**

Run: `npm run migrate:test && npx vitest run src/orchestrator/channels.test.ts`
Expected: FAIL — `./bindings.js` does not exist.

- [ ] **Step 5: Implement the store**

Create `src/orchestrator/bindings.ts`:

```ts
import { config } from '../config.js';
import { ConnectionBinding } from '../domain/connection.js';
import { getPool, type Queryable } from '../db/pool.js';

interface BindingRow {
  system: string;
  status: string;
  endpoint: string | null;
  credential_ref: string | null;
  last_ok_at: Date | null;
  last_error: string | null;
}

function toBinding(row: BindingRow): ConnectionBinding {
  return ConnectionBinding.parse({
    system: row.system,
    status: row.status,
    endpoint: row.endpoint,
    credentialRef: row.credential_ref,
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    lastError: row.last_error,
  });
}

export async function loadBindings(
  options: { businessId?: string; db?: Queryable } = {},
): Promise<ConnectionBinding[]> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<BindingRow>(
    `SELECT system, status, endpoint, credential_ref, last_ok_at, last_error
       FROM connection_bindings
      WHERE business_id = $1
      ORDER BY system`,
    [options.businessId ?? config.businessId],
  );
  return rows.map(toBinding);
}

export async function upsertBinding(
  binding: ConnectionBinding,
  options: { businessId?: string; db?: Queryable } = {},
): Promise<void> {
  const db = options.db ?? getPool();
  await db.query(
    `INSERT INTO connection_bindings
       (business_id, system, status, endpoint, credential_ref, last_ok_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (business_id, system) DO UPDATE
       SET status = EXCLUDED.status,
           endpoint = EXCLUDED.endpoint,
           credential_ref = EXCLUDED.credential_ref,
           last_ok_at = EXCLUDED.last_ok_at,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
    [
      options.businessId ?? config.businessId,
      binding.system,
      binding.status,
      binding.endpoint,
      binding.credentialRef,
      binding.lastOkAt,
      binding.lastError,
    ],
  );
}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run src/orchestrator/channels.test.ts`
Expected: typecheck clean, 3 tests pass.

- [ ] **Step 7: Commit**

```bash
npm run migrate && npm run migrate:test
git add src/db/migrations/003_connection_bindings.sql src/orchestrator/bindings.ts src/test/db.ts src/orchestrator/channels.test.ts
git commit -m "Connection bindings table: whether a permitted connection works

No channel column, deliberately. The charter is the only source of truth for
what is permitted and how; this table can narrow a permitted connection to
unusable and can do nothing else."
```

---

## Task 4: The resolver

**Files:**
- Create: `src/orchestrator/channels.ts`
- Test: `src/orchestrator/channels.test.ts`

**Interfaces:**
- Consumes: `PolicyBundle.connections` (Task 2), `ConnectionBinding` (Task 1)
- Produces: `resolveChannel(bundle, bindings, toolName, targetId): ChannelResolution`, `deriveTargetId(input): string | null`

- [ ] **Step 1: Write the failing tests**

Append to `src/orchestrator/channels.test.ts`:

```ts
import { buildCharter } from '../test/fixtures.js';
import { compileCharter } from '../charter/compile.js';
import type { CharterConnection } from '../domain/connection.js';
import { deriveTargetId, resolveChannel } from './channels.js';

function conn(over: Partial<CharterConnection> = {}): CharterConnection {
  return {
    system: 'office-mail',
    label: 'תיבת המשרד',
    channel: 'api',
    serves: ['mail.send'],
    target: null,
    subprocessor: null,
    ...over,
  };
}

function bundleWith(connections: CharterConnection[]) {
  return compileCharter(buildCharter({ connections }));
}

const LIVE = {
  system: 'office-mail',
  status: 'live' as const,
  endpoint: null,
  credentialRef: null,
  lastOkAt: null,
  lastError: null,
};

describe('resolving a channel', () => {
  it('resolves a tool to the system that serves it', () => {
    const result = resolveChannel(bundleWith([conn()]), [LIVE], 'mail.send', null);
    expect(result).toEqual({ status: 'resolved', system: 'office-mail', channel: 'api' });
  });

  it('prefers an exact target over the catch-all', () => {
    const bundle = bundleWith([
      conn({ system: 'generic', serves: ['browser.submit_order'], target: null }),
      conn({
        system: 'supplier-a-api',
        serves: ['browser.submit_order'],
        target: 'supplier-a',
      }),
    ]);
    const bindings = [
      { ...LIVE, system: 'generic' },
      { ...LIVE, system: 'supplier-a-api' },
    ];

    const result = resolveChannel(bundle, bindings, 'browser.submit_order', 'supplier-a');
    expect(result).toEqual({
      status: 'resolved',
      system: 'supplier-a-api',
      channel: 'api',
    });
  });

  it('refuses when two connections match at the same specificity', () => {
    const bundle = bundleWith([
      conn({ system: 'mail-a' }),
      conn({ system: 'mail-b' }),
    ]);
    const bindings = [
      { ...LIVE, system: 'mail-a' },
      { ...LIVE, system: 'mail-b' },
    ];

    // Array order deciding between two policies looks like a decision and
    // behaves like an accident.
    const result = resolveChannel(bundle, bindings, 'mail.send', null);
    expect(result.status).toBe('ambiguous');
  });

  it('refuses a tool no connection serves', () => {
    const result = resolveChannel(bundleWith([conn()]), [LIVE], 'crm.write', null);
    expect(result.status).toBe('no_channel');
  });

  it('reports a permitted connection with no live binding as unavailable', () => {
    const result = resolveChannel(bundleWith([conn()]), [], 'mail.send', null);
    expect(result).toEqual({
      status: 'unavailable',
      system: 'office-mail',
      reason: 'no binding',
    });
  });

  it('reports a disconnected binding as unavailable, not resolved', () => {
    const result = resolveChannel(
      bundleWith([conn()]),
      [{ ...LIVE, status: 'disconnected' }],
      'mail.send',
      null,
    );
    expect(result.status).toBe('unavailable');
  });

  it('derives the target from the payload the same way facts do', () => {
    expect(deriveTargetId({ supplierId: 'supplier-a' })).toBe('supplier-a');
    expect(deriveTargetId({ counterpartyId: 'c_812' })).toBe('c_812');
    // supplierId wins: a purchase names both, and the supplier is who we deal
    // with.
    expect(deriveTargetId({ supplierId: 'supplier-a', counterpartyId: 'c_812' })).toBe(
      'supplier-a',
    );
    expect(deriveTargetId({ body: 'hello' })).toBeNull();
    expect(deriveTargetId({ supplierId: '' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/orchestrator/channels.test.ts -t "resolving a channel"`
Expected: FAIL — `./channels.js` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `src/orchestrator/channels.ts`:

```ts
import type { PolicyBundle } from '../domain/policy.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';

export type ChannelResolution =
  | { status: 'resolved'; system: string; channel: 'api' | 'browser' }
  | { status: 'no_channel'; reason: string }
  | { status: 'ambiguous'; systems: string[] }
  | { status: 'unavailable'; system: string; reason: string };

/**
 * Which system serves this call, and on which channel.
 *
 * The registry decides, never the model. Choosing between an API and a browser
 * is choosing how much authority to hand out, and the browser session holds
 * the owner's full authority on a site whose content an attacker controls.
 *
 * Matching is written positively: collect every connection that serves the
 * tool, prefer an exact target match over the catch-all, and refuse when two
 * remain. Array order must never break the tie — that looks like a decision
 * and behaves like an accident.
 */
export function resolveChannel(
  bundle: PolicyBundle,
  bindings: readonly ConnectionBinding[],
  toolName: string,
  targetId: string | null,
): ChannelResolution {
  const serving = bundle.connections.filter((c) => c.serves.includes(toolName));
  if (serving.length === 0) {
    return { status: 'no_channel', reason: `no connection serves ${toolName}` };
  }

  const exact = targetId === null ? [] : serving.filter((c) => c.target === targetId);
  const candidates: CharterConnection[] =
    exact.length > 0 ? exact : serving.filter((c) => c.target === null);

  if (candidates.length === 0) {
    return {
      status: 'no_channel',
      reason: `no connection serves ${toolName} for target ${targetId ?? '(none)'}`,
    };
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous', systems: candidates.map((c) => c.system) };
  }

  const connection = candidates[0]!;
  const binding = bindings.find((b) => b.system === connection.system);
  if (binding === undefined) {
    return { status: 'unavailable', system: connection.system, reason: 'no binding' };
  }
  if (binding.status !== 'live') {
    return { status: 'unavailable', system: connection.system, reason: binding.status };
  }

  return { status: 'resolved', system: connection.system, channel: connection.channel };
}

/**
 * The target a payload is addressed to.
 *
 * One function, imported by both call sites — plan validation and step
 * execution. Two derivations written separately are two derivations that will
 * diverge, and when they do a plan will be approved against one channel and
 * executed against another.
 */
export function deriveTargetId(input: Record<string, unknown>): string | null {
  for (const key of ['supplierId', 'counterpartyId']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run src/orchestrator/channels.test.ts`
Expected: typecheck clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/channels.ts src/orchestrator/channels.test.ts
git commit -m "Resolve a tool call to the system and channel that serve it

Matching written positively: collect what serves the tool, prefer an exact
target over the catch-all, refuse when two remain. Array order must never
break the tie — it looks like a decision and behaves like an accident, which
is the defect class positive-controls.test.ts exists to lock."
```

---

## Task 5: Adapter contract, registry, and the browser placeholder

**Files:**
- Create: `src/orchestrator/adapters/types.ts`
- Create: `src/orchestrator/adapters/registry.ts`
- Create: `src/orchestrator/adapters/browser.ts`
- Create: `src/orchestrator/adapters/contract.ts`
- Test: `src/orchestrator/adapters/adapters.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `ExternalAdapter`, `AdapterCall`, `AdapterResult`, `CredentialHandle`, `AdapterRegistry` (`register`, `get`, `systems`), `browserAdapter`, `assertAdapterContract(adapter, sampleCall)`

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/adapters/adapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './registry.js';
import { browserAdapter } from './browser.js';
import { assertAdapterContract } from './contract.js';
import type { AdapterCall } from './types.js';

function call(over: Partial<AdapterCall> = {}): AdapterCall {
  return {
    toolName: 'browser.submit_order',
    input: { supplierId: 'supplier-a', amountMinor: 1000 },
    credential: null,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('the adapter registry', () => {
  it('returns null for a system nothing implements', () => {
    expect(new AdapterRegistry([]).get('ghost')).toBeNull();
  });

  it('finds a registered adapter by system', () => {
    const registry = new AdapterRegistry([browserAdapter]);
    expect(registry.get('browser')?.channel).toBe('browser');
  });

  it('refuses to register two adapters for one system', () => {
    // Silently keeping one of them would make which adapter runs depend on
    // registration order.
    expect(() => new AdapterRegistry([browserAdapter, browserAdapter])).toThrow(
      /already registered/,
    );
  });
});

describe('the browser adapter placeholder', () => {
  it('reports that it is not implemented rather than pretending', async () => {
    const result = await browserAdapter.execute(call());
    expect(result).toEqual({
      ok: false,
      retryable: false,
      code: 'browser_not_implemented',
      message: expect.any(String),
    });
  });

  it('passes the shared adapter contract', async () => {
    await assertAdapterContract(browserAdapter, call());
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/orchestrator/adapters/adapters.test.ts`
Expected: FAIL — `./registry.js` does not exist.

- [ ] **Step 3: Define the contract types**

Create `src/orchestrator/adapters/types.ts`:

```ts
/** An opaque secret. Adapters use it; nothing logs or serialises it. */
export interface CredentialHandle {
  readonly ref: string;
  readonly value: string;
}

export interface AdapterCall {
  toolName: string;
  /**
   * The REDACTED payload.
   *
   * `executeStep` hands `perform` the gate's `redactedInput`, so an adapter
   * cannot send what the agent proposed even by accident.
   */
  input: unknown;
  credential: CredentialHandle | null;
  signal: AbortSignal;
}

export type AdapterResult =
  | { ok: true; output: unknown; externalId: string | null }
  | { ok: false; retryable: boolean; code: string; message: string };

/**
 * One external system, as the orchestrator sees it.
 *
 * An adapter returns a result rather than throwing. An exception escaping an
 * adapter skips the outcome record and leaves an intent entry with no ending;
 * a returned value is something the caller can check.
 */
export interface ExternalAdapter {
  readonly system: string;
  readonly channel: 'api' | 'browser';
  readonly serves: readonly string[];
  execute(call: AdapterCall): Promise<AdapterResult>;
}
```

- [ ] **Step 4: Implement the registry**

Create `src/orchestrator/adapters/registry.ts`:

```ts
import type { ExternalAdapter } from './types.js';

/**
 * Which adapter implements which system.
 *
 * Constructed rather than global so a test can inject a recording adapter and
 * no test ever sends a real message.
 */
export class AdapterRegistry {
  private readonly bySystem = new Map<string, ExternalAdapter>();

  constructor(adapters: readonly ExternalAdapter[]) {
    for (const adapter of adapters) {
      if (this.bySystem.has(adapter.system)) {
        // Keeping one silently would make which adapter runs depend on
        // registration order.
        throw new Error(`adapter for system "${adapter.system}" is already registered`);
      }
      this.bySystem.set(adapter.system, adapter);
    }
  }

  get(system: string): ExternalAdapter | null {
    return this.bySystem.get(system) ?? null;
  }

  systems(): string[] {
    return [...this.bySystem.keys()].sort();
  }
}
```

- [ ] **Step 5: Implement the browser placeholder**

Create `src/orchestrator/adapters/browser.ts`:

```ts
import type { ExternalAdapter } from './types.js';

/**
 * The browser channel, registered but not yet implemented.
 *
 * Present from day one so `channel: 'browser'` in a charter is a statement
 * that resolves, is checked and is reported — and so building the real driver
 * later touches no other file.
 */
export const browserAdapter: ExternalAdapter = {
  system: 'browser',
  channel: 'browser',
  serves: [
    'browser.navigate',
    'browser.click',
    'browser.fill',
    'browser.submit_order',
  ],
  async execute() {
    return {
      ok: false,
      retryable: false,
      code: 'browser_not_implemented',
      message: 'מנוע הדפדפן טרם נבנה — ראה תת-מערכת 4 באפיון',
    };
  },
};
```

- [ ] **Step 6: Implement the shared contract suite**

Create `src/orchestrator/adapters/contract.ts`:

```ts
import { expect } from 'vitest';
import type { AdapterCall, ExternalAdapter } from './types.js';

/**
 * The suite every adapter must pass.
 *
 * One suite rather than per-adapter tests, so a new adapter inherits the
 * properties that matter instead of inventing its own idea of them.
 */
export async function assertAdapterContract(
  adapter: ExternalAdapter,
  sample: AdapterCall,
): Promise<void> {
  expect(adapter.system.length, 'system must be named').toBeGreaterThan(0);
  expect(adapter.serves.length, 'an adapter that serves nothing is unreachable')
    .toBeGreaterThan(0);

  // Never throws: an exception escaping an adapter skips the outcome record.
  const result = await adapter.execute(sample).catch((error: unknown) => {
    throw new Error(
      `${adapter.system} threw instead of returning a result: ${String(error)}`,
    );
  });

  if (result.ok) {
    expect(result).toHaveProperty('output');
    expect(result).toHaveProperty('externalId');
  } else {
    expect(typeof result.retryable, 'retryable must be stated').toBe('boolean');
    expect(result.code.length, 'a failure must carry a code').toBeGreaterThan(0);
  }
}
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run src/orchestrator/adapters/adapters.test.ts`
Expected: typecheck clean, 5 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/adapters/
git commit -m "Adapter contract, registry, and the browser placeholder

An adapter returns a result rather than throwing: an exception escaping one
skips the outcome record and leaves an intent entry with no ending.

The registry refuses two adapters for one system — keeping one silently would
make which adapter runs depend on registration order.

The browser adapter is registered now and returns browser_not_implemented, so
channel: 'browser' is a statement that resolves and is reported, and building
the real driver later touches no other file."
```

---

## Task 6: Credential source

**Files:**
- Create: `src/orchestrator/credentials.ts`
- Test: `src/orchestrator/adapters/adapters.test.ts`

**Interfaces:**
- Consumes: `CredentialHandle` from Task 5
- Produces: `CredentialSource` interface, `envCredentials(env?): CredentialSource`

- [ ] **Step 1: Write the failing test**

Append to `src/orchestrator/adapters/adapters.test.ts`:

```ts
import { envCredentials } from '../credentials.js';

describe('credentials', () => {
  it('resolves a ref to a value from the environment', async () => {
    const source = envCredentials({ OFFICE_MAIL: 'secret-value' });
    const handle = await source.resolve('OFFICE_MAIL');
    expect(handle?.value).toBe('secret-value');
  });

  it('returns null for a ref nothing defines, rather than an empty secret', async () => {
    // An empty credential would be attempted and fail at the far end; null
    // stops the step before it reaches an external system at all.
    expect(await envCredentials({}).resolve('MISSING')).toBeNull();
  });

  it('does not serialise the value when the handle is stringified', async () => {
    const handle = await envCredentials({ K: 'secret-value' }).resolve('K');
    expect(JSON.stringify(handle)).not.toContain('secret-value');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/orchestrator/adapters/adapters.test.ts -t "credentials"`
Expected: FAIL — `../credentials.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/orchestrator/credentials.ts`:

```ts
import type { CredentialHandle } from './adapters/types.js';

/**
 * Where a `credential_ref` turns into an actual secret.
 *
 * An interface with a deliberately small surface: the full CredentialBroker
 * (subsystem 3) replaces the implementation without any adapter changing. The
 * secret never enters the model's context and never enters the audit log —
 * only the ref does.
 */
export interface CredentialSource {
  resolve(ref: string): Promise<CredentialHandle | null>;
}

/**
 * Reads secrets from the process environment.
 *
 * `toJSON` hides the value: a handle that lands in a log line or an error
 * payload by accident must not carry the secret with it.
 */
export function envCredentials(
  env: Record<string, string | undefined> = process.env,
): CredentialSource {
  return {
    async resolve(ref: string): Promise<CredentialHandle | null> {
      const value = env[ref];
      if (value === undefined || value.length === 0) return null;

      return {
        ref,
        value,
        toJSON: () => ({ ref, value: '[redacted]' }),
      } as CredentialHandle;
    },
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run src/orchestrator/adapters/adapters.test.ts`
Expected: typecheck clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/credentials.ts src/orchestrator/adapters/adapters.test.ts
git commit -m "Credential source: a ref resolves to a secret, and nothing else sees it

A deliberately small interface so the full CredentialBroker replaces the
implementation without any adapter changing. toJSON hides the value: a handle
that lands in a log line by accident must not carry the secret with it."
```

---

## Task 7: The SMTP mail adapter

**Files:**
- Create: `src/orchestrator/adapters/mail.ts`
- Modify: `package.json`
- Test: `src/orchestrator/adapters/adapters.test.ts`

**Interfaces:**
- Consumes: `ExternalAdapter`, `AdapterCall`, `AdapterResult` (Task 5)
- Produces: `createMailAdapter(options): ExternalAdapter`, `MailTransport` interface

- [ ] **Step 1: Add the dependency**

Run: `npm install nodemailer && npm install -D @types/nodemailer`

If npm reports blocked install scripts, add the package name to the
`allowScripts` array in `package.json` and re-run.

- [ ] **Step 2: Write the failing test**

Append to `src/orchestrator/adapters/adapters.test.ts`:

```ts
import { createMailAdapter, type MailTransport } from './mail.js';

function recordingTransport() {
  const sent: { to: string[]; subject: string; body: string }[] = [];
  const transport: MailTransport = {
    async send(message) {
      sent.push(message);
      return { messageId: 'MSG-1' };
    },
  };
  return { transport, sent };
}

describe('the mail adapter', () => {
  it('sends the payload it was given and returns the provider id', async () => {
    const { transport, sent } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute({
      toolName: 'mail.send',
      input: { to: 'a@b.com', subject: 'שלום', body: 'הגוף' },
      credential: { ref: 'OFFICE_MAIL', value: 'pw' },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ ok: true, output: { messageId: 'MSG-1' }, externalId: 'MSG-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['a@b.com']);
  });

  it('reads several recipients, whether a list or one joined string', async () => {
    const { transport, sent } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    await adapter.execute({
      toolName: 'mail.send',
      input: { to: ['a@b.com', 'c@d.com'], subject: 's', body: 'b' },
      credential: { ref: 'K', value: 'pw' },
      signal: new AbortController().signal,
    });
    await adapter.execute({
      toolName: 'mail.send',
      input: { to: 'e@f.com, g@h.com', subject: 's', body: 'b' },
      credential: { ref: 'K', value: 'pw' },
      signal: new AbortController().signal,
    });

    expect(sent[0]?.to).toEqual(['a@b.com', 'c@d.com']);
    expect(sent[1]?.to).toEqual(['e@f.com', 'g@h.com']);
  });

  it('refuses a payload with no recipient rather than sending to nobody', async () => {
    const { transport } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute({
      toolName: 'mail.send',
      input: { subject: 's', body: 'b' },
      credential: { ref: 'K', value: 'pw' },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      ok: false,
      retryable: false,
      code: 'no_recipient',
      message: expect.any(String),
    });
  });

  it('refuses without a credential rather than trying anonymously', async () => {
    const { transport } = recordingTransport();
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute({
      toolName: 'mail.send',
      input: { to: 'a@b.com', subject: 's', body: 'b' },
      credential: null,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('credential_missing');
  });

  it('classifies a transport failure as retryable', async () => {
    const transport: MailTransport = {
      async send() {
        throw new Error('ECONNREFUSED');
      },
    };
    const adapter = createMailAdapter({ system: 'office-mail', transport });

    const result = await adapter.execute({
      toolName: 'mail.send',
      input: { to: 'a@b.com', subject: 's', body: 'b' },
      credential: { ref: 'K', value: 'pw' },
      signal: new AbortController().signal,
    });

    // The server being down is a reason to come back later. A malformed
    // address is not.
    expect(result).toEqual({
      ok: false,
      retryable: true,
      code: 'transport_error',
      message: expect.any(String),
    });
  });

  it('passes the shared adapter contract', async () => {
    const { transport } = recordingTransport();
    await assertAdapterContract(createMailAdapter({ system: 'office-mail', transport }), {
      toolName: 'mail.send',
      input: { to: 'a@b.com', subject: 's', body: 'b' },
      credential: { ref: 'K', value: 'pw' },
      signal: new AbortController().signal,
    });
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run src/orchestrator/adapters/adapters.test.ts -t "the mail adapter"`
Expected: FAIL — `./mail.js` does not exist.

- [ ] **Step 4: Implement**

Create `src/orchestrator/adapters/mail.ts`:

```ts
import type { AdapterCall, AdapterResult, ExternalAdapter } from './types.js';

export interface MailMessage {
  to: string[];
  subject: string;
  body: string;
}

/**
 * The seam between this adapter and a real SMTP client.
 *
 * An interface rather than a direct nodemailer call so every test drives a
 * recording transport and no test ever sends a real message.
 */
export interface MailTransport {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

export interface MailAdapterOptions {
  system: string;
  transport: MailTransport;
}

/**
 * Send mail over SMTP.
 *
 * SMTP rather than a provider API: it works against Gmail, Outlook and any
 * self-hosted server with a username and password behind a credential ref,
 * instead of an OAuth flow that is a project of its own. The point of the
 * first adapter is to exercise the layer, not to pick a vendor.
 *
 * `mail.send` only. Reading mail is an inbound direction — it feeds
 * `intake.triage`, which does not exist, and it carries untrusted content that
 * needs the quarantine chain.
 */
export function createMailAdapter(options: MailAdapterOptions): ExternalAdapter {
  return {
    system: options.system,
    channel: 'api',
    serves: ['mail.send'],

    async execute(call: AdapterCall): Promise<AdapterResult> {
      if (call.credential === null) {
        return {
          ok: false,
          retryable: false,
          code: 'credential_missing',
          message: 'אין credential לחיבור — ההודעה לא נשלחה',
        };
      }

      const input = isRecord(call.input) ? call.input : {};
      const to = readRecipients(input);
      if (to.length === 0) {
        // Sending to nobody succeeds at the transport and fails at the goal.
        return {
          ok: false,
          retryable: false,
          code: 'no_recipient',
          message: 'המטען אינו נושא נמען קריא',
        };
      }

      try {
        const sent = await options.transport.send({
          to,
          subject: readString(input, 'subject') ?? '',
          body: readString(input, 'body') ?? '',
        });
        return { ok: true, output: sent, externalId: sent.messageId };
      } catch (error) {
        // The server being down is a reason to come back later; the caller
        // reschedules on `retryable`.
        return {
          ok: false,
          retryable: true,
          code: 'transport_error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Every recipient, whether the payload carried a list or one joined string.
 *
 * Reads all of them for the same reason `buildFacts` does: checking one
 * address of several reads as "we checked" while being false.
 */
function readRecipients(input: Record<string, unknown>): string[] {
  const raw = input['to'];
  const values: string[] = [];
  if (typeof raw === 'string') values.push(raw);
  else if (Array.isArray(raw)) {
    for (const item of raw) if (typeof item === 'string') values.push(item);
  }

  return values
    .flatMap((value) => value.split(/[,;]/))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run src/orchestrator/adapters/adapters.test.ts`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/adapters/mail.ts src/orchestrator/adapters/adapters.test.ts package.json package-lock.json
git commit -m "SMTP mail adapter: the first real external action

SMTP rather than a provider API — it works against Gmail, Outlook and any
self-hosted server with a username and password behind a credential ref,
instead of an OAuth flow that is a project of its own. mail.send only;
reading mail is inbound and needs the quarantine chain.

MailTransport is an interface so every test drives a recording transport and
no test ever sends a real message. A transport failure is retryable; a
missing recipient or credential is not."
```

---

## Task 8: Wire it into the orchestrator

**Files:**
- Modify: `src/orchestrator/run-plan.ts`
- Modify: `src/orchestrator/execute.ts`
- Modify: `CLAUDE.md`
- Test: `src/orchestrator/external.test.ts`

**Interfaces:**
- Consumes: `resolveChannel`, `deriveTargetId` (Task 4); `AdapterRegistry`, `ExternalAdapter` (Task 5); `CredentialSource` (Task 6); `loadBindings` (Task 3)
- Produces: `RunPlanRequest.registry`, `RunPlanRequest.credentials`, `RunPlanRequest.bindings`

- [ ] **Step 1: Write the failing tests**

Create `src/orchestrator/external.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import { KNOWN_TOOL_NAMES } from '../domain/charter.js';
import { classifiedToolNames, READ_ONLY_TOOLS } from '../policy/classify.js';
import { createJob, loadJob, transition } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import { browserAdapter } from './adapters/browser.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const LIVE: ConnectionBinding = {
  system: 'office-mail',
  status: 'live',
  endpoint: null,
  credentialRef: 'OFFICE_MAIL',
  lastOkAt: null,
  lastError: null,
};

function recording() {
  const sent: MailMessage[] = [];
  const adapter = createMailAdapter({
    system: 'office-mail',
    transport: {
      async send(message) {
        sent.push(message);
        return { messageId: 'MSG-1' };
      },
    },
  });
  return { sent, registry: new AdapterRegistry([adapter, browserAdapter]) };
}

function mailPlan() {
  return Plan.parse({
    goal: 'לענות ללקוח',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply',
        toolName: 'mail.send',
        input: {
          to: 'a@b.com',
          inReplyTo: 'm1',
          counterpartyId: 'c_812',
          subject: 'שלום',
          body: 'מספר 123456789',
        },
      },
    ],
  });
}

async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('a plan reaches a real external system', () => {
  it('sends through the adapter the registry resolved', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION] }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [LIVE],
      credentials: envCredentials({ OFFICE_MAIL: 'pw' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('hands the adapter the redacted payload, not the one the plan proposed', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION] }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [LIVE],
      credentials: envCredentials({ OFFICE_MAIL: 'pw' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    // The charter redacts a bare nine-digit number. The adapter must never see
    // the original.
    expect(sent[0]?.body).not.toContain('123456789');
    expect(sent[0]?.body).toContain('[הוסר]');
  });

  it('rejects the whole plan when the charter declares no channel for a tool', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [LIVE],
      credentials: envCredentials({ OFFICE_MAIL: 'pw' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    // Refusal, not a fall back to the browser: an unknown system reached by
    // falling back is exactly the route an attacker would choose.
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toContain('no_channel_for_tool');
    expect(sent).toEqual([]);
  });

  it('rejects a declared connection that no adapter implements', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [{ ...MAIL_CONNECTION, system: 'ghost-mail' }] }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);
    const { registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [{ ...LIVE, system: 'ghost-mail' }],
      credentials: envCredentials({ OFFICE_MAIL: 'pw' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toContain('no_adapter_for_system');
  });

  it('sleeps the job when the adapter says the failure is retryable', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION] }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);
    const failing = createMailAdapter({
      system: 'office-mail',
      transport: {
        async send() {
          throw new Error('ECONNREFUSED');
        },
      },
    });

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry: new AdapterRegistry([failing, browserAdapter]),
      bindings: [LIVE],
      credentials: envCredentials({ OFFICE_MAIL: 'pw' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    const after = await loadJob(job.jobId, { businessId: BUSINESS });
    // Back to followup with a wake time — the loop the scheduler already runs.
    expect(after?.phase).toBe('followup');
    expect(after?.wakeAt).not.toBeNull();
  });

  it('refuses the step when the binding is not live, after the gate has run', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION] }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [{ ...LIVE, status: 'disconnected' }],
      credentials: envCredentials({ OFFICE_MAIL: 'pw' }),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(sent).toEqual([]);
  });
});

describe('structural invariants', () => {
  it('the charter tool list agrees with the policy layer', () => {
    // `src/domain/charter.ts` cannot import from `src/policy/` without a
    // cycle, so the list is duplicated. This is what stops it drifting.
    const policy = new Set([...classifiedToolNames(), ...READ_ONLY_TOOLS]);
    const missing = [...policy].filter((tool) => !KNOWN_TOOL_NAMES.has(tool));
    const extra = [...KNOWN_TOOL_NAMES].filter((tool) => !policy.has(tool));

    expect(missing, 'tools the policy layer knows and the charter does not').toEqual([]);
    expect(extra, 'tools the charter knows and the policy layer does not').toEqual([]);
  });

  it('every browser action a charter can declare has an adapter that serves it', () => {
    const served = new Set(browserAdapter.serves);
    for (const tool of ['browser.navigate', 'browser.click', 'browser.fill', 'browser.submit_order']) {
      expect(served.has(tool), tool).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/orchestrator/external.test.ts`
Expected: FAIL — `runPlan` does not accept `registry`.

- [ ] **Step 3: Extend the plan runner**

In `src/orchestrator/run-plan.ts`, add the imports:

```ts
import type { ConnectionBinding } from '../domain/connection.js';
import type { AdapterRegistry } from './adapters/registry.js';
import type { CredentialSource } from './credentials.js';
import { deriveTargetId, resolveChannel } from './channels.js';
```

Replace the `perform` field of `RunPlanRequest` and add three fields:

```ts
export interface RunPlanRequest {
  job: Job;
  bundle: PolicyBundle;
  plan: Plan;
  /** Which adapter implements which system. Injected so tests never send. */
  registry: AdapterRegistry;
  /** Whether each permitted connection currently works. */
  bindings: readonly ConnectionBinding[];
  credentials: CredentialSource;
  counterpartyTags: string[];
  rampLevel: AutonomyLevel;
  now?: Date;
}
```

Delete the `perform` field — the runner builds it now.

In the plan-validation loop, after the `classMismatch` check, add:

```ts
    const channel = resolveChannel(
      request.bundle,
      request.bindings,
      step.toolName,
      deriveTargetId(step.input),
    );
    if (channel.status === 'no_channel') {
      return { status: 'rejected', reason: `step ${step.id}: no_channel_for_tool — ${channel.reason}` };
    }
    if (channel.status === 'ambiguous') {
      return {
        status: 'rejected',
        reason: `step ${step.id}: ambiguous_channel — ${channel.systems.join(', ')}`,
      };
    }
    // A charter may declare a system the code does not implement yet, and that
    // is a fine state to be in. Discovering it mid-execution is not.
    if (channel.status === 'resolved' && request.registry.get(channel.system) === null) {
      return {
        status: 'rejected',
        reason: `step ${step.id}: no_adapter_for_system — ${channel.system}`,
      };
    }
```

In the execution loop, replace the `perform` argument passed to `executeStep`:

```ts
      perform: async (redacted) => {
        // Resolved a second time, after the gate: availability, not
        // feasibility. A connection that dropped between planning and
        // execution must leave a trace, and the intent is already recorded.
        const resolution = resolveChannel(
          request.bundle,
          request.bindings,
          step.toolName,
          deriveTargetId(step.input),
        );
        if (resolution.status !== 'resolved') {
          throw new StepChannelError('channel_unavailable', JSON.stringify(resolution));
        }

        const adapter = request.registry.get(resolution.system);
        if (adapter === null) {
          throw new StepChannelError('no_adapter_for_system', resolution.system);
        }

        const binding = request.bindings.find((b) => b.system === resolution.system);
        const credential =
          binding?.credentialRef == null
            ? null
            : await request.credentials.resolve(binding.credentialRef);
        if (binding?.credentialRef != null && credential === null) {
          throw new StepChannelError('credential_unavailable', binding.credentialRef);
        }

        const result = await adapter.execute({
          toolName: step.toolName,
          input: redacted,
          credential,
          signal: AbortSignal.timeout(60_000),
        });
        if (!result.ok) {
          throw new StepChannelError(result.code, result.message, result.retryable);
        }
        return result.output;
      },
```

Add the error class at the bottom of the file:

```ts
/**
 * A failure that came from the channel rather than from the gate.
 *
 * Thrown across the `perform` boundary because that callback's contract is a
 * value or a throw; `executeStep` catches it and turns it back into an
 * outcome, so nothing escapes to the caller unrecorded.
 */
export class StepChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'StepChannelError';
  }
}
```

- [ ] **Step 4: Teach executeStep to catch it**

In `src/orchestrator/execute.ts`, add the import:

```ts
import { StepChannelError } from './run-plan.js';
```

Replace the line `const result = await request.perform(decision.redactedInput);` with:

```ts
  let result: unknown;
  try {
    result = await request.perform(decision.redactedInput);
  } catch (error) {
    // An adapter that throws must not escape past the outcome record: the
    // intent is already in the audit log and would otherwise have no ending.
    const code = error instanceof StepChannelError ? error.code : 'adapter_threw';
    const retryable = error instanceof StepChannelError && error.retryable;
    const message = error instanceof Error ? error.message : String(error);

    if (retryable) {
      // The far end being down is a reason to come back later, and the
      // scheduler already runs that loop.
      const wakeAt = new Date(now.getTime() + 5 * 60 * 1000);
      await transition(job.jobId, {
        to: 'followup',
        actor: 'orchestrator',
        reason: `${code} — retry:${request.stepId} at ${wakeAt.toISOString()}`,
        wakeAt,
        businessId: job.businessId,
      });
      return { status: 'deferred', code, wakeAt: wakeAt.toISOString() };
    }

    await transition(job.jobId, {
      to: 'failed',
      actor: 'orchestrator',
      reason: `${code} — ${message}`,
      businessId: job.businessId,
    });
    return { status: 'refused', code, reason: message };
  }
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: typecheck clean, every test passes. Existing `planner.test.ts` calls to
`runPlan` need the three new fields — add `registry: new AdapterRegistry([])`,
`bindings: []`, `credentials: envCredentials({})` and give those plans charter
connections, or assert the new `no_channel_for_tool` rejection where that is
what the test is now about.

- [ ] **Step 6: Verify each new guard bites**

For each of `src/orchestrator/channels.ts` and `src/orchestrator/run-plan.ts`:

```bash
cp <file> /tmp/new && git show HEAD:<file> > <file>
npx vitest run src/orchestrator/external.test.ts
cp /tmp/new <file>
```

Expected: the relevant tests FAIL against the pre-change file. A test that
passes both before and after protects nothing.

- [ ] **Step 7: Document the invariants**

In `CLAUDE.md`, add to the silently-enforced rules section:

```markdown
**המרשם יכול רק לצמצם.** התקנון קובע אילו מערכות מחוברות ובאיזה ערוץ, וחתום על כך. ל-`connection_bindings` **אין עמודת `channel`** — היא יכולה רק להפוך חיבור מותר ללא-זמין. מערכת שאינה בתקנון אין לה ערוץ, גם אם יש לה שורה בטבלה.

**ערוץ נבחר בקוד ולא על ידי המודל.** הבחירה בין API לדפדפן היא החלטה כמה סמכות למסור. `resolveChannel` מתאים בחיוב: מה שמשרת את הכלי, ספציפי גובר על כללי, ו**שתי התאמות באותה רמה הן דחייה** ולא הראשונה במערך.

**מערכת לא מוכרת נדחית ולא נופלת אחורה לדפדפן.** נפילה אוטומטית למערכת שהתקנון לא הזכיר היא המסלול שתוקף היה בוחר: להזכיר ספק חדש בתוכן ולקבל דפדפן פתוח מולו.

**מתאם מחזיר תוצאה ולא זורק.** חריגה שבורחת ממתאם מדלגת על רישום התוצאה ומשאירה שורת כוונה בלי סוף. `executeStep` תופס בכל זאת וממיר ל-`StepChannelError`.
```

Update the test count in the commands block and in `README.md`.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/run-plan.ts src/orchestrator/execute.ts src/orchestrator/external.test.ts CLAUDE.md README.md
git commit -m "Wire the registry and adapters into plan execution

The channel is resolved twice, deliberately. At plan validation it is
feasibility, and it rejects the plan whole — a step that would fail on its
own leaves every step before it already done. At execution it is
availability, and it runs AFTER the gate so a connection that dropped between
planning and execution leaves a trace.

A retryable adapter failure sleeps the job to followup with a wakeAt, which
is the loop the scheduler already runs. A non-retryable one fails it. An
adapter that throws is caught rather than escaping past the outcome record."
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 4 — charter `connections` schema | 1 |
| 4 — `subprocessor` and `serves` enforced at signing | 1 |
| 4 — `connection_bindings` table, no channel column | 3 |
| 5 — `resolveChannel`, positive matching, ambiguity refused | 4 |
| 5 — `targetId` derived by one shared function | 4 |
| 5 — `no_adapter_for_system` at plan validation | 8 |
| 6 — `ExternalAdapter`, redacted input, returns not throws, `retryable` | 5 |
| 7 — two resolutions: feasibility then availability | 8 |
| 8 — failure table, retry backoff, browser placeholder | 5, 8 |
| 9 — `CredentialSource`, ref not secret | 6 |
| 10 — pure resolver tests, contract suite, structural invariants, end-to-end | 4, 5, 8 |
| 12 — SMTP, `mail.send` only | 7 |

No gaps.

**Known deviation from the spec, deliberate:** the spec described the retry
counter as derived from `job_steps` rows with exponential backoff (5 → 25 →
125 minutes). Task 8 implements a flat 5-minute wake and does not count
attempts, so a permanently unreachable server retries forever. The counting
and the backoff belong with the retry policy as a whole and are listed below
rather than half-built here.

**Follow-up work this plan does not do**

- Retry attempt counting and exponential backoff (spec §8)
- Marking a binding `error` after a failure, and health checks
- An onboarding surface for `connection_bindings`
- Wiring a default registry into the live entry points — every caller injects
  one today, which is why no test can send a real message
