// Client-safe alert types (no node imports — safe to bundle for the browser).

export type AlertRuleKey =
  | "gridOutage"
  | "gridRestored"
  | "lowSoc"
  | "feedStale"
  | "pollError";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRow {
  id: number;
  ts: string;
  rule: AlertRuleKey;
  severity: AlertSeverity;
  message: string;
  acknowledged: boolean;
}

export interface AlertSettings {
  /** Master switch — when off, no alerts fire and nothing is pushed. */
  enabled: boolean;
  /** SoC % below which the lowSoc rule fires. */
  lowSocThreshold: number;
  /** ntfy.sh topic for push notifications. Empty = push disabled. */
  ntfyTopic: string;
  rules: Record<AlertRuleKey, { enabled: boolean }>;
}

export const ALERT_RULES: Array<{
  key: AlertRuleKey;
  label: string;
  severity: AlertSeverity;
  blurb: string;
}> = [
  { key: "gridOutage", label: "Grid outage", severity: "critical", blurb: "Fires when the grid leaves grid-connected." },
  { key: "gridRestored", label: "Grid restored", severity: "info", blurb: "Fires when the grid reconnects after an outage." },
  { key: "lowSoc", label: "Battery low", severity: "warning", blurb: "Fires when battery SoC drops below the threshold." },
  { key: "feedStale", label: "Feed stale", severity: "warning", blurb: "Fires when no successful cloud poll for 10+ minutes." },
  { key: "pollError", label: "Poll / inverter error", severity: "warning", blurb: "Fires when a poll fails or the inverter reports an error." },
];
