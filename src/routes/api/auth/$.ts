import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/authn/server";
import { requirePlatformAdmin } from "@/lib/authn/guard.server";
import { AUDIT_ACTIONS, auditEvent } from "@/lib/authn/audit.server";
import {
  checkLoginThrottle,
  getClientIp,
  recordLoginAttempt,
} from "@/lib/authn/login-throttle.server";

/**
 * better-auth handler mount. All of /api/auth/* (sign-in, sign-out, session,
 * organization, api-key, admin endpoints) is served by better-auth itself.
 *
 * Impersonation (research §1h) is DISABLED here: the admin plugin ships
 * /api/auth/admin/impersonate-user with no audit trail, and 1.6.x offers no
 * option to turn it off — so this wrapper 404s every impersonate path before
 * better-auth sees it. There is no public sign-up; users are created by
 * platform admins.
 */

// Phase 3: better-auth 1.6.33's admin plugin exposes no onAdminCall hook, so
// admin invocations are audit-logged in handle() after the gate passes.

/**
 * Normalized request path: percent-decoded, trailing slashes stripped,
 * lowercased. All guards below match on this — never on the raw pathname —
 * so %2e/%2f encodings and trailing slashes can't slip past a filter and
 * reach better-auth unguarded.
 */
function normalizedPath(url: string): string {
  const raw = new URL(url).pathname;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed % sequences: leave raw. It won't match any guarded path,
    // and better-auth will 404 it.
  }
  return decoded.replace(/\/+$/, "").toLowerCase() || "/";
}

function isImpersonatePath(path: string): boolean {
  return (
    path === "/api/auth/admin/impersonate-user" ||
    path.startsWith("/api/auth/admin/impersonate-user/")
  );
}

/**
 * Public sign-up is disabled: users are created by platform admins (seed
 * script / future admin UI). better-auth still mounts /sign-up/email, so this
 * wrapper 404s every sign-up path before better-auth sees it. Returns the
 * same shape as the impersonation block to avoid leaking which disabled
 * endpoints exist.
 */
function isSignUpPath(path: string): boolean {
  return path === "/api/auth/sign-up" || path.startsWith("/api/auth/sign-up/");
}

function isSignInEmailPath(path: string, method: string): boolean {
  return method === "POST" && path === "/api/auth/sign-in/email";
}

function isAdminPath(path: string): boolean {
  return path === "/api/auth/admin" || path.startsWith("/api/auth/admin/");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Login throttling wrapper (research §7a / KEEP list): DB-backed progressive
 * delay after 5 failures and a 15-minute lockout after 10, counted per email
 * OR per IP. The lockout response is identical for unknown and known emails
 * (non-enumerating); wrong-password and unknown-email both come back from
 * better-auth as the same 401.
 */
async function handleSignInWithThrottle(request: Request): Promise<Response> {
  let email = "";
  try {
    const body = (await request.clone().json()) as { email?: unknown };
    if (typeof body.email === "string") email = body.email.trim().slice(0, 320);
  } catch {
    // Unparseable body — let better-auth return its own 4xx.
    return auth.handler(request);
  }
  const ip = getClientIp(request);
  if (email) {
    const decision = await checkLoginThrottle(email, ip);
    if (!decision.allowed) {
      return Response.json(
        { error: "too many attempts", message: "Too many sign-in attempts. Try again later." },
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(decision.retryAfterS),
          },
        },
      );
    }
    if (decision.delayMs > 0) await sleep(decision.delayMs);
  }

  const response = await auth.handler(request);
  if (email) {
    // better-auth returns 2xx only on a successful sign-in.
    await recordLoginAttempt(email, ip, response.ok);
  }
  return response;
}

async function handle(request: Request): Promise<Response> {
  // SINGLE-MOUNT INVARIANT: this file is the only mount of auth.handler in
  // the app. Any second mount must replicate this gate and the admin.api_call
  // audit below, or admin endpoints become reachable without platform-admin
  // checks or logging.
  const path = normalizedPath(request.url);
  if (isImpersonatePath(path) || isSignUpPath(path)) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (isAdminPath(path)) {
    // better-auth's own /api/auth/admin/* endpoints (set-role, ban-user,
    // revoke sessions, ...) must honor the SAME platform-admin gate as the
    // app's admin routes — role check (404 oracle protection) plus the 12h
    // admin-session freshness. Without this the freshness control would only
    // apply to routes calling requirePlatformAdmin() while the raw mount
    // bypassed it entirely.
    const gate = await requirePlatformAdmin(request.headers);
    if (gate instanceof Response) return gate;
    // Phase 3: no onAdminCall hook exists on the admin plugin, so every
    // admin invocation is audit-logged here. Admin calls are rare and
    // privileged — a missing audit row would be a bigger problem than the
    // extra write.
    await auditEvent({
      actorUserId: gate.user.id,
      actorType: "user",
      action: AUDIT_ACTIONS.ADMIN_API_CALL,
      targetType: "admin-endpoint",
      targetId: `${request.method} ${path}`,
      ip: getClientIp(request),
      userAgent: request.headers.get("user-agent")?.slice(0, 512) || undefined,
    });
  }
  if (isSignInEmailPath(path, request.method)) {
    return handleSignInWithThrottle(request);
  }
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
