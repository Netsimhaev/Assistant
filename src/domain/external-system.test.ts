import { describe, expect, it } from 'vitest';
import {
  CHANGE_CLASSES,
  EXTERNAL_SYSTEM_ID,
  ExternalSystem,
  MONEY_CLASSES,
  RESERVED_HEADER_NAMES,
  externalSecretRefs,
  isReservedHeaderName,
  unrecognisedKeyPaths,
} from './external-system.js';
import { AMOUNT_REQUIRED_CLASSES, NEVER_FULLY_AUTONOMOUS } from './action.js';
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
      'אינו מותר לפעולה מסוג "read"',
    );
  });
  it('refuses a delete operation judged as anything but external.delete', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'delete_customer').actionClass = 'crm.write'; }),
      `operations.${DELETE}.actionClass`,
      'אינו מותר לפעולה מסוג "delete"',
    );
  });
  it('refuses a change operation outside CHANGE_CLASSES', () => {
    for (const cls of ['email.reply', 'external.read'] as const) {
      expectRefusedBy(
        withEdit((s) => { op(s, 'update_customer').actionClass = cls; }),
        `operations.${UPDATE}.actionClass`,
        'אינו מותר לפעולה מסוג "change"',
      );
    }
  });
  it('refuses a money operation judged as purchase.place', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'issue_refund').actionClass = 'purchase.place'; }),
      `operations.${REFUND}.actionClass`,
      'אינו מותר לפעולה מסוג "money"',
    );
  });
  it('accepts every class in CHANGE_CLASSES for a change operation (with an amount where the class needs one)', () => {
    for (const cls of CHANGE_CLASSES) {
      expectAccepted(withEdit((s) => {
        const o = op(s, 'update_customer');
        o.actionClass = cls;
        if (AMOUNT_REQUIRED_CLASSES.has(cls)) o.amount = { field: 'total', unit: 'minor', currency: 'ILS' };
      }));
    }
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
      'חייבת להשתמש ב-GET או ב-POST',
    );
  });
  it('accepts a POST read (search endpoints)', () => {
    expectAccepted(withEdit((s) => { op(s, 'get_customer').method = 'POST'; }));
  });
  it('refuses a scan over a POST read', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'list_customers').method = 'POST'; }),
      'scan.operation',
      'חייבת להיות פעולת קריאה מסוג GET',
    );
  });
});

describe('ExternalSystem — money', () => {
  it('refuses a money operation with no amount', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'issue_refund').amount = null; }),
      `operations.${REFUND}.amount`,
      'חייבת להצהיר על שדה הסכום שלה',
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
      'לא יכול להיות גם פרמטר',
    );
  });
});

describe('ExternalSystem — amount rules (I1, I2)', () => {
  const AMOUNT = { field: 'total', unit: 'minor', currency: 'ILS' } as const;
  it.each(['accounting.write', 'quote.issue'] as const)(
    'refuses a change operation judged as %s with no amount — the gate would always refuse it',
    (cls) => {
      expectRefusedBy(
        withEdit((s) => { op(s, 'update_customer').actionClass = cls; }),
        `operations.${UPDATE}.amount`,
        'בלעדיו היא תסורב תמיד',
      );
    },
  );
  it('accepts an amount-required change operation that declares its amount', () => {
    expectAccepted(withEdit((s) => {
      const o = op(s, 'update_customer');
      o.actionClass = 'accounting.write';
      o.amount = { ...AMOUNT };
    }));
  });
  it('refuses an amount on a change operation whose class needs none', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'update_customer').amount = { ...AMOUNT }; }),
      `operations.${UPDATE}.amount`,
      'רשאית להצהיר על שדה סכום',
    );
  });
  it('refuses an amount on a read operation', () => {
    expectRefusedBy(
      withEdit((s) => {
        const o = op(s, 'get_customer');
        o.method = 'POST';
        o.amount = { ...AMOUNT };
      }),
      `operations.${GET}.amount`,
      'רשאית להצהיר על שדה סכום',
    );
  });
  it('refuses an amount on a delete operation', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'delete_customer').amount = { ...AMOUNT }; }),
      `operations.${DELETE}.amount`,
      'רשאית להצהיר על שדה סכום',
    );
  });
  it('refuses an amount on a GET operation, even a money one', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'issue_refund').method = 'GET'; }),
      `operations.${REFUND}.method`,
      'בקשת GET אינה שולחת את הסכום',
    );
    expectRefusedBy(
      withEdit((s) => {
        const o = op(s, 'update_customer');
        o.actionClass = 'quote.issue';
        o.method = 'GET';
        o.params = [{ name: 'customer_id', in: 'path', required: true }];
        o.amount = { ...AMOUNT };
      }),
      `operations.${UPDATE}.method`,
      'בקשת GET אינה שולחת את הסכום',
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
    // Bypasses of a raw-string check: backslash is "/" for https:, and the
    // parser drops tabs and newlines.
    ['https://h.example/v1\\..\\admin'],
    ['https://h.example\\v1\\..\\admin'],
    ['https://h.example/v1/.\t./admin'],
    ['https://h.example/v1/\n../admin'],
    ['https://h.example\\\\evil.example/x'],
    ['https://h.example/v1\\\\x'],
    ['https://h.example/v1 x'],
    ['https://H.example/v1'],
  ])('refuses %j', (baseUrl) => {
    expectRefusedBy(withEdit((s) => { s.baseUrl = baseUrl; }), 'baseUrl', 'baseUrl חייב להיות כתובת https:');
  });
});

