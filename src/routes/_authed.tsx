import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

/**
 * Authenticated area (Phase 1). Pathless layout: every route under it
 * requires a live server session; unauthenticated visitors are bounced to
 * /signin before any page code loads data.
 */
const getSessionState = createServerFn({ method: "GET" }).handler(async () => {
  const { getSessionFromRequest } = await import("@/lib/authn/guard.server");
  const ctx = await getSessionFromRequest();
  if (!ctx) return null;
  return {
    userId: ctx.user.id,
    email: ctx.user.email,
    role: ctx.user.role ?? null,
    mustChangePassword:
      (ctx.user as { mustChangePassword?: boolean }).mustChangePassword ?? false,
  };
});

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ location }) => {
    const session = await getSessionState();
    if (!session) throw redirect({ to: "/signin" });
    // Temp-password gate (2026-09-25): applies to email AND Google sign-ins
    // alike — the social flow is redirect-based so signin.tsx can't catch it.
    // The password page itself is exempt so it can't redirect-loop.
    if (session.mustChangePassword && location.pathname !== "/account/password") {
      throw redirect({ to: "/account/password" });
    }
    return { auth: session };
  },
});
