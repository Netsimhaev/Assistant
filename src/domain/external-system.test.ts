import { describe, expect, it } from 'vitest';
import {
  CHANGE_CLASSES,
  EXTERNAL_SYSTEM_ID,
  ExternalSystem,
  MONEY_CLASSES,
  externalSecretRefs,
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

function refused(system: ExternalSystemInput): boolean {
  return !ExternalSystem.safeParse(system).success;
}

describe('ExternalSystem — the reference fixture', () => {
  it('accepts crmFixture()', () => {
    const result = ExternalSystem.safeParse(crmFixture());
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('fills defaults the operator may leave out', () => {
    const system = crmFixture();
    delete op(system, 'list_customers').bodyEncoding;
    const parsed = ExternalSystem.parse(system);
    expect(parsed.operations[0]?.bodyEncoding).toBe('json');
  });
});

describe('ExternalSystem — kind and class', () => {
  it('refuses a read operation judged as anything but external.read', () => {
    expect(refused(withEdit((s) => { op(s, 'get_customer').actionClass = 'crm.write'; }))).toBe(true);
  });
  it('refuses a delete operation judged as anything but external.delete', () => {
    expect(refused(withEdit((s) => { op(s, 'delete_customer').actionClass = 'crm.write'; }))).toBe(true);
  });
  it('refuses a change operation outside CHANGE_CLASSES', () => {
    expect(refused(withEdit((s) => { op(s, 'update_customer').actionClass = 'email.reply'; }))).toBe(true);
    expect(refused(withEdit((s) => { op(s, 'update_customer').actionClass = 'external.read'; }))).toBe(true);
  });
  it('refuses a money operation judged as purchase.place', () => {
    expect(refused(withEdit((s) => { op(s, 'issue_refund').actionClass = 'purchase.place'; }))).toBe(true);
  });
  it('accepts every class in CHANGE_CLASSES for a change operation', () => {
    for (const cls of CHANGE_CLASSES) {
      expect(refused(withEdit((s) => { op(s, 'update_customer').actionClass = cls; }))).toBe(false);
    }
  });
  it('keeps every money class, and external.delete, never fully autonomous', () => {
    for (const cls of MONEY_CLASSES) expect(NEVER_FULLY_AUTONOMOUS.has(cls)).toBe(true);
    expect(NEVER_FULLY_AUTONOMOUS.has('external.delete')).toBe(true);
    expect(NEVER_FULLY_AUTONOMOUS.has('external.read')).toBe(false);
  });
});

describe('ExternalSystem — money', () => {
  it('refuses a money operation with no amount', () => {
    expect(refused(withEdit((s) => { op(s, 'issue_refund').amount = null; }))).toBe(true);
  });
  it('refuses a currency outside the closed list', () => {
    expect(
      refused(
        withEdit((s) => {
          op(s, 'issue_refund').amount = { field: 'amount_cents', unit: 'minor', currency: 'JPY' as 'ILS' };
        }),
      ),
    ).toBe(true);
  });
  it('refuses an amount field that is also a parameter', () => {
    expect(
      refused(
        withEdit((s) => {
          op(s, 'issue_refund').params?.push({ name: 'amount_cents', in: 'body', required: true });
        }),
      ),
    ).toBe(true);
  });
});

describe('ExternalSystem — base URL', () => {
  it.each([
    ['http://api.crm.example.com/v1'],
    ['https://u:p@api.crm.example.com'],
    ['https://api.crm.example.com/?q=1'],
    ['https://api.crm.example.com/v1#frag'],
    ['not a url'],
  ])('refuses %s', (baseUrl) => {
    expect(refused(withEdit((s) => { s.baseUrl = baseUrl; }))).toBe(true);
  });
});

describe('ExternalSystem — path and parameters', () => {
  it('refuses a placeholder with no path parameter', () => {
    expect(refused(withEdit((s) => { op(s, 'get_customer').path = '/customers/{customer_id}/{extra}'; }))).toBe(true);
  });
  it('refuses a path parameter with no placeholder', () => {
    expect(refused(withEdit((s) => { op(s, 'get_customer').path = '/customers'; }))).toBe(true);
  });
  it('refuses malformed braces', () => {
    expect(refused(withEdit((s) => { op(s, 'list_customers').path = '/customers/{'; }))).toBe(true);
  });
  it('refuses duplicate operation names', () => {
    expect(refused(withEdit((s) => { op(s, 'list_customers').name = 'get_customer'; }))).toBe(true);
  });
  it('refuses a scan operation that is not a read of this system', () => {
    expect(refused(withEdit((s) => { if (s.scan) s.scan.operation = 'update_customer'; }))).toBe(true);
    expect(refused(withEdit((s) => { if (s.scan) s.scan.operation = 'no_such_op'; }))).toBe(true);
  });
  it('refuses a webhook event type listed twice', () => {
    expect(
      refused(withEdit((s) => { s.webhook?.events?.push({ type: 'customer.created', label: 'שוב', fields: [] }); })),
    ).toBe(true);
  });
  it('refuses a form body on a GET operation', () => {
    expect(refused(withEdit((s) => { op(s, 'list_customers').bodyEncoding = 'form'; }))).toBe(true);
  });
  it('refuses a field path that walks the prototype chain', () => {
    expect(refused(withEdit((s) => { op(s, 'get_customer').idPath = 'data.__proto__'; }))).toBe(true);
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
    expect(refused(withPayload('{body}', true))).toBe(false);
    expect(refused(withPayload('{timestamp}.{body}'))).toBe(false);
    expect(refused(withPayload('v0:{timestamp}:{body}'))).toBe(false);
  });
  it('refuses a template without {body}', () => {
    expect(refused(withPayload('{timestamp}'))).toBe(true);
  });
  it('refuses {body} twice', () => {
    expect(refused(withPayload('{body}.{body}'))).toBe(true);
  });
  it('refuses any other placeholder', () => {
    expect(refused(withPayload('{secret}.{body}'))).toBe(true);
  });
  it('refuses {timestamp} with no timestamp source', () => {
    expect(refused(withPayload('{timestamp}.{body}', true))).toBe(true);
  });
  it('refuses a body_challenge with no typePath', () => {
    expect(
      refused(
        withEdit((s) => {
          if (!s.webhook) throw new Error('fixture has no webhook');
          s.webhook.typePath = null;
          s.webhook.events = [];
          s.webhook.handshake = { kind: 'body_challenge', typeValue: 'url_verification', challengePath: 'challenge' };
        }),
      ),
    ).toBe(true);
  });
  it('accepts a body_challenge with a typePath, and a query_challenge', () => {
    expect(
      refused(
        withEdit((s) => {
          if (!s.webhook) throw new Error('fixture has no webhook');
          s.webhook.handshake = { kind: 'body_challenge', typeValue: 'url_verification', challengePath: 'challenge' };
        }),
      ),
    ).toBe(false);
    expect(
      refused(
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
      ),
    ).toBe(false);
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
