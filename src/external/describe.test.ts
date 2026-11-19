import { describe, expect, it } from 'vitest';
import { ExternalSystem } from '../domain/external-system.js';
import { crmFixture, type ExternalSystemInput } from '../test/external-fixtures.js';
import { WEBHOOK_DEDUP_HINT, describeExternalSystem, describeForTechnician } from './describe.js';

function withEvents(fields: { path: string; label: string }[][]): ExternalSystem {
  const def: ExternalSystemInput = crmFixture();
  if (def.webhook === null || def.webhook === undefined) throw new Error('fixture has a webhook');
  def.webhook.events = fields.map((f, i) => ({ type: `t${i}`, label: `אירוע ${i}`, fields: f }));
  return ExternalSystem.parse(def);
}

describe('webhook dedup hint', () => {
  it('appears, for both audiences, when an event declares no id field', () => {
    const def = withEvents([[{ path: 'data.name', label: 'שם' }]]);
    expect(describeForTechnician(def)).toContain(WEBHOOK_DEDUP_HINT);
    expect(describeExternalSystem(def, 'ILS')).toContain(WEBHOOK_DEDUP_HINT);
  });

  it('appears when only one of several events lacks an id field', () => {
    const def = withEvents([[{ path: 'data.id', label: 'מזהה' }], []]);
    expect(describeForTechnician(def)).toContain(WEBHOOK_DEDUP_HINT);
  });

  it('is absent when every event declares a field whose last segment is `id` or ends in `_id`', () => {
    const def = withEvents([[{ path: 'data.id', label: 'מזהה' }], [{ path: 'customer_id', label: 'לקוח' }]]);
    expect(describeForTechnician(def)).not.toContain(WEBHOOK_DEDUP_HINT);
    expect(describeExternalSystem(def, 'ILS')).not.toContain(WEBHOOK_DEDUP_HINT);
  });

  it('`idea` or `data.identity` is not an id', () => {
    const def = withEvents([[{ path: 'idea', label: 'x' }, { path: 'data.identity', label: 'y' }]]);
    expect(describeForTechnician(def)).toContain(WEBHOOK_DEDUP_HINT);
  });
});
