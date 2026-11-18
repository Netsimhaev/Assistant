import { describe, expect, it } from 'vitest';
import {
  CHANGE_CLASSES,
  EXTERNAL_SYSTEM_ID,
  ExternalSystem,
  MONEY_CLASSES,
  RESERVED_HEADER_NAMES,
  externalSecretRefs,
  isReservedHeaderName,
} from './external-system.js';
import { NEVER_FULLY_AUTONOMOUS } from './action.js';
import { crmFixture, type ExternalSystemInput } from '../test/external-fixtures.js';

type Op = ExternalSystemInput['operations'][number];

/** A fresh fixture with one edit applied, so each refusal is caused by that edit alone. */
function withEdit(edit: (s: ExternalSystemInput) => void): ExternalSystemInput {
  const system = crmFixture();
  edit(system);
  return system;
}

function op(system: ExternalSystemInput, name: string): Op {
  const found = system.operations.find((o) => o.name === name);
  if (found === undefined) throw new Error(`fixture has no operation ${name}`);
  return found;
}

function opIndex(name: string): number {
  return crmFixture().operations.findIndex((o) => o.name === name);
}

/** Each issue as `path: message`. */
function issues(system: ExternalSystemInput): string[] {
  const result = ExternalSystem.safeParse(system);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/** The edit is refused, and by the named rule: an issue at `path` whose message contains `fragment`. */
function expectRefusedBy(system: ExternalSystemInput, path: string, fragment: string): void {
  const found = issues(system);
  expect(found, `expected an issue at "${path}" containing "${fragment}"`).toContainEqual(
    expect.stringMatching(new RegExp(`^${escape(path)}: .*${escape(fragment)}`)),
  );
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectAccepted(system: ExternalSystemInput): void {
  expect(issues(system)).toEqual([]);
}

const GET = opIndex('get_customer');
const LIST = opIndex('list_customers');
const UPDATE = opIndex('update_customer');
const DELETE = opIndex('delete_customer');
const REFUND = opIndex('issue_refund');

describe('ExternalSystem — the reference fixture', () => {
  it('accepts crmFixture()', () => {
    expectAccepted(crmFixture());
  });

  it('fills defaults the operator may leave out', () => {
    const system = crmFixture();
    delete op(system, 'list_customers').bodyEncoding;
    const parsed = ExternalSystem.parse(system);
    expect(parsed.operations[LIST]?.bodyEncoding).toBe('json');
  });
});

describe('ExternalSystem — kind and class', () => {
  it('refuses a read operation judged as anything but external.read', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'get_customer').actionClass = 'crm.write'; }),
      `operations.${GET}.actionClass`,
      'is not allowed for a "read" operation',
    );
  });
  it('refuses a delete operation judged as anything but external.delete', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'delete_customer').actionClass = 'crm.write'; }),
      `operations.${DELETE}.actionClass`,
      'is not allowed for a "delete" operation',
    );
  });
  it('refuses a change operation outside CHANGE_CLASSES', () => {
    for (const cls of ['email.reply', 'external.read'] as const) {
      expectRefusedBy(
        withEdit((s) => { op(s, 'update_customer').actionClass = cls; }),
        `operations.${UPDATE}.actionClass`,
        'is not allowed for a "change" operation',
      );
    }
  });
  it('refuses a money operation judged as purchase.place', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'issue_refund').actionClass = 'purchase.place'; }),
      `operations.${REFUND}.actionClass`,
      'is not allowed for a "money" operation',
    );
  });
  it('accepts every class in CHANGE_CLASSES for a change operation', () => {
    for (const cls of CHANGE_CLASSES) expectAccepted(withEdit((s) => { op(s, 'update_customer').actionClass = cls; }));
  });
  it('keeps every money class, and external.delete, never fully autonomous', () => {
    for (const cls of MONEY_CLASSES) expect(NEVER_FULLY_AUTONOMOUS.has(cls)).toBe(true);
    expect(NEVER_FULLY_AUTONOMOUS.has('external.delete')).toBe(true);
    expect(NEVER_FULLY_AUTONOMOUS.has('external.read')).toBe(false);
  });
});

