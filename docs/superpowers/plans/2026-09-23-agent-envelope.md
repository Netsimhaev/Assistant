# תוכנית ביצוע — המעטפת וההאצלה בין סוכנים

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** לתת לסוכנים דרך מוטפסת, נאכפת ומתועדת לבקש עזרה זה מזה — ולהוכיח אותה על זוג סוכנים אחד שרץ בייצור.

**Architecture:** האצלה היא **משימה-בת** ולא צעד שנוסף לתוכנית, כי `bindPlanToJob` מסרב לתוכנית שגיבובה שונה ברגע שצעד אחד הותיר רשומה. המעטפת היא הרשומה של ההאצלה; המשימה-הבת היא הביצוע שלה. התקרות יורשות במינימום בלבד. `agent.request_help` הופך לכלי מסווג שנרשם בביקורת, ו-`COLLABORATION_GRAPH` — שמקומפל לתקנון החתום ואיש אינו קורא אותו היום — מקבל קורא בשער.

**Tech Stack:** TypeScript NodeNext ESM · Postgres 17 דרך `pg` · zod · vitest מול בסיס נתונים אמיתי · `@anthropic-ai/claude-agent-sdk`

**Spec:** [docs/superpowers/specs/2026-09-23-agent-envelope-design.md](../specs/2026-09-23-agent-envelope-design.md) — הסמכות המחייבת. קראו אותו לפני המשימה הראשונה.

---

## Global Constraints

העתקו מילה במילה מהמפרט. הדרישות של כל משימה כוללות את הסעיף הזה במשתמע.

1. **`.js` בכל import יחסי**, גם מקבצי `.ts`. נדרש על ידי `NodeNext` + `"type": "module"`.
2. **שלושה דגלי tsconfig נושכים:** `noUncheckedIndexedAccess` (מכריח `rows[0]?.x`), `exactOptionalPropertyTypes` (מכריח spread מותנה), `verbatimModuleSyntax` (מפריד `import` מ-`import type`).
3. **תקרות מתהדקות מונוטונית.** משימה-בת לעולם לא מקבלת רמת אמון, תקרת אוטונומיה, תקרת כסף או דדליין מרפפים מההורה. **אי אפשר להלבין הרשאות דרך האצלה.**
4. **`contextRefs` נושא מצביעים בלבד.** אף ענף ב-`ContextRef` אינו נושא שדה טקסט חופשי. טקסט גולמי במעטפת הופך את ההאצלה לנתיב הזרקה.
5. **`MAX_HOPS = 6`**, קבוע מיוצא אחד, נקרא גם בסכמה וגם בשומר.
6. **`DELEGATIONS_PER_DAY` ברירת מחדל 50.** נספר משורות `audit_log` מסוג `delegation`, כולל מסלול הכשל.
7. **עברית לבני אדם, אנגלית לקוד.** הודעות דחייה ופלט למשתמש בעברית; מזהים, הערות ושגיאות פנימיות באנגלית.
8. **מוסכמה בכל מודול שקורא שורות DB:** `interface XRow` פרטי + `toX(row)`. SQL ב-snake_case, TS ב-camelCase.
9. **סכמת zod והטיפוס המוסק חולקים שם אחד.**
10. **חיפוש שמשמעותו "נעדר = נדחה" חייב `Object.hasOwn`**, לא `in` ולא גישה ישירה.
11. **`resetDatabase()` ב-`src/test/db.ts` נוקב בטבלאות ביד.** טבלה חדשה שלא תתווסף שם תדלוף בין מבחנים.
12. **סגירת משימה לא תותנה בפסיקה של מודל.** `closeVerifiedJobs` נשאר כפי שהוא.
13. **אל תרחיבו את `CEILING_EXEMPT_TOOLS` מעבר לחבר אחד.** אינווריאנט נועל את גודלה.

---

## תיקון אחד למפרט, שנמצא בהכנת התוכנית

**§6.3 במפרט אומר שבדיקת הגרף בשכבה הראשונה תשב ב-`planProblems`. היא לא יכולה.**

`planProblems` היא **פונקציה טהורה ב-`src/domain/plan.ts:61`** שמקבלת `Plan` ותו לא — אין לה גישה לתקנון המקומפל, ולתת לה אותה פירושו ייבוא מ-`src/governance/` לתוך `src/domain/`, כיוון תלות שהקוד הזה לא עושה.

**ההכרעה:** פונקציה טהורה חדשה `delegationProblems(plan, graph)` ב-`src/governance/delegation.ts`, שנקראת מ-`runPlan` מיד אחרי `planProblems` — `runPlan` מחזיק את `bundle` בהיקף (שורה 184) וקורא ל-`planProblems` בשורה 207. אותה שכבה, אותו תזמון, אותה תוצאה למשתמש; רק לא באותו קובץ.

**עוד ממצא, ולטובה:** `lowestTrust` ו-`mostRestrictiveAutonomy` **כבר קיימים** ב-`src/domain/trust.ts`, וההערות שלהם מצטטות במפורש את שרשרת ההאצלה ואת "תקרת המעטפת" מ-`docs/03-protocol.md`. הם נכתבו בשביל העבודה הזו ואין להם קורא. **אל תכתבו אותם מחדש** — ייבאו.

---

## מבנה הקבצים

**נוצרים:**

| קובץ | אחריות |
|---|---|
| `src/domain/envelope.ts` | הטיפוסים: `AgentEnvelope`, `EnvelopeKind`, `ContextRef`, `EnvelopeConstraints`, `MAX_HOPS` |
| `src/governance/delegation.ts` | חמשת השומרים כפונקציות טהורות, `tightenConstraints`, `contextRefsHash`, `mayDelegate`, `delegationProblems` |
| `src/db/migrations/028_agent_envelopes.sql` | `agent_envelopes`, `verification_verdicts`, `jobs.awaiting_envelope_id` |
| `src/governance/envelope-store.ts` | קריאה וכתיבה של מעטפות, והשאילתות ששומרים 4–5 והתקרה היומית צריכים |
| `src/governance/intent-registry.ts` | לכל סוכן נמען: אילו intents, סכמת מטען, ואיזה כלי |
| `src/orchestrator/delegate.ts` | `requestHelp` — שומרים, מעטפת, משימה-בת, החניית ההורה |
| `src/orchestrator/resume-delegated.ts` | `resumeDelegatedJobs` — התעוררות ההורה, וכן מסלול הדדליין |
| `src/governance/numeric-grounding.ts` | בדיקת העיגון המספרי. טהורה, אפס טוקנים |
| `src/governance/verdict-store.ts` | קריאה וכתיבה של `verification_verdicts` |
| `src/sdk/gov-verify.ts` | הסוכן — שלוש הבדיקות ופסיקה |
| `src/sdk/run-delegate.ts` | ההרצה החיה |

**נערכים:**

`src/domain/action.ts` (מחלקה חדשה) · `src/domain/audit.ts` (`AuditKind`) · `src/domain/job.ts` + `src/orchestrator/jobs.ts` (העמודה החדשה) · `src/domain/policy.ts` (`DENY_CODES`) · `src/policy/classify.ts` (שלוש הרשימות) · `src/policy/engine.ts` (שלב 3) · `src/orchestrator/ramp.ts` (`rampLevelForPlan`) · `src/orchestrator/run-plan.ts` (שכבה ראשונה) · `src/orchestrator/scheduler.ts` (סדר הסבב) · `src/orchestrator/conduct.ts` (המפעיל) · `src/charter/capabilities.ts` (רשימות ההיתר) · `src/charter/capabilities.test.ts` (האינווריאנט המורחב) · `src/governance/erasure-plan.ts` + `erasure.ts` + `erasure-invariants.test.ts` · `src/dashboard/views.ts` (הפסיקה על הכרטיס) · `src/test/db.ts` · `src/test/fixtures.ts` · `src/config.ts` · `package.json` · `CLAUDE.md` · `docs/09-roadmap.md`

---

## הצהרה על צורת התוכנית, במקום להסתיר אותה

משימות 1, 3, 5, 6 ו-9 נושאות **קוד מלא** — הן טהורות או עריכות טבלה, ואפשר לכתוב אותן מול חתימות שקראתי.

משימות 2, 7, 8, 10, 11 ו-12 נושאות **שמות מבחנים, אסרשנים מדויקים ומוטציה שחייבת להפיל מבחן נקוב — ולא גופי מבחן כקוד.** הן נזרעות מול בסיס נתונים אמיתי ומול חתימות שלא הרצתי. בתוכנית הקודמת בפרויקט הזה, הכתבת גופי מבחן מול חתימות שלא הורצו היא בדיוק מה שהכניס שישה פגמים לטקסט. המבצע יקרא את החתימה ויכתוב את הגוף.

---

## Task 1: המעטפת וחמשת השומרים, טהורים

**Files:**
- Create: `src/domain/envelope.ts`
- Create: `src/governance/delegation.ts`
- Test: `src/domain/envelope.test.ts`, `src/governance/delegation.test.ts`

**Interfaces:**
- Consumes: `TrustLevel`, `AutonomyLevel`, `lowestTrust`, `mostRestrictiveAutonomy` מ-`src/domain/trust.js`; `AgentId` מ-`src/domain/audit.js`; `SafeLookupKey` מ-`src/domain/charter.js`; `canonicalHash` מ-`src/util/canonical.js`
- Produces: `AgentEnvelope`, `EnvelopeKind`, `ContextRef`, `EnvelopeConstraints`, `MAX_HOPS`, `tightenConstraints`, `contextRefsHash`, `mayDelegate`, `delegationProblems`, `DelegationDenial`

- [ ] **Step 1: כתבו את המבחן שנכשל — ההידוק**

