import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi, requireOrgManager } from "@/lib/authn/guard.server";
import {
  discoverCameras,
  orgStreamNames,
  ringAuthStart,
  ringAuthVerify,
  ringDisconnect,
  ringStatus,
  syncBridge,
} from "@/lib/ring/ring-api.server";
import {
  loadCameraSettings,
  saveCameraSettings,
  saveDiscovered,
} from "@/lib/ring/ring-store.server";
import { auditEvent, AUDIT_ACTIONS } from "@/lib/authn/audit.server";

const noStore = { "cache-control": "no-store" };

// Tiny guard on the Ring sign-in step: repeated failures in a short window
// could otherwise prod Ring's own rate limits / account lockout.
let authAttempts: number[] = [];
function authRateLimited(): boolean {
  const now = Date.now();
  authAttempts = authAttempts.filter((t) => now - t < 10 * 60 * 1000);
  if (authAttempts.length >= 5) return true;
  authAttempts.push(now);
  return false;
}

type ActionBody = {
  action?: unknown;
  email?: unknown;
  password?: unknown;
  code?: unknown;
} & Record<string, unknown>;

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    ""
  );
}

export const Route = createFileRoute("/api/ring")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const [status, settings] = await Promise.all([
          ringStatus(authz.orgId),
          loadCameraSettings(authz.orgId),
        ]);
        // The browser only ever sees the org's own stream names; internal
        // namespacing stays server-side.
        const [cam1Stream, cam2Stream] = orgStreamNames(authz.orgId);
        return Response.json(
          {
            ...status,
            settings: {
              ...settings,
              cam1: settings.cam1 ? { ...settings.cam1, stream: cam1Stream } : null,
              cam2: settings.cam2 ? { ...settings.cam2, stream: cam2Stream } : null,
            },
          },
          { headers: noStore },
        );
      },
      POST: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        let body: ActionBody = {};
        try {
          body = (await request.json()) as ActionBody;
        } catch {
          body = {};
        }
        const action = String(body.action ?? "");
        try {
          if (action === "auth-start" || action === "auth-verify" || action === "disconnect") {
            const mgr = await requireOrgManager(authz.orgId);
            if (mgr instanceof Response) return mgr;
          }
          if (action === "auth-start") {
            if (authRateLimited()) {
              return Response.json(
                { error: "Too many sign-in attempts — wait a few minutes." },
                { status: 429, headers: noStore },
              );
            }
            const email = String(body.email ?? "").trim();
            const password = String(body.password ?? "");
            if (!email || !password) {
              return Response.json(
                { error: "Email and password are both required." },
                { status: 400, headers: noStore },
              );
            }
            const r = await ringAuthStart(authz.orgId, authz.ctx.user.id, email, password);
            if (!r.need2fa) {
              const cams = await discoverCameras(authz.orgId);
              await saveDiscovered(authz.orgId, cams);
              await syncBridge();
              return Response.json(
                { need2fa: false, cameras: cams },
                { headers: noStore },
              );
            }
            return Response.json(r, { headers: noStore });
          }
          if (action === "auth-verify") {
            const code = String(body.code ?? "").trim();
            if (!code) {
              return Response.json(
                { error: "Enter the code Ring sent you." },
                { status: 400, headers: noStore },
              );
            }
            const cameras = await ringAuthVerify(authz.orgId, authz.ctx.user.id, code);
            await auditEvent({
              actorUserId: authz.ctx.user.id,
              actorType: "user",
              action: AUDIT_ACTIONS.RING_CONNECTED,
              targetType: "organization",
              targetId: authz.orgId,
              orgId: authz.orgId,
              ip: clientIp(request),
            }).catch(() => {});
            return Response.json({ ok: true, cameras }, { headers: noStore });
          }
          if (action === "rediscover") {
            const mgr = await requireOrgManager(authz.orgId);
            if (mgr instanceof Response) return mgr;
            const cameras = await discoverCameras(authz.orgId);
            const settings = await saveDiscovered(authz.orgId, cameras);
            return Response.json({ cameras, settings }, { headers: noStore });
          }
          if (action === "sync") {
            // Manager-gated: rebuilding the shared bridge restarts every
            // org's streams, so it must not be triggerable by any member
            // (security review 2026-09-25 R3.7).
            const mgr = await requireOrgManager(authz.orgId);
            if (mgr instanceof Response) return mgr;
            await syncBridge();
            return Response.json({ ok: true }, { headers: noStore });
          }
          if (action === "disconnect") {
            await ringDisconnect(authz.orgId);
            await auditEvent({
              actorUserId: authz.ctx.user.id,
              actorType: "user",
              action: AUDIT_ACTIONS.RING_DISCONNECTED,
              targetType: "organization",
              targetId: authz.orgId,
              orgId: authz.orgId,
              ip: clientIp(request),
            }).catch(() => {});
            return Response.json({ ok: true }, { headers: noStore });
          }
          return Response.json(
            { error: "Unknown action." },
            { status: 400, headers: noStore },
          );
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "Ring request failed." },
            { status: 500, headers: noStore },
          );
        }
      },
      PUT: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const mgr = await requireOrgManager(authz.orgId);
        if (mgr instanceof Response) return mgr;
        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          body = {};
        }
        try {
          const settings = await saveCameraSettings(authz.orgId, {
            enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
            cam1: "cam1" in body ? body.cam1 : undefined,
            cam2: "cam2" in body ? body.cam2 : undefined,
          });
          await syncBridge();
          return Response.json({ settings }, { headers: noStore });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "Couldn't save camera settings." },
            { status: 500, headers: noStore },
          );
        }
      },
    },
  },
});
