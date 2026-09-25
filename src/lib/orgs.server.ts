/**
 * Organization management (Phase 2).
 *
 * createOrg: creates the org, its org_settings row, and an owner membership.
 * deleteOrg: FULL cascade — stops the org's poller, re-syncs the Ring bridge,
 *   removes members/invitations (explicit; no DB cascade on those tables),
 *   then deletes the org row. org_settings, org_credentials, org_ring_tokens,
 *   energy_samples, alerts, kiosk_devices, and pairing_codes cascade via FK.
 *   The audit log is append-only and intentionally NOT deleted.
 */
import { getSql } from "@/lib/db";
import { stopOrgPoller } from "@/lib/pwrcell/poller.server";
import { syncBridge } from "@/lib/ring/ring-api.server";
import { deleteOrgBackgroundFiles } from "@/lib/display-settings.server";
import { auditEvent, AUDIT_ACTIONS } from "@/lib/authn/audit.server";

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  memberCount: number;
  createdAt: string;
}

export async function listOrgs(): Promise<OrgSummary[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    name: string;
    slug: string;
    timezone: string;
    member_count: number;
    created_at: string;
  }>`
    select o.id, o.name, o.slug, o.timezone,
           (select count(*) from member m where m.organization_id = o.id)::int as member_count,
           o.created_at::text as created_at
    from organization o
    order by o.created_at asc`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    timezone: r.timezone,
    memberCount: r.member_count,
    createdAt: r.created_at,
  }));
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "org"
  );
}

export async function createOrg(opts: {
  name: string;
  slug?: string;
  timezone?: string;
  ownerUserId?: string;
  actorUserId?: string;
}): Promise<OrgSummary> {
  const name = opts.name.trim();
  if (!name) throw new Error("Organization name is required.");
  const slug = (opts.slug?.trim() || slugify(name)).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    throw new Error("Slug must be lowercase alphanumeric with dashes.");
  }
  const timezone = opts.timezone?.trim() || "America/Los_Angeles";
  try {
    // Validate the IANA timezone — throws on unknown zones.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`);
  }

  const sql = await getSql();
  const id = `org_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
  try {
    await sql`
      insert into organization (id, name, slug, timezone)
      values (${id}, ${name}, ${slug}, ${timezone})`;
  } catch (err) {
    if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
      throw new Error(`An organization with slug "${slug}" already exists.`);
    }
    throw err;
  }
  await sql`insert into org_settings (org_id, settings) values (${id}, '{}'::jsonb)`;
  if (opts.ownerUserId) {
    await sql`
      insert into member (id, organization_id, user_id, role)
      values (${`mem_${id}`}, ${id}, ${opts.ownerUserId}, 'owner')
      on conflict do nothing`;
  }
  await auditEvent({
    actorUserId: opts.actorUserId ?? null,
    actorType: opts.actorUserId ? "user" : "system",
    action: AUDIT_ACTIONS.ORG_CREATED,
    targetType: "organization",
    targetId: id,
    orgId: id,
  }).catch(() => {});
  const [org] = await listOrgs().then((all) => all.filter((o) => o.id === id));
  if (!org) throw new Error("Organization created but could not be read back.");
  return org;
}

/**
 * Delete an organization and EVERYTHING under it. Irreversible.
 * Throws when the org does not exist.
 */
export async function deleteOrg(orgId: string, actorUserId?: string): Promise<{ deleted: string }> {
  const sql = await getSql();
  const existing = await sql<{ id: string; name: string }>`
    select id, name from organization where id = ${orgId}`;
  if (existing.length === 0) throw new Error(`Organization not found: ${orgId}`);
  const name = existing[0].name;

  // 1. Stop live machinery first: no more polls, no more streams. Outside the
  //    DB transaction — a poller can't be rolled back, and holding the tx
  //    while stopping it would be backwards.
  stopOrgPoller(orgId);

  // 2. Files the DB can't cascade: the org's custom background image.
  //    Best-effort; the org row is gone either way.
  deleteOrgBackgroundFiles(orgId);

  // 3-5. All database mutations in ONE transaction (security review 2026-09-25
  //    R2.1): member/invitation deletes, orphaned kiosk API-key deletes, the
  //    org row itself (org_settings, org_credentials, org_ring_tokens,
  //    energy_samples, alerts, kiosk_devices, pairing_codes cascade via FK),
  //    and the audit row. Either everything commits or nothing does — a
  //    half-deleted org is impossible.
  await sql.transaction(async (tx) => {
    await tx`delete from member where organization_id = ${orgId}`;
    await tx`delete from invitation where organization_id = ${orgId}`;
    // Orphaned kiosk API keys (kiosk_devices cascades from the org delete in
    // step 5, but the apikey row it referenced does not delete itself). The FK
    // runs kiosk_devices -> apikey ON DELETE CASCADE, so deleting the apikey
    // rows first is safe — no violation.
    await tx`
      delete from apikey
      where id in (select api_key_id from kiosk_devices where org_id = ${orgId})`;
    await tx`delete from organization where id = ${orgId}`;
    // audit_log has no FK — the audit trail survives the org (append-only).
    await auditEvent(
      {
        actorUserId: actorUserId ?? null,
        actorType: actorUserId ? "user" : "system",
        action: AUDIT_ACTIONS.ORG_DELETED,
        targetType: "organization",
        targetId: orgId,
        orgId,
      },
      tx,
    );
  });

  // 6. Re-sync the shared Ring bridge so the deleted org's streams drop.
  try {
    await syncBridge();
  } catch (err) {
    console.warn(`[orgs] bridge re-sync after deleting ${orgId} failed:`, err);
  }

  return { deleted: name };
}

/** Get an org's timezone for display/history bucketing. Falls back to Pacific. */
export async function getOrgTimezone(orgId: string): Promise<string> {
  const sql = await getSql();
  const rows = await sql<{ timezone: string }>`
    select timezone from organization where id = ${orgId}`;
  return rows[0]?.timezone || "America/Los_Angeles";
}