`src/governance/delegation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tightenConstraints } from './delegation.js';
import type { EnvelopeConstraints } from '../domain/envelope.js';

const PARENT: EnvelopeConstraints = {
  charterVersion: 'v7',
  provenanceCeiling: 'staff',
  autonomyCeiling: 'approve_required',
  moneyCeilingMinor: 5000,
  deadlineAt: '2026-09-24T12:00:00.000Z',
};

describe('tightenConstraints', () => {
  /**
   * The whole security property of delegation in one test. Every field moves
   * only one way. Replacing any `mostRestrictive`/`lowest`/`Math.min` with its
   * opposite must fell this.
   */
  it('never loosens a single field, even when the source permits more', () => {
    const tightened = tightenConstraints(PARENT, {
      provenanceCeiling: 'boss',
      autonomyCeiling: 'auto',
      moneyCeilingMinor: 999_999,
      deadlineAt: '2026-12-31T00:00:00.000Z',
    });

    expect(tightened.provenanceCeiling).toBe('staff');
    expect(tightened.autonomyCeiling).toBe('approve_required');
    expect(tightened.moneyCeilingMinor).toBe(5000);
    expect(tightened.deadlineAt).toBe('2026-09-24T12:00:00.000Z');
  });

  it('takes the source value when the source is the stricter of the two', () => {
    const tightened = tightenConstraints(PARENT, {
      provenanceCeiling: 'unknown_external',
      autonomyCeiling: 'draft_only',
      moneyCeilingMinor: 100,
      deadlineAt: '2026-09-23T13:00:00.000Z',
    });

    expect(tightened.provenanceCeiling).toBe('unknown_external');
    expect(tightened.autonomyCeiling).toBe('draft_only');
    expect(tightened.moneyCeilingMinor).toBe(100);
    expect(tightened.deadlineAt).toBe('2026-09-23T13:00:00.000Z');
  });

  /**
   * `null` means "I carry no ceiling of my own", which must not be read as
   * "no ceiling applies" — the parent's number has to survive.
   */
  it('reads a null money ceiling as absent, not as unlimited', () => {
    expect(tightenConstraints(PARENT, { moneyCeilingMinor: null }).moneyCeilingMinor).toBe(5000);
    expect(
      tightenConstraints({ ...PARENT, moneyCeilingMinor: null }, { moneyCeilingMinor: 70 })
        .moneyCeilingMinor,
    ).toBe(70);
  });

  /**
   * A child running under a charter the parent never saw is a child whose
   * result the parent cannot explain. Copied, never negotiated.
   */
  it('copies the charter version from the parent verbatim', () => {
    expect(tightenConstraints(PARENT, { charterVersion: 'v9' }).charterVersion).toBe('v7');
  });
});
```

- [ ] **Step 2: הריצו כדי לוודא שנכשל**

Run: `npx vitest run src/governance/delegation.test.ts`
Expected: FAIL — `Cannot find module './delegation.js'`

- [ ] **Step 3: כתבו `src/domain/envelope.ts`**

```ts
/**
 * The typed object that travels between agents (docs/03-protocol.md §1).
 *
 * **`contextRefs` carries pointers and never text, and that is the control —
 * not an efficiency choice.** If one agent could plant raw text from a hostile
 * document into the payload that reaches another, delegation itself would
 * become the injection path: the text arrives inside an agent the system
 * trusts, stripped of the provenance label that travels with it everywhere
 * else. With pointers, the receiver resolves for itself, and everything it
 * pulls arrives with its own trust level attached — the same rule the planner
 * already follows ("never the raw message") and the memory already follows
 * (provenance on every row).
 */
import { z } from 'zod';
import { AgentId } from './audit.js';
import { SafeLookupKey } from './charter.js';
import { AutonomyLevel, TrustLevel } from './trust.js';

/**
 * Hard ceiling on delegation depth. One exported constant, read by both the
 * schema below and the guard in `governance/delegation.ts` — two places each
 * naming 6 are two places that drift.
 */
export const MAX_HOPS = 6;

/**
 * Only the two kinds this work actually produces.
 *
 * `assign`, `verify_request`, `verdict` and `escalate` appear in
 * docs/03-protocol.md and are deliberately absent until something emits them.
 * A member with no producer is the dead-branch defect this codebase has
 * already paid for with dead action classes.
 */
export const EnvelopeKind = z.enum(['help_request', 'result']);
export type EnvelopeKind = z.infer<typeof EnvelopeKind>;

/**
 * A pointer the receiver resolves itself. **No branch carries free text** —
 * an invariant test asserts that, because the next person to add a branch
 * will reach for a convenient `content: string`.
 */
export const ContextRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: SafeLookupKey }),
  z.object({ kind: z.literal('reading'), readingId: SafeLookupKey }),
  z.object({ kind: z.literal('memory'), memoryId: SafeLookupKey }),
  z.object({ kind: z.literal('job'), jobId: SafeLookupKey }),
]);
export type ContextRef = z.infer<typeof ContextRef>;

export const EnvelopeConstraints = z.object({
  charterVersion: z.string().min(1),
  provenanceCeiling: TrustLevel,
  autonomyCeiling: AutonomyLevel,
  /** `null` means "no ceiling of my own", never "no ceiling applies". */
  moneyCeilingMinor: z.number().int().nonnegative().nullable(),
  deadlineAt: z.string().datetime(),
});
export type EnvelopeConstraints = z.infer<typeof EnvelopeConstraints>;

export const AgentEnvelope = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  /**
   * The root job of the whole tree. For a job with no parent this is the job's
   * own id — without that rule the first envelope in a tree would have nothing
   * to write here, and the no-new-information guard would compare against an
   * empty field.
   */
  correlationId: z.string().min(1),
  /** Envelope ids, root first. */
  causalChain: z.array(z.string().min(1)),
  from: z.union([AgentId, z.literal('orchestrator')]),
  to: AgentId,
  kind: EnvelopeKind,
  intent: z.string().min(1),
  payload: z.unknown(),
  contextRefs: z.array(ContextRef),
  constraints: EnvelopeConstraints,
  /**
   * The guard refuses before a seventh envelope is built, so this `max` should
   * never fire. It is here as a second layer, exactly as an approval's expiry
   * is checked both in the lookup and again in the claim's `WHERE`.
   */
  hops: z.number().int().min(0).max(MAX_HOPS),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type AgentEnvelope = z.infer<typeof AgentEnvelope>;
```

- [ ] **Step 4: כתבו את `tightenConstraints` ב-`src/governance/delegation.ts`**

```ts
/**
 * The five loop guards and the constraint inheritance, all pure.
 *
 * Pure on purpose: every one of them is a rule that must be provable without
 * a database, and the two that need stored rows (§5.4, §5.5) take the rows as
 * arguments rather than fetching them. `envelope-store.ts` owns the queries.
 */
import { AgentId } from '../domain/audit.js';
import {
  MAX_HOPS,
  type AgentEnvelope,
  type ContextRef,
  type EnvelopeConstraints,
} from '../domain/envelope.js';
import type { Plan } from '../domain/plan.js';
import { lowestTrust, mostRestrictiveAutonomy } from '../domain/trust.js';
import { canonicalHash } from '../util/canonical.js';

/**
 * Every field of a child's constraints, derived from the parent's and the
 * source's by taking the stricter of the two.
 *
 * **One function is the single source for all five rows.** Five places each
 * tightening one field are five places that drift, and the drift is silent:
 * a field that stopped tightening still returns a value, and the only symptom
 * is a child with more authority than its parent.
 *
 * `charterVersion` is copied from the parent and never negotiated — a child
 * running under a charter the parent never saw is a child whose result the
 * parent cannot explain.
 */
export function tightenConstraints(
  parent: EnvelopeConstraints,
  source: Partial<EnvelopeConstraints>,
): EnvelopeConstraints {
  const provenanceCeiling =
    source.provenanceCeiling === undefined
      ? parent.provenanceCeiling
      : lowestTrust([parent.provenanceCeiling, source.provenanceCeiling]);

  const autonomyCeiling =
    source.autonomyCeiling === undefined
      ? parent.autonomyCeiling
      : mostRestrictiveAutonomy([parent.autonomyCeiling, source.autonomyCeiling]);

  // `null` on either side means "no ceiling of my own" and must not win.
  const money =
    source.moneyCeilingMinor === undefined || source.moneyCeilingMinor === null
      ? parent.moneyCeilingMinor
      : parent.moneyCeilingMinor === null
        ? source.moneyCeilingMinor
        : Math.min(parent.moneyCeilingMinor, source.moneyCeilingMinor);

  const deadlineAt =
    source.deadlineAt === undefined
      ? parent.deadlineAt
      : Date.parse(source.deadlineAt) < Date.parse(parent.deadlineAt)
        ? source.deadlineAt
        : parent.deadlineAt;

  return {
    charterVersion: parent.charterVersion,
    provenanceCeiling,
    autonomyCeiling,
    moneyCeilingMinor: money,
    deadlineAt,
  };
}
```

- [ ] **Step 5: הריצו כדי לוודא שעובר**

Run: `npx vitest run src/governance/delegation.test.ts`
Expected: PASS — ארבעה מבחנים

- [ ] **Step 6: הריצו את המוטציה שמוכיחה שהמבחן נושך**

החליפו ב-`tightenConstraints` את `lowestTrust` ב-`highestTrust` מאולתר (או הפכו את `Math.min` ל-`Math.max`), הריצו, ואשרו ש**`never loosens a single field` נופל**. החזירו.

Expected: כל מוטציה מפילה את המבחן הנקוב. אם היא לא מפילה — המבחן אינו מבחן, ותקנו אותו לפני שתמשיכו.

- [ ] **Step 7: הוסיפו את ארבעת השומרים הטהורים הנותרים**

באותו קובץ. כל אחד מחזיר `DelegationDenial | null` — `null` פירושו "עבר".

