// Client-safe TOU rate types (no node imports — safe to bundle for the browser).

/**
 * PG&E seasons: summer = June–September, winter = October–May.
 * The peak window is the same year-round on E-TOU-C (4–9pm daily).
 */
export type TouSeason = "summer" | "winter";

export interface TouSettings {
  /** Local HH:MM, 24h — start of the daily peak window (both seasons). */
  peakStart: string;
  /** Local HH:MM, 24h — end of the daily peak window (both seasons). */
  peakEnd: string;
  /** $/kWh imported during peak hours, Jun–Sep. */
  summerPeak: number;
  /** $/kWh imported outside peak hours, Jun–Sep. */
  summerOffPeak: number;
  /** $/kWh credit for exported energy, Jun–Sep (NEM 2.0: ~retail off-peak). */
  summerExport: number;
  /** $/kWh imported during peak hours, Oct–May. */
  winterPeak: number;
  /** $/kWh imported outside peak hours, Oct–May. */
  winterOffPeak: number;
  /** $/kWh credit for exported energy, Oct–May (NEM 2.0: ~retail off-peak). */
  winterExport: number;
  /** Shown in the UI so the defaults are never mistaken for a verified bill. */
  label: string;
}

/**
 * PG&E E-TOU-C — the default TOU plan for residential solar customers —
 * rounded from the published Feb 2026 rate sheet. Replace with the site's
 * actual bill figures if they differ.
 */
export const DEFAULT_TOU_SETTINGS: TouSettings = {
  peakStart: "16:00",
  peakEnd: "21:00",
  summerPeak: 0.2,
  summerOffPeak: 0.1,
  summerExport: 0.1,
  winterPeak: 0.13,
  winterOffPeak: 0.1,
  winterExport: 0.1,
  label: "E-TOU-C · PG&E solar default (NEM 2.0) — verify against the bill",
};

/** PG&E summer season = June through September (1-based month). */
export function seasonForMonth(month: number): TouSeason {
  return month >= 6 && month <= 9 ? "summer" : "winter";
}
