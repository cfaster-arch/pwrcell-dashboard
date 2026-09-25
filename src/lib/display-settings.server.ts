import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_DISPLAY_SETTINGS,
  type BackgroundMode,
  type DisplayMode,
  type DisplaySettings,
  type GaugeStyle,
  type ThemeName,
} from "./display-settings";

const SETTINGS_FILE = path.resolve(process.cwd(), "display-settings.json");
const BG_PREFIX = path.resolve(process.cwd(), "display-background");

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function sanitize(raw: unknown): DisplaySettings {
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
    hasBackgroundImage: findBackgroundFile() !== null,
  };
  if (s.backgroundMode === "image" && !s.hasBackgroundImage) s.backgroundMode = "default";
  return s;
}

export function loadDisplaySettings(): DisplaySettings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as unknown;
    return sanitize(raw);
  } catch {
    return sanitize(null);
  }
}

export function saveDisplaySettings(patch: Partial<DisplaySettings>): DisplaySettings {
  const next = sanitize({ ...loadDisplaySettings(), ...patch, hasBackgroundImage: undefined });
  const { hasBackgroundImage: _ignored, ...persisted } = next;
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(persisted, null, 2) + "\n", "utf8");
  } catch {
    // Best effort: a read-only FS keeps running with in-memory values for this tick.
  }
  return next;
}

function findBackgroundFile(): string | null {
  for (const ext of Object.values(IMAGE_EXT)) {
    const p = BG_PREFIX + ext;
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not present */
    }
  }
  return null;
}

export function getBackgroundFile(): { path: string; contentType: string } | null {
  const found = findBackgroundFile();
  if (!found) return null;
  const ext = path.extname(found);
  const entry = Object.entries(IMAGE_EXT).find(([, e]) => e === ext);
  return { path: found, contentType: entry ? entry[0] : "application/octet-stream" };
}

export function saveBackgroundImage(data: Buffer, contentType: string): DisplaySettings {
  const ext = IMAGE_EXT[contentType] ?? null;
  if (!ext) throw new Error("Unsupported image type.");
  const old = findBackgroundFile();
  if (old) {
    try {
      fs.unlinkSync(old);
    } catch {
      /* ignore */
    }
  }
  fs.writeFileSync(BG_PREFIX + ext, data);
  return saveDisplaySettings({ backgroundMode: "image" });
}

export function deleteBackgroundImage(): DisplaySettings {
  const old = findBackgroundFile();
  if (old) {
    try {
      fs.unlinkSync(old);
    } catch {
      /* ignore */
    }
  }
  const current = loadDisplaySettings();
  return saveDisplaySettings({
    backgroundMode: current.backgroundMode === "image" ? "default" : current.backgroundMode,
  });
}
