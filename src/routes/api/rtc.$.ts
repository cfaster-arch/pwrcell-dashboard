import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import { orgStreamNames } from "@/lib/ring/ring-api.server";
import { GO2RTC_PORT } from "@/lib/ring/go2rtc.server";

/**
 * Same-origin proxy to the local go2rtc bridge (127.0.0.1:1984).
 *
 * The browser must never reach go2rtc directly (it's localhost-only), and the
 * dashboard is served over HTTPS, so all camera traffic goes through here —
 * no mixed content, no extra TLS config, no credentials in the browser.
 *
 * Only the endpoints the camera UI needs are allowlisted; everything else 404s.
 *
 * Multi-org: stream names are namespaced per org ("org_<16 hex>__cam1", a
 * SHA-256 digest of the org id — opaque and collision-free), and the proxy
 * validates the requested `src` against the caller's org before forwarding.
 * The api/streams listing is filtered the same way.
 */

const ALLOW: Record<string, Set<string>> = {
  "api/webrtc": new Set(["GET", "POST"]),
  "api/frame.jpeg": new Set(["GET"]),
  "api/streams": new Set(["GET"]),
};

async function proxy(
  request: Request,
  splat: string,
  allowedStreams: Set<string>,
): Promise<Response> {
  const clean = splat.replace(/^\/+/, "").split("?")[0];
  const allowed = ALLOW[clean];
  if (!allowed || !allowed.has(request.method)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const url = new URL(request.url);
  // Rebuild the forwarded query from an explicit whitelist (security review
  // 2026-09-25 R3.4): only a single `src` param is ever meaningful to these
  // endpoints, so anything else (duplicate src params, go2rtc-internal flags)
  // is dropped rather than forwarded verbatim.
  const srcValues = url.searchParams.getAll("src");
  if (srcValues.length > 1) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const src = srcValues[0] ?? null;
  if (src !== null && !allowedStreams.has(src)) {
    // Another org's stream (or a forged name) — don't reveal whether it exists.
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (src === null && clean !== "api/streams") {
    // The stream-specific endpoints are meaningless without a stream; require
    // it rather than forwarding a bare request to go2rtc.
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const fwdSearch = src !== null ? `?src=${encodeURIComponent(src)}` : "";
  const target = `http://127.0.0.1:${GO2RTC_PORT}/${clean}${fwdSearch}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  // Never forward the caller's credentials to the local bridge (R3.4).
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  try {
    const res = await fetch(target, init);
    const out = new Headers();
    const ct = res.headers.get("content-type");
    if (ct) out.set("content-type", ct);
    out.set("cache-control", "no-store");
    if (clean === "api/streams") {
      // Filter the global stream list down to this org's namespaced streams.
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (json && typeof json === "object") {
        const filtered: Record<string, unknown> = {};
        for (const [name, info] of Object.entries(json)) {
          if (allowedStreams.has(name)) filtered[name] = info;
        }
        return Response.json(filtered, { status: res.status, headers: out });
      }
      return new Response(null, { status: res.status, headers: out });
    }
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
      GET: async ({ request, params }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        return proxy(request, params._splat ?? "", new Set(orgStreamNames(authz.orgId)));
      },
      POST: async ({ request, params }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        return proxy(request, params._splat ?? "", new Set(orgStreamNames(authz.orgId)));
      },
    },
  },
});
