/**
 * Per-organization Ring camera slot settings (Phase 2).
 *
 * Camera slot assignment lives in the org_settings "camera" section. Refresh
 * tokens moved to org-ring-tokens.server.ts (AES-256-GCM at rest).
 */
import { getOrgSection, setOrgSection } from "@/lib/org-settings.server";
import type {
  CameraSettings,
  CameraSlot,
  DiscoveredCamera,
} from "./types";

export type { CameraMode, CameraSettings, CameraSlot, DiscoveredCamera } from "./types";

const DEFAULTS: CameraSettings = {
  enabled: false,
  cam1: null,
  cam2: null,
  discovered: [],
  discoveredAt: null,
};

const VALID_INTERVALS = new Set([30, 60, 300]);

function sanitizeSlot(raw: unknown): CameraSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const deviceId = Number(r.deviceId);
  if (!Number.isFinite(deviceId) || deviceId <= 0) return null;
  const mode = r.mode === "snap" || r.mode === "off" ? r.mode : "live";
  const intervalSec = VALID_INTERVALS.has(Number(r.intervalSec))
    ? Number(r.intervalSec)
    : 30;
  return {
    deviceId,
    name: String(r.name ?? `Camera ${deviceId}`).slice(0, 60),
    wired: r.wired === true,
    // Battery cameras can't do the snapshot workflow: force live.
    mode: r.wired === true ? mode : mode === "snap" ? "live" : mode,
    intervalSec,
  };
}

/**
 * Merge a (possibly partial) slot patch over the current slot before
 * sanitizing, so changing just the mode or snapshot interval doesn't wipe
 * the camera assignment. Explicit null still unassigns the slot.
 */
function mergeSlot(cur: CameraSlot | null, raw: unknown): CameraSlot | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return cur;
  return sanitizeSlot({ ...(cur ?? {}), ...(raw as Record<string, unknown>) });
}

function sanitize(raw: unknown): CameraSettings {
  const r = (raw ?? {}) as Partial<CameraSettings>;
  return {
    enabled: r.enabled === true,
    cam1: sanitizeSlot(r.cam1),
    cam2: sanitizeSlot(r.cam2),
    discovered: Array.isArray(r.discovered)
      ? r.discovered
          .filter(
            (d): d is DiscoveredCamera =>
              !!d && typeof d === "object" && Number.isFinite((d as DiscoveredCamera).deviceId),
          )
          .map((d) => ({
            deviceId: Number(d.deviceId),
            name: String(d.name ?? "").slice(0, 60),
            model: String(d.model ?? "").slice(0, 60),
          }))
      : [],
    discoveredAt:
      typeof r.discoveredAt === "number" && r.discoveredAt > 0
        ? r.discoveredAt
        : null,
  };
}

export async function loadCameraSettings(orgId: string): Promise<CameraSettings> {
  const raw = await getOrgSection(orgId, "camera");
  if (raw === undefined) return { ...DEFAULTS };
  return sanitize(raw);
}

export interface CameraSettingsPatch {
  enabled?: boolean;
  cam1?: unknown;
  cam2?: unknown;
}

export async function saveCameraSettings(orgId: string, patch: CameraSettingsPatch): Promise<CameraSettings> {
  const cur = await loadCameraSettings(orgId);
  const next: CameraSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    cam1: "cam1" in patch ? mergeSlot(cur.cam1, patch.cam1) : cur.cam1,
    cam2: "cam2" in patch ? mergeSlot(cur.cam2, patch.cam2) : cur.cam2,
    discovered: cur.discovered,
    discoveredAt: cur.discoveredAt,
  };
  await setOrgSection(orgId, "camera", next);
  return next;
}

export async function saveDiscovered(orgId: string, cams: DiscoveredCamera[]): Promise<CameraSettings> {
  const cur = await loadCameraSettings(orgId);
  const next: CameraSettings = {
    ...cur,
    discovered: cams,
    discoveredAt: Date.now(),
  };
  // Auto-assign empty slots in discovery order (user can rearrange after).
  if (!next.cam1 && cams[0]) {
    next.cam1 = {
      deviceId: cams[0].deviceId,
      name: cams[0].name,
      wired: false,
      mode: "live",
      intervalSec: 30,
    };
  }
  if (!next.cam2 && cams[1]) {
    next.cam2 = {
      deviceId: cams[1].deviceId,
      name: cams[1].name,
      wired: false,
      mode: "live",
      intervalSec: 30,
    };
  }
  await setOrgSection(orgId, "camera", next);
  return next;
}

export async function resetCameraSettings(orgId: string): Promise<CameraSettings> {
  const next = { ...DEFAULTS };
  await setOrgSection(orgId, "camera", next);
  return next;
}
