/**
 * Records of ONE contact from any signed external system the owner chose in
 * `/settings/whatsapp-contacts` (each entry: a signed `read` operation, the
 * parameter that carries the contact's id, and the declared response field
 * that carries it per row). Same ownership rule as the accounting source: the
 * provider is not trusted to filter, a row whose id differs is dropped, and
 * ANY violation in ANY configured source voids the whole result.
 *
 * A source runs only when the contact has an id for that system. Nothing from
 * message text reaches a request.
 */
import { stripBidiControls, toOneLine } from '../../util/bidi.js';
import { loadContactWaSettings } from './invoice-settings.js';
import { readOwnedRows, type AccountingInvoicesDeps } from './accounting-invoices.js';
import type { SourceItem, Tier2Source } from './types.js';

const MAX_TEXT_CHARS = 2000;
const clean = (v: string): string => toOneLine(stripBidiControls(v));

export type ExternalOfSenderDeps = AccountingInvoicesDeps;

export function createExternalOfSenderSource(deps: ExternalOfSenderDeps): Tier2Source {
  return async (db, ids, signal) => {
    const items: SourceItem[] = [];
    let failed = false;
    try {
      const { externalSources } = await loadContactWaSettings(db);
      for (const source of externalSources) {
        if (signal.aborted) break;
        const id = ids.externalIds?.[source.systemId];
        if (id === undefined || id === '') continue;
        const r = await readOwnedRows(db, deps, ids, signal, source);
        if (r.ownershipViolation) return { items: [], ownershipViolation: true };
        if (r.failed === true) failed = true;
        for (const row of r.rows) {
          const text = r.fields
            .filter((f) => row[f.path] !== undefined)
            .map((f) => `${clean(f.label)}: ${clean(row[f.path] as string)}`)
            .join('\n')
            .slice(0, MAX_TEXT_CHARS);
          items.push({ source: 'external_of_sender', label: clean(r.opLabel), text, documentId: null, at: null });
        }
      }
    } catch {
      return { items: [], ownershipViolation: false, failed: true };
    }
    return failed ? { items, ownershipViolation: false, failed: true } : { items, ownershipViolation: false };
  };
}
