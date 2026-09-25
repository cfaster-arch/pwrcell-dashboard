import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import { getHomesPayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/homes")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const body = await getHomesPayload(authz.orgId);
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