describe('ExternalSystem — base URL accepted forms', () => {
  it.each(['https://api.crm.example.com', 'https://api.crm.example.com/', 'https://api.crm.example.com/v1/'])(
    'accepts %s',
    (baseUrl) => {
      expectAccepted(withEdit((s) => { s.baseUrl = baseUrl; }));
    },
  );
});

describe('ExternalSystem — path and parameters', () => {
  it('refuses a placeholder with no path parameter', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'get_customer').path = '/customers/{customer_id}/{extra}'; }),
      `operations.${GET}.path`,
      'למקום {extra} בנתיב אין פרמטר מסוג "path"',
    );
  });
  it('refuses a path parameter with no placeholder', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'get_customer').path = '/customers'; }),
      `operations.${GET}.params`,
      'לפרמטר הנתיב "customer_id" אין מקום בנתיב',
    );
  });
  it('refuses malformed braces', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'list_customers').path = '/customers/{'; }),
      `operations.${LIST}.path`,
      'חייבים להיות בצורה {param}',
    );
  });
  it.each(['/customers/../admin', '/./customers', '/customers/..', '//evil.example/x', '/customers//x'])(
    'refuses the escaping path %s',
    (path) => {
      expectRefusedBy(
        withEdit((s) => { op(s, 'list_customers').path = path; }),
        `operations.${LIST}.path`,
        'לא יכול להכיל מקטעי "." או ".." או "//"',
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
      'הפעולה "get_customer" מופיעה פעמיים',
    );
  });
  it.each(['__proto__', 'constructor', 'prototype'])('refuses the parameter name %s', (name) => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'update_customer').params?.push({ name, in: 'body', required: false }); }),
      `operations.${UPDATE}.params.2.name`,
      'נדרש שם פרמטר תקין',
    );
  });
  it('refuses a scan operation that is not a read of this system', () => {
    expectRefusedBy(
      withEdit((s) => { if (s.scan) s.scan.operation = 'update_customer'; }),
      'scan.operation',
      'חייבת להיות פעולת קריאה מסוג GET',
    );
    expectRefusedBy(
      withEdit((s) => { if (s.scan) s.scan.operation = 'no_such_op'; }),
      'scan.operation',
      'חייבת להיות פעולת קריאה מסוג GET',
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
  it('refuses a sinceParam that is not a parameter name, in Hebrew', () => {
    expectRefusedBy(withEdit((s) => { if (s.scan) s.scan.sinceParam = '__proto__'; }), 'scan.sinceParam', 'שם פרמטר לא תקין');
  });
  it('accepts a null sinceParam', () => {
    expectAccepted(withEdit((s) => { if (s.scan) s.scan.sinceParam = null; }));
  });
  it('refuses a webhook event type listed twice', () => {
    expectRefusedBy(
      withEdit((s) => { s.webhook?.events?.push({ type: 'customer.created', label: 'שוב', fields: [] }); }),
      'webhook.events.2.type',
      'סוג האירוע "customer.created" מופיע פעמיים',
    );
  });
  it('refuses a form body on a GET operation', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'list_customers').bodyEncoding = 'form'; }),
      `operations.${LIST}.bodyEncoding`,
      'אין גוף לקידוד form',
    );
  });
  it('refuses a field path that walks the prototype chain', () => {
    expectRefusedBy(
      withEdit((s) => { op(s, 'get_customer').idPath = 'data.__proto__'; }),
      `operations.${GET}.idPath`,
      'נדרש נתיב שדה מנוקד',
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
    expectRefusedBy(withPayload('{timestamp}'), 'webhook.scheme.signedPayload', 'חייב להכיל את {body} פעם אחת בדיוק');
  });
  it('refuses {body} twice', () => {
    expectRefusedBy(withPayload('{body}.{body}'), 'webhook.scheme.signedPayload', 'חייב להכיל את {body} פעם אחת בדיוק');
  });
  it('refuses any other placeholder', () => {
    expectRefusedBy(
      withPayload('{secret}.{body}'),
      'webhook.scheme.signedPayload',
      'מותר להשתמש רק ב-{timestamp} וב-{body}',
    );
  });
  it('refuses {timestamp} with no timestamp source', () => {
    expectRefusedBy(
      withPayload('{timestamp}.{body}', true),
      'webhook.scheme.timestamp',
      'צריך מקור לחותמת הזמן',
    );
  });
  it('refuses a null typePath with more than one event', () => {
    expectRefusedBy(
      withEdit((s) => { if (s.webhook) s.webhook.typePath = null; }),
      'webhook.typePath',
      'רק כשמוגדר אירוע אחד בדיוק',
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
      'רק כשמוגדר אירוע אחד בדיוק',
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
      'לחיצת יד מסוג body_challenge צריכה typePath',
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

describe('unrecognisedKeyPaths', () => {
  it('finds nothing in the fixture, even though parsing added defaults', () => {
    const raw = crmFixture();
    expect(unrecognisedKeyPaths(raw, ExternalSystem.parse(raw))).toEqual([]);
  });

  it('lists every stripped key by its dotted path, through auth, operations, webhook and scan', () => {
    const raw = JSON.parse(JSON.stringify(crmFixture())) as Record<string, any>;
    raw.idempotencyHeaders = 'Idempotency-Key';
    raw.auth.headr = 'X-Key';
    raw.operations[2].ammount = { field: 'x' };
    raw.operations[0].params[0].requird = true;
    raw.webhook.scheme.secret = 'x';
    raw.scan.every = 12;
    expect(unrecognisedKeyPaths(raw, ExternalSystem.parse(raw)).sort()).toEqual(
      [
        'idempotencyHeaders',
        'auth.headr',
        'operations.2.ammount',
        'operations.0.params.0.requird',
        'webhook.scheme.secret',
        'scan.every',
      ].sort(),
    );
  });
});
