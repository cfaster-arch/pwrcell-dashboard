import { Battery, Home, SunMedium, UtilityPole } from "lucide-react";
import { batteryDirection, formatKw, gridDirection } from "@/lib/pwrcell/format";
import type { PowerPoint } from "@/lib/pwrcell/types";
import { cn } from "@/lib/utils";

function FlowNode({
  label,
  value,
  caption,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  caption: string;
  tone: "solar" | "home" | "battery" | "grid";
  icon: typeof SunMedium;
}) {
  const color =
    tone === "solar"
      ? "text-solar"
      : tone === "battery"
        ? "text-battery"
        : tone === "grid"
          ? "text-grid"
          : "text-home";
  const wash =
    tone === "solar"
      ? "bg-solar-dim"
      : tone === "battery"
        ? "bg-battery-dim"
        : tone === "grid"
          ? "bg-grid-dim"
          : "bg-home-dim";
  return (
    <div className={cn("flex min-h-20 flex-col items-center justify-center rounded-lg px-3 py-2", wash)}>
      <Icon className={cn("size-4", color)} aria-hidden="true" />
      <p className="mt-1 text-[10px] tracking-[0.16em] text-muted uppercase">{label}</p>
      <p className={cn("font-mono text-lg font-medium tabular-nums", color)}>{value}</p>
      <p className="text-[11px] text-subtle">{caption}</p>
    </div>
  );
}

function Connector({
  active,
  reverse,
  tone,
  className,
}: {
  active: boolean;
  reverse?: boolean;
  tone: "solar" | "battery" | "grid";
  className?: string;
}) {
  const color =
    tone === "solar" ? "bg-solar" : tone === "battery" ? "bg-battery" : "bg-grid";
  return (
    <div className={cn("relative flex items-center justify-center", className)} aria-hidden="true">
      <span className={cn("h-full w-px rounded-full", active ? color : "bg-border-strong")} />
      {active ? (
        <span
          className={cn(
            "absolute size-1.5 rounded-full",
            color,
            reverse ? "bottom-1" : "top-1",
            "status-dot",
          )}
        />
      ) : null}
    </div>
  );
}

export function PowerFlow({ point, className }: { point: PowerPoint | null; className?: string }) {
  const solar = point?.solarW ?? 0;
  const home = point?.homeW ?? 0;
  const battery = point?.batteryW ?? 0;
  const grid = point?.gridW ?? 0;
  const battDir = batteryDirection(battery);
  const gridDir = gridDirection(grid);

  return (
    <section className={cn("flex min-h-64 flex-col rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5", className)}>
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-tile-label font-medium tracking-[0.16em] text-muted uppercase">Power flow</h2>
        <p className="text-xs tracking-wide text-subtle">Live path of watts</p>
      </header>
      <div className="grid flex-1 grid-cols-3 grid-rows-[auto_1.5rem_auto] items-stretch gap-x-2">
        <div />
        <FlowNode
          label="Solar"
          value={formatKw(solar)}
          caption={solar > 50 ? "producing" : "idle"}
          tone="solar"
          icon={SunMedium}
        />
        <div />
        <div />
        <Connector active={solar > 50} tone="solar" className="h-6" />
        <div />
        <FlowNode
          label="Grid"
          value={formatKw(grid)}
          caption={gridDir}
          tone="grid"
          icon={UtilityPole}
        />
        <FlowNode
          label="Home"
          value={formatKw(home)}
          caption="using"
          tone="home"
          icon={Home}
        />
        <FlowNode
          label="Battery"
          value={formatKw(battery)}
          caption={battDir}
          tone="battery"
          icon={Battery}
        />
      </div>
    </section>
  );
}
