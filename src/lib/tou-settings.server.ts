import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TOU_SETTINGS, type TouSettings } from "./tou-types";

export { DEFAULT_TOU_SETTINGS };
export type { TouSettings };

const SETTINGS_FILE = path.resolve(process.cwd(), "tou-settings.json");

function validTime(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function validRate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10;
}

function sanitize(raw: unknown): TouSettings {
  const r = (raw ?? {}) as Partial<TouSettings>;
  return {
    peakRate: validRate(r.peakRate) ? r.peakRate : DEFAULT_TOU_SETTINGS.peakRate,
    peakStart: validTime(r.peakStart) ? r.peakStart : DEFAULT_TOU_SETTINGS.peakStart,
    peakEnd: validTime(r.peakEnd) ? r.peakEnd : DEFAULT_TOU_SETTINGS.peakEnd,
    offPeakRate: validRate(r.offPeakRate) ? r.offPeakRate : DEFAULT_TOU_SETTINGS.offPeakRate,
    exportRate: validRate(r.exportRate) ? r.exportRate : DEFAULT_TOU_SETTINGS.exportRate,
    label:
      typeof r.label === "string" && r.label.trim()
        ? r.label.trim().slice(0, 120)
        : DEFAULT_TOU_SETTINGS.label,
  };
}

export function loadTouSettings(): TouSettings {
  try {
    return sanitize(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as unknown);
  } catch {
    return sanitize(null);
  }
}

export function saveTouSettings(patch: Partial<TouSettings>): TouSettings {
  const merged = sanitize({ ...loadTouSettings(), ...patch });
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
  } catch {
    /* best effort */
  }
  return merged;
}

/** Minutes since midnight for an HH:MM string. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
