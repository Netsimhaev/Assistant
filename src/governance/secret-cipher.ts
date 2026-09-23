/**
 * Sealing and opening one secret. No database, no files, no configuration —
 * so every property below is provable without any of them.
 *
 * **The business id and the ref are authenticated, not merely stored**
 * (spec §4.4). They are passed to the cipher as additional authenticated
 * data, which means the sealed bytes are bound to the row they belong to: a
 * ciphertext lifted from one customer's row into another's fails to open
 * rather than opening wrongly.
 *
 * That gives two independent controls on the same boundary — the `WHERE`
 * clause that filters by business, and this. A dropped predicate, a wrong
 * join, a swapped parameter: the class of bug that actually happens is not
 * enough on its own to hand one customer another's secret. This is the only
 * control in the design that does not depend on our having written the
 * queries correctly, which is why it is here and not left to the store.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretAad {
  businessId: string;
  ref: string;
}

export interface Sealed {
  /** Ciphertext with the GCM tag appended. */
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * The bytes the cipher authenticates alongside the secret.
 *
 * A length-prefixed join rather than a separator, so that a business called
 * `a` with ref `B_C` and a business called `a_B` with ref `C` cannot produce
 * the same authenticated data — an ambiguity that would quietly undo the
 * binding this function exists to create.
 */
function aadBytes(aad: SecretAad): Buffer {
  return Buffer.from(
    `${aad.businessId.length}:${aad.businessId}:${aad.ref.length}:${aad.ref}`,
    'utf8',
  );
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    // Thrown, not returned as null: a short key is a broken installation, not
    // a secret that failed to open. The two must not be indistinguishable.
    throw new Error(`secret-cipher: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

export function encryptSecret(plain: string, key: Buffer, aad: SecretAad): Sealed {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aadBytes(aad));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/**
 * Returns `null` for every failure — wrong key, wrong business, wrong ref,
 * altered bytes — and never distinguishes between them to the caller.
 *
 * Deliberate: the caller's only correct response to any of them is the same
 * (`credential_unavailable`, a final failure), and a message that says WHICH
 * check failed tells whoever provoked it something about the stored row.
 * The operator's diagnosis comes from the key check at startup
 * (`master-key.ts`), which runs before any real secret is touched.
 */
export function decryptSecret(sealed: Sealed, key: Buffer, aad: SecretAad): string | null {
  assertKey(key);
  if (sealed.ciphertext.length <= TAG_BYTES) return null;
  if (sealed.nonce.length !== NONCE_BYTES) return null;

  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce);
    decipher.setAAD(aadBytes(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // `final()` throws when the tag does not verify. That is the expected
    // path for every wrong-key and wrong-row case above, not an exception.
    return null;
  }
}
