import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env.server";
import type {
  CameraSettings,
  CameraSlot,
  DiscoveredCamera,
} from "./types";

export type { CameraMode, CameraSettings, CameraSlot, DiscoveredCamera } from "./types";

/**
 * Ring persistence: refresh token in dashboard.env (0600, never exposed via
 * API) and camera slot assignment in camera-settings.json.
 */

const ENV_FILE = path.resolve(process.cwd(), "dashboard.env");
const CAM_FILE = path.resolve(process.cwd(), "camera-settings.json");

function readEnvFile(): Record<string, string> {
  try {
    const raw = fs.readFileSync(ENV_FILE, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

function writeEnvFile(vars: Record<string, string>): void {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
}

export function getRingToken(): string | null {
  const file = readEnvFile();
  const t = (file["RING_REFRESH_TOKEN"] ?? env("RING_REFRESH_TOKEN") ?? "").trim();
  return t || null;
}

/** Save the refresh token (file + live process env so no restart is needed). */
export function setRingToken(token: string): void {
  const file = readEnvFile();
  file["RING_REFRESH_TOKEN"] = token.trim();
  writeEnvFile(file);
  process.env.RING_REFRESH_TOKEN = token.trim();
}

export function clearRingToken(): void {
  const file = readEnvFile();
  delete file["RING_REFRESH_TOKEN"];
  writeEnvFile(file);
  delete process.env.RING_REFRESH_TOKEN;
}

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

export function loadCameraSettings(): CameraSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(CAM_FILE, "utf8")) as Partial<CameraSettings>;
    return {
      enabled: raw.enabled === true,
      cam1: sanitizeSlot(raw.cam1),
      cam2: sanitizeSlot(raw.cam2),
      discovered: Array.isArray(raw.discovered)
        ? raw.discovered
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
        typeof raw.discoveredAt === "number" && raw.discoveredAt > 0
          ? raw.discoveredAt
          : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(s: CameraSettings): void {
  fs.writeFileSync(CAM_FILE, JSON.stringify(s, null, 2) + "\n", "utf8");
}

export interface CameraSettingsPatch {
  enabled?: boolean;
  cam1?: unknown;
  cam2?: unknown;
}

export function saveCameraSettings(patch: CameraSettingsPatch): CameraSettings {
  const cur = loadCameraSettings();
  const next: CameraSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    cam1: "cam1" in patch ? sanitizeSlot(patch.cam1) : cur.cam1,
    cam2: "cam2" in patch ? sanitizeSlot(patch.cam2) : cur.cam2,
    discovered: cur.discovered,
    discoveredAt: cur.discoveredAt,
  };
  writeSettings(next);
  return next;
}

export function saveDiscovered(cams: DiscoveredCamera[]): CameraSettings {
  const cur = loadCameraSettings();
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
  writeSettings(next);
  return next;
}

export function resetCameraSettings(): CameraSettings {
  const next = { ...DEFAULTS };
  writeSettings(next);
  return next;
}
