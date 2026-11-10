// Phase 12.1 — field-level encryption for the one kind of value AthletixOS
// stores that would be identity theft if it leaked: a tax identification
// number.
//
// Design approved by Julian; written up in docs/accounting/plan.md under
// "1099 — the TIN question".
//
// ── THE RULES THIS MODULE EXISTS TO ENFORCE ─────────────────────────────────
//
//  1. AES-256-GCM. Authenticated, so a tampered value fails to decrypt rather
//     than returning plausible nonsense.
//  2. A fresh random 12-byte IV per value. Never a fixed or derived one: with
//     GCM, reusing an IV under the same key is catastrophic — it leaks the
//     XOR of the plaintexts and the authentication subkey.
//  3. NO PLAINTEXT FALLBACK, EVER. If the key is missing, `encryptField`
//     throws and the caller refuses to save. A value this sensitive landing in
//     the database readable because an environment variable was forgotten is
//     the exact failure this module is here to prevent.
//  4. Nothing here logs. No console call, no error carrying the value, no
//     value in a stack trace. `FieldCryptoError` messages are deliberately
//     about the KEY and the FORMAT, never the data.
//  5. Key rotation is built in. The stored value names the key that wrote it,
//     so a new key can take over encryption while old values stay readable.
//
// ── THE STORED FORMAT ───────────────────────────────────────────────────────
//
//     v1:<keyId>:<iv>:<ciphertext>:<tag>
//
// `v1` is the algorithm/format version — AES-256-GCM, 12-byte IV, 16-byte tag.
// A future `v2` can change any of that without guessing how old values were
// written. `keyId` says WHICH key encrypted it.
//
// The three payload fields are standard base64. Base64's alphabet is
// A–Z a–z 0–9 + / = and contains no colon, so splitting on ":" is unambiguous
// — which is why keyIds are restricted to a colon-free character set below.
//
// ── OPERATING IT ────────────────────────────────────────────────────────────
//
// Generate a key:        openssl rand -base64 32
// Set it:                FIELD_ENCRYPTION_KEY="1:<that base64>"
// Rotate:                move the old value into
//                        FIELD_ENCRYPTION_KEYS_RETIRED="1:<old base64>"
//                        and set FIELD_ENCRYPTION_KEY="2:<new base64>"
//
// ⚠️  A LOST KEY MEANS THE STORED TINs CAN NEVER BE READ AGAIN. There is no
//     recovery, by design — that is what makes the ciphertext worth anything.
//     Keep a copy in a password manager.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/// Colon-free so the format stays splittable; short so a stored value stays
/// readable in a psql dump when somebody is debugging the shape (never the
/// content).
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

export const FIELD_KEY_ENV = "FIELD_ENCRYPTION_KEY";
export const FIELD_RETIRED_KEYS_ENV = "FIELD_ENCRYPTION_KEYS_RETIRED";

/// Thrown for every failure. The message NEVER contains the value, the key, or
/// any part of either — it is about configuration and format only, because
/// these messages reach logs and error reporters.
export class FieldCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldCryptoError";
  }
}

type FieldKey = { id: string; key: Buffer };