```ts
export type DelegationDenial =
  | { code: 'hop_limit'; reason: string }
  | { code: 'not_permitted'; reason: string }
  | { code: 'unknown_intent'; reason: string }
  | { code: 'no_new_information'; reason: string }
  | { code: 'oscillation'; reason: string }
  | { code: 'daily_cap'; reason: string };

/**
 * Guard 1. Refuses at the ceiling rather than at the ceiling plus one, so no
 * envelope carrying `hops > MAX_HOPS` is ever constructed.
 */
export function hopGuard(parentHops: number): DelegationDenial | null {
  if (parentHops + 1 > MAX_HOPS) {
    return {
      code: 'hop_limit',
      reason: `שרשרת ההאצלה הגיעה ל-${MAX_HOPS} קפיצות ואינה ממשיכה`,
    };
  }
  return null;
}

/**
 * Guard 4, and the one that actually kills ping-pong. A→B→A continues only
 * when A genuinely has new context.
 *
 * Takes the prior quadruples as an argument rather than querying: the rule is
 * provable without a database, and `envelope-store.ts` owns the query.
 */
export function noNewInformationGuard(
  candidate: { from: string; to: string; intent: string; contextRefsHash: string },
  prior: readonly { from: string; to: string; intent: string; contextRefsHash: string }[],
): DelegationDenial | null {
  const seen = prior.some(
    (p) =>
      p.from === candidate.from &&
      p.to === candidate.to &&
      p.intent === candidate.intent &&
      p.contextRefsHash === candidate.contextRefsHash,
  );
  if (seen) {
    return {
      code: 'no_new_information',
      reason: `${candidate.from} כבר ביקש מ-${candidate.to} בדיוק את זה, על אותו הקשר`,
    };
  }
  return null;
}

/** Guard 5. More than two exchanges between one pair on one intent. */
export const MAX_PAIR_EXCHANGES = 2;

export function oscillationGuard(exchanges: number): DelegationDenial | null {
  if (exchanges >= MAX_PAIR_EXCHANGES) {
    return {
      code: 'oscillation',
      reason:
        `שני הסוכנים החליפו ביניהם ${exchanges} פעמים על אותו נושא. ` +
        `שני סוכנים שחלוקים ביניהם הם סימן שאדם צריך להסתכל, לא שסוכן שלישי יכריע`,
    };
  }
  return null;
}

/** Guard 2's model-cost half. Money is already capped per business by `spend_ledger`. */
export function dailyCapGuard(used: number, cap: number): DelegationDenial | null {
  if (used >= cap) {
    return { code: 'daily_cap', reason: `תקרת ההאצלות היומית (${cap}) נוצלה` };
  }
  return null;
}

/**
 * The hash guard 4 compares.
 *
 * **Sorted before hashing**, the same lesson `planFingerprint` in
 * `erasure-plan.ts` already carries: the arrays behind these pointers come
 * from queries without `ORDER BY`, so hashing the raw order refuses at random
 * — and a control that fires when nothing happened teaches people to click
 * past it.
 */
export function contextRefsHash(refs: readonly ContextRef[]): string {
  const canonical = refs
    .map((ref) => JSON.stringify(ref, Object.keys(ref).sort()))
    .slice()
    .sort();
  return canonicalHash({ refs: canonical });
}

/**
 * Guard 3 of §6.3's first layer: may `from` ask `to` at all.
 *
 * Read from the compiled charter's `collaborationGraph`, which until this work
 * was compiled into the signed bundle and read by nobody.
 */
export function mayDelegate(
  graph: Readonly<Record<string, readonly string[]>>,
  from: string,
  to: string,
): boolean {
  if (!Object.hasOwn(graph, from)) return false;
  return (graph[from] ?? []).includes(to);
}

export type DelegationPlanProblem = {
  kind: 'delegation_pair_not_permitted';
  stepId: string;
  from: string;
  to: string;
};

/**
 * Layer one of §6.3: a plan naming a forbidden pair is rejected whole, before
 * any step runs — the rule that already holds for the tool allowlist, and for
 * the same reason: a step that fails alone leaves the steps before it done.
 *
 * Lives here rather than in `planProblems` (`src/domain/plan.ts`), which the
 * spec named: that function is pure over a `Plan` and reaching the compiled
 * bundle from it would import `src/governance/` into `src/domain/`.
 */
export function delegationProblems(
  plan: Plan,
  graph: Readonly<Record<string, readonly string[]>>,
): DelegationPlanProblem[] {
  const problems: DelegationPlanProblem[] = [];
  for (const step of plan.steps) {
    if (step.toolName !== 'agent.request_help') continue;
    const to = Object.hasOwn(step.input, 'to') ? step.input['to'] : undefined;
    if (typeof to !== 'string' || !AgentId.safeParse(to).success || !mayDelegate(graph, step.agent, to)) {
      problems.push({
        kind: 'delegation_pair_not_permitted',
        stepId: step.id,
        from: step.agent,
        to: typeof to === 'string' ? to : '(חסר)',
      });
    }
  }
  return problems;
}
```

- [ ] **Step 8: כתבו מבחנים לארבעת השומרים ולשתי הפונקציות**

שמות המבחנים, וכל אחד עם אסרשן מדויק:

- `hopGuard` — `refuses at the ceiling, not one past it`: `hopGuard(5)` הוא `null`, `hopGuard(6)` מחזיר `hop_limit`.
- `noNewInformationGuard` — `refuses the identical quadruple and allows a changed context`: אותה רביעייה → `no_new_information`; שינוי ב-`contextRefsHash` בלבד → `null`.
- `oscillationGuard` — `refuses at two exchanges`: `1` הוא `null`, `2` מחזיר `oscillation`.
- `dailyCapGuard` — `refuses when the cap is used up`: `(49, 50)` הוא `null`, `(50, 50)` מחזיר `daily_cap`.
- `contextRefsHash` — `is stable under reordering`: שני מערכים עם אותם מצביעים בסדר הפוך מניבים אותו hash; מצביע שונה מניב hash שונה.
- `mayDelegate` — `refuses an agent with no graph entry and refuses ops.web by name`: `mayDelegate(graph, 'ops.web', 'comms.email')` הוא `false`. **וגם** `mayDelegate({}, 'constructor', 'x')` הוא `false` — `Object.hasOwn` ולא `in`.
- `delegationProblems` — `rejects a step whose payload names a pair outside the graph`, ו-`rejects a delegation step with no "to" at all`.

- [ ] **Step 9: כתבו את מבחן האינווריאנט על `ContextRef`**

`src/domain/envelope.test.ts`:

```ts
/**
 * Every branch of ContextRef is a pointer. The next person to add one will
 * reach for a convenient `content: string`, and that single field turns
 * delegation into the injection path §3.2 exists to close.
 *
 * Asserted against the schema rather than a hand-written list of branch names,
 * so a branch added without touching this file is still covered.
 */
it('has no branch carrying free text', () => {
  const branches = ContextRef.options;
  expect(branches.length).toBeGreaterThan(0);
  for (const branch of branches) {
    const keys = Object.keys(branch.shape);
    expect(keys.length, JSON.stringify(keys)).toBe(2);
    expect(keys).toContain('kind');
    const idKey = keys.find((k) => k !== 'kind');
    expect(idKey, JSON.stringify(keys)).toMatch(/Id$/);
  }
});
```

- [ ] **Step 10: הריצו הכול, ואז `typecheck`**

Run: `npx vitest run src/domain/envelope.test.ts src/governance/delegation.test.ts` ואז `npm run typecheck`
Expected: הכול עובר

- [ ] **Step 11: Commit**

```bash
git add src/domain/envelope.ts src/domain/envelope.test.ts src/governance/delegation.ts src/governance/delegation.test.ts
git commit -m "The envelope, and the five guards as pure functions"
```

---

## Task 2: מיגרציה 028 ומאגר המעטפות

**Files:**
- Create: `src/db/migrations/028_agent_envelopes.sql`
- Create: `src/governance/envelope-store.ts`
- Modify: `src/test/db.ts` (רשימת `TRUNCATE`)
- Test: `src/governance/envelope-store.test.ts`

**Interfaces:**
- Consumes: `AgentEnvelope`, `EnvelopeConstraints` מ-Task 1; `getPool`, `withTransaction`, `Queryable` מ-`src/db/pool.js`
- Produces:
  - `writeEnvelope(envelope: AgentEnvelope, options: { parentJobId: string; childJobId?: string | null; businessId?: string; db?: Queryable }): Promise<{ status: 'stored' | 'duplicate'; envelope: AgentEnvelope }>`
  - `loadEnvelope(envelopeId: string, options?: { businessId?: string; db?: Queryable }): Promise<AgentEnvelope | null>`
  - `priorQuadruples(correlationId: string, options?): Promise<{ from: string; to: string; intent: string; contextRefsHash: string }[]>`
  - `countPairExchanges(correlationId: string, from: string, to: string, intent: string, options?): Promise<number>`
  - `delegationsToday(options?: { businessId?: string; db?: Queryable }): Promise<number>`
  - `attachChildJob(envelopeId: string, childJobId: string, options?): Promise<void>`

- [ ] **Step 1: כתבו את המיגרציה**

`src/db/migrations/028_agent_envelopes.sql` — **קובץ חדש ולא עריכה של קובץ קיים.** הרַץ עוקב לפי שם קובץ, ולכן עריכה במקום הייתה משאירה כל בסיס שכבר הריץ מיגרציה קודמת בלי הטבלאות בזמן שהקובץ טוען אחרת.

