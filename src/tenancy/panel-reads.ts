/**
 * The operator panel's reads (admin-panel spec) — part of the closed list of
 * cross-business operations, on the platform pool.
 *
 * The panel shows technicians states and counts, never business content: no
 * mail, no memory, no job titles or instructions, no charter text. So every
 * query here computes its booleans and counts IN SQL and selects no content
 * column into the result. The one exception is `setupDataForPanel`, which
 * returns the data a technician typed — and only while the business has no
 * active charter; from the first signature on it answers `'locked'`.
 *
 * One more nuance (Stage D): `businessDetailForPanel` reads external-system
 * definitions — the drafts and the signed ones — into this module only to
 * parse and hash them (`externalSystemStatuses`); what it returns is ids and
 * flags. It never touches `external_events` or `external_reads`.
 *
 * The platform login is BYPASSRLS: there is no second wall under these
 * queries. Every subquery is therefore correlated on `b.business_id` (or
 * filtered by `$1`) explicitly — a missing filter here is a cross-business
 * leak, not a miss. `panel-reads.test.ts` seeds a second business to prove
 * its data never reaches the first's row, and `panel-reads-invariants.test.ts`
 * locks the exported names and the absence of content.
 */
import { withPlatform } from '../db/platform-pool.js';
import type { Queryable } from '../db/pool.js';
import { SetupPackage, type PersonEntry } from '../business/setup-package.js';
import { EXTERNAL_SYSTEM_ID, ExternalSystem, externalSecretRefs } from '../domain/external-system.js';
import { canonicalHash } from '../util/canonical.js';

export interface PanelBusinessRow {
  businessId: string;
  displayName: string;
  /** `deleting`: the rows are gone, the files not yet (migration 081). */
  status: 'active' | 'suspended' | 'deleting';
  setupState: 'setting_up' | 'live';
  basicDone: number;
  basicTotal: 4;
  /** Live connections in the active charter other than `mailbox`. Stage D placeholder: always `[]`. */
  systems: string[];
}

export interface PanelSnapshot {
  jobsLast7Days: number;
  pendingApprovals: number;
  spendTodayMinor: number;
  /** `max(job_steps.at)` — nothing records a scheduler pass per business. */
  lastActivityAt: Date | null;
  failedLast7Days: number;
}

/**
 * Where an external system stands (Stage D). `draft`: a draft whose required
 * secrets are not all saved yet, or that no longer parses; `awaiting_signature`:
 * a valid draft with every secret it needs, nothing signed; `signed`: signed,
 * with no draft or a draft equal to it; `unsigned_changes`: signed, and a draft
 * that differs.
 */
export type ExternalSystemPanelState = 'draft' | 'awaiting_signature' | 'signed' | 'unsigned_changes';

/** Flags only — never a label, an address, an operation or anything a system returned. */
export interface ExternalSystemPanelStatus {
  systemId: string;
  state: ExternalSystemPanelState;
  keySaved: boolean;
  /** `null` when the definition declares no webhook. */
  hookSaved: boolean | null;
  /** `null` unless the webhook handshake is `query_challenge`. */
  verifySaved: boolean | null;
}

export type PanelBusinessDetail = PanelBusinessRow & {
  whatsappSaved: boolean;
  bossNumberSet: boolean;
  mailboxConnected: boolean;
  ownerEnrolled: boolean;
  ownerExists: boolean;
  contactsPending: number;
  colleaguesPending: number;
  contactsConfirmed: number;
  colleaguesConfirmed: number;
  addressSet: boolean;
  logoSet: boolean;
  snapshot: PanelSnapshot;
  /** One entry per drafted or signed external system, in id order. */
  externalSystems: ExternalSystemPanelStatus[];
};

export interface PanelSetupData {
  bossWhatsapp: string | null;
  contacts: PersonEntry[];
  colleagues: PersonEntry[];
  address: string | null;
}

/** The memory `source_ref`s that mark a confirmed contact (setup, or the owner's people screen). */
const CONFIRMED_CONTACT_SOURCES = ['setup_package', 'settings_people'] as const;

/**
 * One row per business, booleans and counts only. Every subquery names
 * `b.business_id`; the `WHERE` is appended by the caller.
 */