/// Parses `"<id>:<base64>"`, or a bare `"<base64>"` which is treated as id
/// "1" so a first-time setup needs no ceremony.
function parseKey(raw: string, envName: string): FieldKey {
  const trimmed = raw.trim();
  if (!trimmed) throw new FieldCryptoError(`${envName} is empty.`);

  const colon = trimmed.indexOf(":");
  const id = colon === -1 ? "1" : trimmed.slice(0, colon);
  const b64 = colon === -1 ? trimmed : trimmed.slice(colon + 1);

  if (!KEY_ID_RE.test(id)) {
    throw new FieldCryptoError(
      `${envName} has an invalid key id. Use letters, digits, underscore or hyphen, up to 16 characters — for example "2:<base64 key>".`,
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(b64, "base64");
  } catch {
    throw new FieldCryptoError(`${envName} is not valid base64. Generate one with: openssl rand -base64 32`);
  }
  if (key.length !== KEY_BYTES) {
    // The LENGTH is safe to state; it is the single most common setup mistake
    // and saying so turns a mystery into a fix.
    throw new FieldCryptoError(
      `${envName} must be exactly ${KEY_BYTES} bytes once base64-decoded (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return { id, key };
}

/// The key new values are encrypted with, or null when none is configured.
function activeKey(): FieldKey | null {
  const raw = process.env[FIELD_KEY_ENV];
  if (!raw || !raw.trim()) return null;
  return parseKey(raw, FIELD_KEY_ENV);
}

/// Every key that can DECRYPT: the active one plus any retired ones, so a
/// rotation does not strand existing values.
function decryptionKeys(): FieldKey[] {
  const keys: FieldKey[] = [];
  const active = activeKey();
  if (active) keys.push(active);

  const retired = process.env[FIELD_RETIRED_KEYS_ENV];
  if (retired && retired.trim()) {
    for (const part of retired.split(",")) {
      if (!part.trim()) continue;
      const k = parseKey(part, FIELD_RETIRED_KEYS_ENV);
      // A retired key sharing the active id would silently shadow it.
      if (!keys.some((x) => x.id === k.id)) keys.push(k);
    }
  }
  return keys;
}

/// Whether a TIN can be saved at all. Routes call this to refuse BEFORE
/// collecting the value, so a contractor is never asked to type a tax id the
/// app cannot store safely.
export function fieldCryptoConfigured(): boolean {
  try {
    return activeKey() !== null;
  } catch {
    // A present but malformed key is NOT "configured". Saying otherwise would
    // let a route collect a TIN and then fail at the write.
    return false;
  }
}

/// Describes the configuration for a diagnostics screen. Reports the key's ID
/// and whether it parses — never the key.
export function fieldCryptoStatus(): {
  configured: boolean;
  activeKeyId: string | null;
  retiredKeyIds: string[];
  problem: string | null;
} {
  try {
    const active = activeKey();
    const retired = decryptionKeys().filter((k) => k.id !== active?.id);
    return {
      configured: active !== null,
      activeKeyId: active?.id ?? null,
      retiredKeyIds: retired.map((k) => k.id),
      problem: active ? null : `${FIELD_KEY_ENV} is not set.`,
    };
  } catch (e) {
    return {
      configured: false,
      activeKeyId: null,
      retiredKeyIds: [],
      problem: e instanceof FieldCryptoError ? e.message : "The encryption key could not be read.",
    };
  }
}

export function isEncryptedField(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split(":");
  return parts.length === 5 && parts[0] === FORMAT && KEY_ID_RE.test(parts[1]);
}

/// Encrypts a value for storage. THROWS when no key is configured — there is
/// no plaintext path out of this function.
export function encryptField(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new FieldCryptoError("There is nothing to encrypt.");
  }
  if (plaintext.length > 4096) {
    // A tax id is nine digits. Anything near this is a bug or an attack, and a
    // cap keeps a single row from becoming a denial-of-service.
    throw new FieldCryptoError("That value is too long to store encrypted.");
  }
  const k = activeKey();
  if (!k) {
    throw new FieldCryptoError(
      `${FIELD_KEY_ENV} is not set, so this value cannot be stored. It is never stored unencrypted. Generate a key with: openssl rand -base64 32`,
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, k.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [FORMAT, k.id, iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(":");
}

/// Decrypts a stored value. THROWS on a missing key, an unknown key id, a bad
/// format, or a failed authentication tag.
///
/// Every caller of this is expected to have audited the read first — see
/// lib/contractorTin.ts, which is the only module that calls it.
export function decryptField(stored: string): string {
  if (typeof stored !== "string" || !stored) {
    throw new FieldCryptoError("There is nothing to decrypt.");
  }
  const parts = stored.split(":");
  if (parts.length !== 5 || parts[0] !== FORMAT) {
    throw new FieldCryptoError(
      `That stored value is not in the ${FORMAT} format this version can read. It may have been written by a newer release.`,
    );
  }
  const [, keyId, ivB64, ctB64, tagB64] = parts;
  if (!KEY_ID_RE.test(keyId)) throw new FieldCryptoError("That stored value names an invalid key id.");

  const keys = decryptionKeys();
  if (keys.length === 0) {
    throw new FieldCryptoError(`${FIELD_KEY_ENV} is not set, so stored values cannot be read.`);
  }
  const k = keys.find((x) => x.id === keyId);
  if (!k) {
    // Naming the id is safe and is the only way an operator can tell which key
    // they are missing. A rotation that dropped the old key lands here.
    throw new FieldCryptoError(
      `No encryption key with id "${keyId}" is configured. If the key was rotated, keep the previous one in ${FIELD_RETIRED_KEYS_ENV} so existing values stay readable.`,
    );
  }

  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new FieldCryptoError("That stored value is malformed.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, k.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // The underlying error is swallowed ON PURPOSE: node's GCM failure can
    // include buffer contents, and this message goes to logs.
    throw new FieldCryptoError(
      "That stored value could not be decrypted. Either the wrong key is configured or the value was altered.",
    );
  }
}

/// True when `stored` was written by a key other than the active one — what a
/// rotation script would use to find rows still to re-encrypt.
export function needsReencryption(stored: string): boolean {
  if (!isEncryptedField(stored)) return false;
  const active = (() => {
    try {
      return activeKey();
    } catch {
      return null;
    }
  })();
  if (!active) return false;
  return stored.split(":")[1] !== active.id;
}
