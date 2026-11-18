import type { z } from 'zod';
import type { ExternalSystem } from '../domain/external-system.js';
import type { CharterConnection } from '../domain/connection.js';

/** The input shape of a definition — what an operator writes, before defaults. */
export type ExternalSystemInput = z.input<typeof ExternalSystem>;

/**
 * The reference definition the Stage D tests share: a small CRM with one
 * operation of every kind, a Stripe-style signed webhook and a daily scan.
 * Returned fresh on every call so a test can mutate its copy.
 */
export function crmFixture(): ExternalSystemInput {
  return {
    id: 'crm',
    label: 'מערכת הלקוחות',
    baseUrl: 'https://api.crm.example.com/v1',
    auth: { kind: 'bearer' },
    idempotencyHeader: 'Idempotency-Key',
    operations: [
      {
        name: 'list_customers',
        label: 'רשימת לקוחות',
        kind: 'read',
        actionClass: 'external.read',
        method: 'GET',
        path: '/customers',
        params: [{ name: 'updated_since', in: 'query', required: false }],
        fields: [
          { path: 'name', label: 'שם' },
          { path: 'email', label: 'מייל' },
        ],
        idPath: 'id',
        amount: null,
      },
      {
        name: 'get_customer',
        label: 'פרטי לקוח',
        kind: 'read',
        actionClass: 'external.read',
        method: 'GET',
        path: '/customers/{customer_id}',
        params: [{ name: 'customer_id', in: 'path', required: true }],
        fields: [{ path: 'data.name', label: 'שם' }],
        idPath: 'data.id',
        amount: null,
      },
      {
        name: 'update_customer',
        label: 'עדכון לקוח',
        kind: 'change',
        actionClass: 'crm.write',
        method: 'PATCH',
        path: '/customers/{customer_id}',
        params: [
          { name: 'customer_id', in: 'path', required: true },
          { name: 'phone', in: 'body', required: false },
        ],
        fields: [],
        idPath: 'id',
        amount: null,
      },
      {
        name: 'delete_customer',
        label: 'מחיקת לקוח',
        kind: 'delete',
        actionClass: 'external.delete',
        method: 'DELETE',
        path: '/customers/{customer_id}',
        params: [{ name: 'customer_id', in: 'path', required: true }],
        fields: [],
        idPath: null,
        amount: null,
      },
      {
        name: 'issue_refund',
        label: 'החזר כספי',
        kind: 'money',
        actionClass: 'refund.issue',
        method: 'POST',
        path: '/refunds',
        params: [{ name: 'customer_id', in: 'body', required: true }],
        bodyEncoding: 'form',
        fields: [],
        idPath: 'id',
        amount: { field: 'amount_cents', unit: 'minor', currency: 'ILS' },
      },
    ],
    webhook: {
      scheme: {
        kind: 'hmac-sha256',
        encoding: 'hex',
        signature: { from: 'kv', header: 'Stripe-Signature', key: 'v1', separator: ',' },
        signedPayload: '{timestamp}.{body}',
        timestamp: { from: 'kv', key: 't' },
      },
      typePath: 'type',
      events: [
        { type: 'customer.created', label: 'לקוח חדש', fields: [{ path: 'data.name', label: 'שם' }] },
        { type: 'payment.failed', label: 'תשלום נכשל', fields: [] },
      ],
      handshake: null,
    },
    scan: { operation: 'list_customers', sinceParam: 'updated_since', itemsPath: 'data', everyHours: 24 },
  };
}

/** The one connection a charter must carry for `crmFixture()`. */
export function crmConnection(): CharterConnection {
  return {
    system: 'ext:crm',
    label: 'מערכת הלקוחות',
    channel: 'api',
    serves: ['ext.call', 'ext.read'],
    target: 'crm',
    subprocessor: null,
  };
}
