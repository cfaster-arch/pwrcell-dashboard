import { createFileRoute } from "@tanstack/react-router";
import { requirePlatformAdmin } from "@/lib/authn/guard.server";
import { AUDIT_ACTIONS, auditEvent } from "@/lib/authn/audit.server";
import { getSql } from "@/lib/db";

/**
 * Phase 3 (slim): operator-triggered immediate session revocation.
 *
 *   POST /api/admin/users/$userId/revoke-sessions  { reason?: string }
 *     → { revoked: <session count> }
 *
 * Platform admins only. Deletes every session row for the user; because
 * session.cookieCache is disabled (research §1c), the revocation takes
 * effect on the user's very next request — there is no stale-cache window.
 * The action is audit-logged (session.revoked) with the admin as actor.
 */

const NO_STORE = { "cache-control": "no-store" };

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    ""
  );
}

export const Route = createFileRoute("/api/admin/users/$userId/revoke-sessions")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const gate = await requirePlatformAdmin(request.headers);
        if (gate instanceof Response) return gate;

        const userId = String(params.userId ?? "").slice(0, 128);
        if (!userId) {
          return Response.json({ error: "missing user id" }, { status: 400, headers: NO_STORE });
        }

        let reason = "";
        try {
          const body = (await request.json()) as { reason?: unknown };
          if (typeof body.reason === "string") reason = body.reason.slice(0, 280);
        } catch {
          // No body is fine — reason is optional.
        }

        const sql = await getSql();
        const target = await sql<{ id: string }>`select id from "user" where id = ${userId}`;
        if (target.length === 0) {
          return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
        }

        // Delete + audit in ONE transaction: the revocation can never land
        // without its audit record (repudiation), and a concurrent audit
        // failure rolls the delete back instead of hiding a completed
        // revocation behind a 500. Sessions are the only credential class in
        // this app (no API keys / PATs / OAuth grants — kiosk device keys are
        // Phase 4), so deleting session rows is complete revocation.
        const deleted = await sql.transaction(async (tx) => {
          const rows = await tx<{ id: string }>`
            delete from session where user_id = ${userId} returning id`;
          if (rows.length > 0) {
            await auditEvent(
              {
                actorUserId: gate.user.id,
                actorType: "user",
                action: AUDIT_ACTIONS.SESSION_REVOKED,
                targetType: "user",
                targetId: userId,
                ip: clientIp(request),
                userAgent: request.headers.get("user-agent")?.slice(0, 512) || undefined,
              },
              tx,
            );
          }
          return rows;
        });

        return Response.json(
          { revoked: deleted.length, reason: reason || undefined },
          { headers: NO_STORE },
        );
      },
    },
  },
});
