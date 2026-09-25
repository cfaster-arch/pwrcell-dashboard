import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import { getSeriesPayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/series")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const url = new URL(request.url);
        const body = await getSeriesPayload(authz.orgId, url.searchParams.get("minutes"));
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
