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

/** Above this, major-unit formatting can lose a cent; refuse rather than round. */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000_000;

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

/** A path value must be a real segment: not empty, not `.` or `..` in any encoding. */
function isUsablePathValue(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: it is sent encoded as-is, so judge the raw text.
  }
  const lower = decoded.toLowerCase();
  return value !== '' && lower !== '' && lower !== '.' && lower !== '..';
}

/** Does a key equal to `key` occur at any depth inside `value`? Too deep counts as yes. */
function containsKey(value: unknown, key: string, depth = 0): boolean {
  const wanted = key.toLowerCase();
  return containsKeyLower(value, wanted, depth);
}

function containsKeyLower(value: unknown, key: string, depth: number): boolean {
  if (depth > 50) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsKeyLower(v, key, depth + 1));
  for (const k of Object.keys(value)) {
    if (k.toLowerCase() === key) return true;
    if (containsKeyLower((value as Record<string, unknown>)[k], key, depth + 1)) return true;
  }
  return false;
}

/**
 * The built pathname must have exactly the shape of the signed template:
 * base segments, then the template's segments, literals equal and each
 * placeholder holding exactly its encoded value. Returns a problem or null.
 */
export function pathShapeProblem(
  pathname: string,
  basePath: string,
  templatePath: string,
  encodedValues: ReadonlyMap<string, string>,
): string | null {
  const problem = 'מבנה הכתובת שונה מהפעולה שנחתמה';
  const expected = `${basePath}${templatePath}`.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return problem;
  for (const [i, want] of expected.entries()) {
    const m = /^\{([^{}]*)\}$/.exec(want);
    const wanted = m ? encodedValues.get(m[1] ?? '') : want;
    if (wanted === undefined || actual[i] !== wanted) return problem;
  }
  return null;
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
    if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 0 || minor > MAX_AMOUNT_MINOR) {
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
      if (param.required || param.in === 'path') return bad(`חסר פרמטר חובה "${quote(param.name)}"`);
      continue;
    }
    const value = params[param.name];
    if (param.in === 'body') {
      if (op.method === 'GET') return bad(`הפרמטר "${quote(param.name)}" אינו יכול להישלח בגוף בקשת GET`);
      if (op.bodyEncoding === 'form' && !isScalar(value)) {
        return bad(`הפרמטר "${quote(param.name)}" חייב להיות ערך פשוט בקידוד טופס`);
      }
      if (op.amount !== null && containsKey(value, op.amount.field)) {
        return bad(`הפרמטר "${quote(param.name)}" מכיל את שדה הסכום — הסכום נקבע רק מהסכום שאושר`);
      }
      bodyPairs.push([param.name, value]);
      continue;
    }
    if (!isScalar(value)) return bad(`הפרמטר "${quote(param.name)}" חייב להיות מחרוזת, מספר או ערך בוליאני`);
    if (param.in === 'path') {
      if (!isUsablePathValue(String(value))) return bad(`ערך הפרמטר "${quote(param.name)}" אינו קטע נתיב תקין`);
      pathValues.set(param.name, String(value));
    }
    else queryPairs.push([param.name, String(value)]);
  }

  // Build the URL by joining strings; never resolve a path against the base.
  const base = new URL(system.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const encoded = new Map<string, string>();
  try {
    for (const [k, v] of pathValues) encoded.set(k, encodeURIComponent(v));
  } catch (e) {
    if (e instanceof URIError) return bad('אחד מערכי הנתיב מכיל תו שאי אפשר לקודד');
    throw e;
  }
  const path = op.path.replace(/\{([^{}]*)\}/g, (_m, name: string) => encoded.get(name) ?? '');
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
  const shape = pathShapeProblem(url.pathname, basePath, op.path, encoded);
  if (shape !== null) return bad(shape);

  const headers: Record<string, string> = {};
  if (system.idempotencyHeader !== null) headers[system.idempotencyHeader] = idempotencyKey;

  let body: string | null = null;
  if (op.method !== 'GET' && (bodyPairs.length > 0 || op.amount !== null)) {
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

/** The adapter's refusal when a payload's `params` is present but not an object. */
export const PARAMS_NOT_OBJECT_MESSAGE = 'הפרמטרים לפעולה אינם תקינים — לא נשלח דבר';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A plan step's payload, read as the request builder's input — the ONE
 * reading the adapter, the confirmation echo and the instruction door share,
 * so the request the owner is shown is the request that is sent.
 *
 * Own keys only. `params` must be an object when present; `amountMinor` is
 * passed through untouched for `buildExternalRequest` to validate against
 * the operation (it refuses anything that is not a safe non-negative integer).
 */
export function buildExternalRequestFromPayload(
  system: ExternalSystem,
  op: ExternalOperation,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): ExternalRequestResult {
  let params: Record<string, unknown> | undefined;
  if (Object.hasOwn(payload, 'params')) {
    const p = payload['params'];
    if (!isPlainObject(p)) return bad(PARAMS_NOT_OBJECT_MESSAGE);
    params = p;
  }
  const requestInput: { params?: Record<string, unknown>; amountMinor?: number } = {
    ...(params !== undefined ? { params } : {}),
    ...(Object.hasOwn(payload, 'amountMinor') ? { amountMinor: payload['amountMinor'] as number } : {}),
  };
  return buildExternalRequest(system, op, requestInput, idempotencyKey);
}
