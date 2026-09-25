import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import { getLivePayload } from "@/lib/pwrcell/poller.server";

const NO_STORE = { "cache-control": "no-store" };

export const Route = createFileRoute("/api/live")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const body = await getLivePayload(authz.orgId);
        return Response.json(body, { headers: NO_STORE });
      },
    },
  },
});
