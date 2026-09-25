// Client-safe TOU rate types (no node imports — safe to bundle for the browser).

export interface TouSettings {
  /** $/kWh for imported energy during peak hours. */
  peakRate: number;
  /** Local HH:MM, 24h. */
  peakStart: string;
  /** Local HH:MM, 24h. */
  peakEnd: string;
  /** $/kWh for imported energy outside peak hours. */
  offPeakRate: number;
  /** $/kWh credit for exported energy. */
  exportRate: number;
  /** Shown in the UI so the defaults are never mistaken for a real rate plan. */
  label: string;
}

/**
 * PG&E-style placeholders — intentionally round numbers that must be replaced
 * with the site's actual rate plan. The label says so in the UI.
 */
export const DEFAULT_TOU_SETTINGS: TouSettings = {
  peakRate: 0.6,
  peakStart: "16:00",
  peakEnd: "21:00",
  offPeakRate: 0.36,
  exportRate: 0.04,
  label: "PG&E-style estimates — verify against your actual rate plan",
};
