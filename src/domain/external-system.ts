import { z } from 'zod';
import { ActionClass } from './action.js';

/**
 * An external system the owner has signed for: a CRM, an accounting package,
 * a booking tool — anything reached over HTTPS with a key, described as data
 * rather than as code (Stage D, `docs/superpowers/specs/2026-11-13-external-systems-design.md`).
 *
 * A definition lives inside the signed charter. That is the control: which
 * operations exist, which action class each one is judged as, and how much
 * money one may move are all fixed at signing, so a page or an email cannot
 * argue the assistant into an operation nobody signed. Everything here is
 * validated positively — an operation is accepted only when every rule below
 * holds, and an unrecognised shape is refused, never read as permissive.
 *
 * This module only describes. Calling a system, resolving an operation at the
 * gate and verifying a webhook are later tasks; none of them may widen what a
 * definition here permits.
 */

/** A system id: lowercase, starts with a letter, 2–31 characters. */
export const EXTERNAL_SYSTEM_ID = /^[a-z][a-z0-9_]{1,30}$/;

const OPERATION_NAME = /^[a-z][a-z0-9_]{1,40}$/;
const PARAM_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
/** An HTTP header name (RFC 9110 token, restricted to the characters real headers use). */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** A query-string parameter name for a handshake — Meta's are dotted (`hub.mode`). */
const QUERY_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const FIELD_SEGMENT = /^[A-Za-z0-9_]{1,64}$/;
/** Segments that would walk the prototype chain if a path were followed into an object. */
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A parameter name: an identifier that is not one of the prototype-chain
 * names, since a request builder may key an object by it.
 */
function isParamName(name: string): boolean {
  return PARAM_NAME_SHAPE.test(name) && !UNSAFE_SEGMENTS.has(name);
}

/**
 * Header names no definition may set, compared case-insensitively. Each one
 * is set by the HTTP client itself (framing, connection, host, body type) or
 * carries the client's own session — a definition that could set one could
 * smuggle a request, redirect it, or ride a cookie it was never given.
 * Positive and closed: a header is accepted only when it is not on this list
 * and does not start with one of the prefixes below.
 */
export const RESERVED_HEADER_NAMES: readonly string[] = [
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'cookie',
  'content-type',
];
/** Header-name prefixes no definition may set (`Proxy-Authorization` and its family). */
export const RESERVED_HEADER_PREFIXES: readonly string[] = ['proxy-'];

export function isReservedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADER_NAMES.includes(lower) || RESERVED_HEADER_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * A URL path with no `.`/`..` segment and no `//` anywhere — so a joined
 * request URL can never climb out of the base path or become
 * protocol-relative. Encoded dots (`%2e`) count as dots.
 */