const FACTS_SQL = `
SELECT b.business_id,
       b.display_name,
       b.status,
       (ca.charter_version IS NOT NULL) AS live,
       ((SELECT count(DISTINCT c.ref) FROM credentials c
          WHERE c.business_id = b.business_id
            AND c.ref IN ('GREEN_API_INSTANCE_ID', 'GREEN_API_TOKEN')) = 2) AS whatsapp_saved,
       EXISTS (SELECT 1 FROM setup_packages sp
                WHERE sp.business_id = b.business_id
                  AND sp.boss_whatsapp IS NOT NULL AND sp.boss_whatsapp <> '') AS package_boss,
       EXISTS (SELECT 1
                 FROM charter_versions cv
                 CROSS JOIN LATERAL jsonb_array_elements(
                   CASE WHEN jsonb_typeof(cv.charter -> 'people') = 'array'
                        THEN cv.charter -> 'people' ELSE '[]'::jsonb END) AS p(person)
                WHERE cv.business_id = b.business_id
                  AND cv.charter_version = ca.charter_version
                  AND p.person -> 'isPrincipal' = 'true'::jsonb
                  AND coalesce(p.person -> 'channels' ->> 'whatsapp', '') <> '') AS charter_boss,
       EXISTS (SELECT 1 FROM oauth_grants g
                WHERE g.business_id = b.business_id
                  AND g.system = 'mailbox' AND g.revoked_at IS NULL) AS mailbox_connected,
       coalesce((SELECT jsonb_array_length(sp.contacts) FROM setup_packages sp
                  WHERE sp.business_id = b.business_id), 0) AS contacts_pending,
       coalesce((SELECT jsonb_array_length(sp.colleagues) FROM setup_packages sp
                  WHERE sp.business_id = b.business_id), 0) AS colleagues_pending,
       (SELECT count(*) FROM memories m
         WHERE m.business_id = b.business_id
           AND m.kind = 'entity' AND m.retired_at IS NULL
           AND m.source_ref = ANY($SOURCES::text[]) AND m.provenance = 'boss') AS contacts_confirmed,
       (SELECT count(*) FROM business_colleagues bc
         WHERE bc.business_id = b.business_id) AS colleagues_confirmed
  FROM businesses b
  LEFT JOIN charter_active ca ON ca.business_id = b.business_id`;

interface FactsRow {
  business_id: string;
  display_name: string;
  status: 'active' | 'suspended' | 'deleting';
  live: boolean;
  whatsapp_saved: boolean;
  package_boss: boolean;
  charter_boss: boolean;
  mailbox_connected: boolean;
  contacts_pending: number;
  colleagues_pending: number;
  contacts_confirmed: string;
  colleagues_confirmed: string;
}

interface Facts {
  row: PanelBusinessRow;
  whatsappSaved: boolean;
  bossNumberSet: boolean;
  mailboxConnected: boolean;
  contactsPending: number;
  colleaguesPending: number;
  contactsConfirmed: number;
  colleaguesConfirmed: number;
}

function toFacts(r: FactsRow): Facts {
  const bossNumberSet = r.package_boss || r.charter_boss;
  const contactsPending = Number(r.contacts_pending);
  const colleaguesPending = Number(r.colleagues_pending);
  const contactsConfirmed = Number(r.contacts_confirmed);
  const colleaguesConfirmed = Number(r.colleagues_confirmed);
  const anyPerson = contactsPending + colleaguesPending + contactsConfirmed + colleaguesConfirmed > 0;
  const basicDone = [r.whatsapp_saved, bossNumberSet, r.mailbox_connected, anyPerson].filter(Boolean).length;
  return {
    row: {
      businessId: r.business_id,
      displayName: r.display_name,
      status: r.status,
      setupState: r.live ? 'live' : 'setting_up',
      basicDone,
      basicTotal: 4,
      systems: [],
    },
    whatsappSaved: r.whatsapp_saved,
    bossNumberSet,
    mailboxConnected: r.mailbox_connected,
    contactsPending,
    colleaguesPending,
    contactsConfirmed,
    colleaguesConfirmed,
  };
}

function factsSql(where: string): string {
  // `$SOURCES` is always the first parameter; the business filter, when any, is `$2`.
  return `${FACTS_SQL.replace('$SOURCES', '$1')} ${where}`;
}

/** Every registered business, in byte order of its id. */
export async function listBusinessesForPanel(): Promise<PanelBusinessRow[]> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<FactsRow>(factsSql('ORDER BY b.business_id COLLATE "C"'), [
      [...CONFIRMED_CONTACT_SOURCES],
    ]);
    return rows.map((r) => toFacts(r).row);
  });
}

interface DetailRow {
  owner_exists: boolean;
  owner_enrolled: boolean;
  address_set: boolean;
  logo_set: boolean;
  jobs_last_7_days: string;
  pending_approvals: string;
  spend_today_minor: string;
  last_activity_at: Date | null;
  failed_last_7_days: string;
}

