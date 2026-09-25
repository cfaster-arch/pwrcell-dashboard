import { createFileRoute } from "@tanstack/react-router";
import { ALERT_RULES } from "@/lib/alert-types";
import { loadAlertSettings, saveAlertSettings } from "@/lib/alerts.server";

export const Route = createFileRoute("/api/alerts-settings")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          { settings: loadAlertSettings(), rules: ALERT_RULES },
          { headers: { "cache-control": "no-store" } },
        ),
      PUT: async ({ request }) => {
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
        return Response.json({ settings: saveAlertSettings(patch) });
      },
    },
  },
});
