import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import { getHealthPayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Authenticated: the payload reveals credential state and poll errors.
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const body = await getHealthPayload(authz.orgId);
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
