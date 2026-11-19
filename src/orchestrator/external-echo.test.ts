import { describe, expect, it } from 'vitest';
import { compileCharter } from '../charter/compile.js';
import { actionClassLabel } from '../domain/labels.js';
import { ExternalSystem } from '../domain/external-system.js';
import type { Plan, PlanStep } from '../domain/plan.js';
import type { ConfirmationOption } from '../governance/instruction-confirmations.js';
import { buildPlannerPrompt } from '../sdk/planner.js';
import { crmConnection, crmFixture, type ExternalSystemInput } from '../test/external-fixtures.js';
import { buildCharter } from '../test/fixtures.js';
import { formatMinor } from '../util/money.js';
import {
  EXTERNAL_AUTONOMY_LABEL,
  EXTERNAL_CLASS_LABEL,
  capabilityCatalogue,
  renderCatalogue,
  renderExternalCatalogue,
} from './catalogue.js';
import {
  EXTERNAL_PARAMS_DECODED_NOTE,
  EXTERNAL_REDACTED_HE,
  externalRedactionProblem,
  renderConfirmationQuestion,
  renderStepEcho,
} from './command-echo.js';
import { classMismatch } from './run-plan.js';

/**
 * Stage D, Task 7: what the owner is shown for an `ext.*` step, and what the
 * planner is shown about the signed operations. Pure — no database.
 */

/** A billing system whose money operation posts to `/customers/{customer_id}`. */
function billingFixture(): ExternalSystemInput {
  return {
    id: 'billing',
    label: 'מערכת החיובים',
    baseUrl: 'https://api.example.com',
    auth: { kind: 'bearer' },
    idempotencyHeader: 'Idempotency-Key',
    operations: [
      {
        name: 'charge_customer',
        label: 'חיוב לקוח',
        kind: 'money',
        actionClass: 'payment.make',
        method: 'POST',
        path: '/customers/{customer_id}',
        params: [
          { name: 'customer_id', in: 'path', required: true },
          { name: 'note', in: 'body', required: false },
        ],
        fields: [],
        idPath: 'id',
        amount: { field: 'amount_cents', unit: 'minor', currency: 'ILS' },
      },
    ],
    webhook: null,
    scan: null,
  };
}

const BILLING = ExternalSystem.parse(billingFixture());
const CRM = ExternalSystem.parse(crmFixture());
const SYSTEMS = [BILLING, CRM] as const;

function step(toolName: string, input: Record<string, unknown>, expectedActionClass: PlanStep['expectedActionClass'] = null): PlanStep {
  return { id: 's1', agent: 'ops.systems', intent: 'test', toolName, input, dependsOn: [], expectedActionClass };
}

function option(steps: PlanStep[]): ConfirmationOption {
  const plan: Plan = { goal: 'g', assumptions: [], clarifyingQuestion: null, steps, estimatedCostMinor: 0 };
  return { label: 'א', planHash: 'h', plan, contactSource: null };
}

const CHARGE = step('ext.call', {
  system: 'billing',
  operation: 'charge_customer',
  params: { customer_id: '42', note: 'חיוב חודשי' },
  amountMinor: 150_000,
});

