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
  return { userId: ctx.user.id, email: ctx.user.email, role: ctx.user.role ?? null };
});

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const session = await getSessionState();
    if (!session) throw redirect({ to: "/signin" });
    return { auth: session };
  },
});
