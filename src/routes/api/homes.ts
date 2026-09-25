import { createFileRoute } from "@tanstack/react-router";
import { requireSessionApi } from "@/lib/authn/guard.server";
import { getHomesPayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/homes")({
  server: {
    handlers: {
      GET: async () => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        const body = await getHomesPayload();
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
