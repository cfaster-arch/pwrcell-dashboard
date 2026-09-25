import type { ReactNode } from "react";
import { tileSurfaceStyle } from "@/lib/display-settings";
import { useDisplaySettings } from "./display-settings-context";

const RAIL: Record<string, string> = {
  solar: "var(--color-solar)",
  home: "var(--color-home)",
  battery: "var(--color-battery)",
  grid: "var(--color-grid)",
};

function formatKw(watts: number | null | undefined): string {
  if (watts == null || Number.isNaN(watts)) return "—";
  const kw = Math.abs(watts) / 1000;
  return kw >= 10 ? kw.toFixed(1) : kw.toFixed(2);
}

export function ClassicTile({
  tone,
  label,
  icon,
  watts,
  caption,
  socPct,
}: {
  tone: "solar" | "home" | "battery" | "grid";
  label: string;
  icon: ReactNode;
  watts: number | null | undefined;
  caption: string;
  socPct?: number | null;
}) {
  const { settings } = useDisplaySettings();
  const customBackdrop = settings.backgroundMode !== "default";
  return (
    <article
      className="relative flex min-h-40 flex-col overflow-hidden rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5"
      style={tileSurfaceStyle(customBackdrop)}
    >
      <span
        className="absolute top-0 bottom-0 left-0 w-1"
        style={{ background: RAIL[tone] }}
        aria-hidden="true"
      />
      <header className="flex items-center justify-between pl-2">
        <p className="text-tile-label font-medium tracking-[0.16em] text-muted uppercase">{label}</p>
        <span className="flex size-6 items-center justify-center" aria-hidden="true">
          {icon}
        </span>
      </header>
      <div className="mt-3 flex items-end gap-2 pl-2">
        <p
          className="font-mono text-hero leading-none font-medium tracking-tight tabular-nums"
          style={{ color: RAIL[tone] }}
        >
          {formatKw(watts)}
        </p>
        <span className="mb-1 font-mono text-sm text-muted">kW</span>
      </div>
      <p className="mt-3 pl-2 text-sm font-medium text-fg/80">{caption}</p>
      {socPct != null ? (
        <div className="mt-auto pt-4 pl-2">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
            <span>Charge</span>
            <span className="font-mono text-fg tabular-nums">{Math.round(socPct)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, socPct))}%`, background: RAIL[tone] }}
            />
          </div>
        </div>
      ) : null}
    </article>
  );
}
