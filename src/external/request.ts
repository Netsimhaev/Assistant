import type { ExternalOperation, ExternalSystem } from '../domain/external-system.js';
import { toOneLine } from '../util/bidi.js';

/**
 * Turns a signed operation and the planner's params into the exact HTTP
 * request. The operation decides the method, the path and which params exist;
 * the plan supplies only values, and every value is checked against what was
 * signed. Auth is added later (Task 6), never here.
 */

/** Money is carried in minor units; a `major` operation divides by this. */
export const MAJOR_DIVISOR = 100;

export type ExternalRequestResult =
  | { ok: true; method: string; url: URL; headers: Record<string, string>; body: string | null }
  | { ok: false; code: 'bad_params'; message: string };

function bad(message: string): { ok: false; code: 'bad_params'; message: string } {
  return { ok: false, code: 'bad_params', message };
}

/** A param name quoted for a message: one line, capped. */
function quote(value: string): string {
  const line = toOneLine(value);
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

export function buildExternalRequest(
  system: ExternalSystem,
  op: ExternalOperation,
  input: { params?: Record<string, unknown>; amountMinor?: number },
  idempotencyKey: string,
): ExternalRequestResult {
  const params = input.params ?? {};
  const declared = new Set(op.params.map((p) => p.name));

  // Own keys only: an inherited or prototype key is not something the plan said.
  for (const key of Object.keys(params)) {
    if (!declared.has(key)) return bad(`הפרמטר "${quote(key)}" אינו מוגדר בפעולה`);
  }

  // The amount: exactly one, top-level, and only on a money operation.
  let amountText: string | null = null;
  let amountValue: number | null = null;
  if (op.amount !== null) {
    const minor = input.amountMinor;
    if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 0) {
      return bad('פעולת כסף דורשת סכום תקין (מספר שלם אי-שלילי)');
    }
    if (op.amount.unit === 'major') {
      amountValue = minor / MAJOR_DIVISOR;
      amountText = String(amountValue);
    } else {
      amountValue = minor;
      amountText = String(minor);
    }
  } else if (input.amountMinor !== undefined) {
    return bad('פעולה שאינה פעולת כסף אינה מקבלת סכום');
  }

  const pathValues = new Map<string, string>();
  const queryPairs: [string, string][] = [];
  const bodyPairs: [string, unknown][] = [];

  for (const param of op.params) {
    const present = Object.hasOwn(params, param.name);
    if (!present) {
      if (param.required) return bad(`חסר פרמטר חובה "${quote(param.name)}"`);
      continue;
    }
    const value = params[param.name];
    if (param.in === 'body') {
      if (op.method === 'GET') return bad(`הפרמטר "${quote(param.name)}" אינו יכול להישלח בגוף בקשת GET`);
      if (op.bodyEncoding === 'form' && !isScalar(value)) {
        return bad(`הפרמטר "${quote(param.name)}" חייב להיות ערך פשוט בקידוד טופס`);
      }
      bodyPairs.push([param.name, value]);
      continue;
    }
    if (!isScalar(value)) return bad(`הפרמטר "${quote(param.name)}" חייב להיות מחרוזת, מספר או ערך בוליאני`);
    if (param.in === 'path') pathValues.set(param.name, String(value));
    else queryPairs.push([param.name, String(value)]);
  }

  // Build the URL by joining strings; never resolve a path against the base.
  const base = new URL(system.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const path = op.path.replace(/\{([^{}]*)\}/g, (_m, name: string) => encodeURIComponent(pathValues.get(name) ?? ''));
  const query = new URLSearchParams();
  for (const [k, v] of queryPairs) query.append(k, v);
  const qs = query.toString();
  let url: URL;
  try {
    url = new URL(`${base.origin}${basePath}${path}${qs === '' ? '' : `?${qs}`}`);
  } catch {
    return bad('לא ניתן לבנות כתובת תקינה לבקשה');
  }
  if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) {
    return bad('הכתובת שנבנתה חורגת מכתובת הבסיס של המערכת');
  }

  const headers: Record<string, string> = {};
  if (system.idempotencyHeader !== null) headers[system.idempotencyHeader] = idempotencyKey;

  let body: string | null = null;
  if (op.method !== 'GET') {
    if (op.bodyEncoding === 'form') {
      const form = new URLSearchParams();
      for (const [k, v] of bodyPairs) form.append(k, String(v));
      if (op.amount !== null && amountText !== null) form.append(op.amount.field, amountText);
      body = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      const obj = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of bodyPairs) Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
      if (op.amount !== null && amountValue !== null) {
        Object.defineProperty(obj, op.amount.field, { value: amountValue, enumerable: true, writable: true, configurable: true });
      }
      body = JSON.stringify(obj);
      headers['Content-Type'] = 'application/json';
    }
  }

  return { ok: true, method: op.method, url, headers, body };
}