function pathEscapes(path: string): boolean {
  if (path.includes('//')) return true;
  return path
    .toLowerCase()
    .replaceAll('%2e', '.')
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

/**
 * The classes a `change` operation may be judged as. Named, never derived:
 * every one is a class the gate already knows how to weigh, and none moves
 * money directly.
 */
export const CHANGE_CLASSES = [
  'crm.write',
  'accounting.write',
  'quote.issue',
  'commitment.make',
  'data.export',
] as const satisfies readonly ActionClass[];

/**
 * The classes a `money` operation may be judged as. Both are in
 * `NEVER_FULLY_AUTONOMOUS` (`domain/action.ts`), which is the point: an
 * external system can move money only through a class that always asks.
 * `purchase.place` is deliberately absent — it is not never-fully-autonomous.
 */
export const MONEY_CLASSES = ['payment.make', 'refund.issue'] as const satisfies readonly ActionClass[];

/** Currencies a money operation may declare. Closed. */
export const EXTERNAL_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP'] as const;

export const OperationKind = z.enum(['read', 'change', 'delete', 'money']);
export type OperationKind = z.infer<typeof OperationKind>;

const Label = z.string().trim().min(1).max(100);

/** A dotted path into a JSON response or body, e.g. `data.customer.id`. */
const FieldPath = z
  .string()
  .max(200)
  .refine(
    (path) => {
      const segments = path.split('.');
      return segments.every((s) => FIELD_SEGMENT.test(s) && !UNSAFE_SEGMENTS.has(s));
    },
    { message: 'נדרש נתיב שדה מנוקד של אותיות אנגליות, ספרות וקו תחתון (למשל data.customer.id)' },
  );

const HeaderName = z
  .string()
  .regex(HEADER_NAME, 'נדרש שם כותרת HTTP תקין')
  .refine((name) => !isReservedHeaderName(name), {
    message: 'כותרת שמורה — אסור להגדיר אותה (Host, Content-Length, Cookie, Content-Type, Proxy-* ועוד)',
  });

export const ExternalField = z.object({
  path: FieldPath,
  label: Label,
});
export type ExternalField = z.infer<typeof ExternalField>;

const ExternalParam = z
  .object({
    name: z.string().refine(isParamName, { message: 'נדרש שם פרמטר תקין (אותיות אנגליות, ספרות וקו תחתון)' }),
    in: z.enum(['path', 'query', 'body']),
    required: z.boolean(),
  })
  .refine((p) => p.in !== 'path' || p.required, {
    path: ['required'],
    message: 'פרמטר נתיב חייב להיות חובה — נתיב בלי ערך אינו כתובת תקינה',
  });

const ExternalAmount = z.object({
  // One top-level key, no dots: a dotted field would be written as a literal
  // key while a body param could carry the same path nested, and the amount
  // the gate judged could differ from the one the provider reads.
  field: FieldPath.refine((f) => !f.includes('.'), {
    message: 'שדה הסכום חייב להיות שם בודד ללא נקודות (סכום מקונן אינו נתמך)',
  }),
  unit: z.enum(['minor', 'major']),
  currency: z.enum(EXTERNAL_CURRENCIES),
});

/** Placeholders a path may hold, and every brace that is not one of them. */
function pathPlaceholders(path: string): { names: string[]; malformed: boolean } {
  const names: string[] = [];
  const stripped = path.replace(/\{([^{}]*)\}/g, (_m, name: string) => {
    names.push(name);
    return '';
  });
  const malformed = /[{}]/.test(stripped) || names.some((n) => !isParamName(n));
  return { names, malformed };
}

const OperationShape = z.object({
  name: z.string().regex(OPERATION_NAME, 'נדרש שם פעולה באותיות אנגליות קטנות, ספרות וקו תחתון'),
  label: Label,
  kind: OperationKind,
  actionClass: ActionClass,
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z
    .string()
    .max(300)
    .regex(/^\/[A-Za-z0-9\-._~/{}]*$/, 'נדרש נתיב שמתחיל ב-"/"')
    .refine((path) => !pathEscapes(path), { message: 'הנתיב לא יכול להכיל מקטעי "." או ".." או "//"' }),
  params: z.array(ExternalParam).max(30).default([]),
  bodyEncoding: z.enum(['json', 'form']).default('json'),
  fields: z.array(ExternalField).max(20).default([]),
  idPath: FieldPath.nullable().default(null),
  amount: ExternalAmount.nullable().default(null),
});

/** Is this class one the operation's kind may be judged as? Positive, per kind. */
function classFitsKind(kind: OperationKind, actionClass: ActionClass): boolean {
  switch (kind) {
    case 'read':
      return actionClass === 'external.read';
    case 'delete':
      return actionClass === 'external.delete';
    case 'change':
      return (CHANGE_CLASSES as readonly string[]).includes(actionClass);
    case 'money':
      return (MONEY_CLASSES as readonly string[]).includes(actionClass);
  }
}

export const ExternalOperation = OperationShape.superRefine((op, ctx) => {
  if (!classFitsKind(op.kind, op.actionClass)) {
    ctx.addIssue({
      code: 'custom',
      path: ['actionClass'],
      message: `סוג הפעולה "${op.actionClass}" אינו מותר לפעולה מסוג "${op.kind}"`,
    });
  }

  // A read must not change anything; POST is allowed for search endpoints.
  if (op.kind === 'read' && op.method !== 'GET' && op.method !== 'POST') {
    ctx.addIssue({ code: 'custom', path: ['method'], message: 'פעולת קריאה חייבת להשתמש ב-GET או ב-POST' });
  }

  if (op.kind === 'money' && op.amount === null) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'פעולת כסף חייבת להצהיר על שדה הסכום שלה' });
  }

  const paramNames = new Set<string>();
  for (const [index, param] of op.params.entries()) {
    if (paramNames.has(param.name)) {
      ctx.addIssue({ code: 'custom', path: ['params', index, 'name'], message: `הפרמטר "${param.name}" מופיע פעמיים` });
    }
    paramNames.add(param.name);
  }

  // The amount travels in its own declared field, never as a free parameter
  // the plan could fill in beside it.
  const amountLower = op.amount?.field.toLowerCase();
  if (op.amount !== null && [...paramNames].some((n) => n.toLowerCase() === amountLower)) {
    ctx.addIssue({
      code: 'custom',
      path: ['amount', 'field'],
      message: `שדה הסכום "${op.amount.field}" לא יכול להיות גם פרמטר`,
    });
  }

  const { names: placeholders, malformed } = pathPlaceholders(op.path);
  // A placeholder fills a whole segment: `/files/{id}`, never `/files/{id}.json` or `/x/{a}-{b}`.
  if (op.path.split('/').some((seg) => seg.includes('{') && !/^\{[^{}]*\}$/.test(seg))) {
    ctx.addIssue({
      code: 'custom',
      path: ['path'],
      message: 'פרמטר בנתיב חייב למלא מקטע שלם (למשל ‎/files/{id}‎)',
    });
  }
  if (malformed) {
    ctx.addIssue({ code: 'custom', path: ['path'], message: 'פרמטרים בנתיב חייבים להיות בצורה {param}' });
  }
  const pathParams = new Set(op.params.filter((p) => p.in === 'path').map((p) => p.name));
  for (const name of placeholders) {
    if (!pathParams.has(name)) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: `למקום {${name}} בנתיב אין פרמטר מסוג "path"` });
    }
  }
  for (const name of pathParams) {
    if (!placeholders.includes(name)) {
      ctx.addIssue({ code: 'custom', path: ['params'], message: `לפרמטר הנתיב "${name}" אין מקום בנתיב` });
    }
  }

  if (op.method === 'GET' && op.bodyEncoding === 'form') {
    ctx.addIssue({ code: 'custom', path: ['bodyEncoding'], message: 'לפעולת GET אין גוף לקידוד form' });
  }
});
export type ExternalOperation = z.infer<typeof ExternalOperation>;

