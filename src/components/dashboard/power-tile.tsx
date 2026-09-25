import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatKw } from "@/lib/pwrcell/format";
import { tileSurfaceStyle } from "@/lib/display-settings";
import { useDisplaySettings } from "./display-settings-context";
import { Gauge, type GaugeZone } from "./gauge";

const ACCENT = {
  solar: "var(--color-solar)",
  home: "var(--color-home)",
  battery: "var(--color-battery)",
  grid: "var(--color-grid)",
} as const;

function zonesFor(
  tone: keyof typeof ACCENT,
  minW: number,
  maxW: number,
): GaugeZone[] {
  const span = maxW - minW;
  const at = (f: number) => minW + span * f;
  switch (tone) {
    case "solar":
      return [
        { fromW: at(0), toW: at(0.5), color: "#e0a04a", opacity: 0.22 },
        { fromW: at(0.5), toW: at(0.8), color: "#e0a04a", opacity: 0.55 },
        { fromW: at(0.8), toW: at(1), color: "#e0a04a", opacity: 1 },
      ];
    case "home":
      return [
        { fromW: at(0), toW: at(0.6), color: "var(--color-home)", opacity: 0.22 },
        { fromW: at(0.6), toW: at(0.85), color: "#d4a056", opacity: 0.65 },
        { fromW: at(0.85), toW: at(1), color: "#d4675a", opacity: 0.9 },
      ];
    case "battery":
      return [
        { fromW: minW, toW: 0, color: "#3aae9a", opacity: 0.75 },
        { fromW: 0, toW: maxW, color: "#e0a04a", opacity: 0.75 },
      ];
    case "grid":
      return [
        { fromW: minW, toW: 0, color: "#5dba7a", opacity: 0.75 },
        { fromW: 0, toW: maxW, color: "#6d93c2", opacity: 0.75 },
      ];
  }
}

const WASH = {
  solar: "bg-solar-dim text-solar",
  home: "bg-home-dim text-home",
  battery: "bg-battery-dim text-battery",
  grid: "bg-grid-dim text-grid",
} as const;

export function PowerTile({
  tone,
  label,
  watts,
  maxW,
  centerZero = false,
  caption,
  icon,
  socPct = null,
}: {
  tone: keyof typeof ACCENT;
  label: string;
  watts: number | null;
  maxW: number;
  centerZero?: boolean;
  caption: string;
  icon: ReactNode;
  socPct?: number | null;
}) {
  const minW = centerZero ? -maxW : 0;
  const display = formatKw(watts);
  const { settings } = useDisplaySettings();
  const customBackdrop = settings.backgroundMode !== "default";
  return (
    <article
      className={cn(
        "plate relative flex min-h-36 flex-col overflow-hidden p-4",
        "sm:min-h-40 sm:p-5",
      )}
      style={tileSurfaceStyle(customBackdrop)}
    >
      <header className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[0.95rem] font-medium text-muted">
          <span
            className="size-2 rounded-full"
            style={{ background: ACCENT[tone], boxShadow: `0 0 8px ${ACCENT[tone]}` }}
            aria-hidden="true"
          />
          {label}
        </p>
        <span className={cn("size-9 rounded-md p-2", WASH[tone])} aria-hidden="true">
          {icon}
        </span>
      </header>
      <div className="mt-1">
        <Gauge
          id={`gauge-${tone}`}
          valueW={watts}
          minW={minW}
          maxW={maxW}
          zones={zonesFor(tone, minW, maxW)}
          accent={ACCENT[tone]}
          display={display}
          socPct={socPct}
          ariaLabel={`${label}: ${display} kilowatts, ${caption}`}
        />
      </div>
      <p className="mt-1 text-sm font-medium tracking-wide text-fg/80">{caption}</p>
    </article>
  );
}
