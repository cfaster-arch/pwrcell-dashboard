import { createFileRoute } from "@tanstack/react-router";
import { requireSessionApi } from "@/lib/authn/guard.server";
import { loadDisplaySettings, saveDisplaySettings } from "@/lib/display-settings.server";

const NO_STORE = { "cache-control": "no-store" };

export const Route = createFileRoute("/api/display")({
  server: {
    handlers: {
      GET: async () => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        return Response.json(loadDisplaySettings(), { headers: NO_STORE });
      },
      PUT: async ({ request }) => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const patch: Record<string, unknown> = {};
        if (body.theme === "dark" || body.theme === "light") patch.theme = body.theme;
        if (
          body.displayMode === "graphs" ||
          body.displayMode === "tiles" ||
          body.displayMode === "gauges" ||
          body.displayMode === "flow"
        ) {
          patch.displayMode = body.displayMode;
        } else if (body.gaugeStyle === "analog" || body.gaugeStyle === "tiles") {
          // Legacy binary toggle: map onto the 3-way mode.
          patch.displayMode = body.gaugeStyle === "tiles" ? "tiles" : "gauges";
        }
        if (
          body.backgroundMode === "default" ||
          body.backgroundMode === "color" ||
          body.backgroundMode === "image"
        ) {
          patch.backgroundMode = body.backgroundMode;
        }
        if (typeof body.backgroundColor === "string" && /^#[0-9a-fA-F]{6}$/.test(body.backgroundColor)) {
          patch.backgroundColor = body.backgroundColor;
        }
        if (typeof body.nightDim === "boolean") patch.nightDim = body.nightDim;
        if (typeof body.setupComplete === "boolean") patch.setupComplete = body.setupComplete;
        if (typeof body.showRates === "boolean") patch.showRates = body.showRates;
        if (typeof body.showCameras === "boolean") patch.showCameras = body.showCameras;
        const next = saveDisplaySettings(patch);
        return Response.json(next, { headers: NO_STORE });
      },
    },
  },
});
