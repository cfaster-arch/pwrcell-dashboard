/**
 * Credential encryption at rest — AES-256-GCM via `node:crypto` (research §6).
 *
 * SERVER-ONLY. This module imports `node:crypto` / `node:fs` and must never be
 * imported from client code.
 *
 * Design (per research §6a–§6d):
 * - Symmetric AEAD (AES-256-GCM), random 96-bit nonce per encryption.
 * - The caller's `aad` (additional authenticated data) MUST be the
 *   organizationId. This binds each ciphertext to its org: a ciphertext copied
 *   from org A's row cannot be decrypted in org B's context, closing the
 *   ciphertext-swap attack.
 * - The data-encryption key (DEK) lives in a 0600 JSON key file outside the
 *   repo (default `./data/dek.key`, overridable via `DEK_FILE`), with key
 *   versioning for rotation: `{ "activeKeyId": "k1", "keys": { "k1": "<base64>" } }`.
 *   Encrypt always uses the active key; decrypt looks up the key id carried in
 *   the call, so old rows stay readable after rotation.
 * - DEK loss = encrypted credentials are unrecoverable (users re-enter them).
 *   That is the honest, bounded recovery path — never silent corruption.
 *
 * Hygiene rules this module enforces on itself:
 * - Never log plaintext or key material.
 * - Errors never include secret bytes (payloads, keys, decrypted output).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const DEK_BYTE_LENGTH = 32;
export const GCM_NONCE_BYTE_LENGTH = 12;
export const GCM_TAG_BYTE_LENGTH = 16;

/** Envelope returned by encryption. `payload` = base64(nonce || ciphertext || authTag). */
export interface EncryptedPayload {
  keyId: string;
  payload: string;
}

interface DekFileDoc {
  activeKeyId: string;
  keys: Record<string, string>;
}

interface DekSet {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

// Cached per resolved DEK_FILE path so tests can point at different files.
// A process restart (or reloadDek()) picks up on-disk rotation.
const dekCache = new Map<string, DekSet>();

/** Resolved path of the DEK key file. */
export function dekFilePath(): string {
  const raw = process.env.DEK_FILE;
  if (raw !== undefined && !raw.trim()) {
    // An explicitly-set-but-empty DEK_FILE is a misconfiguration; fail loudly
    // rather than silently using the default path (wrong key file = brick).
    throw new Error("[authn:crypto] DEK_FILE is set but empty");
  }
  return resolve(raw && raw.trim() ? raw.trim() : "./data/dek.key");
}

/** Drop the cached DEK so the next operation re-reads the key file from disk. */
export function reloadDek(): void {
  dekCache.delete(dekFilePath());
}

function fail(path: string, detail: string): never {
  // Deliberately never includes key material or file contents.
  throw new Error(`[authn:crypto] invalid DEK file at ${path}: ${detail}`);
}

function validateDekDoc(path: string, doc: unknown): DekFileDoc {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    fail(path, "top level must be an object");
  }
  const d = doc as Record<string, unknown>;
  if (typeof d.activeKeyId !== "string" || !d.activeKeyId) {
    fail(path, '"activeKeyId" must be a non-empty string');
  }
  if (typeof d.keys !== "object" || d.keys === null || Array.isArray(d.keys)) {
    fail(path, '"keys" must be an object of keyId -> base64 key');
  }
  const keys = d.keys as Record<string, unknown>;
  const ids = Object.keys(keys);
  if (ids.length === 0) fail(path, '"keys" must contain at least one key');
  // Object.hasOwn, not `in`: "toString"/"constructor" pass `in` via the
  // prototype chain but have no real entry in the keys map.
  if (!Object.hasOwn(keys, d.activeKeyId)) {
    fail(path, `activeKeyId "${d.activeKeyId}" has no entry in "keys"`);
  }
  for (const id of ids) {
    const b64 = keys[id];
    if (typeof b64 !== "string") fail(path, `key "${id}" must be a base64 string`);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64 as string, "base64");
    } catch {
      fail(path, `key "${id}" is not valid base64`);
    }
    if (bytes!.length !== DEK_BYTE_LENGTH) {
      fail(path, `key "${id}" must decode to ${DEK_BYTE_LENGTH} bytes`);
    }
    // Buffer.from(base64) is lenient (ignores invalid chars); require the
    // canonical round-trip so the stored value is exactly what we decoded.
    if (bytes!.toString("base64") !== (b64 as string)) {
      fail(path, `key "${id}" is not canonical base64`);
    }
    bytes!.fill(0);
  }
  return { activeKeyId: d.activeKeyId, keys: keys as Record<string, string> };
}

