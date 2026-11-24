/**
 * Which signed read operation of an accounting system supplies a contact's
 * invoices, and which of its parameters and declared response fields carry the
 * customer id (`contact_whatsapp_settings`). Every choice is checked against
 * the ACTIVE charter's signed definition: a system that is not signed, an
 * operation that is not `read`, a parameter the operation does not declare or
 * a field it does not declare is refused. The settings only choose among
 * things the owner already signed; they grant nothing.
 */
import { appendAudit } from '../../audit/log.js';
import { loadActiveCharter } from '../../charter/store.js';
import type { BusinessDb } from '../../db/pool.js';
import { canonicalHash } from '../../util/canonical.js';

export interface InvoiceSettings {
  systemId: string;
  operation: string;
  customerParam: string;
  customerField: string;
}

export type SaveInvoiceSettingsResult = { ok: true } | { ok: false; error: string };

export const INVOICE_SETTINGS_REFUSALS = {
  charterUnreadable: 'התקנון הפעיל אינו קריא — אי אפשר לשמור הגדרה עכשיו.',
  unknownSystem: 'המערכת הזו אינה חתומה בתקנון הפעיל.',
  unknownOperation: 'הפעולה הזו אינה קיימת במערכת שנבחרה.',
  notRead: 'אפשר לבחור רק פעולת קריאה.',
  unknownParam: 'הפרמטר הזה אינו מוצהר בפעולה שנבחרה.',
  indexedField: 'שדה המזהה אינו יכול לעבור דרך מערך (מקטע מספרי בנתיב).',
  unknownField: 'השדה הזה אינו מוצהר כשדה תשובה בפעולה שנבחרה.',
} as const;

interface SettingsRow {
  invoice_system_id: string | null;
  invoice_operation: string | null;
  invoice_customer_param: string | null;
  invoice_customer_field: string | null;
}

/** The saved choice, or `null` when nothing (or only part) is configured. */
export async function loadInvoiceSettings(db: BusinessDb): Promise<InvoiceSettings | null> {
  const { rows } = await db.query<SettingsRow>(
    `SELECT invoice_system_id, invoice_operation, invoice_customer_param, invoice_customer_field
       FROM contact_whatsapp_settings WHERE business_id = $1`,
    [db.businessId],
  );
  const row = rows[0];
  if (
    row === undefined ||
    row.invoice_system_id === null ||
    row.invoice_operation === null ||
    row.invoice_customer_param === null ||
    row.invoice_customer_field === null
  ) {
    return null;
  }
  return {
    systemId: row.invoice_system_id,
    operation: row.invoice_operation,
    customerParam: row.invoice_customer_param,
    customerField: row.invoice_customer_field,
  };
}

export async function saveInvoiceSettings(db: BusinessDb, input: InvoiceSettings): Promise<SaveInvoiceSettingsResult> {
  const refusals = INVOICE_SETTINGS_REFUSALS;
  let active;
  try {
    active = await loadActiveCharter(db);
  } catch {
    return { ok: false, error: refusals.charterUnreadable };
  }
  if (active === null) return { ok: false, error: refusals.charterUnreadable };
  const system = active.bundle.externalSystems.find((s) => s.id === input.systemId);
  if (system === undefined) return { ok: false, error: refusals.unknownSystem };
  const op = system.operations.find((o) => o.name === input.operation);
  if (op === undefined) return { ok: false, error: refusals.unknownOperation };
  if (op.kind !== 'read') return { ok: false, error: refusals.notRead };
  if (!op.params.some((p) => p.name === input.customerParam)) return { ok: false, error: refusals.unknownParam };
  if (input.customerField.split('.').some((segment) => /^\d+$/.test(segment))) {
    return { ok: false, error: refusals.indexedField };
  }
  if (!op.fields.some((f) => f.path === input.customerField)) return { ok: false, error: refusals.unknownField };
  await db.query(
    `INSERT INTO contact_whatsapp_settings
       (business_id, invoice_system_id, invoice_operation, invoice_customer_param, invoice_customer_field, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (business_id) DO UPDATE SET
       invoice_system_id = EXCLUDED.invoice_system_id,
       invoice_operation = EXCLUDED.invoice_operation,
       invoice_customer_param = EXCLUDED.invoice_customer_param,
       invoice_customer_field = EXCLUDED.invoice_customer_field,
       updated_at = now()`,
    [db.businessId, input.systemId, input.operation, input.customerParam, input.customerField],
  );
  return { ok: true };
}

