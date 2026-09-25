import { createFileRoute } from "@tanstack/react-router";
import { GO2RTC_PORT } from "@/lib/ring/go2rtc.server";

/**
 * Same-origin proxy to the local go2rtc bridge (127.0.0.1:1984).
 *
 * The browser must never reach go2rtc directly (it's localhost-only), and the
 * dashboard is served over HTTPS, so all camera traffic goes through here —
 * no mixed content, no extra TLS config, no credentials in the browser.
 *
 * Only the endpoints the camera UI needs are allowlisted; everything else 404s.
 */

const ALLOW: Record<string, Set<string>> = {
  "api/webrtc": new Set(["GET", "POST"]),
  "api/frame.jpeg": new Set(["GET"]),
  "api/streams": new Set(["GET"]),
};

async function proxy(request: Request, splat: string): Promise<Response> {
  const clean = splat.replace(/^\/+/, "").split("?")[0];
  const allowed = ALLOW[clean];
  if (!allowed || !allowed.has(request.method)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const url = new URL(request.url);
  const target = `http://127.0.0.1:${GO2RTC_PORT}/${clean}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  try {
    const res = await fetch(target, init);
    const out = new Headers();
    const ct = res.headers.get("content-type");
    if (ct) out.set("content-type", ct);
    out.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers: out });
  } catch {
    return Response.json(
      { error: "Camera bridge isn't running — check the Ring setup." },
      { status: 502 },
    );
  }
}

export const Route = createFileRoute("/api/rtc/$")({
  server: {
    handlers: {
      GET: ({ request, params }) => proxy(request, params._splat ?? ""),
      POST: ({ request, params }) => proxy(request, params._splat ?? ""),
    },
  },
});