describe('ExternalSystem — method per kind', () => {
  it.each(['PUT', 'PATCH', 'DELETE'] as const)('refuses a read operation using %s', (method) => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'get_customer').method = method; }),
      `operations.${GET}.method`,
      'must use GET or POST',
    );
  });
  it('accepts a POST read (search endpoints)', () => {
    expectAccepted(withEdit((s) => { op(s, 'get_customer').method = 'POST'; }));
  });
  it('refuses a scan over a POST read', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'list_customers').method = 'POST'; }),
      'scan.operation',
      'must be a GET read operation',
    );
  });
});

describe('ExternalSystem — money', () => {
  it('refuses a money operation with no amount', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'issue_refund').amount = null; }),
      `operations.${REFUND}.amount`,
      'must declare its amount field',
    );
  });
  it('refuses a currency outside the closed list', () => {
    expectRefusedBy(
      withEdit((s) => {
        op(s, 'issue_refund').amount = { field: 'amount_cents', unit: 'minor', currency: 'JPY' as 'ILS' };
      }),
      `operations.${REFUND}.amount.currency`,
      '',
    );
  });
  it('refuses an amount field that is also a parameter', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'issue_refund').params?.push({ name: 'amount_cents', in: 'body', required: true }); }),
      `operations.${REFUND}.amount.field`,
      'must not also be a parameter',
    );
  });
});

describe('ExternalSystem — base URL', () => {
  it.each([
    ['http://api.crm.example.com/v1'],
    ['https://u:p@api.crm.example.com'],
    ['https://api.crm.example.com/?q=1'],
    ['https://api.crm.example.com/v1#frag'],
    ['not a url'],
    ['https://api.crm.example.com/v1/../admin'],
    ['https://api.crm.example.com/./v1'],
    ['https://api.crm.example.com//evil.example'],
    ['https://api.crm.example.com/v1/%2e%2e/admin'],
  ])('refuses %s', (baseUrl) => {
    expectRefusedBy(withEdit((s) => { s.baseUrl = baseUrl; }), 'baseUrl', 'baseUrl must be an https: URL');
  });
});

describe('ExternalSystem — path and parameters', () => {
  it('refuses a placeholder with no path parameter', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'get_customer').path = '/customers/{customer_id}/{extra}'; }),
      `operations.${GET}.path`,
      'placeholder {extra} has no "path" parameter',
    );
  });
  it('refuses a path parameter with no placeholder', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'get_customer').path = '/customers'; }),
      `operations.${GET}.params`,
      'path parameter "customer_id" has no placeholder',
    );
  });
  it('refuses malformed braces', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'list_customers').path = '/customers/{'; }),
      `operations.${LIST}.path`,
      'placeholders must be of the form {param}',
    );
  });
  it.each(['/customers/../admin', '/./customers', '/customers/..', '//evil.example/x', '/customers//x'])(
    'refuses the escaping path %s',
    (path) => {
      expectRefusedBy(
        withEdit((s) => { op(s, 'list_customers').path = path; }),
        `operations.${LIST}.path`,
        'must not contain "." or ".." segments or "//"',
      );
    },
  );
  it('accepts a dot inside a segment', () => {
    expectAccepted(withEdit((s) => { op(s, 'list_customers').path = '/customers.json'; }));
  });
  it('refuses duplicate operation names', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'delete_customer').name = 'get_customer'; }),
      `operations.${DELETE}.name`,
      'duplicate operation "get_customer"',
    );
  });
  it.each(['__proto__', 'constructor', 'prototype'])('refuses the parameter name %s', (name) => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'update_customer').params?.push({ name, in: 'body', required: false }); }),
      `operations.${UPDATE}.params.2.name`,
      'expected a parameter name',
    );
  });
  it('refuses a scan operation that is not a read of this system', () => {
    expectRefusedBy(
      withEdit((s) => { if (s.scan) s.scan.operation = 'update_customer'; }),
      'scan.operation',
      'must be a GET read operation',
    );
    expectRefusedBy(
      withEdit((s) => { if (s.scan) s.scan.operation = 'no_such_op'; }),
      'scan.operation',
      'must be a GET read operation',
    );
  });
  it('refuses a sinceParam the scan operation does not declare', () => {
    expectRefusedBy(
      withEdit((s) => { if (s.scan) s.scan.sinceParam = 'since'; }),
      'scan.sinceParam',
      'אינו פרמטר שאילתה',
    );
  });
  it('refuses a sinceParam declared outside the query', () => {
    expectRefusedBy(
      withEdit((s) => {
        const list = op(s, 'list_customers');
        list.params = [{ name: 'updated_since', in: 'body', required: false }];
        list.method = 'GET';
      }),
      'scan.sinceParam',
      'אינו פרמטר שאילתה',
    );
  });
  it('accepts a null sinceParam', () => {
    expectAccepted(withEdit((s) => { if (s.scan) s.scan.sinceParam = null; }));
  });
  it('refuses a webhook event type listed twice', () => {
    expectRefusedBy(
      withEdit((s) => { s.webhook?.events?.push({ type: 'customer.created', label: 'שוב', fields: [] }); }),
      'webhook.events.2.type',
      'duplicate event type "customer.created"',
    );
  });
  it('refuses a form body on a GET operation', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'list_customers').bodyEncoding = 'form'; }),
      `operations.${LIST}.bodyEncoding`,
      'no body to form-encode',
    );
  });
  it('refuses a field path that walks the prototype chain', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'get_customer').idPath = 'data.__proto__'; }),
      `operations.${GET}.idPath`,
      'expected a dotted field path',
    );
  });
});