function generateDekFile(path: string): DekFileDoc {
  const key = randomBytes(DEK_BYTE_LENGTH);
  const doc: DekFileDoc = {
    activeKeyId: "k1",
    keys: { k1: key.toString("base64") },
  };
  const body = JSON.stringify(doc, null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Atomic, durable write: tmp file + fsync + rename + fsync dir, so a crash
  // or power loss mid-write can never leave a truncated/corrupt key file
  // behind (which would brick every encrypted credential on next boot).
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dirname(path), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  key.fill(0);
  console.warn(
    "[authn:crypto] *** NEW DATA-ENCRYPTION KEY GENERATED ***\n" +
      `[authn:crypto]   path: ${path}\n` +
      "[authn:crypto]   This key encrypts third-party credentials (PWRview logins).\n" +
      "[authn:crypto]   BACK IT UP NOW, separately from database backups, encrypted with the\n" +
      "[authn:crypto]   backup passphrase. Keep the file at mode 0600, owned by the service\n" +
      "[authn:crypto]   user, outside the repo. If this key is lost, encrypted credentials\n" +
      "[authn:crypto]   are UNRECOVERABLE (users must re-enter them).",
  );
  return doc;
}

function loadDekDoc(path: string): DekFileDoc {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return generateDekFile(path);
    }
    throw new Error(
      `[authn:crypto] cannot read DEK file at ${path}: ${(err as Error).message}`,
    );
  }
  // mode 0600 is only guaranteed at creation; flag a pre-existing looser file
  // loudly (it means other users on the box can read the key).
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      console.warn(
        `[authn:crypto] WARNING: DEK file at ${path} has mode ${mode.toString(8)}, ` +
          "expected 0600. Restrict it to the service user.",
      );
    }
  } catch {
    // stat failure is non-fatal; the read above already succeeded.
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    fail(path, "file is not valid JSON");
  }
  return validateDekDoc(path, doc);
}

function getDek(): DekSet {
  const path = dekFilePath();
  const cached = dekCache.get(path);
  if (cached) return cached;
  const doc = loadDekDoc(path);
  const keys = new Map<string, Buffer>();
  for (const [id, b64] of Object.entries(doc.keys)) {
    keys.set(id, Buffer.from(b64, "base64"));
  }
  const set: DekSet = { activeKeyId: doc.activeKeyId, keys };
  dekCache.set(path, set);
  return set;
}

function getKey(keyId: string): Buffer {
  const key = getDek().keys.get(keyId);
  if (!key) {
    // keyId is not secret; the key bytes themselves are never echoed.
    throw new Error(`[authn:crypto] unknown DEK id "${keyId}"`);
  }
  return key;
}

function checkAad(aad: string): void {
  // AAD must be a non-empty string; fail inside the module's error contract
  // rather than letting Buffer.from(undefined) throw a raw TypeError.
  if (typeof aad !== "string" || !aad) {
    throw new Error("[authn:crypto] aad must be a non-empty string");
  }
}

/**
 * Build the AES-GCM AAD for an org-scoped secret. The AAD binds BOTH the
 * organization and the secret's purpose (`pwrcell.password`, `ring.refresh`,
 * …): ciphertexts for different secrets of the same org are not interchangeable,
 * so a confused write or a DB-level swap cannot authenticate (security review
 * 2026-09-25 R2.3). The \0 separators make the framing unambiguous.
 */