```sql
CREATE TABLE agent_envelopes (
    business_id       TEXT        NOT NULL,
    envelope_id       TEXT        NOT NULL,
    correlation_id    TEXT        NOT NULL,
    causal_chain      TEXT[]      NOT NULL,
    from_agent        TEXT        NOT NULL,
    to_agent          TEXT        NOT NULL,
    kind              TEXT        NOT NULL,
    intent            TEXT        NOT NULL,
    payload           JSONB       NOT NULL,
    context_refs      JSONB       NOT NULL,
    context_refs_hash TEXT        NOT NULL,
    constraints       JSONB       NOT NULL,
    hops              INT         NOT NULL CHECK (hops >= 0 AND hops <= 6),
    idempotency_key   TEXT        NOT NULL,
    parent_job_id     TEXT        NOT NULL,
    child_job_id      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, envelope_id),
    CONSTRAINT envelope_idempotency_unique UNIQUE (business_id, idempotency_key)
);

-- Guard 4: the quadruple, inside one correlation.
CREATE INDEX agent_envelopes_no_new_info_idx
    ON agent_envelopes (business_id, correlation_id, from_agent, to_agent, intent, context_refs_hash);

-- resumeDelegatedJobs: find the envelope of a child that just finished.
CREATE INDEX agent_envelopes_child_idx
    ON agent_envelopes (business_id, child_job_id) WHERE child_job_id IS NOT NULL;

CREATE TABLE verification_verdicts (
    business_id TEXT        NOT NULL,
    job_id      TEXT        NOT NULL,
    verdict     JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (business_id, job_id)
);

ALTER TABLE jobs ADD COLUMN awaiting_envelope_id TEXT;
```

**`kind` נושא `NOT NULL` ולא `CHECK`, בכוונה** — סכמת zod היא המקור היחיד לרשימת הערכים, בדיוק כמו `audit_log.kind`. שני מקומות שמונים ערכים הם שני מקומות שייסחפו.

- [ ] **Step 2: הוסיפו את שתי הטבלאות ל-`resetDatabase`**

`src/test/db.ts` — הוסיפו `agent_envelopes` ו-`verification_verdicts` לרשימת ה-`TRUNCATE`, **לפני** `jobs` (שתיהן מפנות ל-job, וגם אם אין מפתח זר הסדר קורא נכון לקורא הבא).

- [ ] **Step 3: הריצו את המיגרציה על בסיס הבדיקות**

Run: `npm run migrate:test`
Expected: המיגרציה 028 רצה; אין שגיאה

- [ ] **Step 4: כתבו את המבחנים — שמות ואסרשנים, גופים ייכתבו מול החתימות**

`src/governance/envelope-store.test.ts`, עם `resetDatabase()` ב-`beforeEach`:

1. **`round-trips an envelope through the database unchanged`** — `writeEnvelope` ואז `loadEnvelope` מחזיר אובייקט שעובר `AgentEnvelope.parse` ושווה למקור, **כולל `causalChain` כמערך ו-`constraints` כאובייקט**.
2. **`returns duplicate and stores nothing on a repeated idempotency key`** — קריאה שנייה עם אותו `idempotencyKey` מחזירה `status: 'duplicate'`, ו-`SELECT count(*)` על הטבלה הוא 1. **זה שומר 3.**
3. **`prior quadruples are scoped to one correlation`** — שתי מעטפות תחת שני `correlation_id` שונים עם אותה רביעייה בדיוק; `priorQuadruples` על הראשון מחזיר אחת. בלי הסקופ, שומר 4 היה דוחה בקשה לגיטימית במשימה אחרת לגמרי.
4. **`counts exchanges for one pair on one intent only`** — שלוש מעטפות: שתיים על אותו זוג ואותו intent, אחת על intent אחר; `countPairExchanges` מחזיר 2.
5. **`delegationsToday counts audit rows and not envelope rows`** — כתבו שורת `audit_log` מסוג `delegation` **בלי** שורת מעטפת, ואשרו שהמונה הוא 1. זה מה שמבדיל בין "האצלה שנכשלה אחרי שחויבה" לבין "לא קרה כלום", ומה שמונע ספירה שמפספסת כשל בתשלום.
6. **`attachChildJob fills the column the resumer reads`**.

- [ ] **Step 5: כתבו `src/governance/envelope-store.ts`**

מוסכמת `interface EnvelopeRow` פרטי + `toEnvelope(row)`. `writeEnvelope` משתמש ב-`INSERT ... ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING *` ואז, אם לא הוחזרה שורה, קורא את הקיימת — **insert-then-read ולא read-then-insert**, אותו דפוס בדיוק ש-`bindPlanToJob` מחזיק ומאותה סיבה: שני כותבים בו-זמנית ששניהם קוראים "אין שורה" ושניהם מתקדמים.

- [ ] **Step 6: הריצו**

Run: `npx vitest run src/governance/envelope-store.test.ts`
Expected: שישה מבחנים עוברים

- [ ] **Step 7: הריצו את המוטציה**

הסירו את `correlation_id = $1` מה-`WHERE` של `priorQuadruples`. **מבחן 3 חייב ליפול.** החזירו.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/028_agent_envelopes.sql src/governance/envelope-store.ts src/governance/envelope-store.test.ts src/test/db.ts
git commit -m "Migration 028 and the envelope store"
```

---

## Task 3: ההאצלה הופכת ליכולת מסווגת

**Files:**
- Modify: `src/domain/action.ts` (`ActionClass`, `ACTION_ADDRESSEE`)
- Modify: `src/policy/classify.ts` (`READ_ONLY_TOOLS`, `TOOL_ACTION_CLASS`, `CEILING_EXEMPT_TOOLS` חדשה)
- Modify: `src/orchestrator/ramp.ts` (`rampLevelForPlan`)
- Modify: `src/charter/capabilities.ts` (`AGENT_ALLOWLISTS`)
- Modify: `src/test/fixtures.ts` (`buildCharter` — בסיס אוטונומיה)
- Test: `src/policy/positive-controls.test.ts`, `src/charter/capabilities.test.ts`

**Interfaces:**
- Produces: מחלקת הפעולה `'agent.delegate'`; `CEILING_EXEMPT_TOOLS: Set<string>`

- [ ] **Step 1: כתבו את שלושת מבחני האינווריאנט שנכשלים**

ב-`src/policy/positive-controls.test.ts`:

```ts
/**
 * Delegation is classified so it is gated and audited, and exempt from the
 * plan ceiling so it can actually run. Both halves are load-bearing and both
 * are easy to undo by accident, so both are asserted here.
 */
describe('delegation is classified but contributes no plan ceiling', () => {
  it('classifies agent.request_help and keeps it off the read-only list', () => {
    expect(classifyAction('agent.request_help', {})).toBe('agent.delegate');
    expect(READ_ONLY_TOOLS.has('agent.request_help')).toBe(false);
  });

  /**
   * The list that lets a plan containing a delegation still run. Kept to one
   * member: a tool that carries a real side effect and contributes no ceiling
   * runs under whatever other class the plan declares, which is the documented
   * hazard. Delegation is admissible only because it carries no outbound
   * authority of its own — the child job's own steps face the full ten stages.
   */
  it('exempts exactly one tool from the plan ceiling, and it addresses internally', () => {
    expect([...CEILING_EXEMPT_TOOLS]).toEqual(['agent.request_help']);
    for (const tool of CEILING_EXEMPT_TOOLS) {
      const cls = classifyAction(tool, {});
      expect(cls, tool).not.toBeNull();
      expect(addresseeOf(cls!), tool).toBe('internal');
      // Disjoint from READ_ONLY_TOOLS: that list already means "no ceiling",
      // and a tool in both would be two mechanisms for one property.
      expect(READ_ONLY_TOOLS.has(tool), tool).toBe(false);
    }
  });
});
```

ב-`src/charter/capabilities.test.ts`:

```ts
/**
 * The capability layer denies before the charter, so an agent with graph
 * neighbours but without the delegation tool holds a signed edge it can never
 * use — the dead-rule class this file already guards against for
 * `UNOWNED_TOOLS`. And the other direction is the dangerous one: `ops.web`
 * must not hold the tool at all, not merely be refused at the gate. A hijacked
 * browser session should not reach even a call that would be denied.
 */
it('holds the delegation tool if and only if its graph entry is non-empty', () => {
  for (const agent of AgentId.options) {
    const hasNeighbours = (COLLABORATION_GRAPH[agent] ?? []).length > 0;
    const holdsTool = isToolPermitted(agent, 'agent.request_help');
    expect(holdsTool, `${agent}: neighbours=${hasNeighbours}`).toBe(hasNeighbours);
  }
  expect(isToolPermitted('ops.web', 'agent.request_help')).toBe(false);
});
```

- [ ] **Step 2: הריצו כדי לוודא שנכשלים**

Run: `npx vitest run src/policy/positive-controls.test.ts src/charter/capabilities.test.ts`
Expected: FAIL — `CEILING_EXEMPT_TOOLS` אינו מיוצא, ו-`classifyAction` מחזיר `null`

- [ ] **Step 3: הוסיפו את מחלקת הפעולה**

`src/domain/action.ts` — הוסיפו `'agent.delegate'` ל-`ActionClass` תחת תגובה חדשה, ו-`'agent.delegate': 'internal'` ל-`ACTION_ADDRESSEE`:

```ts
  // Asking another agent for help. `internal` and therefore not outbound: a
  // delegation does not leave the installation, so it is not redacted, not
  // subject to quiet hours, and not in the kill switch's `outbound` scope.
  'agent.delegate',
```

- [ ] **Step 4: הזיזו את הכלי בין הרשימות והוסיפו את השלישית**

ב-`src/policy/classify.ts`: הסירו `'agent.request_help'` מ-`READ_ONLY_TOOLS`; הוסיפו `'agent.request_help': 'agent.delegate'` ל-`TOOL_ACTION_CLASS`; **השאירו** `ingestsExternalContent['agent.request_help'] = true` כפי שהוא. ואז:

```ts
/**
 * Classified and audited, but contributing no ceiling to the plan.
 *
 * `rampLevelForPlan` takes the minimum over the classes a plan declares. With
 * a class of its own and no exemption, every plan containing a delegation is
 * floored by `agent.delegate`'s ramp — and since the owner's dial defaults to
 * `off`, which clamps both floor and ceiling to `draft_only`, no delegation
 * would ever run in a fresh install. That is exactly what happened on 11/09
 * with `memory.recall` and `mail.draft`.
 *
 * `READ_ONLY_TOOLS` is the existing way to contribute no ceiling, and the tool
 * must not go back there: the two tables must stay disjoint, and an invariant
 * locks that.
 *
 * **One member, and the reason is attached to it:** a delegation carries no
 * outbound authority. It opens a child job whose every step faces all ten
 * gate stages under its own ramp and under constraints that could only have
 * tightened. The ceiling belongs to what the child does, not to the request
 * that opened it.
 */
