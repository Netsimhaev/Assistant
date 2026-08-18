import type { BusinessCharter, UnsignedCharter } from '../domain/charter.js';
import { canonicalHash } from '../util/canonical.js';

/**
 * The content hash covers the charter *excluding* its own signature block —
 * otherwise the hash would have to contain itself.
 */
export function charterContentHash(charter: UnsignedCharter): string {
  return canonicalHash(charter);
}

export interface SignatureInput {
  signedByPersonId: string;
  method: 'dashboard_click' | 'e_sign' | 'signed_pdf';
  signedAt?: Date;
}

/**
 * Attach a signature to an unsigned charter.
 *
 * The owner signs the plain-language rendering, not the JSON — but what gets
 * hashed is the JSON, so the two must be produced from the same object. Render
 * the prose from the same value you pass here (docs/04-charter.md).
 */
export function signCharter(
  charter: UnsignedCharter,
  input: SignatureInput,
): BusinessCharter {
  return {
    ...charter,
    signature: {
      signedByPersonId: input.signedByPersonId,
      signedAt: (input.signedAt ?? new Date()).toISOString(),
      method: input.method,
      contentHash: charterContentHash(charter),
    },
  };
}

export type VerificationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Verify a charter has not been altered since it was signed.
 *
 * `SessionStart` refuses to start an agent when this fails, and the gate
 * refuses to act on a charter whose version does not match the active one.
 * A charter that fails here is not "suspicious" — it is unusable.
 */
export function verifyCharterSignature(charter: BusinessCharter): VerificationResult {
  const { signature, ...unsigned } = charter;
  const expected = charterContentHash(unsigned as UnsignedCharter);

  if (expected !== signature.contentHash) {
    return {
      valid: false,
      reason:
        `charter ${charter.charterVersion} does not match its signature: ` +
        `signed ${signature.contentHash.slice(0, 12)}…, computed ${expected.slice(0, 12)}…`,
    };
  }
  return { valid: true };
}
