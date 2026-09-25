/**
 * Per-organization PWRview (Generac) credentials (Phase 2).
 *
 * Passwords are stored AES-256-GCM encrypted with the org id AND the secret's
 * purpose as authenticated additional data (orgAad): ciphertext from one org,
 * or for a different secret of the same org, cannot be decrypted here.
 * See src/lib/authn/crypto.server.ts.
 *
 * Legacy migration: the first read for the default org falls back to the
 * single-tenant dashboard.env (GENERAC_EMAIL / GENERAC_PASSWORD). When present
 * the credentials are encrypted into org_credentials and the plaintext keys
 * are removed from dashboard.env (only after the DB round-trip verifies).
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSql } from "@/lib/db";
import { decryptString, encryptString, orgAad } from "@/lib/authn/crypto.server";
import { DEFAULT_ORG_ID } from "@/lib/org-settings.server";

/**
 * NOTE (security): these functions take a verified `orgId` and do NOT
 * re-check membership — the AES-GCM AAD binds ciphertext to the org
 * (integrity), it does not authorize the caller. Every route/server
 * function must resolve orgId via requireOrgApi()/requireOrgServerFn()
 * BEFORE calling in. Never pass a client-supplied org id.
 */

const ENV_FILE = join(process.cwd(), "dashboard.env");

export interface OrgCredentials {
  email: string;
  password: string;
}

let legacyMigrated = false;

const LEGACY_KEYS = new Set(["GENERAC_EMAIL", "GENERAC_PASSWORD"]);

function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * Remove only the legacy credential lines from the raw env text, preserving
 * comments, blank lines, `export` prefixes, and every other variable exactly
 * (security review 2026-09-25 R2.5 — the old parse/re-serialize dropped them).
 */
function stripLegacyCredentialLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const m = line.match(/^(?:export\s+)?([A-Za-z0-9_]+)=/);
      return !(m && LEGACY_KEYS.has(m[1]));
    })
    .join("\n");
}

/** Atomic file replace: temp file + rename, so a crash can't truncate in place. */
async function atomicWriteFile(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/**
 * One-time migration of the legacy single-tenant dashboard.env credentials
 * into the encrypted org_credentials row for the default org. Idempotent:
 * once a row exists it never runs again. Best-effort: failures are logged and
 * the caller falls through to "not configured".
 *
 * The `legacyMigrated` flag is set only after a fully verified success, so a
 * transient failure retries on the next call (security review 2026-09-25 R2.8).
 */
async function migrateLegacyCredentials(orgId: string): Promise<void> {
  if (legacyMigrated || orgId !== DEFAULT_ORG_ID) return;
  if (!existsSync(ENV_FILE)) return;
  try {
    const sql = await getSql();
    const existing = await sql`select 1 as one from org_credentials where org_id = ${orgId}`;
    if (existing.length > 0) {
      legacyMigrated = true;
      return;
    }

    const raw = await readFile(ENV_FILE, "utf8");
    const vars = parseEnvFile(raw);
    const email = (vars.get("GENERAC_EMAIL") ?? "").trim();
    let password = vars.get("GENERAC_PASSWORD") ?? "";
    const m = password.match(/^"(.*)"$/s);
    if (m) password = m[1];
    if (!email || !password) return;

    const enc = encryptString(password, orgAad(orgId, "pwrcell.password"));
    await sql`
      insert into org_credentials (org_id, email, password_enc, key_id)
      values (${orgId}, ${email}, ${enc.payload}, ${enc.keyId})
      on conflict (org_id) do nothing`;

    // Verify the round-trip before touching the plaintext file.
    const back = await sql<{ email: string; password_enc: string; key_id: string }>`
      select email, password_enc, key_id from org_credentials where org_id = ${orgId}`;
    const row = back[0];
    if (!row || row.email !== email || decryptString(row.password_enc, row.key_id, orgAad(orgId, "pwrcell.password")) !== password) {
      console.warn("[org-credentials] legacy migration: DB round-trip failed, keeping dashboard.env");
      return;
    }

    await atomicWriteFile(ENV_FILE, stripLegacyCredentialLines(raw));
    legacyMigrated = true;
    console.info("[org-credentials] migrated legacy dashboard.env credentials to encrypted storage");
  } catch (err) {
    console.warn("[org-credentials] legacy migration failed:", err);
  }
}

/** Full credentials for an org, or null when none are configured. */
export async function getOrgCredentials(orgId: string): Promise<OrgCredentials | null> {
  await migrateLegacyCredentials(orgId);
  const sql = await getSql();
  const rows = await sql<{ email: string; password_enc: string; key_id: string }>`
    select email, password_enc, key_id from org_credentials where org_id = ${orgId}`;
  if (rows.length === 0) return null;
  const { email, password_enc, key_id } = rows[0];
  return { email, password: decryptString(password_enc, key_id, orgAad(orgId, "pwrcell.password")) };
}

/** Never includes the password — only whether credentials exist + the email. */
export async function getOrgCredentialMeta(
  orgId: string,
): Promise<{ configured: boolean; email: string | null }> {
  const email = await getOrgCredentialEmail(orgId);
  return { configured: email !== null, email };
}

/** True when the org has a credentials row (no decryption performed). */
export async function orgCredentialsConfigured(orgId: string): Promise<boolean> {
  await migrateLegacyCredentials(orgId);
  const sql = await getSql();
  const rows = await sql`select 1 as one from org_credentials where org_id = ${orgId}`;
  return rows.length > 0;
}

/** Configured email for display, without touching the password. */
export async function getOrgCredentialEmail(orgId: string): Promise<string | null> {
  await migrateLegacyCredentials(orgId);
  const sql = await getSql();
  const rows = await sql<{ email: string }>`
    select email from org_credentials where org_id = ${orgId}`;
  return rows[0]?.email ?? null;
}

/** Store (or replace) an org's PWRview credentials, encrypted at rest. */
export async function setOrgCredentials(orgId: string, email: string, password: string): Promise<void> {
  if (!email.trim() || !password) throw new Error("email and password are required");
  const enc = encryptString(password, orgAad(orgId, "pwrcell.password"));
  const sql = await getSql();
  await sql`
    insert into org_credentials (org_id, email, password_enc, key_id)
    values (${orgId}, ${email.trim()}, ${enc.payload}, ${enc.keyId})
    on conflict (org_id) do update
      set email = excluded.email,
          password_enc = excluded.password_enc,
          key_id = excluded.key_id,
          updated_at = now()`;
}

/** Remove an org's PWRview credentials. */
export async function clearOrgCredentials(orgId: string): Promise<void> {
  const sql = await getSql();
  await sql`delete from org_credentials where org_id = ${orgId}`;
}
