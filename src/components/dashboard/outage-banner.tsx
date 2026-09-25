import { TriangleAlert } from "lucide-react";
import type { PowerPoint } from "@/lib/pwrcell/types";

/** Grid is down when the inverter says so (anything but GRID_CONNECTED). */
export function isGridOutage(point: PowerPoint | null | undefined): boolean {
  const s = point?.gridState;
  return !!s && !s.toUpperCase().includes("CONNECT");
}

/** 7260s -> "2.0 h", 1500s -> "25 min". Null-safe. */
export function formatBackupTime(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds < 0) return null;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  const h = seconds / 3600;
  return `${h >= 10 ? Math.round(h) : h.toFixed(1)} h`;
}

export function OutageBanner({ point }: { point: PowerPoint | null }) {
  if (!isGridOutage(point)) return null;
  const backup = formatBackupTime(point?.batteryBackupSeconds);
  const soc = point?.batterySoc;
  return (
    <div
      role="alert"
      className="flex items-center gap-4 rounded-xl border-2 border-danger bg-danger/15 px-5 py-4 shadow-[var(--shadow-border)]"
    >
      <TriangleAlert className="size-8 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-lg font-semibold tracking-tight text-danger">
          Grid outage — running on battery{soc != null ? ` (${Math.round(soc)}%)` : ""}
        </p>
        <p className="mt-0.5 text-sm text-fg">
          {backup
            ? `About ${backup} of backup power at current use. Non-essential loads should stay off.`
            : "Conserve power — non-essential loads should stay off."}
        </p>
      </div>
    </div>
  );
}
