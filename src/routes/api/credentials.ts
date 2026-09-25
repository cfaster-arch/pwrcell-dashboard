import { createFileRoute } from "@tanstack/react-router";
import {
  clearCredentials,
  getCredentialMeta,
  setCredentials,
} from "@/lib/pwrcell/credentials.server";
import { resetAuth, resetToDemo } from "@/lib/pwrcell/poller.server";

type Body = { email?: unknown; password?: unknown };

export const Route = createFileRoute("/api/credentials")({
  server: {
    handlers: {
      // Never returns the password — only whether credentials exist + the email.
      GET: async () => {
        return Response.json(getCredentialMeta(), {
          headers: { "cache-control": "no-store" },
        });
      },
      POST: async ({ request }) => {
        let body: Body = {};
        try {
          body = (await request.json()) as Body;
        } catch {
          body = {};
        }
        const email = String(body.email ?? "").trim();
        const password = String(body.password ?? "");
        if (!email || !password) {
          return Response.json(
            { error: "Email and password are both required." },
            { status: 400 },
          );
        }
        setCredentials(email, password);
        resetAuth();
        return Response.json(getCredentialMeta(), {
          headers: { "cache-control": "no-store" },
        });
      },
      DELETE: async () => {
        clearCredentials();
        resetToDemo();
        return Response.json(getCredentialMeta(), {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
