import type { TouSettings } from "./tou-types";

/** "16:00" -> minutes after midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Minutes after midnight in the site's timezone. */
function localMinutes(now: number, timeZone?: string | null): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? undefined,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date(now));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  } catch {
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes();
  }
}

function fmtHour(hhmm: string): string {
  const [h] = hhmm.split(":").map(Number);
  const hr = ((h + 11) % 12) + 1;
  const ap = h >= 12 ? "PM" : "AM";
  return `${hr} ${ap}`;
}

export interface RatePeriod {
  peak: boolean;
  /** Short pill label, e.g. "PEAK". */
  label: string;
  /** Longer caption, e.g. "PEAK · until 9 PM". */
  detail: string;
}

/**
 * Which TOU period we're in right now, from the configured peak window.
 * Peak is 4–9pm daily on E-TOU-C; the window comes from settings so a
 * future bill-corrected plan just works.
 */
export function describeRatePeriod(
  s: TouSettings,
  now: number,
  timeZone?: string | null,
): RatePeriod {
  const mins = localMinutes(now, timeZone);
  const start = toMinutes(s.peakStart);
  const end = toMinutes(s.peakEnd);
  const inPeak = start <= end ? mins >= start && mins < end : mins >= start || mins < end;
  if (inPeak) {
    return { peak: true, label: "PEAK", detail: `PEAK · until ${fmtHour(s.peakEnd)}` };
  }
  // Off-peak: say when the next peak starts.
  const nextPeak = mins < start ? `peak ${fmtHour(s.peakStart)}` : `peak ${fmtHour(s.peakStart)} tomorrow`;
  return { peak: false, label: "Off-peak", detail: `Off-peak · ${nextPeak}` };
}

/** True during the local night-dim window (22:00–06:00). */
export function isNightHour(now: number, timeZone?: string | null): boolean {
  const mins = localMinutes(now, timeZone);
  return mins >= 22 * 60 || mins < 6 * 60;
}
