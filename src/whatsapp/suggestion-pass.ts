/**
 * The scheduler pass that turns the owner's own decisions into suggestions.
 * It only inserts rows; a suggestion changes nothing until the owner says yes.
 * Auto-reply and public-document candidates are plain SQL thresholds; only the
 * new-topic case calls the quarantined clusterer, and code does the counting.
 */
import type { BusinessDb } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { listManagedContacts } from '../memory/managed-contacts.js';
import type { ContactClusterer } from '../sdk/contact-clusterer.js';
import { listTopics } from './contact-topics.js';
import { decisionIdsCarriedByNewTopicSuggestions, insertSuggestion, shapeHashFor } from './contact-suggestions.js';
import { autoReplyCandidates, publicDocumentCandidates, unthemedDecisions } from './learning-signals.js';
import { NEW_TOPIC_MIN_DECISIONS, parseClusters } from './topic-clusters.js';

/** Audit reason prefix; counts only follow it. */
export const CLUSTER_AUDIT_REASON = 'contact_cluster';
export const CLUSTER_DEADLINE_MS = 60_000;

export interface SuggestionPassDeps {
  clusterer: ContactClusterer;
  now: Date;
  /** 0 = off. */
  clusterRunsPerDay: number;
  charterVersion: string;
}

/** Today is the server (database session) day: the charter timezone is not available to this pass. */
async function clusterRunState(db: BusinessDb): Promise<{ today: number; last: Date | null }> {
  const { rows } = await db.query<{ today: string; last: Date | null }>(
    `SELECT count(*) FILTER (WHERE at >= date_trunc('day', now())) AS today, max(at) AS last
       FROM audit_log
      WHERE business_id = $1 AND kind = 'tool_call' AND reason LIKE $2`,
    [db.businessId, `${CLUSTER_AUDIT_REASON}%`],
  );
  const r = rows[0];
  return { today: Number(r?.today ?? 0), last: r?.last ?? null };
}

export async function buildSuggestions(
  db: BusinessDb,
  deps: SuggestionPassDeps,
): Promise<{ inserted: number; clusterCalled: boolean }> {
  let inserted = 0;

  for (const c of await autoReplyCandidates(db, deps.now)) {
    const row = await insertSuggestion(
      db,
      'auto_reply',
      { topicId: c.topic.topicId, topicUpdatedAt: c.topic.updatedAt.toISOString(), right: c.right, counted: c.counted },
      shapeHashFor({ kind: 'auto_reply', topicId: c.topic.topicId, topicUpdatedAt: c.topic.updatedAt }),
    );
    if (row !== null) inserted++;
  }

  for (const c of await publicDocumentCandidates(db)) {
    const row = await insertSuggestion(
      db,
      'public_document',
      { documentId: c.documentId, appliesTo: c.appliesTo, approvals: c.approvals },
      shapeHashFor({ kind: 'public_document', documentId: c.documentId }),
    );
    if (row !== null) inserted++;
  }

  let clusterCalled = false;
  if (deps.clusterRunsPerDay > 0) {
    const state = await clusterRunState(db);
    if (state.today < deps.clusterRunsPerDay) {
      const all = await unthemedDecisions(db, deps.now);
      // The gate: enough NEW decisions since the last run to be worth a billed call.
      const fresh = state.last === null ? all : all.filter((d) => d.decidedAt > (state.last as Date));
      // What is sent: every unthemed decision in the window — older ones too, so
      // a theme that arrives slowly still reaches five — minus any decision a
      // new-topic suggestion already carried (open, accepted or rejected).
      const carried = await decisionIdsCarriedByNewTopicSuggestions(db);
      const rows = all.filter((d) => !carried.has(d.decisionId));
      if (fresh.length >= NEW_TOPIC_MIN_DECISIONS && rows.length >= NEW_TOPIC_MIN_DECISIONS) {
        // Written before the call: a billed call counts even when it fails.
        await appendAudit(db, {
          actor: 'comms.whatsapp',
          kind: 'tool_call',
          charterVersion: deps.charterVersion,
          provenance: 'unknown_external',
          inputHash: canonicalHash({ decisions: rows.length }),
          reason: `${CLUSTER_AUDIT_REASON} decisions=${rows.length}`,
        });
        clusterCalled = true;
        // Retired names too: a topic the owner retired is not re-proposed under its old name.
        const existingTopicNames = (await listTopics(db, { includeRetired: true })).map((t) => t.name);
        const contactNames = (await listManagedContacts(db)).map((c) => c.name);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CLUSTER_DEADLINE_MS);
        try {
          const outcome = await Promise.race([
            deps.clusterer({
              summaries: rows.map((d, index) => ({ index, text: d.summary })),
              existingTopicNames,
              signal: controller.signal,
            }),
            new Promise<null>((resolve) => controller.signal.addEventListener('abort', () => resolve(null))),
          ]);
          if (outcome !== null && outcome.status === 'ok') {
            for (const g of parseClusters(outcome.raw, { rows, existingTopicNames, contactNames })) {
              const row = await insertSuggestion(db, 'new_topic', g, shapeHashFor({ kind: 'new_topic', name: g.name }));
              if (row !== null) inserted++;
            }
          }
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
  return { inserted, clusterCalled };
}
