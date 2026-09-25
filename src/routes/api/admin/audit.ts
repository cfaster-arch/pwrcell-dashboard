import { createFileRoute } from "@tanstack/react-router";
import { requirePlatformAdmin } from "@/lib/authn/guard.server";
import { AUDIT_ACTIONS, auditEvent, verifyAuditChain } from "@/lib/authn/audit.server";
import { getSql } from "@/lib/db";

/**
 * Phase 3 (slim): minimal operator review/export path for the append-only
 * audit log. Platform admins only (404 oracle protection via the gate).
 *
 *   GET /api/admin/audit?limit=100&offset=0[&action=auth.login][&orgId=x][&actor=y]
 *     → { rows: [...], limit, offset } — newest first. The JSON itself is the
 *       export format: save the response body to archive it.
 *   GET /api/admin/audit?verify=1[&limit=1000]
 *     → { ok, checked, reachedGenesis, breakAt? } — recomputes the hash
 *       chain. reachedGenesis=false means the window was truncated at an
 *       interior anchor: internally consistent, but a full-table rewrite by
 *       someone with DB write access would not be detected (only an
 *       externally anchored checkpoint catches that).
 *
 * Every read is itself audit-logged (audit.exported) — an admin who
 * exfiltrates the trail leaves a trace. No UI: operators curl this or save
 * the JSON. no-store everywhere.
 */

const NO_STORE = { "cache-control": "no-store" };

const MAX_LIMIT = 500;
const MAX_OFFSET = 100000;
const MAX_VERIFY_LIMIT = 5000;

interface AuditRowOut {
  id: number;
  ts: string;
  actor_user_id: string | null;
  actor_type: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  org_id: string | null;
  ip: string | null;
  user_agent: string | null;
  prev_hash: string;
  row_hash: string;
}

export const Route = createFileRoute("/api/admin/audit")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const gate = await requirePlatformAdmin(request.headers);
        if (gate instanceof Response) return gate;

        const url = new URL(request.url);
        const sql = await getSql();

        // The read itself is audited (fail-closed, like every other audit
        // write): exporting the trail without a trace is not possible.
        const readAudit = () =>
          auditEvent({
            actorUserId: gate.user.id,
            actorType: "user",
            action: AUDIT_ACTIONS.AUDIT_EXPORTED,
            targetType: "audit_log",
            targetId:
              url.searchParams.get("verify") === "1" ? "verify" : "export",
            ip:
              request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
              request.headers.get("x-real-ip") ||
              undefined,
            userAgent: request.headers.get("user-agent")?.slice(0, 512) || undefined,
          });

        if (url.searchParams.get("verify") === "1") {
          const limit = Math.min(
            Math.max(parseInt(url.searchParams.get("limit") ?? "1000", 10) || 1000, 1),
            MAX_VERIFY_LIMIT,
          );
          await readAudit();
          const result = await verifyAuditChain(limit);
          return Response.json(result, { headers: NO_STORE });
        }

        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1),
          MAX_LIMIT,
        );
        const offset = Math.min(
          Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0),
          MAX_OFFSET,
        );
        const action = url.searchParams.get("action")?.slice(0, 64) || null;
        const orgId = url.searchParams.get("orgId")?.slice(0, 64) || null;
        const actor = url.searchParams.get("actor")?.slice(0, 64) || null;

        await readAudit();
        const rows = await sql<AuditRowOut>`
          select id, ts, actor_user_id, actor_type, action, target_type,
                 target_id, org_id, ip, user_agent, prev_hash, row_hash
          from audit_log
          where (${action} is null or action = ${action})
            and (${orgId} is null or org_id = ${orgId})
            and (${actor} is null or actor_user_id = ${actor})
          order by id desc
          limit ${limit} offset ${offset}`;
        return Response.json({ rows, limit, offset }, { headers: NO_STORE });
      },
    },
  },
});
