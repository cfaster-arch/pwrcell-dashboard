import { createAuthClient } from "better-auth/react";
import { adminClient, organizationClient } from "better-auth/client/plugins";
import { apiKeyClient } from "@better-auth/api-key/client";

/**
 * better-auth browser client. Mounted at /api/auth (see
 * src/routes/api/auth/$.ts). Plugins mirror the server plugin set so the
 * client exposes organization/admin/api-key actions.
 *
 * baseURL must be absolute (better-auth validates it in the constructor, which
 * also runs during SSR — so the server branch is a never-called placeholder
 * and the browser branch resolves the real origin).
 */
export const authClient = createAuthClient({
  baseURL:
    typeof window === "undefined"
      ? "http://localhost:8080/api/auth"
      : `${window.location.origin}/api/auth`,
  plugins: [organizationClient(), adminClient(), apiKeyClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;