const ExternalAuth = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('header'), header: HeaderName }),
  z.object({ kind: z.literal('bearer') }),
  z.object({ kind: z.literal('basic') }),
]);

const SignatureSource = z.discriminatedUnion('from', [
  z.object({ from: z.literal('header'), header: HeaderName, prefix: z.string().max(32).nullable() }),
  z.object({
    from: z.literal('kv'),
    header: HeaderName,
    key: z.string().min(1).max(32),
    separator: z.string().min(1).max(3),
  }),
]);

const TimestampSource = z.discriminatedUnion('from', [
  z.object({ from: z.literal('header'), header: HeaderName }),
  z.object({ from: z.literal('kv'), key: z.string().min(1).max(32) }),
]);

/**
 * The template the HMAC is computed over. Only `{timestamp}` and `{body}` may
 * appear, and `{body}` exactly once — a template without the body would sign
 * something an attacker can reproduce without the payload.
 */
function signedPayloadProblem(template: string): string | null {
  const placeholders = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  if (/[{}]/.test(template.replace(/\{([^{}]*)\}/g, ''))) return 'סוגריים מסולסלים לא מאוזנים ב-signedPayload';
  if (placeholders.some((p) => p !== 'timestamp' && p !== 'body')) {
    return 'ב-signedPayload מותר להשתמש רק ב-{timestamp} וב-{body}';
  }
  if (placeholders.filter((p) => p === 'body').length !== 1) return 'signedPayload חייב להכיל את {body} פעם אחת בדיוק';
  return null;
}

