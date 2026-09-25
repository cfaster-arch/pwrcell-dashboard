import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import { loadTouSettings, saveTouSettings } from "@/lib/tou-settings.server";

export const Route = createFileRoute("/api/tou")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        return Response.json(
          { settings: await loadTouSettings(authz.orgId) },
          { headers: { "cache-control": "no-store" } },
        );
      },
      PUT: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of ["peakStart", "peakEnd", "summerPeak", "summerOffPeak", "summerExport", "winterPeak", "winterOffPeak", "winterExport", "label"]) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        return Response.json({ settings: await saveTouSettings(authz.orgId, patch) });
      },
    },
  },
});