/** A signed read operation that supplies one more kind of per-sender records (generic external source). */
export interface ExternalSenderSource {
  systemId: string;
  operation: string;
  param: string;
  field: string;
}

export interface ContactWaSettings {
  autoReplyEnabled: boolean;
  externalSources: ExternalSenderSource[];
}

function parseExternalSources(raw: unknown): ExternalSenderSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ExternalSenderSource[] = [];
  for (const e of raw) {
    const o = e as Record<string, unknown> | null;
    if (
      o !== null &&
      typeof o === 'object' &&
      typeof o['systemId'] === 'string' &&
      typeof o['operation'] === 'string' &&
      typeof o['param'] === 'string' &&
      typeof o['field'] === 'string'
    ) {
      out.push({ systemId: o['systemId'], operation: o['operation'], param: o['param'], field: o['field'] });
    }
  }
  return out;
}

export async function loadContactWaSettings(db: BusinessDb): Promise<ContactWaSettings> {
  const { rows } = await db.query<{ auto_reply_enabled: boolean; external_sources: unknown }>(
    `SELECT auto_reply_enabled, external_sources FROM contact_whatsapp_settings WHERE business_id = $1`,
    [db.businessId],
  );
  const row = rows[0];
  if (row === undefined) return { autoReplyEnabled: false, externalSources: [] };
  return { autoReplyEnabled: row.auto_reply_enabled, externalSources: parseExternalSources(row.external_sources) };
}

export async function saveAutoReplyEnabled(db: BusinessDb, on: boolean, by: string): Promise<void> {
  await db.query(
    `INSERT INTO contact_whatsapp_settings (business_id, auto_reply_enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (business_id) DO UPDATE SET auto_reply_enabled = EXCLUDED.auto_reply_enabled, updated_at = now()`,
    [db.businessId, on],
  );
  await appendAudit(db, {
    actor: 'human',
    onBehalfOf: by,
    kind: 'tool_call',
    charterVersion: 'n/a',
    provenance: 'boss',
    inputHash: canonicalHash({ setting: 'auto_reply_enabled' }),
    reason: `contact_whatsapp_settings:auto_reply_${on ? 'on' : 'off'}`,
  });
}

/** Same rules as the invoice choice, applied to every entry; nothing is saved unless all pass. */
export async function saveExternalSources(
  db: BusinessDb,
  sources: ExternalSenderSource[],
): Promise<SaveInvoiceSettingsResult> {
  const refusals = INVOICE_SETTINGS_REFUSALS;
  let active;
  try {
    active = await loadActiveCharter(db);
  } catch {
    return { ok: false, error: refusals.charterUnreadable };
  }
  if (active === null) return { ok: false, error: refusals.charterUnreadable };
  for (const s of sources) {
    const system = active.bundle.externalSystems.find((x) => x.id === s.systemId);
    if (system === undefined) return { ok: false, error: refusals.unknownSystem };
    const op = system.operations.find((o) => o.name === s.operation);
    if (op === undefined) return { ok: false, error: refusals.unknownOperation };
    if (op.kind !== 'read') return { ok: false, error: refusals.notRead };
    if (!op.params.some((p) => p.name === s.param)) return { ok: false, error: refusals.unknownParam };
    if (s.field.split('.').some((segment) => /^\d+$/.test(segment))) return { ok: false, error: refusals.indexedField };
    if (!op.fields.some((f) => f.path === s.field)) return { ok: false, error: refusals.unknownField };
  }
  await db.query(
    `INSERT INTO contact_whatsapp_settings (business_id, external_sources, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (business_id) DO UPDATE SET external_sources = EXCLUDED.external_sources, updated_at = now()`,
    [db.businessId, JSON.stringify(sources)],
  );
  return { ok: true };
}

/**
 * Removes one source without re-validating the rest: fewer sources only narrows
 * what is read, so a stale sibling (an operation a later charter dropped) must
 * not block removing another entry.
 */
export async function removeExternalSource(db: BusinessDb, systemId: string, operation: string): Promise<void> {
  const rest = (await loadContactWaSettings(db)).externalSources.filter(
    (x) => !(x.systemId === systemId && x.operation === operation),
  );
  await db.query(
    `INSERT INTO contact_whatsapp_settings (business_id, external_sources, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (business_id) DO UPDATE SET external_sources = EXCLUDED.external_sources, updated_at = now()`,
    [db.businessId, JSON.stringify(rest)],
  );
}
