import { createFileRoute } from "@tanstack/react-router";
import { createReadStream, statSync } from "node:fs";
import { requireOrgApi, requireOrgManager } from "@/lib/authn/guard.server";
import {
  deleteBackgroundImage,
  getBackgroundFile,
  saveBackgroundImage,
} from "@/lib/display-settings.server";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Per-org custom display background image.
 *
 * GET    — serves the org's background (its own org only).
 * POST   — uploads a new one (managers only); switches backgroundMode to image.
 * DELETE — removes it (managers only).
 */
export const Route = createFileRoute("/api/display-background")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const file = getBackgroundFile(authz.orgId);
        if (!file) return new Response(null, { status: 404, headers: NO_STORE });
        const size = statSync(file.path).size;
        const headers = new Headers(NO_STORE);
        headers.set("content-type", file.contentType);
        headers.set("content-length", String(size));
        // stream the file; node runtime only
        const stream = createReadStream(file.path) as unknown as ReadableStream;
        return new Response(stream, { status: 200, headers });
      },
      POST: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const mgr = await requireOrgManager(authz.orgId);
        if (mgr instanceof Response) return mgr;
        let file: File | null = null;
        try {
          const form = await request.formData();
          const f = form.get("image");
          if (f instanceof File) file = f;
        } catch {
          file = null;
        }
        if (!file || file.size === 0) {
          return Response.json(
            { error: "No image file was attached." },
            { status: 400, headers: NO_STORE },
          );
        }
        if (!IMAGE_TYPES.has(file.type)) {
          return Response.json(
            { error: "Unsupported image type (jpeg, png, webp, gif only)." },
            { status: 415, headers: NO_STORE },
          );
        }
        if (file.size > MAX_BYTES) {
          return Response.json(
            { error: "Image must be under 8 MB." },
            { status: 413, headers: NO_STORE },
          );
        }
        try {
          const buf = Buffer.from(await file.arrayBuffer());
          const settings = await saveBackgroundImage(authz.orgId, buf, file.type);
          return Response.json(settings, { headers: NO_STORE });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "Couldn't save the image." },
            { status: 500, headers: NO_STORE },
          );
        }
      },
      DELETE: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const mgr = await requireOrgManager(authz.orgId);
        if (mgr instanceof Response) return mgr;
        const settings = await deleteBackgroundImage(authz.orgId);
        return Response.json(settings, { headers: NO_STORE });
      },
    },
  },
});