export const CEILING_EXEMPT_TOOLS = new Set<string>(['agent.request_help']);
```

- [ ] **Step 5: לימדו את `rampLevelForPlan` לדלג**

ב-`src/orchestrator/ramp.ts`, בלולאה על הצעדים, דלגו על צעד שהכלי שלו ב-`CEILING_EXEMPT_TOOLS` — **לפני** הבדיקה של `expectedActionClass === null`, ועם הערה שמפנה ל-docblock של הרשימה.

- [ ] **Step 6: הוסיפו את הכלי לרשימות ההיתר, לפי הגרף**

ב-`src/charter/capabilities.ts`, הוסיפו `'agent.request_help'` ל-`AGENT_ALLOWLISTS` של **כל סוכן שהערך שלו ב-`COLLABORATION_GRAPH` אינו ריק**: `comms.email`, `comms.whatsapp`, `sched.meetings`, `know.memory`, `ops.tasks`, `ops.systems`, `prod.docs`, `prod.media`, `gov.risk`, `gov.verify`. **לא** ל-`intake.triage`, `know.reader`, `know.digest`, `ops.web`, `gov.charter`.

- [ ] **Step 7: תנו לתקנון בסיס אוטונומיה למחלקה החדשה**

ב-`src/test/fixtures.ts`, ב-`buildCharter`, הוסיפו `'agent.delegate': 'auto'` ל-`autonomyBase`. בלי זה המחלקה חסומה בתקנון ושום רמפה לא תזיז אותה — וזו הבחירה שהמשתמש אישר במפורש: ההאצלה נרשמת ורצה, והכרטיס שייך לפעולה היוצאת.

- [ ] **Step 8: הריצו את החבילה המלאה**

Run: `npm run typecheck && npm test`
Expected: הכול עובר. **`ActionClass` חדש עלול להפיל מבחנים קיימים שממפים על כל המחלקות** — אם נפל מבחן כזה, הוסיפו את המחלקה לטבלה שהוא בודק ואל תרככו את המבחן.

- [ ] **Step 9: הריצו את המוטציה**

הוסיפו `'mail.send'` ל-`CEILING_EXEMPT_TOOLS`. **מבחן `exempts exactly one tool from the plan ceiling` חייב ליפול** (גם על הגודל וגם על `addresseeOf`). החזירו.

- [ ] **Step 10: Commit**

```bash
git add src/domain/action.ts src/policy/classify.ts src/orchestrator/ramp.ts src/charter/capabilities.ts src/charter/capabilities.test.ts src/policy/positive-controls.test.ts src/test/fixtures.ts
git commit -m "Delegation becomes a classified capability, exempt from the plan ceiling alone"
```

---

## Task 4: השער קורא את הגרף, והאינווריאנט מורחב לכל השדות המקומפלים

**Files:**
- Modify: `src/policy/engine.ts` (שלב 3, אחרי `isToolPermitted`, שורה ~160)
- Modify: `src/domain/policy.ts` (`DENY_CODES`)
- Modify: `src/charter/capabilities.test.ts` (`compiled policy has a reader`)
- Test: `src/policy/engine.test.ts`

**Interfaces:**
- Consumes: `mayDelegate` מ-Task 1
- Produces: `DENY_CODES.delegationNotPermitted = 'delegation_not_permitted'`

- [ ] **Step 1: כתבו את שני המבחנים שנכשלים**

ב-`src/policy/engine.test.ts`, דרך `evaluateToolCall` אמיתי:

1. **`refuses a delegation to an agent outside the caller's graph entry`** — `agent: 'ops.web'`, `toolName: 'agent.request_help'`, `toolInput: { to: 'comms.email', intent: 'x', payload: {} }`. מצפים ל-`outcome: 'deny'` עם `code: 'delegation_not_permitted'`.
2. **`allows a delegation the graph permits`** — `agent: 'gov.verify'`, `to: 'know.reader'`. מצפים ל-`outcome: 'allow'`.
3. **`refuses a delegation whose payload has no readable "to"`** — `toolInput: { intent: 'x' }` ואז `toolInput: { to: 123 }`. שניהם `deny`. **ערך שלא הצלחנו לקרוא אינו ערך מתיר.**

**זהירות — הלקח מהמבחנים השליליים:** מבחן 1 עלול לעבור מהסיבה הלא נכונה, כי `ops.web` **אינו מחזיק** את הכלי אחרי Task 3, ולכן ייפול קודם על `tool_not_allowlisted`. לכן **מבחן 1 חייב לאשר את הקוד המדויק** (`delegation_not_permitted` ולא `tool_not_allowlisted`), ולהשתמש בסוכן שכן מחזיק את הכלי אך שהיעד אינו בערך שלו — למשל `gov.verify` אל `comms.email` (הערך של `gov.verify` הוא `['know.reader']` בלבד).

- [ ] **Step 2: הריצו כדי לוודא שנכשלים**

Run: `npx vitest run src/policy/engine.test.ts`
Expected: FAIL — הקוד `delegation_not_permitted` אינו קיים

- [ ] **Step 3: הוסיפו את קוד הדחייה**

`src/domain/policy.ts`, ב-`DENY_CODES`: `delegationNotPermitted: 'delegation_not_permitted',`

- [ ] **Step 4: הוסיפו את הבדיקה בשלב 3**

`src/policy/engine.ts`, **מיד אחרי** גוש ה-`isToolPermitted` ולפני `// 4. Read-only short-circuit`:

```ts
  // Still stage 3, and deliberately here rather than in a stage of its own:
  // "whom may you ask" is a permission question, and this is the one place
  // that answers permission questions. The gate already reads payloads for
  // exactly this — stage 6 reads the recipient list to answer "whom may you
  // write to". Same question, different addressee space.
  //
  // `collaborationGraph` was compiled into the signed bundle from the first
  // migration and read by nobody until this line, which made the rule that
  // `ops.web` delegates to nobody signed and unenforced.
  if (toolName === 'agent.request_help') {
    const to = Object.hasOwn(toolInput, 'to') ? toolInput['to'] : undefined;
    if (typeof to !== 'string' || !AgentId.safeParse(to).success) {
      return deny(
        DENY_CODES.delegationNotPermitted,
        'בקשת עזרה בלי נמען קריא — סוכן יעד שלא נפתר אינו נמען מותר',
      );
    }
    if (!mayDelegate(ctx.bundle.collaborationGraph, ctx.agent, to)) {
      return deny(
        DENY_CODES.delegationNotPermitted,
        `${ctx.agent} אינו רשאי לבקש עזרה מ-${to}`,
      );
    }
  }
```

`Object.hasOwn` ולא גישה ישירה, מאותה סיבה שהיא כזו ב-`SDK_TO_INTERNAL`: `constructor` ו-`toString` נפתרים לערך ועוברים בדיקה תמימה.

- [ ] **Step 5: הרחיבו את `compiled policy has a reader` לכל השדות**

`src/charter/capabilities.test.ts` — מבחן חדש לצד השניים הקיימים:

```ts
/**
 * The two tests above cover `ceilings` and `doNotContact`. `collaborationGraph`
 * sat outside both, compiled into the signed charter and read by nobody — the
 * fifth instance of this defect class in this project, and the first that the
 * mechanical check was supposed to catch and did not.
 *
 * This asserts over EVERY top-level field of the compiled bundle, so the sixth
 * instance cannot exist. A field genuinely not meant for the gate is added to
 * `NOT_READ_BY_GATE` by name, with a reason — which is a decision someone
 * writes down, not a gap nobody noticed.
 */
it('every compiled top-level field is named somewhere in the gate', () => {
  const NOT_READ_BY_GATE = new Set<string>([
    // Identity of the bundle itself, compared in stage 2 by value rather than
    // by name lookup.
    'charterVersion',
  ]);
  const compiled = compileCharter(buildCharter()) as Record<string, unknown>;
  const fields = Object.keys(compiled).filter((f) => !NOT_READ_BY_GATE.has(f));
  expect(fields.length).toBeGreaterThan(3);
  const unread = fields.filter((field) => !GATE_SOURCES.some((src) => src.includes(field)));
  expect(unread).toEqual([]);
});
```

**אם המבחן הזה מאדים על שדות נוספים מלבד `collaborationGraph` — זו מציאה, לא תקלה במבחן.** רשמו כל שדה כזה בדוח המשימה; אל תוסיפו אותו ל-`NOT_READ_BY_GATE` בלי נימוק כתוב.

- [ ] **Step 6: הריצו**

Run: `npx vitest run src/policy/engine.test.ts src/charter/capabilities.test.ts && npm test`
Expected: הכול עובר

- [ ] **Step 7: הריצו את המוטציה**

הסירו את גוש `mayDelegate` משלב 3. **מבחן `refuses a delegation to an agent outside the caller's graph entry` חייב ליפול.** אשרו שהוא נופל על הקוד הנכון ולא על `tool_not_allowlisted`. החזירו.

- [ ] **Step 8: Commit**

```bash
git add src/policy/engine.ts src/domain/policy.ts src/policy/engine.test.ts src/charter/capabilities.test.ts
git commit -m "The gate reads the collaboration graph, and the reader check covers every compiled field"
```

---

## Task 5: השכבה הראשונה — `delegationProblems` ב-`runPlan`

