/**
 * Display settings (Phase 2: per-organization).
 *
 * Settings live in the org_settings "display" section. Background images are
 * per-org files (display-background-<org>.<ext>) in the app working dir.
 */
import fs from "node:fs";
import path from "node:path";
import { getOrgSection, setOrgSection } from "@/lib/org-settings.server";
import {
  DEFAULT_DISPLAY_SETTINGS,
  type BackgroundMode,
  type DisplayMode,
  type DisplaySettings,
  type GaugeStyle,
  type ThemeName,
} from "./display-settings";

const BG_PREFIX = path.resolve(process.cwd(), "display-background");

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** Filenames must not escape the working dir — org ids are slug-safe but be strict anyway. */
function safeOrg(orgId: string): string {
  return orgId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "org";
}

function sanitize(raw: unknown, orgId?: string): DisplaySettings {
  const r = (raw ?? {}) as Partial<DisplaySettings>;
  const theme: ThemeName = r.theme === "light" ? "light" : "dark";
  const gaugeStyle: GaugeStyle = r.gaugeStyle === "tiles" ? "tiles" : "analog";
  // displayMode supersedes gaugeStyle; old files without displayMode migrate
  // from the binary toggle (tiles -> "tiles", anything else -> "gauges").
  const displayMode: DisplayMode =
    r.displayMode === "graphs" ||
    r.displayMode === "tiles" ||
    r.displayMode === "gauges" ||
    r.displayMode === "flow"
      ? r.displayMode
      : gaugeStyle === "tiles"
        ? "tiles"
        : "gauges";
  const backgroundMode: BackgroundMode =
    r.backgroundMode === "color" || r.backgroundMode === "image" ? r.backgroundMode : "default";
  const backgroundColor =
    typeof r.backgroundColor === "string" && /^#[0-9a-fA-F]{6}$/.test(r.backgroundColor)
      ? r.backgroundColor
      : DEFAULT_DISPLAY_SETTINGS.backgroundColor;
  const s: DisplaySettings = {
    theme,
    displayMode,
    // Keep the deprecated field in sync so downgrades still read something sane.
    gaugeStyle: displayMode === "tiles" ? "tiles" : "analog",
    backgroundMode,
    backgroundColor,
    hasBackgroundImage: orgId ? findBackgroundFile(orgId) !== null : false,
    nightDim: r.nightDim !== false,
    setupComplete: r.setupComplete === true,
    showRates: r.showRates !== false,
    showCameras: r.showCameras !== false,
  };
  if (s.backgroundMode === "image" && !s.hasBackgroundImage) s.backgroundMode = "default";
  return s;
}

/** Defaults for contexts with no organization (e.g. the signed-out root shell). */
export function loadDisplayDefaults(): DisplaySettings {
  return sanitize(null);
}

export async function loadDisplaySettings(orgId: string): Promise<DisplaySettings> {
  const raw = await getOrgSection(orgId, "display");
  return sanitize(raw, orgId);
}

export async function saveDisplaySettings(
  orgId: string,
  patch: Partial<DisplaySettings>,
): Promise<DisplaySettings> {
  const current = await loadDisplaySettings(orgId);
  const next = sanitize({ ...current, ...patch, hasBackgroundImage: undefined }, orgId);
  const { hasBackgroundImage: _ignored, ...persisted } = next;
  await setOrgSection(orgId, "display", persisted);
  return next;
}

function backgroundCandidates(orgId: string): string[] {
  return Object.values(IMAGE_EXT).map((ext) => `${BG_PREFIX}-${safeOrg(orgId)}${ext}`);
}

function findBackgroundFile(orgId: string): string | null {
  for (const p of backgroundCandidates(orgId)) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not present */
    }
  }
  return null;
}

/** Remove every background file for an org (used by org deletion). */
export function deleteOrgBackgroundFiles(orgId: string): void {
  for (const p of backgroundCandidates(orgId)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* not present */
    }
  }
}

export function getBackgroundFile(orgId: string): { path: string; contentType: string } | null {
  const found = findBackgroundFile(orgId);
  if (!found) return null;
  const ext = path.extname(found);
  const entry = Object.entries(IMAGE_EXT).find(([, e]) => e === ext);
  return { path: found, contentType: entry ? entry[0] : "application/octet-stream" };
}

export async function saveBackgroundImage(
  orgId: string,
  data: Buffer,
  contentType: string,
): Promise<DisplaySettings> {
  const ext = IMAGE_EXT[contentType] ?? null;
  if (!ext) throw new Error("Unsupported image type.");
  const old = findBackgroundFile(orgId);
  if (old) {
    try {
      fs.unlinkSync(old);
    } catch {
      /* ignore */
    }
  }
  fs.writeFileSync(`${BG_PREFIX}-${safeOrg(orgId)}${ext}`, data);
  return saveDisplaySettings(orgId, { backgroundMode: "image" });
}

export async function deleteBackgroundImage(orgId: string): Promise<DisplaySettings> {
  const old = findBackgroundFile(orgId);
  if (old) {
    try {
      fs.unlinkSync(old);
    } catch {
      /* ignore */
    }
  }
  const current = await loadDisplaySettings(orgId);
  return saveDisplaySettings(orgId, {
    backgroundMode: current.backgroundMode === "image" ? "default" : current.backgroundMode,
  });
}
