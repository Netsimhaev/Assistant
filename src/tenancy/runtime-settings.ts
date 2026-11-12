/**
 * A business's runtime settings — what `buildRuntime` used to read from the
 * process environment, one row per business (spec §5.4).
 *
 * **No row means every channel off.** No approval email, no WhatsApp, no
 * inbox: everything that costs money or leaves the server is a switch the
 * owner turns on, never a default. The same rule `DOCUMENT_INBOX` already
 * stated ("a switch, not only an address").
 *
 * **A daily cap is NULL or a number, and the two mean different things.**
 * NULL is "the server's default" (`config.ts`, from the environment); a
 * stored number — 0 included — is this business's own value. `capFor` is the
 * one place that tells them apart, so no consumer can read a stored 0 as
 * "unset" by writing `||` instead of `??`.
 *
 * No secret lives here. The SMTP password stays in the business's own
 * encrypted `credentials` under the fixed ref `NOTIFY_SMTP_PASS`.
 */
import { config } from '../config.js';
import { transaction } from '../db/pool.js';
import type { BusinessDb } from '../db/pool.js';

/** The daily caps a business may override, by their `config` names. */
export const CAP_NAMES = [
  'documentReadsPerDay',
  'documentsPerDay',
  'mailReadsPerDay',
  'mailCurationPerDay',
  'curationRunsPerDay',
  'delegationsPerDay',
  'ledgerNudgesPerDay',
  'whatsappTranscribeBossPerDay',
  'whatsappTranscribeOtherPerDay',
  'whatsappInstructionsPerDay',
  'whatsappQuestionWindowMinutes',
  'whatsappMaxAudioSeconds',
] as const;
export type CapName = (typeof CAP_NAMES)[number];

/**
 * Each cap's column, which is its environment variable in snake case. Written
 * out rather than derived, so a renamed `config` key fails to compile here
 * instead of quietly reading a column that does not exist.
 */
export const CAP_COLUMNS: Readonly<Record<CapName, string>> = {
  documentReadsPerDay: 'document_reads_per_day',
  documentsPerDay: 'documents_per_day',
  mailReadsPerDay: 'mail_reads_per_day',
  mailCurationPerDay: 'mail_curation_per_day',
  curationRunsPerDay: 'curation_runs_per_day',
  delegationsPerDay: 'delegations_per_day',
  ledgerNudgesPerDay: 'ledger_nudges_per_day',
  whatsappTranscribeBossPerDay: 'whatsapp_transcribe_boss_per_day',
  whatsappTranscribeOtherPerDay: 'whatsapp_transcribe_other_per_day',
  whatsappInstructionsPerDay: 'whatsapp_instructions_per_day',
  whatsappQuestionWindowMinutes: 'whatsapp_question_window_minutes',
  whatsappMaxAudioSeconds: 'whatsapp_max_audio_seconds',
};

export interface RuntimeSettings {
  notifyTo: string | null;
  notifySmtpHost: string | null;
  notifySmtpPort: number | null;
  notifySmtpSecure: boolean | null;
  notifySmtpFrom: string | null;
  notifySmtpUser: string | null;
  notifySmtpAllowCleartext: boolean;
  mailSystem: string | null;
  whatsappEnabled: boolean;
  inboxEnabled: boolean;
  /** NULL = the server's default; see `capFor`. */
  caps: Readonly<Record<CapName, number | null>>;
}

/** What `saveRuntimeSettings` changes: every field optional, `null` clears it. */
export type RuntimeSettingsPatch = Partial<Omit<RuntimeSettings, 'caps'>> & {
  caps?: Partial<Record<CapName, number | null>>;
};

/** A refusal over a value, meant for the operator; the message is Hebrew. */
export class RuntimeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSettingsError';
  }
}

function noCaps(): Record<CapName, number | null> {
  const caps = {} as Record<CapName, number | null>;
  for (const name of CAP_NAMES) caps[name] = null;
  return caps;
}

/** Every channel off and every cap at the server default — a business with no row. */
export function defaultRuntimeSettings(): RuntimeSettings {
  return {
    notifyTo: null,
    notifySmtpHost: null,
    notifySmtpPort: null,
    notifySmtpSecure: null,
    notifySmtpFrom: null,
    notifySmtpUser: null,
    notifySmtpAllowCleartext: false,
    mailSystem: null,
    whatsappEnabled: false,
    inboxEnabled: false,
    caps: noCaps(),
  };
}

interface SettingsRow {
  notify_to: string | null;
  notify_smtp_host: string | null;
  notify_smtp_port: number | null;
  notify_smtp_secure: boolean | null;
  notify_smtp_from: string | null;
  notify_smtp_user: string | null;
  notify_smtp_allow_cleartext: boolean;
  mail_system: string | null;
  whatsapp_enabled: boolean;
  inbox_enabled: boolean;
  [cap: string]: unknown;
}

function toRuntimeSettings(row: SettingsRow): RuntimeSettings {
  const caps = noCaps();
  for (const name of CAP_NAMES) {
    const value = row[CAP_COLUMNS[name]];
    caps[name] = typeof value === 'number' ? value : null;
  }
  return {
    notifyTo: row.notify_to,
    notifySmtpHost: row.notify_smtp_host,
    notifySmtpPort: row.notify_smtp_port,
    notifySmtpSecure: row.notify_smtp_secure,
    notifySmtpFrom: row.notify_smtp_from,
    notifySmtpUser: row.notify_smtp_user,
    notifySmtpAllowCleartext: row.notify_smtp_allow_cleartext,
    mailSystem: row.mail_system,
    whatsappEnabled: row.whatsapp_enabled,
    inboxEnabled: row.inbox_enabled,
    caps,
  };
}