export function orgAad(orgId: string, purpose: string): string {
  checkAad(orgId);
  checkAad(purpose);
  return `${orgId}\0${purpose}`;
}

/**
 * Encrypt a UTF-8 string. `aad` must be built with orgAad() (binds the
 * ciphertext to the org AND the secret's purpose — research §6a, hardened
 * 2026-09-25). Returns the key envelope; store both `keyId` and `payload`
 * on the credential row.
 */
export function encryptString(plaintext: string, aad: string): EncryptedPayload {
  checkAad(aad);
  const dek = getDek();
  return encryptWithKey(dek.activeKeyId, getKey(dek.activeKeyId), Buffer.from(plaintext, "utf8"), aad);
}

function encryptWithKey(
  keyId: string,
  key: Buffer,
  plaintext: Buffer,
  aad: string,
): EncryptedPayload {
  const nonce = randomBytes(GCM_NONCE_BYTE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    // The envelope names the key that actually encrypted, not just the
    // current active key — required for any rotation/re-encrypt path.
    keyId,
    payload: Buffer.concat([nonce, ciphertext, tag]).toString("base64"),
  };
}

/**
 * Encrypt raw bytes (preferred for secrets: the caller keeps a Buffer it can
 * wipe with zeroBuffer(), instead of an immutable string).
 */
export function encryptBuffer(plaintext: Buffer, aad: string): EncryptedPayload {
  checkAad(aad);
  const dek = getDek();
  return encryptWithKey(dek.activeKeyId, getKey(dek.activeKeyId), plaintext, aad);
}

function decryptToBuffer(payload: string, keyId: string, aad: string): Buffer {
  checkAad(aad);
  const key = getKey(keyId);
  const raw = Buffer.from(payload, "base64");
  if (raw.length < GCM_NONCE_BYTE_LENGTH + GCM_TAG_BYTE_LENGTH) {
    throw new Error("[authn:crypto] payload too short to be valid");
  }
  const nonce = raw.subarray(0, GCM_NONCE_BYTE_LENGTH);
  const tag = raw.subarray(raw.length - GCM_TAG_BYTE_LENGTH);
  const ciphertext = raw.subarray(GCM_NONCE_BYTE_LENGTH, raw.length - GCM_TAG_BYTE_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Authentication failure (wrong AAD/org, tampered bytes, wrong key):
    // never return partial data, never leak which check failed into the message.
    throw new Error("[authn:crypto] decryption failed: authentication error");
  }
}

/**
 * Decrypt to a UTF-8 string. Throws on authentication failure, unknown keyId,
 * or malformed payload — never returns partial data.
 */
export function decryptString(payload: string, keyId: string, aad: string): string {
  const buf = decryptToBuffer(payload, keyId, aad);
  const str = buf.toString("utf8");
  buf.fill(0);
  return str;
}

/**
 * Decrypt to a Buffer. The caller owns the returned buffer and should wipe it
 * with zeroBuffer() when done.
 */
export function decryptBuffer(payload: string, keyId: string, aad: string): Buffer {
  return decryptToBuffer(payload, keyId, aad);
}

/**
 * Best-effort wipe of secret bytes. Use for passwords/tokens held as Buffers.
 */
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

/**
 * Best-effort wipe of a secret held as a string.
 *
 * HONEST LIMITATION: JavaScript strings are immutable, so this can only zero
 * a *copy* of the string's bytes — the original string stays in memory until
 * garbage-collected and cannot be erased. Callers handling secrets should
 * prefer Buffers with encryptBuffer()/decryptBuffer()/zeroBuffer() so the
 * bytes can actually be wiped.
 */
export function zeroString(str: string): void {
  const copy = Buffer.from(str, "utf8");
  copy.fill(0);
}
