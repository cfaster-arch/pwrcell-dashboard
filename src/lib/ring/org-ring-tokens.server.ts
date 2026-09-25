/**
 * Per-organization Ring refresh tokens (Phase 2).
 *
 * Stored AES-256-GCM encrypted with the org id AND the secret's purpose as
 * authenticated additional data (orgAad), same pattern as PWRview credentials.
 * Replaces the global RING_REFRESH_TOKEN in dashboard.env.
 *
 * Legacy migration: the first read for the default org falls back to
 * dashboard.env's RING_REFRESH_TOKEN, encrypts it into org_ring_tokens, and
 * removes the plaintext key from the file (only after the DB round-trip
 * verifies).
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

let legacyMigrated = false;

/** Atomic file replace: temp file + rename, so a crash can't truncate in place. */
async function atomicWriteFile(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Remove only the RING_REFRESH_TOKEN line from the raw env text, preserving
 * comments, blank lines, `export` prefixes, and every other variable exactly
 * (security review 2026-09-25 R2.5).
 */
function stripLegacyTokenLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const m = line.match(/^(?:export\s+)?([A-Za-z0-9_]+)=/);
      return !(m && m[1] === "RING_REFRESH_TOKEN");
    })
    .join("\n");
}

async function migrateLegacyToken(orgId: string): Promise<void> {
  if (legacyMigrated || orgId !== DEFAULT_ORG_ID) return;
  if (!existsSync(ENV_FILE)) return;
  try {
    const sql = await getSql();
    const existing = await sql`select 1 as one from org_ring_tokens where org_id = ${orgId}`;
    if (existing.length > 0) {
      legacyMigrated = true;
      return;
    }

    const raw = await readFile(ENV_FILE, "utf8");
    const vars = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) vars.set(m[1], m[2]);
    }
    const token = vars.get("RING_REFRESH_TOKEN") ?? "";
    if (!token) return;

    const enc = encryptString(token, orgAad(orgId, "ring.refresh"));
    await sql`
      insert into org_ring_tokens (org_id, refresh_token_enc, key_id)
      values (${orgId}, ${enc.payload}, ${enc.keyId})
      on conflict (org_id) do nothing`;

    const back = await sql<{ refresh_token_enc: string; key_id: string }>`
      select refresh_token_enc, key_id from org_ring_tokens where org_id = ${orgId}`;
    const row = back[0];
    if (!row || decryptString(row.refresh_token_enc, row.key_id, orgAad(orgId, "ring.refresh")) !== token) {
      console.warn("[org-ring-tokens] legacy migration: DB round-trip failed, keeping dashboard.env");
      return;
    }

    await atomicWriteFile(ENV_FILE, stripLegacyTokenLine(raw));
    legacyMigrated = true;
    console.info("[org-ring-tokens] migrated legacy dashboard.env Ring token to encrypted storage");
  } catch (err) {
    console.warn("[org-ring-tokens] legacy migration failed:", err);
  }
}

/** Decrypted Ring refresh token for an org, or null when not connected. */
export async function getOrgRingToken(orgId: string): Promise<string | null> {
  await migrateLegacyToken(orgId);
  const sql = await getSql();
  const rows = await sql<{ refresh_token_enc: string; key_id: string }>`
    select refresh_token_enc, key_id from org_ring_tokens where org_id = ${orgId}`;
  if (rows.length === 0) return null;
  return decryptString(rows[0].refresh_token_enc, rows[0].key_id, orgAad(orgId, "ring.refresh"));
}

/** True when the org has a Ring token row (no decryption performed). */
export async function orgRingConfigured(orgId: string): Promise<boolean> {
  await migrateLegacyToken(orgId);
  const sql = await getSql();
  const rows = await sql`select 1 as one from org_ring_tokens where org_id = ${orgId}`;
  return rows.length > 0;
}

/** Store (or replace) an org's Ring refresh token, encrypted at rest. */
export async function setOrgRingToken(orgId: string, token: string): Promise<void> {
  if (!token) throw new Error("token is required");
  const enc = encryptString(token, orgAad(orgId, "ring.refresh"));
  const sql = await getSql();
  await sql`
    insert into org_ring_tokens (org_id, refresh_token_enc, key_id)
    values (${orgId}, ${enc.payload}, ${enc.keyId})
    on conflict (org_id) do update
      set refresh_token_enc = excluded.refresh_token_enc,
          key_id = excluded.key_id,
          updated_at = now()`;
}

/** Remove an org's Ring token (disconnect). */
export async function clearOrgRingToken(orgId: string): Promise<void> {
  const sql = await getSql();
  await sql`delete from org_ring_tokens where org_id = ${orgId}`;
}
