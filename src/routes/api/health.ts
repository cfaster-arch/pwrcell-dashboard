import { createFileRoute } from "@tanstack/react-router";
import { getHealthPayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const body = await getHealthPayload();
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
