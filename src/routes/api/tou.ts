import { createFileRoute } from "@tanstack/react-router";
import { requireSessionApi } from "@/lib/authn/guard.server";
import { loadTouSettings, saveTouSettings } from "@/lib/tou-settings.server";

export const Route = createFileRoute("/api/tou")({
  server: {
    handlers: {
      GET: async () => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        return Response.json(
          { settings: loadTouSettings() },
          { headers: { "cache-control": "no-store" } },
        );
      },
      PUT: async ({ request }) => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of ["peakStart", "peakEnd", "summerPeak", "summerOffPeak", "summerExport", "winterPeak", "winterOffPeak", "winterExport", "label"]) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        return Response.json({ settings: saveTouSettings(patch) });
      },
    },
  },
});
