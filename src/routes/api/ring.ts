import { createFileRoute } from "@tanstack/react-router";
import { requireSessionApi } from "@/lib/authn/guard.server";
import {
  discoverCameras,
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

export const Route = createFileRoute("/api/ring")({
  server: {
    handlers: {
      GET: async () => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        const [status, settings] = await Promise.all([
          ringStatus(),
          Promise.resolve(loadCameraSettings()),
        ]);
        return Response.json({ ...status, settings }, { headers: noStore });
      },
      POST: async ({ request }) => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        let body: ActionBody = {};
        try {
          body = (await request.json()) as ActionBody;
        } catch {
          body = {};
        }
        const action = String(body.action ?? "");
        try {
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
            const r = await ringAuthStart(email, password);
            if (!r.need2fa) {
              const cams = await discoverCameras();
              saveDiscovered(cams);
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
            const cameras = await ringAuthVerify(code);
            return Response.json({ ok: true, cameras }, { headers: noStore });
          }
          if (action === "rediscover") {
            const cameras = await discoverCameras();
            const settings = saveDiscovered(cameras);
            return Response.json({ cameras, settings }, { headers: noStore });
          }
          if (action === "sync") {
            await syncBridge();
            return Response.json({ ok: true }, { headers: noStore });
          }
          if (action === "disconnect") {
            await ringDisconnect();
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
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          body = {};
        }
        try {
          const settings = saveCameraSettings({
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