describe('ExternalSystem — reserved headers', () => {
  it('is one positive list, plus the proxy- prefix', () => {
    expect([...RESERVED_HEADER_NAMES].sort()).toEqual(
      ['connection', 'content-length', 'content-type', 'cookie', 'host', 'te', 'trailer', 'transfer-encoding', 'upgrade'],
    );
    expect(isReservedHeaderName('Proxy-Authorization')).toBe(true);
    expect(isReservedHeaderName('X-Api-Key')).toBe(false);
  });

  const RESERVED_FRAGMENT = 'כותרת שמורה';

  it.each(['Host', 'cookie', 'Content-Type', 'TRANSFER-ENCODING', 'Proxy-Authorization', 'te'])(
    'refuses %s as auth.header',
    (header) => {
      expectRefusedBy(withEdit((s) => { s.auth = { kind: 'header', header }; }), 'auth.header', RESERVED_FRAGMENT);
    },
  );
  it('refuses a reserved idempotencyHeader', () => {
    expectRefusedBy(
      withEdit((s) => { s.idempotencyHeader = 'Content-Length'; }),
      'idempotencyHeader',
      RESERVED_FRAGMENT,
    );
  });
  it('refuses a reserved webhook signature header', () => {
    expectRefusedBy(
      withEdit((s) => {
        const scheme = s.webhook?.scheme;
        if (scheme?.kind !== 'hmac-sha256') throw new Error('fixture scheme changed');
        scheme.signature = { from: 'header', header: 'Cookie', prefix: null };
      }),
      'webhook.scheme.signature.header',
      RESERVED_FRAGMENT,
    );
  });
  it('refuses a reserved webhook timestamp header', () => {
    expectRefusedBy(
      withEdit((s) => {
        const scheme = s.webhook?.scheme;
        if (scheme?.kind !== 'hmac-sha256') throw new Error('fixture scheme changed');
        scheme.timestamp = { from: 'header', header: 'Upgrade' };
      }),
      'webhook.scheme.timestamp.header',
      RESERVED_FRAGMENT,
    );
  });
  it('refuses a reserved shared-secret header', () => {
    expectRefusedBy(
      withEdit((s) => {
        if (!s.webhook) throw new Error('fixture has no webhook');
        s.webhook.scheme = { kind: 'shared-secret', header: 'Host' };
      }),
      'webhook.scheme.header',
      RESERVED_FRAGMENT,
    );
  });
  it('accepts an ordinary header', () => {
    expectAccepted(withEdit((s) => { s.auth = { kind: 'header', header: 'X-Api-Key' }; }));
  });
});

