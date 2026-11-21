/**
 * Which signed read operation of an accounting system supplies a contact's
 * invoices, and which of its parameters and declared response fields carry the
 * customer id (`contact_whatsapp_settings`). Every choice is checked against
 * the ACTIVE charter's signed definition: a system that is not signed, an
 * operation that is not `read`, a parameter the operation does not declare or
 * a field it does not declare is refused. The settings only choose among
 * things the owner already signed; they grant nothing.
 */
import { loadActiveCharter } from '../../charter/store.js';
import type { BusinessDb } from '../../db/pool.js';

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