const WebhookScheme = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shared-secret'), header: HeaderName }),
  z
    .object({
      kind: z.literal('hmac-sha256'),
      encoding: z.enum(['hex', 'base64']),
      signature: SignatureSource,
      signedPayload: z.string().max(100).default('{body}'),
      timestamp: TimestampSource.nullable().default(null),
    })
    .superRefine((scheme, ctx) => {
      const problem = signedPayloadProblem(scheme.signedPayload);
      if (problem !== null) ctx.addIssue({ code: 'custom', path: ['signedPayload'], message: problem });
      if (scheme.signedPayload.includes('{timestamp}') && scheme.timestamp === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['timestamp'],
          message: 'signedPayload שמשתמש ב-{timestamp} צריך מקור לחותמת הזמן (timestamp)',
        });
      }
    }),
]);

const Handshake = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('query_challenge'),
    modeParam: z.string().regex(QUERY_NAME, 'נדרש שם פרמטר שאילתה תקין'),
    modeValue: z.string().min(1).max(64),
    tokenParam: z.string().regex(QUERY_NAME, 'נדרש שם פרמטר שאילתה תקין'),
    challengeParam: z.string().regex(QUERY_NAME, 'נדרש שם פרמטר שאילתה תקין'),
  }),
  z.object({
    kind: z.literal('body_challenge'),
    typeValue: z.string().min(1).max(64),
    challengePath: FieldPath,
  }),
]);

const WebhookEvent = z.object({
  type: z.string().min(1).max(100),
  label: Label,
  fields: z.array(ExternalField).max(20).default([]),
});

const ExternalWebhook = z
  .object({
    scheme: WebhookScheme,
    typePath: FieldPath.nullable().default(null),
    events: z.array(WebhookEvent).max(50).default([]),
    handshake: Handshake.nullable().default(null),
  })
  .superRefine((hook, ctx) => {
    const seen = new Set<string>();
    for (const [index, event] of hook.events.entries()) {
      if (seen.has(event.type)) {
        ctx.addIssue({ code: 'custom', path: ['events', index, 'type'], message: `סוג האירוע "${event.type}" מופיע פעמיים` });
      }
      seen.add(event.type);
    }
    // Without a type path every delivery is the same event, which is
    // meaningful only when exactly one event is declared.
    if (hook.typePath === null && hook.events.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['typePath'],
        message: 'typePath יכול להיות null רק כשמוגדר אירוע אחד בדיוק',
      });
    }
    // A body challenge is recognised by its type value, so there must be a
    // path to read the type from.
    if (hook.handshake?.kind === 'body_challenge' && hook.typePath === null) {
      ctx.addIssue({ code: 'custom', path: ['typePath'], message: 'לחיצת יד מסוג body_challenge צריכה typePath' });
    }
  });

const ExternalScan = z.object({
  operation: z.string().regex(OPERATION_NAME, 'נדרש שם פעולה באותיות אנגליות קטנות, ספרות וקו תחתון'),
  sinceParam: z
    .string()
    .refine(isParamName, { message: 'שם פרמטר לא תקין לפרמטר "מאז" של הסריקה' })
    .nullable()
    .default(null),
  itemsPath: FieldPath.nullable().default(null),
  everyHours: z.number().int().min(1).max(168),
});

