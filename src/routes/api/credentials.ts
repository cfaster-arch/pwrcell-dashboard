import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi, requireOrgManager } from "@/lib/authn/guard.server";
import {
  clearOrgCredentials,
  getOrgCredentialMeta,
  setOrgCredentials,
} from "@/lib/pwrcell/org-credentials.server";
import { probeCredentials } from "@/lib/pwrcell/client.server";
import {
  resetOrgAuth,
  resetOrgToDemo,
} from "@/lib/pwrcell/poller.server";
import { auditEvent, AUDIT_ACTIONS } from "@/lib/authn/audit.server";

type Body = { email?: unknown; password?: unknown };

const NO_STORE = { "cache-control": "no-store" };

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    ""
  );
}

export const Route = createFileRoute("/api/credentials")({
  server: {
    handlers: {
      // Never returns the password — only whether credentials exist + the email.
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        return Response.json(await getOrgCredentialMeta(authz.orgId), {
          headers: NO_STORE,
        });
      },
      POST: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const mgr = await requireOrgManager(authz.orgId);
        if (mgr instanceof Response) return mgr;
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
            { status: 400, headers: NO_STORE },
          );
        }
        // Validate against Generac before persisting, so a typo can't put the
        // org's poller into a permanent auth-failure loop.
        try {
          await probeCredentials(email, password);
        } catch (e) {
          return Response.json(
            { error: `Couldn't sign in to Generac: ${e instanceof Error ? e.message : "sign-in failed"}` },
            { status: 400, headers: NO_STORE },
          );
        }
        await setOrgCredentials(authz.orgId, email, password);
        resetOrgAuth(authz.orgId);
        await auditEvent({
          actorUserId: authz.ctx.user.id ?? null,
          actorType: "user",
          action: AUDIT_ACTIONS.CREDENTIALS_SET,
          targetType: "organization",
          targetId: authz.orgId,
          orgId: authz.orgId,
          ip: clientIp(request),
        }).catch(() => {});
        return Response.json(await getOrgCredentialMeta(authz.orgId), {
          headers: NO_STORE,
        });
      },
      DELETE: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const mgr = await requireOrgManager(authz.orgId);
        if (mgr instanceof Response) return mgr;
        await clearOrgCredentials(authz.orgId);
        resetOrgToDemo(authz.orgId);
        await auditEvent({
          actorUserId: authz.ctx.user.id ?? null,
          actorType: "user",
          action: AUDIT_ACTIONS.CREDENTIALS_CLEARED,
          targetType: "organization",
          targetId: authz.orgId,
          orgId: authz.orgId,
          ip: clientIp(request),
        }).catch(() => {});
        return Response.json(await getOrgCredentialMeta(authz.orgId), {
          headers: NO_STORE,
        });
      },
    },
  },
});