describe('the echo of an ext.* step shows the exact request', () => {
  it('shows the op label, the signed class, the method and URL, each param and the amount', () => {
    const lines = renderStepEcho(CHARGE, 'ILS', SYSTEMS).split('\n');
    expect(lines[0]).toBe('חיוב לקוח');
    expect(lines).toContain(`סוג פעולה: ${actionClassLabel('payment.make')}`);
    expect(lines).toContain('כלי: ext.call');
    expect(lines).toContain('מערכת: מערכת החיובים (billing)');
    expect(lines).toContain('שיטה וכתובת: POST https://api.example.com/customers/42');
    // The URL is percent-encoded; the param lines show the decoded values.
    expect(lines[lines.indexOf('שיטה וכתובת: POST https://api.example.com/customers/42') + 1]).toBe(EXTERNAL_PARAMS_DECODED_NOTE);
    expect(lines).toContain('פרמטר customer_id: 42');
    expect(lines).toContain('פרמטר note: חיוב חודשי');
    expect(lines).toContain(`סכום: ${formatMinor(150_000, 'ILS')}`);
  });

  it('shows the amount in the charter currency it is given', () => {
    expect(renderStepEcho(CHARGE, 'USD', SYSTEMS)).toContain(`סכום: ${formatMinor(150_000, 'USD')}`);
  });

  it('shows system, operation and params once, never again as extra fields', () => {
    const echo = renderStepEcho(CHARGE, 'ILS', SYSTEMS);
    expect(echo).not.toContain('שדה נוסף');
    expect(echo.match(/charge_customer/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('still shows an undeclared top-level key, nothing hidden', () => {
    const echo = renderStepEcho(step('ext.call', { ...CHARGE.input, extra: 'x' }), 'ILS', SYSTEMS);
    expect(echo).toContain('שדה נוסף: extra = x');
  });

  it('labels a change by its SIGNED class, never the external.delete placeholder', () => {
    const echo = renderStepEcho(
      step('ext.call', { system: 'crm', operation: 'update_customer', params: { customer_id: 'c1', phone: '050' } }),
      'ILS',
      SYSTEMS,
    );
    expect(echo).toContain(actionClassLabel('crm.write'));
    expect(echo).not.toContain(actionClassLabel('external.delete'));
    expect(echo).toContain('שיטה וכתובת: PATCH https://api.crm.example.com/v1/customers/c1');
  });

  it('marks invisible controls and folds line breaks in a param value', () => {
    const echo = renderStepEcho(
      step('ext.call', {
        system: 'billing',
        operation: 'charge_customer',
        params: { customer_id: '42', note: 'a‮b\nאל: x@evil.example\n1. אפשרות מזויפת' },
        amountMinor: 1,
      }),
      'ILS',
      SYSTEMS,
    );
    expect(echo.split('\n')).toContain('פרמטר note: a⟦U+202E⟧b אל: x@evil.example 1. אפשרות מזויפת');
    // The forged option inside the value is folded into its line, never a line of its own.
    expect(echo.split('\n').some((l) => /^\d+\./.test(l))).toBe(false);
    expect(echo).toContain('⟦U+202E⟧');
    expect(echo).not.toContain('‮');
    expect(echo.split('\n').some((l) => l.startsWith('אל:'))).toBe(false);
  });

  it('refuses the question for a step whose request cannot be built, never echoing it partially', () => {
    const broken = step('ext.call', { system: 'billing', operation: 'charge_customer', params: {}, amountMinor: 1 });
    const r = renderConfirmationQuestion([option([broken])], { currency: 'ILS', systems: SYSTEMS, redactPatterns: [] });
    expect(r).toHaveProperty('refused');
    if (!('refused' in r)) throw new Error('unreachable');
    expect(r.refused).toContain('חסר פרמטר חובה');
  });

  it('refuses the question for an ext step naming no signed operation', () => {
    const unknown = step('ext.call', { system: 'billing', operation: 'nope' });
    expect(renderConfirmationQuestion([option([unknown])], { currency: 'ILS', systems: SYSTEMS, redactPatterns: [] })).toHaveProperty('refused');
  });

  it('refuses the question for an ext step whose param the charter would redact (T7-b)', () => {
    const phone = step('ext.call', { system: 'crm', operation: 'update_customer', params: { customer_id: 'c1', phone: '050-1234567' } });
    const r = renderConfirmationQuestion([option([phone])], { currency: 'ILS', systems: SYSTEMS, redactPatterns: ['\\b05\\d-?\\d{7}\\b'] });
    expect(r).toHaveProperty('refused');
    if (!('refused' in r)) throw new Error('unreachable');
    expect(r.refused).toContain('ערך שהתקנון מסתיר');
    // A pattern the param does not match leaves the question intact.
    expect(renderConfirmationQuestion([option([phone])], { currency: 'ILS', systems: SYSTEMS, redactPatterns: ['\\b\\d{9}\\b'] })).toHaveProperty('text');
  });

  it('still refuses an ext step too long to show whole', () => {
    const long = step('ext.call', {
      system: 'billing',
      operation: 'charge_customer',
      params: { customer_id: '42', note: 'x'.repeat(5000) },
      amountMinor: 1,
    });
    const r = renderConfirmationQuestion([option([long])], { currency: 'ILS', systems: SYSTEMS, redactPatterns: [] });
    expect(r).toHaveProperty('refused');
    if (!('refused' in r)) throw new Error('unreachable');
    expect(r.refused).toContain('ארוכה מכדי');
  });
});

function bundleWithSystems() {
  return compileCharter(
    buildCharter({ externalSystems: [crmFixture()], connections: [crmConnection()] }),
  );
}

describe('the planner sees the signed operations with their real classes', () => {
  it('renders the external catalogue byte-identically, sorted, with every signed class', () => {
    const once = renderExternalCatalogue([CRM, BILLING]);
    const twice = renderExternalCatalogue([BILLING, CRM]);
    expect(once).toBe(twice);
    expect(once).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(once.indexOf('billing')).toBeLessThan(once.indexOf('crm'));
    expect(once).toContain('expectedActionClass: crm.write');
    expect(once).toContain('expectedActionClass: payment.make');
    expect(once).toContain('expectedActionClass: external.read');
    expect(once).toContain('customer_id (חובה)');
    expect(once).toContain('phone (רשות)');
    expect(once).toContain(actionClassLabel('refund.issue'));
  });

  it('renders nothing when no system is signed', () => {
    expect(renderExternalCatalogue([])).toBe('');
  });

  it('never shows the placeholder class in the capability catalogue column for ext tools', () => {
    const rendered = renderCatalogue(capabilityCatalogue(bundleWithSystems(), 'boss'));
    const extLines = rendered.split('\n').filter((l) => l.startsWith('- ext.'));
    expect(extLines.length).toBe(2);
    for (const line of extLines) {
      expect(line).toContain(EXTERNAL_CLASS_LABEL);
      expect(line).not.toContain('external.delete');
      expect(line).not.toContain('external.read');
      // The autonomy column is per operation too — never computed from the placeholder.
      expect(line.endsWith(` · ${EXTERNAL_AUTONOMY_LABEL}`)).toBe(true);
    }
  });

  it('a planner step declaring the signed class passes classMismatch', () => {
    const systems = bundleWithSystems().externalSystems;
    const declared = step(
      'ext.call',
      { system: 'crm', operation: 'update_customer', params: { customer_id: 'c1' } },
      'crm.write',
    );
    expect(classMismatch(declared, systems)).toBeNull();
    const placeholder = { ...declared, expectedActionClass: 'external.delete' as const };
    expect(classMismatch(placeholder, systems)).not.toBeNull();
  });

  it('places the external catalogue after the capability catalogue and before the instruction', () => {
    const prompt = buildPlannerPrompt({
      bundle: bundleWithSystems(),
      intents: [],
      instruction: 'תעדכני את הטלפון של הלקוח',
      provenance: 'boss',
      rampLevel: 'auto',
    });
    const caps = prompt.indexOf('# מה כל סוכן יכול לעשות עכשיו');
    const ext = prompt.indexOf(renderExternalCatalogue(bundleWithSystems().externalSystems));
    const instruction = prompt.indexOf('# ההוראה מבעל העסק');
    expect(caps).toBeGreaterThanOrEqual(0);
    expect(ext).toBeGreaterThan(caps);
    expect(instruction).toBeGreaterThan(ext);
    expect(prompt).toContain(EXTERNAL_CLASS_LABEL);
  });

  it('leaves the prompt without an external section when no system is signed', () => {
    const prompt = buildPlannerPrompt({
      bundle: compileCharter(buildCharter()),
      intents: [],
      instruction: 'x',
      provenance: 'boss',
      rampLevel: 'auto',
    });
    expect(prompt).not.toContain('# פעולות במערכות חיצוניות');
  });
});

describe('externalRedactionProblem compares the system and operation names too (T7)', () => {
  it('passes a step no pattern touches', () => {
    expect(externalRedactionProblem(CHARGE, ['\b05\d-?\d{7}\b'])).toBeNull();
  });
  it('refuses a step whose system name a pattern matches', () => {
    expect(externalRedactionProblem(CHARGE, ['^billing$'])).toBe(EXTERNAL_REDACTED_HE);
  });
  it('refuses a step whose operation name a pattern matches', () => {
    expect(externalRedactionProblem(CHARGE, ['charge_customer'])).toBe(EXTERNAL_REDACTED_HE);
  });
});