**Files:**
- Modify: `src/orchestrator/run-plan.ts` (אחרי `planProblems`, שורה ~210)
- Test: `src/orchestrator/plan-body.test.ts`

**Interfaces:**
- Consumes: `delegationProblems` מ-Task 1

- [ ] **Step 1: כתבו את המבחן שנכשל**

**`rejects the whole plan when a delegation step names a pair outside the graph`** — תוכנית בת שני צעדים: צעד ראשון תמים, צעד שני `agent.request_help` מ-`gov.verify` אל `comms.email`. מצפים ל-`status: 'rejected'`, `code: 'malformed_plan'`, ו**שאף שורה לא נכתבה ב-`job_step_results`** — הנקודה כולה היא שהתוכנית נפסלת לפני שצעד אחד רץ.

- [ ] **Step 2: הריצו כדי לוודא שנכשל**

Run: `npx vitest run src/orchestrator/plan-body.test.ts`
Expected: FAIL — התוכנית רצה והצעד הראשון מבוצע

- [ ] **Step 3: הוסיפו את הקריאה**

`src/orchestrator/run-plan.ts`, מיד אחרי גוש `planProblems`:

```ts
  // Layer one of two. The gate answers "is it permitted right now" per call;
  // this answers "can the charter ever serve this plan" for the plan as a
  // whole — the same split the channel already has (feasibility at validation,
  // availability at execution), and for the same reason: a step that fails
  // alone leaves the steps before it already done.
  const delegationIssues = delegationProblems(plan, bundle.collaborationGraph);
  if (delegationIssues.length > 0) {
    const first = delegationIssues[0]!;
    return {
      status: 'rejected',
      code: 'malformed_plan',
      reason: `צעד ${first.stepId}: ${first.from} אינו רשאי לבקש עזרה מ-${first.to}`,
    };
  }
```

- [ ] **Step 4: הריצו**

Run: `npx vitest run src/orchestrator/plan-body.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/run-plan.ts src/orchestrator/plan-body.test.ts
git commit -m "A plan naming a forbidden delegation pair is rejected whole"
```

---

## Task 6: מרשם ה-intents ומטפל ההאצלה

**Files:**
- Create: `src/governance/intent-registry.ts`
- Create: `src/orchestrator/delegate.ts`
- Modify: `src/domain/audit.ts` (`AuditKind`)
- Modify: `src/config.ts` (`delegationsPerDay`)
- Modify: `src/domain/job.ts` + `src/orchestrator/jobs.ts` (`awaitingEnvelopeId`)
- Test: `src/governance/intent-registry.test.ts`, `src/orchestrator/delegate.test.ts`

**Interfaces:**
- Consumes: כל Task 1, כל Task 2, `createJob`, `transition`, `loadJob`, `appendAudit`, `bindPlanToJob`
- Produces: `INTENT_REGISTRY`, `resolveIntent(to, intent)`, `requestHelp(input): Promise<RequestHelpResult>`

- [ ] **Step 1: כתבו את המרשם**

`src/governance/intent-registry.ts`:

```ts
/**
 * For each RECEIVING agent: which intents it accepts, the zod schema for each
 * payload, and the tool the child's one step will call.
 *
 * One receiver today. `gov.verify` is nobody's delegate in
 * `COLLABORATION_GRAPH`, so it has no entry — an empty entry would advertise a
 * capability that does not exist, which is the dead-rule shape this codebase
 * already pays to avoid.
 *
 * Lookup is `Object.hasOwn`, never `in`: `constructor` and `toString` resolve
 * through the prototype and would read as registered intents.
 */
import { z } from 'zod';

export interface IntentSpec {
  payload: z.ZodTypeAny;
  /** A context ref of this kind must be present, or the request is refused. */
  requiresContextRef: 'document' | 'reading' | 'memory' | 'job' | null;
  /** The tool the child job's single step calls. */
  tool: string;
}

export const INTENT_REGISTRY: Record<string, Record<string, IntentSpec>> = {
  'know.reader': {
    /**
     * "Read this and tell me what it asks." The only intent this work needs,
     * and the one that the quarantine boundary forces: `gov.verify` may not
     * open an untrusted document itself.
     */
    read_for_question: {
      payload: z.object({ question: z.string().min(1).max(500) }),
      requiresContextRef: 'document',
      // know.reader's allowlist is ['doc.fetch', 'memory.recall'].
      tool: 'doc.fetch',
    },
  },
};

export function resolveIntent(to: string, intent: string): IntentSpec | null {
  if (!Object.hasOwn(INTENT_REGISTRY, to)) return null;
  const forAgent = INTENT_REGISTRY[to]!;
  if (!Object.hasOwn(forAgent, intent)) return null;
  return forAgent[intent]!;
}
```

- [ ] **Step 2: כתבו את מבחני המרשם**

1. **`resolves a registered intent and refuses an unregistered one`**.
2. **`refuses a prototype key as an agent name and as an intent name`** — `resolveIntent('constructor', 'x')` ו-`resolveIntent('know.reader', 'toString')` שניהם `null`.
3. **`every registered intent names a tool the policy engine knows`** — אינווריאנט: לכל ערך במרשם, `isKnownTool(spec.tool)` הוא `true`, **וגם** הכלי נמצא ברשימת ההיתר של הסוכן הנמען (`isToolPermitted(to, spec.tool)`). ערך שנוקב בכלי שהנמען אינו מחזיק הוא ערך שייכשל רק בזמן ריצה.

- [ ] **Step 3: הוסיפו `'delegation'` ל-`AuditKind`**

`src/domain/audit.ts`, עם docblock בסגנון השכנים:

```ts
  /**
   * One agent asked another for help. Carries the pair, the intent, the hop
   * count and the envelope id — never the payload and never what the context
   * refs point at. A delegation is a fact about the system's own plumbing, and
   * a row naming the subject would make the audit log the one place that
   * subject survives.
   */
  'delegation',
```

אין `CHECK` ב-SQL על `audit_log.kind`, ולכן זו עריכה אחת.

- [ ] **Step 4: הוסיפו את התקרה היומית ל-`config.ts`**

```ts
  // A delegation costs at least one model call in the child. Same shape as
  // `curationRunsPerDay` and for the same reason: this project caps model cost
  // with a daily count off `audit_log`, not with a token budget — and a second,
  // unproven cost mechanism beside the one that works is how two readers drift.
  delegationsPerDay: positiveInt('DELEGATIONS_PER_DAY', 50),
```

והוסיפו את השורה ל-`.env.example` עם הסבר בעברית.

- [ ] **Step 5: הוסיפו את העמודה לטיפוס ולממפה**

`src/domain/job.ts` — `awaitingEnvelopeId: string | null` על `Job`. `src/orchestrator/jobs.ts` — `toJob` ממפה `row.awaiting_envelope_id`.

- [ ] **Step 6: כתבו את המבחנים של `requestHelp` — שמות ואסרשנים**

`src/orchestrator/delegate.test.ts`, מול בסיס נתונים אמיתי:

1. **`opens a child job and parks the parent on the envelope`** — האם ב-`execute`; אחרי `requestHelp`, האם ב-`followup` עם `awaiting_envelope_id` שווה למזהה המעטפת, והבת קיימת עם תוכנית בת צעד אחד קשורה.
2. **`the child's constraints are tightened in every field, never loosened`** — האם עם `provenanceCeiling: 'staff'`; המקור מבקש `'boss'`; הבת מקבלת `'staff'`. **זהו האסרשן המרכזי של כל התוכנית.**
3. **`the child carries the parent's correlation id, not the parent's job id`**.
4. **`refuses a second identical request and opens no second child`** — שומר 3. `SELECT count(*) FROM jobs` אינו גדל.
5. **`refuses a repeat of the same quadruple with no new context`** — שומר 4.
6. **`fails the parent job on the third exchange between the same pair`** — שומר 5. האם ב-`failed`, והסיבה נוקבת בשני הסוכנים.
7. **`refuses when the daily cap is used up`** — שומר 2. זרעו `DELEGATIONS_PER_DAY` שורות ביקורת מסוג `delegation`.
8. **`refuses an unregistered intent`** ו-**`refuses a missing required context ref`**.
9. **`writes an audit row that names the pair and never the payload`** — השורה קיימת, `kind: 'delegation'`, `envelope_id` **אינו `null`**, ומחרוזת מהמטען **אינה** מופיעה ב-`reason`.
10. **`refuses to delegate from a job that is not in execute`** — אותו נימוק ש-`runPlan` בודק את הפאזה לפני שהוא כותב דבר.

- [ ] **Step 7: כתבו `src/orchestrator/delegate.ts`**

סדר הפעולות, והוא אינו שרירותי:

1. `loadJob` על ההורה; אם אינו ב-`execute` — סירוב, **לפני כל כתיבה**.
2. `resolveIntent` ואימות המטען בסכמה, ואימות `requiresContextRef`.
3. `hopGuard` · `dailyCapGuard` (מ-`delegationsToday`) · `noNewInformationGuard` (מ-`priorQuadruples`) · `oscillationGuard` (מ-`countPairExchanges`).
4. **בטרנזקציה אחת:** `writeEnvelope` → אם `duplicate`, יוצאים בלי לפתוח בת → `createJob` לבת → `bindPlanToJob` עם התוכנית הדטרמיניסטית → `attachChildJob` → `transition` של האם ל-`followup` עם `awaitingEnvelopeId`.
5. **אחרי ה-commit:** `appendAudit` מסוג `delegation`. אם הוא נכשל — זרקו `DelegationAuditUnrecordedError` בדפוס של `RotationAuditUnrecordedError`: הבת כבר קיימת, וההודעה הכנה היחידה היא "זה קרה והרישום חסר".

שומר 5 הוא היחיד שגם **מכשיל את האם** — `transition` ל-`failed` עם הסיבה, במקום להחזיר סירוב שההורה יתעלם ממנו.

