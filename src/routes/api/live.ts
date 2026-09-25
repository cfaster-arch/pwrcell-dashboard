import { createFileRoute } from "@tanstack/react-router";
import { getLivePayload } from "@/lib/pwrcell/poller.server";

export const Route = createFileRoute("/api/live")({
  server: {
    handlers: {
      GET: async () => {
        const body = await getLivePayload();
        return Response.json(body, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
