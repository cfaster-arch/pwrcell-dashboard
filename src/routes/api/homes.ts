import { createFileRoute } from "@tanstack/react-router";
import { getHomesPayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/homes")({
  server: {
    handlers: {
      GET: async () => {
        const body = await getHomesPayload();
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