- [ ] **Step 8: הריצו והריצו מוטציה**

Run: `npx vitest run src/orchestrator/delegate.test.ts src/governance/intent-registry.test.ts`

מוטציה: ב-`requestHelp`, העבירו את `constraints` של ההורה לבת **כמו שהם** במקום דרך `tightenConstraints`. **מבחן 2 חייב ליפול.** החזירו.

- [ ] **Step 9: Commit**

```bash
git add src/governance/intent-registry.ts src/governance/intent-registry.test.ts src/orchestrator/delegate.ts src/orchestrator/delegate.test.ts src/domain/audit.ts src/domain/job.ts src/orchestrator/jobs.ts src/config.ts .env.example
git commit -m "requestHelp: the five guards, the envelope, and the child job"
```

---

## Task 7: התעוררות ההורה, וסדר הסבב

**Files:**
- Create: `src/orchestrator/resume-delegated.ts`
- Modify: `src/orchestrator/scheduler.ts` (`schedulerPass`, `SchedulerPassResult`)
- Test: `src/orchestrator/resume-delegated.test.ts`

**Interfaces:**
- Produces: `resumeDelegatedJobs(options?): Promise<ResumeResult>` עם `{ resumed: string[]; timedOut: string[]; errored: string[] }`

- [ ] **Step 1: כתבו את המבחנים — שמות ואסרשנים**

1. **`wakes the parent when the child closes, and writes a result envelope`** — האם חוזרת ל-`execute`, `awaiting_envelope_id` הוא `null`, ונכתבה מעטפת `kind: 'result'`.
2. **`wakes the parent and says so plainly when the child failed`** — מעטפת `result` נכתבת גם כאן, עם התוצאה שהבקשה נכשלה. **האם אינה נכשלת מאליה.**
3. **`wakes the parent when the envelope's deadline passed and the child is still running`** — הבת ב-`execute`, הדדליין עבר; האם חוזרת ל-`execute`, המעטפת נכתבת עם `timeout`, וה-job מופיע ב-`timedOut`. בלי זה, בת תקועה אחת משאירה את האם ב-`followup` לנצח.
4. **`leaves a parent alone while its child is still inside the deadline`** — האם נשארת ב-`followup`.
5. **`isolates a failure on one parent from the rest of the round`** — שני הורים, אחד מהם עם נתונים פגומים; השני מתעורר בכל זאת, והראשון ב-`errored`. אותו דפוס בדיוק ש-`runDueJobs` מחזיק, כדי ש-poison pill אחד לא יעצור סבב.

- [ ] **Step 2: הריצו כדי לוודא שנכשלים**

Run: `npx vitest run src/orchestrator/resume-delegated.test.ts`
Expected: FAIL — המודול אינו קיים

- [ ] **Step 3: כתבו את המודול**

השאילתה מוצאת משימות ב-`followup` עם `awaiting_envelope_id IS NOT NULL`, ולכל אחת טוענת את המעטפת ואת הבת. מנעול advisory לפי job, וכשל מבודד לכל job — בדיוק כמו `runDueJobs`.

- [ ] **Step 4: חווטו לסבב, ראשון אחרי ה-tick**

ב-`schedulerPass`, **לפני** `runDueJobs`, עם הערה:

```ts
  // First after the tick, and the order matters: a child that closed on the
  // previous pass wakes its parent at the top of this one, so the parent runs
  // in this very pass through `runDueJobs` below. Run it after the plans
  // instead and every delegation would cost a full extra interval.
  const delegated = await resumeDelegatedJobs(options);
```

והוסיפו `delegated` ל-`SchedulerPassResult` עם docblock.

- [ ] **Step 5: הריצו**

Run: `npx vitest run src/orchestrator/resume-delegated.test.ts src/orchestrator/scheduler.test.ts && npm run typecheck`

- [ ] **Step 6: הריצו את המוטציה**