/** An `https:` origin and path — no credentials, query or fragment. */
const BaseUrl = z
  .string()
  .max(300)
  .refine(
    (raw) => {
      if (raw.includes('?') || raw.includes('#') || raw.includes('@')) return false;
      // The WHATWG parser reads `\` as `/` for https: and silently drops
      // tabs and newlines, so a raw string can hide a dot segment or a `//`
      // that appears only once parsed. None of these belongs in a base URL.
      if (/[\\\s\u0000-\u001F\u007F-\u009F]/.test(raw)) return false;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      // What is validated must be what gets used: the parsed form equals the
      // raw string (up to the one trailing slash an empty path gets), so no
      // normalisation the parser does can differ from what the owner signed.
      if (url.href !== raw && url.href !== `${raw}/`) return false;
      if (pathEscapes(url.pathname)) return false;
      return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== '';
    },
    { message: 'baseUrl חייב להיות כתובת https: בלי פרטי התחברות, שאילתה (?), עוגן (#), מקטעי נקודה או "//" בנתיב' },
  );

export const ExternalSystem = z
  .object({
    id: z.string().regex(EXTERNAL_SYSTEM_ID, 'מזהה מערכת לא תקין — אותיות אנגליות קטנות, ספרות וקו תחתון, מתחיל באות, באורך 2 עד 31'),
    label: Label,
    baseUrl: BaseUrl,
    auth: ExternalAuth,
    idempotencyHeader: HeaderName.nullable().default(null),
    operations: z.array(ExternalOperation).min(1).max(50),
    webhook: ExternalWebhook.nullable().default(null),
    scan: ExternalScan.nullable().default(null),
  })
  .superRefine((system, ctx) => {
    const names = new Set<string>();
    for (const [index, op] of system.operations.entries()) {
      if (names.has(op.name)) {
        ctx.addIssue({ code: 'custom', path: ['operations', index, 'name'], message: `הפעולה "${op.name}" מופיעה פעמיים` });
      }
      names.add(op.name);
    }
    if (system.scan !== null) {
      const target = system.operations.find((op) => op.name === system.scan?.operation);
      if (target === undefined || target.kind !== 'read' || target.method !== 'GET') {
        ctx.addIssue({
          code: 'custom',
          path: ['scan', 'operation'],
          message: `פעולת הסריקה "${system.scan.operation}" חייבת להיות פעולת קריאה מסוג GET של המערכת הזו`,
        });
      }
      const since = system.scan.sinceParam;
      if (
        target !== undefined &&
        since !== null &&
        !target.params.some((p) => p.name === since && p.in === 'query')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['scan', 'sinceParam'],
          message: `הפרמטר "${since}" אינו פרמטר שאילתה (query) מוצהר של פעולת הסריקה "${target.name}"`,
        });
      }
    }
  });
export type ExternalSystem = z.infer<typeof ExternalSystem>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The dotted paths of every key in `raw` that the schema did not keep in
 * `parsed`, recursively through objects and arrays. zod strips unknown keys,
 * so without this a misspelled `idempotencyHeader` would vanish on save and
 * the definition would run without it (ruling T9-a: the panel refuses such a
 * draft). Keys the schema added as defaults are not reported.
 */
export function unrecognisedKeyPaths(raw: unknown, parsed: unknown, path: readonly (string | number)[] = []): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((item, index) => unrecognisedKeyPaths(item, parsed[index], [...path, index]));
  }
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return [];
  const found: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(parsed, key)) found.push([...path, key].join('.'));
    else found.push(...unrecognisedKeyPaths(raw[key], parsed[key], [...path, key]));
  }
  return found;
}

/**
 * The three credential refs a system's secrets are stored under. Derived, so
 * the operator never types one: `key` is the API key, `hook` the webhook
 * signing secret, and `verify` the token a `query_challenge` handshake
 * compares — which is not the signing secret.
 */
export function externalSecretRefs(id: string): { key: string; hook: string; verify: string } {
  if (!EXTERNAL_SYSTEM_ID.test(id)) throw new Error(`invalid external system id "${id}"`);
  const upper = id.toUpperCase();
  return { key: `EXT_${upper}_KEY`, hook: `EXT_${upper}_HOOK`, verify: `EXT_${upper}_VERIFY` };
}

/** The charter connection `system` name an external system is paired with. */
export function externalConnectionSystem(id: string): string {
  return `ext:${id}`;
}
