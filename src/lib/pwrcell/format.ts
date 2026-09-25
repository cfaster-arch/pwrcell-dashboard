const IDLE_W = 50;

export function formatKw(watts: number | null | undefined): string {
  if (watts == null || Number.isNaN(watts)) return "—";
  const kw = Math.abs(watts) / 1000;
  if (kw >= 10) return kw.toFixed(1);
  return kw.toFixed(2);
}

export function formatKwh(kwh: number | null | undefined): string {
  if (kwh == null || Number.isNaN(kwh)) return "—";
  if (kwh >= 1000) return `${kwh.toFixed(0)} kWh`;
  if (kwh >= 100) return `${kwh.toFixed(1)} kWh`;
  return `${kwh.toFixed(2)} kWh`;
}

export function formatSoc(soc: number | null | undefined): string {
  if (soc == null || Number.isNaN(soc)) return "—";
  return `${Math.round(soc)}%`;
}

export function formatHours(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return "—";
  const hours = seconds / 3600;
  if (hours >= 24) {
    const d = Math.floor(hours / 24);
    const h = Math.round(hours % 24);
    return `${d}d ${h}h`;
  }
  if (hours >= 10) return `${hours.toFixed(1)} h`;
  return `${hours.toFixed(1)} h`;
}

export function batteryDirection(watts: number | null | undefined): "charging" | "discharging" | "idle" {
  if (watts == null) return "idle";
  if (watts > IDLE_W) return "discharging";
  if (watts < -IDLE_W) return "charging";
  return "idle";
}

export function gridDirection(watts: number | null | undefined): "importing" | "exporting" | "idle" {
  if (watts == null) return "idle";
  if (watts > IDLE_W) return "importing";
  if (watts < -IDLE_W) return "exporting";
  return "idle";
}

export function prettyState(raw: string | null | undefined): string {
  if (!raw) return "—";
  const stripped = raw
    .replace(/^BATTERY_SOC_STATUS_/, "")
    .replace(/^GRID_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  if (!stripped || stripped === "unspecified") return "—";
  return stripped.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function prettyMode(raw: string | null | undefined): string {
  if (!raw) return "—";
  return raw
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function clockLabel(ts: number, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ts));
  }
}

export function weekdayLabel(ts: number, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(ts));
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(ts));
  }
}
