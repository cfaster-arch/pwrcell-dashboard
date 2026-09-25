import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import {
  acknowledgeAlert,
  acknowledgeAll,
  getAlerts,
  getUnacknowledged,
} from "@/lib/alerts.server";

export const Route = createFileRoute("/api/alerts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const url = new URL(request.url);
        if (url.searchParams.get("unacknowledged") === "1") {
          return Response.json(
            { alerts: await getUnacknowledged(authz.orgId) },
            { headers: { "cache-control": "no-store" } },
          );
        }
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        return Response.json(
          { alerts: await getAlerts(authz.orgId, limit) },
          { headers: { "cache-control": "no-store" } },
        );
      },
      POST: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const body = (await request.json().catch(() => ({}))) as {
          action?: string;
          id?: unknown;
        };
        if (body.action === "acknowledgeAll") {
          await acknowledgeAll(authz.orgId);
          return Response.json({ ok: true });
        }
        if (body.action === "acknowledge" && typeof body.id === "number") {
          await acknowledgeAlert(authz.orgId, body.id);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "action must be 'acknowledge' (with id) or 'acknowledgeAll'" }, { status: 400 });
      },
    },
  },
});
