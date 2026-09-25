/**
 * Per-organization settings store (Phase 2).
 *
 * Named settings sections ("display", "alerts", "tou", "camera") live in the
 * org_settings.settings jsonb document, keyed by org_id. This replaces the
 * legacy per-setting JSON files in the app data dir (alert-settings.json,
 * tou-settings.json, display-settings.json, camera-settings.json).
 *
 * Legacy import: on the first read for the default organization, when no row
 * (or an empty document) exists yet, the legacy files are imported once. That
 * lets a single-tenant deploy upgrade without losing its settings. Never runs
 * for non-default organizations.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSql } from "@/lib/db";

export const DEFAULT_ORG_ID = "org_default";

const LEGACY_DIR = process.cwd();

/** Legacy single-tenant file -> settings section. */
const LEGACY_FILES: Record<string, string> = {
  alerts: "alert-settings.json",
  tou: "tou-settings.json",
  display: "display-settings.json",
  camera: "camera-settings.json",
};

let legacyImportDone = false;

async function importLegacySettings(orgId: string): Promise<void> {
  if (legacyImportDone || orgId !== DEFAULT_ORG_ID) return;
  legacyImportDone = true;
  const sql = await getSql();
  const rows = await sql<{ settings: Record<string, unknown> }>`
    select settings from org_settings where org_id = ${orgId}`;
  const existing = rows[0]?.settings ?? {};
  if (Object.keys(existing).length > 0) return;

  const imported: Record<string, unknown> = {};
  for (const [section, file] of Object.entries(LEGACY_FILES)) {
    const path = join(LEGACY_DIR, file);
    if (!existsSync(path)) continue;
    try {
      imported[section] = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      console.warn(`[org-settings] legacy import: could not read ${file}:`, err);
    }
  }
  if (Object.keys(imported).length === 0) return;
  await sql`
    insert into org_settings (org_id, settings)
    values (${orgId}, ${JSON.stringify(imported)}::jsonb)
    on conflict (org_id) do update
      set settings = org_settings.settings || ${JSON.stringify(imported)}::jsonb,
          updated_at = now()`;
}

/** Read one settings section for an org. Returns undefined when never set. */
export async function getOrgSection(orgId: string, section: string): Promise<unknown> {
  await importLegacySettings(orgId);
  const sql = await getSql();
  const rows = await sql<{ settings: Record<string, unknown> }>`
    select settings from org_settings where org_id = ${orgId}`;
  return rows[0]?.settings?.[section];
}

/** Replace one settings section for an org (deep-merged by the caller). */
export async function setOrgSection(orgId: string, section: string, value: unknown): Promise<void> {
  await importLegacySettings(orgId);
  const sql = await getSql();
  const patch = JSON.stringify({ [section]: value });
  await sql`
    insert into org_settings (org_id, settings)
    values (${orgId}, ${patch}::jsonb)
    on conflict (org_id) do update
      set settings = org_settings.settings || ${patch}::jsonb,
          updated_at = now()`;
}

/** Delete one settings section for an org. */
export async function deleteOrgSection(orgId: string, section: string): Promise<void> {
  const sql = await getSql();
  await sql`
    update org_settings
    set settings = settings - ${section}, updated_at = now()
    where org_id = ${orgId}`;
}