/**
 * Today is the day in the active charter's time zone (UTC without one), the
 * same day the owner means by "today".
 */
const DETAIL_SQL = `
WITH tz AS (
  SELECT coalesce(
           (SELECT cv.charter -> 'identity' ->> 'timezone'
              FROM charter_active ca
              JOIN charter_versions cv ON cv.charter_version = ca.charter_version
                                      AND cv.business_id = ca.business_id
             WHERE ca.business_id = $1),
           'UTC') AS zone
)
SELECT EXISTS (SELECT 1 FROM dashboard_users u WHERE u.business_id = $1) AS owner_exists,
       EXISTS (SELECT 1 FROM dashboard_users u
                WHERE u.business_id = $1 AND u.totp_enrolled_at IS NOT NULL) AS owner_enrolled,
       EXISTS (SELECT 1 FROM business_profiles bp
                WHERE bp.business_id = $1 AND bp.address IS NOT NULL AND bp.address <> '') AS address_set,
       EXISTS (SELECT 1 FROM business_profiles bp
                WHERE bp.business_id = $1 AND bp.logo_path IS NOT NULL) AS logo_set,
       (SELECT count(*) FROM jobs j
         WHERE j.business_id = $1 AND j.created_at >= now() - interval '7 days') AS jobs_last_7_days,
       (SELECT count(*) FROM approval_requests a
         WHERE a.business_id = $1 AND a.state = 'pending') AS pending_approvals,
       (SELECT coalesce(sum(s.amount_minor), 0) FROM spend_ledger s, tz
         WHERE s.business_id = $1
           AND s.at >= (date_trunc('day', now() AT TIME ZONE tz.zone) AT TIME ZONE tz.zone)) AS spend_today_minor,
       (SELECT max(js.at) FROM job_steps js WHERE js.business_id = $1) AS last_activity_at,
       (SELECT count(*) FROM jobs j
         WHERE j.business_id = $1 AND j.phase = 'failed'
           AND j.updated_at >= now() - interval '7 days') AS failed_last_7_days`;

/** One business's states, counts and snapshot; `null` when it is not registered. */
export async function businessDetailForPanel(businessId: string): Promise<PanelBusinessDetail | null> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<FactsRow>(factsSql('WHERE b.business_id = $2'), [
      [...CONFIRMED_CONTACT_SOURCES],
      businessId,
    ]);
    const factsRow = rows[0];
    if (!factsRow) return null;
    const facts = toFacts(factsRow);

    const detail = await db.query<DetailRow>(DETAIL_SQL, [businessId]);
    const d = detail.rows[0];
    if (!d) throw new Error('panel detail query returned no row');

    return {
      ...facts.row,
      whatsappSaved: facts.whatsappSaved,
      bossNumberSet: facts.bossNumberSet,
      mailboxConnected: facts.mailboxConnected,
      ownerEnrolled: d.owner_enrolled,
      ownerExists: d.owner_exists,
      contactsPending: facts.contactsPending,
      colleaguesPending: facts.colleaguesPending,
      contactsConfirmed: facts.contactsConfirmed,
      colleaguesConfirmed: facts.colleaguesConfirmed,
      addressSet: d.address_set,
      logoSet: d.logo_set,
      snapshot: {
        jobsLast7Days: Number(d.jobs_last_7_days),
        pendingApprovals: Number(d.pending_approvals),
        spendTodayMinor: Number(d.spend_today_minor),
        lastActivityAt: d.last_activity_at,
        failedLast7Days: Number(d.failed_last_7_days),
      },
      externalSystems: await externalSystemStatuses(db, businessId),
    };
  });
}

interface ExternalDefinitionRow {
  source: 'draft' | 'signed';
  system_id: string | null;
  definition: unknown;
}

/**
 * The drafts and the active charter's signed definitions, both filtered by
 * `$1` explicitly (BYPASSRLS). The definitions are read only to be parsed and
 * hashed here; nothing of them leaves this function but flags.
 */
const EXTERNAL_DEFINITIONS_SQL = `
SELECT 'draft' AS source, d.system_id, d.definition
  FROM external_system_drafts d
 WHERE d.business_id = $1
UNION ALL
SELECT 'signed' AS source, e.def ->> 'id' AS system_id, e.def AS definition
  FROM charter_active ca
  JOIN charter_versions cv ON cv.business_id = ca.business_id AND cv.charter_version = ca.charter_version
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(cv.charter -> 'externalSystems') = 'array'
         THEN cv.charter -> 'externalSystems' ELSE '[]'::jsonb END) AS e(def)
 WHERE ca.business_id = $1`;

