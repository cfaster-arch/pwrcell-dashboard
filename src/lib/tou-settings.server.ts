import { getOrgSection, setOrgSection } from "@/lib/org-settings.server";
import { DEFAULT_TOU_SETTINGS, type TouSettings } from "./tou-types";

export { DEFAULT_TOU_SETTINGS };
export type { TouSettings };

function validTime(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function validRate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10;
}

const rateOr = (v: unknown, fb: number) => (validRate(v) ? v : fb);

function sanitize(raw: unknown): TouSettings {
  const r = (raw ?? {}) as Partial<TouSettings> & {
    peakRate?: unknown;
    offPeakRate?: unknown;
    exportRate?: unknown;
  };
  // Back-compat: a pre-seasonal settings file used one rate pair for the year.
  const legacyPeak = validRate(r.peakRate) ? r.peakRate : null;
  const legacyOff = validRate(r.offPeakRate) ? r.offPeakRate : null;
  const legacyExp = validRate(r.exportRate) ? r.exportRate : null;
  return {
    peakStart: validTime(r.peakStart) ? r.peakStart : DEFAULT_TOU_SETTINGS.peakStart,
    peakEnd: validTime(r.peakEnd) ? r.peakEnd : DEFAULT_TOU_SETTINGS.peakEnd,
    summerPeak: rateOr(r.summerPeak, legacyPeak ?? DEFAULT_TOU_SETTINGS.summerPeak),
    summerOffPeak: rateOr(r.summerOffPeak, legacyOff ?? DEFAULT_TOU_SETTINGS.summerOffPeak),
    summerExport: rateOr(r.summerExport, legacyExp ?? DEFAULT_TOU_SETTINGS.summerExport),
    winterPeak: rateOr(r.winterPeak, legacyPeak ?? DEFAULT_TOU_SETTINGS.winterPeak),
    winterOffPeak: rateOr(r.winterOffPeak, legacyOff ?? DEFAULT_TOU_SETTINGS.winterOffPeak),
    winterExport: rateOr(r.winterExport, legacyExp ?? DEFAULT_TOU_SETTINGS.winterExport),
    label:
      typeof r.label === "string" && r.label.trim()
        ? r.label.trim().slice(0, 120)
        : DEFAULT_TOU_SETTINGS.label,
  };
}

export async function loadTouSettings(orgId: string): Promise<TouSettings> {
  const raw = await getOrgSection(orgId, "tou");
  return sanitize(raw);
}

export async function saveTouSettings(orgId: string, patch: Partial<TouSettings>): Promise<TouSettings> {
  const current = await loadTouSettings(orgId);
  const merged = sanitize({ ...current, ...patch });
  await setOrgSection(orgId, "tou", merged);
  return merged;
}

/** Minutes since midnight for an HH:MM string. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
