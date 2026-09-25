import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import { ALERT_RULES } from "@/lib/alert-types";
import { loadAlertSettings, saveAlertSettings } from "@/lib/alerts.server";

export const Route = createFileRoute("/api/alerts-settings")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        return Response.json(
          { settings: await loadAlertSettings(authz.orgId), rules: ALERT_RULES },
          { headers: { "cache-control": "no-store" } },
        );
      },
      PUT: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body.lowSocThreshold === "number") patch.lowSocThreshold = body.lowSocThreshold;
        if (typeof body.ntfyTopic === "string") patch.ntfyTopic = body.ntfyTopic;
        if (body.rules && typeof body.rules === "object") {
          const rr = body.rules as Record<string, { enabled?: unknown }>;
          const rules: Record<string, { enabled: boolean }> = {};
          for (const meta of ALERT_RULES) {
            if (rr[meta.key] && typeof rr[meta.key].enabled === "boolean") {
              rules[meta.key] = { enabled: rr[meta.key].enabled as boolean };
            }
          }
          patch.rules = rules;
        }
        return Response.json({ settings: await saveAlertSettings(authz.orgId, patch) });
      },
    },
  },
});
