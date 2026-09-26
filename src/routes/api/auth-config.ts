import { createFileRoute } from "@tanstack/react-router";
import { googleOAuthConfigured } from "@/lib/authn/server";

/**
 * Public auth capabilities endpoint (no session required): tells the
 * sign-in page whether to render the "Sign in with Google" button.
 * Exposes only a boolean — never any secret material.
 */
export const Route = createFileRoute("/api/auth-config")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(
          { googleEnabled: googleOAuthConfigured },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