הסירו את בדיקת הדדליין. **מבחן 3 חייב ליפול.** החזירו.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/resume-delegated.ts src/orchestrator/resume-delegated.test.ts src/orchestrator/scheduler.ts
git commit -m "The parent wakes when its child finishes, or when the deadline says it will not"
```

---

## Task 8: חיבור שתי הטבלאות למחיקה

**Files:**
- Modify: `src/governance/erasure-plan.ts` (`countItems`, והפרדיקטים)
- Modify: `src/governance/erasure.ts` (המבצע)
- Modify: `src/governance/erasure-invariants.test.ts` (הזריעה)
- Test: `src/governance/erasure-plan.test.ts`, `src/governance/erasure.test.ts`

- [ ] **Step 1: קראו את שני הקבצים לפני שתכתבו שורה**

`agent_envelopes.payload`, `context_refs` ו-`intent` מחזיקים תוכן על אנשים, וכך גם `verification_verdicts.verdict` — פסיקה שאומרת "שני מספרים בטיוטה אינם במסמך" מצטטת את הטיוטה.

**הפרויקט הזה נכווה מזה שלוש פעמים** (`job_plans`, `job_authorizations`, וכרטיס אישור יתום שמעולם לא נזרע). הזריעה היא מה שהופך את הסריקה לבקרה; בלעדיה היא ירוקה מהסיבה הלא נכונה.

- [ ] **Step 2: הוסיפו את הזריעה למבחן האינווריאנט**

ב-`erasure-invariants.test.ts`, זרעו את המזהה הייחודי **בשתי הטבלאות** — ב-`agent_envelopes.payload` וב-`verification_verdicts.verdict`. הריצו, ואשרו ש**הסריקה מאדימה** לפני שחיברתם את המבצע. סריקה שירוקה עכשיו היא סריקה שלא בודקת את מה שהוספתם.

- [ ] **Step 3: הוסיפו לתצוגה המקדימה ולמבצע**

`countItems` נוקב בשתי הטבלאות בשמן; המבצע מוחק `agent_envelopes` לפי `parent_job_id` ו-`verification_verdicts` לפי `job_id`. **אותם פרדיקטים מילה במילה בשני המקומות** — התצוגה המקדימה והמחיקה אינן יכולות להיפרד כאן.

- [ ] **Step 4: הריצו**

Run: `npx vitest run src/governance/`
Expected: הסריקה ירוקה עכשיו, **ומהסיבה הנכונה** — כי המחיקה באמת מוחקת

- [ ] **Step 5: Commit**

```bash
git add src/governance/erasure-plan.ts src/governance/erasure.ts src/governance/erasure-invariants.test.ts
git commit -m "The two new tables are reached by erasure, and the scan proves it"
```

---

## Task 9: העיגון המספרי ומאגר הפסיקות

**Files:**
- Create: `src/governance/numeric-grounding.ts`
- Create: `src/governance/verdict-store.ts`
- Test: `src/governance/numeric-grounding.test.ts`, `src/governance/verdict-store.test.ts`

**Interfaces:**
- Produces:
  - `ungroundedNumbers(draft: string, sources: readonly string[]): string[]`
  - `Verdict` (סכמת zod) ו-`saveVerdict` / `loadVerdict`

- [ ] **Step 1: כתבו את המבחנים**

```ts
describe('ungroundedNumbers', () => {
  it('returns nothing when every number in the draft appears in a source', () => {
    expect(ungroundedNumbers('הסכום 11,988 ש"ח עד 15/10', ['סה"כ 11988', 'תאריך 15/10'])).toEqual([]);
  });

  it('names a number the sources never carry', () => {
    expect(ungroundedNumbers('הסכום 12,500 ש"ח', ['סה"כ 11988'])).toEqual(['12500']);
  });

  /**
   * Thousands separators and currency symbols are formatting, not value.
   * Comparing the raw strings would report every correctly copied amount.
   */
  it('compares values, not formatting', () => {
    expect(ungroundedNumbers('11,988.00', ['11988'])).toEqual([]);
  });

  /**
   * The check is a `must` criterion, so a false positive is a blocked send.
   * An empty source list means nothing was extracted, and reporting every
   * number as ungrounded there would make the control fire loudest exactly
   * when it knows least.
   */
  it('reports nothing when there are no sources to compare against', () => {
    expect(ungroundedNumbers('11,988', [])).toEqual([]);
  });
});
```

- [ ] **Step 2: הריצו כדי לוודא שנכשל, כתבו את המימוש, הריצו שוב**

הנרמול: חילוץ כל רצף ספרות עם מפרידים אפשריים, הסרת פסיקים ואפסי-סוף עשרוניים, השוואה כמחרוזות מנורמלות. **אפס קריאות מודל.**

- [ ] **Step 3: כתבו את `Verdict` ואת המאגר**

```ts
export const Verdict = z.object({
  criteria: z.array(
    z.object({
      id: z.string().min(1),
      statement: z.string().min(1),
      severity: z.enum(['must', 'should']),
      passed: z.boolean(),
      detail: z.string(),
    }),
  ).min(1),
  ungroundedNumbers: z.array(z.string()),
});
export type Verdict = z.infer<typeof Verdict>;
```

`saveVerdict` הוא `INSERT ... ON CONFLICT (business_id, job_id) DO UPDATE` — פסיקה חדשה על אותה משימה מחליפה, כי היא טענה על *מה נכון עכשיו*.

- [ ] **Step 4: הריצו ו-Commit**

```bash
git add src/governance/numeric-grounding.ts src/governance/numeric-grounding.test.ts src/governance/verdict-store.ts src/governance/verdict-store.test.ts
git commit -m "The numeric grounding check, at zero tokens, and the verdict store"
```

---

## Task 10: הסוכן `gov.verify`

**Files:**
- Create: `src/sdk/gov-verify.ts`
- Test: `src/sdk/gov-verify.test.ts`

**Interfaces:**
- Consumes: Task 6 (`requestHelp`), Task 9 (`ungroundedNumbers`, `saveVerdict`)
- Produces: `verifyDraft(input): Promise<Verdict | { status: 'awaiting_delegation' }>`

- [ ] **Step 1: קראו את `src/sdk/curator.ts` לפני שתכתבו**

הוא התקדים לצורה: קריאת מודל עם `tools: []` ו-`env: { PATH }` בלבד, ופירוק מופרד מהקריאה כדי שיהיה ניתן לבדיקה בלעדיה. `gov.verify` נושא אותה הגבלה בדיוק ומאותו נימוק.

- [ ] **Step 2: כתבו את המבחנים — שמות ואסרשנים**

1. **`reports ungrounded numbers without any model call`** — planner/שופט מוזרק שזורק אם נקרא; הפסיקה נושאת את המספרים. **הבדיקה הזולה רצה לבד.**
2. **`ends its own run and asks know.reader when it needs the document`** — מחזיר `awaiting_delegation`, ונכתבה מעטפת. **הריצה של המבקש נגמרת; הוא אינו ממתין.**
3. **`never opens the document itself`** — אינווריאנט: הקובץ אינו מייבא `loadArtifacts`, `readDocument` או כל מודול שקורא תוכן מסמך. **זה גבול ההסגר, וזו הסיבה שהאצלה נחוצה כאן.**
4. **`refuses under NODE_ENV=test without an injected judge`** — אותה הגנה ש-`refuseUnderTest` מחזיקה ב-`planner.ts`, כדי שהגנה מפני קריאה חיה לא תישען על משמעת מבחנים.

- [ ] **Step 3: כתבו את המימוש והריצו**

- [ ] **Step 4: Commit**

```bash
git add src/sdk/gov-verify.ts src/sdk/gov-verify.test.ts
git commit -m "gov.verify: three checks, and a delegation forced by its own quarantine"
```

---

## Task 11: המפעיל, והפסיקה על הכרטיס

**Files:**
- Modify: `src/orchestrator/conduct.ts`
- Modify: `src/dashboard/views.ts`
- Test: `src/orchestrator/conduct.test.ts`, `src/dashboard/server.test.ts`

- [ ] **Step 1: כתבו את המבחנים — שמות ואסרשנים**

1. **`opens a gov.verify job beside the card and never before it`** — המנצח מרים כרטיס **וגם** פותח משימת `gov.verify`; הכרטיס קיים גם אם האימות טרם הסתיים. **הרמת כרטיס לעולם אינה ממתינה לקריאת מודל** — אחרת מסמך אחד שהאימות שלו נתקע חוסם את הבקשה שהבוס היה צריך לראות.
2. **`the verification job carries unknown_external as a literal`** — אינווריאנט בסגנון `conductor-invariants.test.ts`: הפרובננס בגוש הקריאה הוא הליטרל, לא ביטוי שקורא יכול לכוון.
3. **`the card shows the verdict when one exists`** — פסיקה עם שני מספרים לא-מעוגנים; ה-HTML של הכרטיס מכיל אותם.
4. **`the card renders exactly as before when no verdict exists`** — אין תלות בסדר.
5. **`the verdict is escaped like every other untrusted label`** — פסיקה שנושאת `<script>`; ה-HTML מנוטרל. הפסיקה מצטטת טיוטה שנגזרה ממסמך שמישהו אחר כתב.

- [ ] **Step 2: כתבו, הריצו, Commit**

```bash
git add src/orchestrator/conduct.ts src/dashboard/views.ts src/orchestrator/conduct.test.ts src/dashboard/server.test.ts
git commit -m "The conductor opens verification beside the card, and the card carries the verdict"
```

---

## Task 12: הרצה חיה ותיעוד

**Files:**
- Create: `src/sdk/run-delegate.ts`
- Modify: `package.json` (`sdk:delegate`)
- Modify: `CLAUDE.md`, `docs/09-roadmap.md`

- [ ] **Step 1: כתבו את סקריפט ההרצה החיה**

בסגנון `src/sdk/run-contact-resolver.ts`. משימה אמיתית שבה `gov.verify` מאציל ל-`know.reader`, ובסוף **מדפיס ומאמת**:

- שורת `agent_envelopes` אחת `help_request` ואחת `result`
- משימה-בת שנסגרה, ש-`correlationId` שלה זהה לשל האם
- `constraints` של הבת מהודקות או שוות **בכל שדה**
- שורות `audit_log` מסוג `delegation` עם `envelope_id` **שאינו `null`** — הפעם הראשונה בחיי הפרויקט שהעמודה הזו נושאת ערך
- האם התעוררה והשלימה

**השתמשו בכתובות ובמזהים ייחודיים בסגנון `probe-*`.** בהרצה חיה קודמת בפרויקט הזה, זריעה דרסה זיכרון אמיתי של האוצר דרך החלפה-בכתיבה.

- [ ] **Step 2: עדכנו את התיעוד**

ב-`CLAUDE.md`, פסקאות חדשות תחת "כללים שהקוד אוכף בשקט":

- **המעטפת נושאת מצביעים ולא טקסט, וזו הבקרה.**
- **`COLLABORATION_GRAPH` קיבל קורא, ומה זה עלה** — שדה מקומפל בלי קורא הוא הפגם החמישי מהמחלקה הזו, והאינווריאנט מכסה עכשיו את כל השדות.
- **הרשימה השלישית** — `CEILING_EXEMPT_TOOLS`, בת חבר אחד, והנימוק המלא.
- **תקרות מתהדקות בלבד**, ו-`tightenConstraints` הוא המקור היחיד לכל חמש השורות.
- **האצלה היא משימה-בת ולא צעד** — והנימוק הוא `bindPlanToJob`.

ב-`docs/09-roadmap.md`: פרוטוקול ה-envelope **אינו עוד פתוח** בשלב 0, עם מה שנבנה ומה שנשאר (ארבעת סוגי המעטפת שקוצצו, `gov.verify` כנמען, שש אסטרטגיות האימות).

עדכנו את ספירת המבחנים ב-`CLAUDE.md`.

- [ ] **Step 3: הריצו את החבילה המלאה, ואז את הסקירה**

Run: `npm run typecheck && npm test`

**ואז `/security-review` על הענף** — הכלל בפרויקט הזה דורש אותה כשנגעו ב-`policy/engine.ts`, ב-`charter/capabilities.ts`, ב-`policy/classify.ts` או בקבצי מיגרציה. **העבודה הזו נגעה בכל ארבעתם.**

- [ ] **Step 4: Commit**

```bash
git add src/sdk/run-delegate.ts package.json CLAUDE.md docs/09-roadmap.md
git commit -m "The live delegation run, and the documentation it earned"
```

---

## Self-Review

**1. כיסוי המפרט.** כל סעיף, ומי מיישם אותו:

| מפרט | משימה |
|---|---|
| §1.1(1) המעטפת · §3 | 1 |
| §1.1(2) האצלה כמשימה-בת · §4 | 6, 7 |
| §1.1(3) חמשת השומרים · §5 | 1 (טהורים), 2 (השאילתות), 6 (החיווט) |
| §1.1(4) קורא לגרף · §6.3, §6.4 | 4 (שער), 5 (אימות תוכנית) |
| §1.1(5) יציאה מרשימת הקריאה-בלבד · §6.1, §6.2 | 3 |
| §1.1(6) `gov.verify` · §7 | 9, 10, 11 |
| §1.1(7) מרשם intents · §6.5 | 6 |
| §5.6 תקרה יומית | 6 (`config.ts`), 2 (`delegationsToday`) |
| §8 מיגרציה 028 | 2 |
| §8.1 חיבור למחיקה | 8 |
| §8.2 `AuditKind` | 6 |
| §9.1 מוטציות | 1, 2, 3, 4, 6, 7 — כל אחת עם צעד מוטציה נקוב |
| §9.2 אינווריאנטים | 1 (`ContextRef`), 3 (הרשימות והרשאות), 4 (השדות המקומפלים), 6 (המרשם), 8 (מחיקה), 10 (ההסגר) |
| §9.3 הרצה חיה | 12 |

**אין סעיף במפרט בלי משימה.**

**2. סריקת placeholders.** אין "TBD", אין "טפלו בשגיאות", אין "מבחנים לעיל". שש המשימות שאינן נושאות גופי מבחן מוצהרות ככאלה בראש התוכנית עם הנימוק, ונושאות שמות מבחנים, אסרשנים מדויקים ומוטציה נקובה.

**3. עקביות טיפוסים.** `tightenConstraints`, `contextRefsHash`, `mayDelegate`, `delegationProblems`, `hopGuard`, `noNewInformationGuard`, `oscillationGuard`, `dailyCapGuard`, `DelegationDenial` — מוגדרים ב-Task 1 ונקראים באותם שמות ב-4, 5, 6. `writeEnvelope`, `loadEnvelope`, `priorQuadruples`, `countPairExchanges`, `delegationsToday`, `attachChildJob` — מוגדרים ב-Task 2, נקראים ב-6 ו-7. `resolveIntent`/`IntentSpec` — 6. `ungroundedNumbers`, `Verdict`, `saveVerdict`, `loadVerdict` — 9, נקראים ב-10 ו-11. `MAX_HOPS` — 1, נקרא בסכמה ובשומר.

**שני פערים שנמצאו בסקירה הזו ותוקנו במקום:**

- Task 4 היה מסתמך על מבחן שלילי שעלול לעבור מהסיבה הלא נכונה — `ops.web` נדחה על `tool_not_allowlisted` לפני שבדיקת הגרף בכלל רצה, אחרי Task 3. הצעד נוקב עכשיו בזוג `gov.verify → comms.email` ובאסרשן על **הקוד המדויק**.
- Task 9 חסר את המקרה של רשימת מקורות ריקה. בדיקה שמדווחת על כל מספר כלא-מעוגן כשלא חולץ דבר היא בקרה שצורחת הכי חזק כשהיא יודעת הכי מעט — ומכיוון שזו קריטריון `must`, המשמעות הייתה שליחה חסומה.