describe('ExternalSystem — webhook', () => {
  function withPayload(signedPayload: string, timestampNull = false): ExternalSystemInput {
    return withEdit((s) => {
      const scheme = s.webhook?.scheme;
      if (scheme?.kind !== 'hmac-sha256') throw new Error('fixture scheme changed');
      scheme.signedPayload = signedPayload;
      if (timestampNull) scheme.timestamp = null;
    });
  }
  it('accepts the three known templates', () => {
    expectAccepted(withPayload('{body}', true));
    expectAccepted(withPayload('{timestamp}.{body}'));
    expectAccepted(withPayload('v0:{timestamp}:{body}'));
  });
  it('refuses a template without {body}', () => {
    expectRefusedBy(withPayload('{timestamp}'), 'webhook.scheme.signedPayload', 'must contain {body} exactly once');
  });
  it('refuses {body} twice', () => {
    expectRefusedBy(withPayload('{body}.{body}'), 'webhook.scheme.signedPayload', 'must contain {body} exactly once');
  });
  it('refuses any other placeholder', () => {
    expectRefusedBy(
      withPayload('{secret}.{body}'),
      'webhook.scheme.signedPayload',
      'may only use {timestamp} and {body}',
    );
  });
  it('refuses {timestamp} with no timestamp source', () => {
    expectRefusedBy(
      withPayload('{timestamp}.{body}', true),
      'webhook.scheme.timestamp',
      'needs a timestamp source',
    );
  });
  it('refuses a null typePath with more than one event', () => {
    expectRefusedBy(
      withEdit((s) => { if (s.webhook) s.webhook.typePath = null; }),
      'webhook.typePath',
      'only when exactly one event is declared',
    );
  });
  it('refuses a null typePath with no event', () => {
    expectRefusedBy(
      withEdit((s) => {
        if (!s.webhook) throw new Error('fixture has no webhook');
        s.webhook.typePath = null;
        s.webhook.events = [];
      }),
      'webhook.typePath',
      'only when exactly one event is declared',
    );
  });
  it('accepts a null typePath with exactly one event', () => {
    expectAccepted(
      withEdit((s) => {
        if (!s.webhook) throw new Error('fixture has no webhook');
        s.webhook.typePath = null;
        s.webhook.events = [{ type: 'any', label: 'אירוע', fields: [] }];
      }),
    );
  });
  it('refuses a body_challenge with no typePath', () => {
    expectRefusedBy(
      withEdit((s) => {
        if (!s.webhook) throw new Error('fixture has no webhook');
        s.webhook.typePath = null;
        s.webhook.events = [{ type: 'any', label: 'אירוע', fields: [] }];
        s.webhook.handshake = { kind: 'body_challenge', typeValue: 'url_verification', challengePath: 'challenge' };
      }),
      'webhook.typePath',
      'a body_challenge handshake needs typePath',
    );
  });
  it('accepts a body_challenge with a typePath, and a query_challenge', () => {
    expectAccepted(
      withEdit((s) => {
        if (!s.webhook) throw new Error('fixture has no webhook');
        s.webhook.handshake = { kind: 'body_challenge', typeValue: 'url_verification', challengePath: 'challenge' };
      }),
    );
    expectAccepted(
      withEdit((s) => {
        if (!s.webhook) throw new Error('fixture has no webhook');
        s.webhook.handshake = {
          kind: 'query_challenge',
          modeParam: 'hub.mode',
          modeValue: 'subscribe',
          tokenParam: 'hub.verify_token',
          challengeParam: 'hub.challenge',
        };
      }),
    );
  });
});

describe('externalSecretRefs', () => {
  it('derives three refs in the credential ref alphabet', () => {
    expect(externalSecretRefs('my_crm')).toEqual({
      key: 'EXT_MY_CRM_KEY',
      hook: 'EXT_MY_CRM_HOOK',
      verify: 'EXT_MY_CRM_VERIFY',
    });
  });
  it('refuses an invalid id', () => {
    expect(() => externalSecretRefs('Bad-Id')).toThrow();
    expect(EXTERNAL_SYSTEM_ID.test('a')).toBe(false);
  });
});
