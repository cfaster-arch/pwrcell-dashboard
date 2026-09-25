import { createFileRoute } from "@tanstack/react-router";
import { getSeriesPayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/series")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const body = await getSeriesPayload(url.searchParams.get("minutes"));
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
