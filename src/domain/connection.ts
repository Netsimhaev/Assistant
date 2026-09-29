import { z } from 'zod';
import { CREDENTIAL_REF_PATTERN } from '../orchestrator/credentials.js';

/** The two ways an action can reach the outside world. */
export const CONNECTION_CHANNELS = ['api', 'browser'] as const;

/**
 * A connection the owner has signed for.
 *
 * `channel` is the load-bearing field. "Use the browser when there is no API"
 * is a decision about how much authority to hand out, and it is signed here
 * per system rather than made at run time — a page an attacker wrote must not
 * be able to argue the system into the stronger channel.
 */
export const CharterConnection = z.object({
  system: z.string().min(1),
  /** What the owner reads in the plain-language charter. */
  label: z.string().min(1),
  channel: z.enum(CONNECTION_CHANNELS),
  /** Internal tool names this connection serves. */
  serves: z.array(z.string().min(1)).min(1),
  /** A specific counterparty or supplier, or null for every target. */
  target: z.string().min(1).nullable(),
  /** Third party that processes the payload on the way out; null is direct. */
  subprocessor: z.string().nullable(),
});
export type CharterConnection = z.infer<typeof CharterConnection>;

/** The operational half: whether a permitted connection currently works. */
export const ConnectionBinding = z.object({
  system: z.string().min(1),
  status: z.enum(['live', 'disconnected', 'error']),
  endpoint: z.string().nullable(),
  /**
   * A POINTER to a secret. Never the secret. Must match
   * CREDENTIAL_REF_PATTERN (uppercase letters, digits, underscores) so a
   * misspelled ref is refused when the binding is written, rather than
   * reading as credentialled and failing only at execution with nothing
   * distinguishing "the ref is misspelled" from "the environment variable
   * is missing".
   */
  credentialRef: z.string().regex(CREDENTIAL_REF_PATTERN).nullable(),
  /**
   * Which vendor's code runs this system, or `null` for a connection served
   * by an env-configured adapter (the mail transport) rather than a
   * registered provider. Operational, like `endpoint` beside it: the
   * charter decides whether the system exists, on which channel, and which
   * tools it serves -- this only says whose code runs. `runtime.ts` reads
   * it, alongside the charter's own `channel` for the same system, to
   * decide which provider-specific adapter (if any) to register.
   */
  provider: z.string().min(1).nullable(),
  lastOkAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type ConnectionBinding = z.infer<typeof ConnectionBinding>;