/** The parsed definition, or `null` for one that no longer parses. */
function parsedOrNull(definition: unknown): ExternalSystem | null {
  const parsed = ExternalSystem.safeParse(definition);
  return parsed.success ? parsed.data : null;
}

/**
 * "Unsigned changes" is decided on the canonical hash of the PARSED
 * definitions, so key order and an omitted default are not a change. A
 * definition that does not parse is hashed raw — it can never equal a signed
 * one, which always parses.
 */
function definitionHash(definition: unknown): string {
  const parsed = parsedOrNull(definition);
  return parsed === null ? canonicalHash({ unparsed: definition }) : canonicalHash(parsed);
}

async function externalSystemStatuses(db: Queryable, businessId: string): Promise<ExternalSystemPanelStatus[]> {
  const definitions = await db.query<ExternalDefinitionRow>(EXTERNAL_DEFINITIONS_SQL, [businessId]);
  const secrets = await db.query<{ ref: string }>(
    `SELECT ref FROM credentials WHERE business_id = $1 AND starts_with(ref, 'EXT_')`,
    [businessId],
  );
  const saved = new Set(secrets.rows.map((r) => r.ref));

  const drafts = new Map<string, unknown>();
  const signed = new Map<string, unknown>();
  for (const row of definitions.rows) {
    // Positive: only a well-formed id is ever returned — never free text from a row written elsewhere.
    if (row.system_id === null || !EXTERNAL_SYSTEM_ID.test(row.system_id)) continue;
    (row.source === 'draft' ? drafts : signed).set(row.system_id, row.definition);
  }

  const ids = [...new Set([...drafts.keys(), ...signed.keys()])].sort();
  return ids.map((systemId) => {
    const refs = externalSecretRefs(systemId);
    const draft = drafts.has(systemId) ? parsedOrNull(drafts.get(systemId)) : null;
    const current = draft ?? (signed.has(systemId) ? parsedOrNull(signed.get(systemId)) : null);
    const keySaved = saved.has(refs.key);
    const hookSaved = current?.webhook ? saved.has(refs.hook) : null;
    const verifySaved = current?.webhook?.handshake?.kind === 'query_challenge' ? saved.has(refs.verify) : null;

    let state: ExternalSystemPanelState;
    if (signed.has(systemId)) {
      const unchanged =
        !drafts.has(systemId) || definitionHash(drafts.get(systemId)) === definitionHash(signed.get(systemId));
      state = unchanged ? 'signed' : 'unsigned_changes';
    } else {
      const ready = draft !== null && keySaved && hookSaved !== false && verifySaved !== false;
      state = ready ? 'awaiting_signature' : 'draft';
    }
    return { systemId, state, keySaved, hookSaved, verifySaved };
  });
}

interface SetupRow {
  locked: boolean;
  boss_whatsapp: string | null;
  contacts: unknown;
  colleagues: unknown;
  address: string | null;
}

/**
 * The data a technician typed for a business that has not signed yet — the
 * only read here that returns typed text. `'locked'` once a charter is
 * active: from then on the panel shows only "set/missing" and counts. The
 * lock and the data are read in one statement, so no install can land
 * between the check and the read.
 */
export async function setupDataForPanel(businessId: string): Promise<PanelSetupData | 'locked'> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<SetupRow>(
      `SELECT EXISTS (SELECT 1 FROM charter_active ca WHERE ca.business_id = $1) AS locked,
              sp.boss_whatsapp, sp.contacts, sp.colleagues, bp.address
         FROM (SELECT 1) AS one
         LEFT JOIN setup_packages sp ON sp.business_id = $1
         LEFT JOIN business_profiles bp ON bp.business_id = $1`,
      [businessId],
    );
    const row = rows[0];
    if (!row) throw new Error('panel setup query returned no row');
    if (row.locked) return 'locked';
    // Parsed, not cast: a row written outside `saveSetupPackage` is refused loudly.
    const pkg = SetupPackage.parse({
      bossWhatsapp: row.boss_whatsapp,
      contacts: row.contacts ?? [],
      colleagues: row.colleagues ?? [],
    });
    return {
      bossWhatsapp: pkg.bossWhatsapp,
      contacts: pkg.contacts,
      colleagues: pkg.colleagues,
      address: row.address,
    };
  });
}
