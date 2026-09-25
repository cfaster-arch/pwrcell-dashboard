/**
 * Authorization primitives for API routes and protected pages (Phase 1).
 *
 * Research §1g/§2: `session.activeOrganizationId` is UI state, NEVER
 * authorization. Every route resolves the org from the request target and
 * verifies membership with a DB query — `requireOrgAccess()` below is THE
 * authorization primitive. Denials return 404 (not 403) so a probe can't
 * distinguish "no such org" from "not your org" (research §2a).
 */
import { redirect } from "@tanstack/react-router";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "./server";
import { getSql } from "../db";

export type SessionContext = {
  user: typeof auth.$Infer.Session.user;
  session: typeof auth.$Infer.Session.session;
};

/** Platform-admin sessions live 12h max (research §7e) — then re-authenticate. */
const ADMIN_SESSION_TTL_MS = 12 * 3600 * 1000;

/**
 * Fresh session lookup for the current request. cookieCache is disabled in
 * server.ts, so this ALWAYS hits the DB — revocation, ban, and role changes
 * take effect on the very next request (research §1c).
 */
export async function getSessionFromRequest(): Promise<SessionContext | null> {
  const data = await auth.api.getSession({ headers: getRequestHeaders() });
  if (!data) return null;
  return { user: data.user, session: data.session };
}

/** For pages/layouts: redirect to /signin when there is no session. */
export async function requireSession(): Promise<SessionContext> {
  const ctx = await getSessionFromRequest();
  if (!ctx) throw redirect({ to: "/signin" });
  return ctx;
}

/**
 * For API routes: returns the session context, or a 401 Response the handler
 * must return. Usage:
 *   const authz = await requireSessionApi();
 *   if (authz instanceof Response) return authz;
 */
export async function requireSessionApi(): Promise<SessionContext | Response> {
  const ctx = await getSessionFromRequest();
  if (!ctx) return Response.json({ error: "unauthorized" }, { status: 401 });
  return ctx;
}

/**
 * Platform-admin gate (the `admin` plugin axis — manages users/orgs).
 * Non-admins get 404 (existence oracle protection); admin sessions older
 * than 12h get 401 "re-authenticate" (research §7e).
 *
 * Takes optional explicit headers so the /api/auth/* mount in
 * src/routes/api/auth/$.ts can enforce the SAME gate on better-auth's own
 * /api/auth/admin/* endpoints — otherwise the 12h freshness would apply
 * only to routes that call this helper, while the raw mount bypassed it.
 */
export async function requirePlatformAdmin(
  headers?: Headers,
): Promise<SessionContext | Response> {
  const data = await auth.api.getSession({
    headers: headers ?? getRequestHeaders(),
  });
  if (!data) return Response.json({ error: "unauthorized" }, { status: 401 });
  const ctx = { user: data.user, session: data.session };
  if (ctx.user.role !== "admin") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const ageMs = Date.now() - new Date(ctx.session.createdAt).getTime();
  if (ageMs > ADMIN_SESSION_TTL_MS) {
    return Response.json(
      { error: "re-authenticate", message: "Admin session expired — sign in again." },
      { status: 401 },
    );
  }
  return ctx;
}

/**
 * Resolve the caller's org from their memberships (research §1g: never trust
 * session.activeOrganizationId blindly).
 * - exactly 1 membership → that org
 * - 0 memberships → 404 Response ("no organization")
 * - no session → 401 Response
 * - >1 → session.activeOrganizationId IF it is among the memberships,
 *   otherwise the first membership (callers re-verify with requireOrgAccess).
 *
 * Takes the request headers explicitly so API handlers pass what they
 * received — never a header set built elsewhere. Returns a Response the
 * handler must return on 401/404, matching the other guards in this file
 * (never throws a page redirect — this is an API helper).
 */
export async function getMyOrgId(headers: Headers): Promise<string | Response> {
  const data = await auth.api.getSession({ headers });
  if (!data) return Response.json({ error: "unauthorized" }, { status: 401 });
  const ctx = { user: data.user, session: data.session };
  const sql = await getSql();
  const rows = await sql<{ organization_id: string }>`
    select organization_id from member where user_id = ${ctx.user.id}`;
  if (rows.length === 0) {
    return Response.json({ error: "no organization" }, { status: 404 });
  }
  if (rows.length === 1) return rows[0].organization_id;
  const ids = rows.map((r) => r.organization_id);
  const active = ctx.session.activeOrganizationId;
  if (active && ids.includes(active)) return active;
  return ids[0];
}

/**
 * THE authorization primitive: verify a (user, orgId) membership row exists
 * in the DB. Returns the session context, or a 401/404 Response the handler
 * must return. Never derive the org from the client — pass the verified id.
 */
export async function requireOrgAccess(orgId: string): Promise<SessionContext | Response> {
  const ctx = await getSessionFromRequest();
  if (!ctx) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sql = await getSql();
  const rows = await sql<{ one: number }>`
    select 1 as one from member where user_id = ${ctx.user.id} and organization_id = ${orgId}`;
  if (rows.length === 0) {
    // 404, not 403 — a 403 would confirm the org exists (research §2a).
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return ctx;
}
