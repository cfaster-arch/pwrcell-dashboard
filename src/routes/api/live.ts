import { createFileRoute } from "@tanstack/react-router";
import { requireSessionApi } from "@/lib/authn/guard.server";
import { getLivePayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/live")({
  server: {
    handlers: {
      GET: async () => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        const body = await getLivePayload();
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
