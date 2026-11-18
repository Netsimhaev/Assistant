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
    { message: 'expected a dotted field path of letters, digits and underscores' },
  );

const HeaderName = z
  .string()
  .regex(HEADER_NAME, 'expected an HTTP header name')
  .refine((name) => !isReservedHeaderName(name), {
    message: 'כותרת שמורה — אסור להגדיר אותה (Host, Content-Length, Cookie, Content-Type, Proxy-* ועוד)',
  });

export const ExternalField = z.object({
  path: FieldPath,
  label: Label,
});
export type ExternalField = z.infer<typeof ExternalField>;

const ExternalParam = z.object({
  name: z.string().refine(isParamName, { message: 'expected a parameter name' }),
  in: z.enum(['path', 'query', 'body']),
  required: z.boolean(),
});

const ExternalAmount = z.object({
  field: FieldPath,
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
  name: z.string().regex(OPERATION_NAME, 'expected a lowercase operation name'),
  label: Label,
  kind: OperationKind,
  actionClass: ActionClass,
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z
    .string()
    .max(300)
    .regex(/^\/[A-Za-z0-9\-._~/{}]*$/, 'expected a path that starts with "/"')
    .refine((path) => !pathEscapes(path), { message: 'path must not contain "." or ".." segments or "//"' }),
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
      message: `action class "${op.actionClass}" is not allowed for a "${op.kind}" operation`,
    });
  }

  // A read must not change anything; POST is allowed for search endpoints.
  if (op.kind === 'read' && op.method !== 'GET' && op.method !== 'POST') {
    ctx.addIssue({ code: 'custom', path: ['method'], message: 'a read operation must use GET or POST' });
  }

  if (op.kind === 'money' && op.amount === null) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'a money operation must declare its amount field' });
  }

  const paramNames = new Set<string>();
  for (const [index, param] of op.params.entries()) {
    if (paramNames.has(param.name)) {
      ctx.addIssue({ code: 'custom', path: ['params', index, 'name'], message: `duplicate parameter "${param.name}"` });
    }
    paramNames.add(param.name);
  }

  // The amount travels in its own declared field, never as a free parameter
  // the plan could fill in beside it.
  if (op.amount !== null && paramNames.has(op.amount.field)) {
    ctx.addIssue({
      code: 'custom',
      path: ['amount', 'field'],
      message: `amount field "${op.amount.field}" must not also be a parameter`,
    });
  }

  const { names: placeholders, malformed } = pathPlaceholders(op.path);
  if (malformed) {
    ctx.addIssue({ code: 'custom', path: ['path'], message: 'path placeholders must be of the form {param}' });
  }
  const pathParams = new Set(op.params.filter((p) => p.in === 'path').map((p) => p.name));
  for (const name of placeholders) {
    if (!pathParams.has(name)) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: `placeholder {${name}} has no "path" parameter` });
    }
  }
  for (const name of pathParams) {
    if (!placeholders.includes(name)) {
      ctx.addIssue({ code: 'custom', path: ['params'], message: `path parameter "${name}" has no placeholder in the path` });
    }
  }

  if (op.method === 'GET' && op.bodyEncoding === 'form') {
    ctx.addIssue({ code: 'custom', path: ['bodyEncoding'], message: 'a GET operation has no body to form-encode' });
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
  if (/[{}]/.test(template.replace(/\{([^{}]*)\}/g, ''))) return 'unbalanced braces in signedPayload';
  if (placeholders.some((p) => p !== 'timestamp' && p !== 'body')) {
    return 'signedPayload may only use {timestamp} and {body}';
  }
  if (placeholders.filter((p) => p === 'body').length !== 1) return 'signedPayload must contain {body} exactly once';
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
          message: 'a signedPayload that uses {timestamp} needs a timestamp source',
        });
      }
    }),
]);

const Handshake = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('query_challenge'),
    modeParam: z.string().regex(QUERY_NAME),
    modeValue: z.string().min(1).max(64),
    tokenParam: z.string().regex(QUERY_NAME),
    challengeParam: z.string().regex(QUERY_NAME),
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
        ctx.addIssue({ code: 'custom', path: ['events', index, 'type'], message: `duplicate event type "${event.type}"` });
      }
      seen.add(event.type);
    }
    // Without a type path every delivery is the same event, which is
    // meaningful only when exactly one event is declared.
    if (hook.typePath === null && hook.events.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['typePath'],
        message: 'typePath may be null only when exactly one event is declared',
      });
    }
    // A body challenge is recognised by its type value, so there must be a
    // path to read the type from.
    if (hook.handshake?.kind === 'body_challenge' && hook.typePath === null) {
      ctx.addIssue({ code: 'custom', path: ['typePath'], message: 'a body_challenge handshake needs typePath' });
    }
  });

const ExternalScan = z.object({
  operation: z.string().regex(OPERATION_NAME),
  sinceParam: z.string().refine(isParamName).nullable().default(null),
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
      // The path part, read from the raw string: `URL` would already have
      // collapsed the dot segments this check exists to refuse.
      const afterScheme = raw.replace(/^https:\/\//i, '');
      const slash = afterScheme.indexOf('/');
      if (slash !== -1 && pathEscapes(afterScheme.slice(slash))) return false;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== '';
    },
    { message: 'baseUrl must be an https: URL with no credentials, query, fragment, dot segments or "//" in its path' },
  );

export const ExternalSystem = z
  .object({
    id: z.string().regex(EXTERNAL_SYSTEM_ID, 'expected a lowercase system id'),
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
        ctx.addIssue({ code: 'custom', path: ['operations', index, 'name'], message: `duplicate operation "${op.name}"` });
      }
      names.add(op.name);
    }
    if (system.scan !== null) {
      const target = system.operations.find((op) => op.name === system.scan?.operation);
      if (target === undefined || target.kind !== 'read' || target.method !== 'GET') {
        ctx.addIssue({
          code: 'custom',
          path: ['scan', 'operation'],
          message: `scan operation "${system.scan.operation}" must be a GET read operation of this system`,
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
