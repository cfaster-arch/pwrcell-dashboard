import { createFileRoute } from "@tanstack/react-router";
import { loadTouSettings, saveTouSettings } from "@/lib/tou-settings.server";

export const Route = createFileRoute("/api/tou")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          { settings: loadTouSettings() },
          { headers: { "cache-control": "no-store" } },
        ),
      PUT: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of ["peakRate", "peakStart", "peakEnd", "offPeakRate", "exportRate", "label"]) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        return Response.json({ settings: saveTouSettings(patch) });
      },
    },
  },
});