const COLUMNS = [
  'notify_to',
  'notify_smtp_host',
  'notify_smtp_port',
  'notify_smtp_secure',
  'notify_smtp_from',
  'notify_smtp_user',
  'notify_smtp_allow_cleartext',
  'mail_system',
  'whatsapp_enabled',
  'inbox_enabled',
  ...CAP_NAMES.map((name) => CAP_COLUMNS[name]),
] as const;

/** This business's settings; with no row, `defaultRuntimeSettings()`. */
export async function loadRuntimeSettings(db: BusinessDb): Promise<RuntimeSettings> {
  const { rows } = await db.query<SettingsRow>(
    `SELECT ${COLUMNS.join(', ')} FROM business_runtime_settings WHERE business_id = $1`,
    [db.businessId],
  );
  const row = rows[0];
  return row === undefined ? defaultRuntimeSettings() : toRuntimeSettings(row);
}

/**
 * The cap in force for this business: its own value, or the server's default
 * when it has none. `??` and not `||` — a stored 0 is the owner turning the
 * feature off, and it must stay 0.
 */
export function capFor(settings: RuntimeSettings, name: CapName): number {
  return settings.caps[name] ?? config[name];
}

/** `''` and whitespace are "unset" — the same rule `buildRuntime` applied to env values. */
function text(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function assertCap(name: CapName, value: number | null): void {
  if (value === null) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new RuntimeSettingsError(`התקרה ${name} חייבת להיות מספר שלם אי-שלילי (התקבל: ${value})`);
  }
}

function assertPort(value: number | null): void {
  if (value === null) return;
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new RuntimeSettingsError(`פורט SMTP חייב להיות מספר שלם בין 1 ל-65535 (התקבל: ${value})`);
  }
}

/**
 * Change some of this business's settings and return the row as it now
 * stands. Fields the patch omits keep their stored value; `null` clears one.
 *
 * Read-modify-write under `FOR UPDATE`, in one transaction, so two saves at
 * once cannot each keep a field the other just changed.
 */
export async function saveRuntimeSettings(
  db: BusinessDb,
  patch: RuntimeSettingsPatch,
): Promise<RuntimeSettings> {
  if (patch.notifySmtpPort !== undefined) assertPort(patch.notifySmtpPort);
  for (const [name, value] of Object.entries(patch.caps ?? {}) as Array<[CapName, number | null]>) {
    if (!(CAP_NAMES as readonly string[]).includes(name)) {
      throw new RuntimeSettingsError(`תקרה לא מוכרת: ${name}`);
    }
    assertCap(name, value);
  }

  return transaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO business_runtime_settings (business_id) VALUES ($1)
       ON CONFLICT (business_id) DO NOTHING`,
      [tx.businessId],
    );
    const { rows } = await tx.query<SettingsRow>(
      `SELECT ${COLUMNS.join(', ')} FROM business_runtime_settings WHERE business_id = $1 FOR UPDATE`,
      [tx.businessId],
    );
    const current = rows[0] === undefined ? defaultRuntimeSettings() : toRuntimeSettings(rows[0]);
    const next: RuntimeSettings = {
      notifyTo: text(patch.notifyTo !== undefined ? patch.notifyTo : current.notifyTo),
      notifySmtpHost: text(patch.notifySmtpHost !== undefined ? patch.notifySmtpHost : current.notifySmtpHost),
      notifySmtpPort: patch.notifySmtpPort !== undefined ? patch.notifySmtpPort : current.notifySmtpPort,
      notifySmtpSecure: patch.notifySmtpSecure !== undefined ? patch.notifySmtpSecure : current.notifySmtpSecure,
      notifySmtpFrom: text(patch.notifySmtpFrom !== undefined ? patch.notifySmtpFrom : current.notifySmtpFrom),
      notifySmtpUser: text(patch.notifySmtpUser !== undefined ? patch.notifySmtpUser : current.notifySmtpUser),
      notifySmtpAllowCleartext: patch.notifySmtpAllowCleartext ?? current.notifySmtpAllowCleartext,
      mailSystem: text(patch.mailSystem !== undefined ? patch.mailSystem : current.mailSystem),
      whatsappEnabled: patch.whatsappEnabled ?? current.whatsappEnabled,
      inboxEnabled: patch.inboxEnabled ?? current.inboxEnabled,
      caps: { ...current.caps, ...(patch.caps ?? {}) },
    };

    const values: unknown[] = [
      next.notifyTo,
      next.notifySmtpHost,
      next.notifySmtpPort,
      next.notifySmtpSecure,
      next.notifySmtpFrom,
      next.notifySmtpUser,
      next.notifySmtpAllowCleartext,
      next.mailSystem,
      next.whatsappEnabled,
      next.inboxEnabled,
      ...CAP_NAMES.map((name) => next.caps[name]),
    ];
    const assignments = COLUMNS.map((column, i) => `${column} = $${i + 2}`).join(', ');
    await tx.query(
      `UPDATE business_runtime_settings SET ${assignments}, updated_at = now() WHERE business_id = $1`,
      [tx.businessId, ...values],
    );
    return next;
  });
}
