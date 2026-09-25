import type { CSSProperties } from "react";
import { Battery, Home, SunMedium, UtilityPole } from "lucide-react";
import { batteryDirection, formatKw, gridDirection } from "@/lib/pwrcell/format";
import type { PowerPoint } from "@/lib/pwrcell/types";
import { cn } from "@/lib/utils";

/** Watts above which a branch counts as carrying flow. */
const FLOW_W = 50;

type Tone = "solar" | "home" | "battery" | "grid";

/**
 * Seconds per dash cycle — bigger flows visibly move faster.
 * ~0.35s at 4.5kW+, stretching to 2.5s near the idle threshold.
 */
function flowDuration(watts: number): number {
  const kw = Math.max(Math.abs(watts) / 1000, 0.05);
  return Math.min(2.5, Math.max(0.35, 1.6 / kw));
}

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
  tone: Tone;
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
    <div
      className={cn(
        "flex min-h-20 flex-col items-center justify-center rounded-lg px-3 py-2",
        wash,
      )}
    >
      <Icon className={cn("size-4", color)} aria-hidden="true" />
      <p className="mt-1 text-[10px] tracking-[0.16em] text-muted uppercase">{label}</p>
      <p className={cn("font-mono text-lg font-medium tabular-nums", color)}>{value}</p>
      <p className="text-[11px] text-subtle">{caption}</p>
    </div>
  );
}

/**
 * One branch of the flow diagram. A dim track is always drawn; when the
 * branch is active, dashes stream along it — down/right for positive watts,
 * up/left for negative, faster for bigger flows.
 */
function FlowSegment({
  watts,
  tone,
  orientation,
  className,
}: {
  /** Signed watts. Positive flows down (vertical) or right (horizontal). */
  watts: number;
  tone: Exclude<Tone, "home">;
  orientation: "v" | "h";
  className?: string;
}) {
  const active = Math.abs(watts) > FLOW_W;
  const forward = watts >= 0;
  const track =
    tone === "solar" ? "bg-solar-dim" : tone === "battery" ? "bg-battery-dim" : "bg-grid-dim";
  return (
    <div className={cn("relative", className)} aria-hidden="true">
      <span
        className={cn(
          "absolute inset-0 m-auto rounded-full",
          active ? track : "bg-border-strong",
          orientation === "v" ? "h-full w-px" : "h-px w-full",
        )}
      />
      {active ? (
        <span
          className={cn(
            "absolute inset-0 m-auto rounded-full",
            orientation === "v" ? "flow-dash-v h-full w-[3px]" : "flow-dash-h h-[3px] w-full",
            !forward && "flow-rev",
          )}
          style={
            {
              "--flow-color": `var(--color-${tone})`,
              animationDuration: `${flowDuration(watts).toFixed(2)}s`,
            } as CSSProperties
          }
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
    <section
      className={cn(
        "flex min-h-64 flex-col rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5",
        className,
      )}
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-tile-label font-medium tracking-[0.16em] text-muted uppercase">
          Power flow
        </h2>
        <p className="text-xs tracking-wide text-subtle">Live path of watts</p>
      </header>
      <div className="grid flex-1 grid-cols-[1fr_2.5rem_1fr_2.5rem_1fr] grid-rows-[auto_2rem_auto] items-stretch">
        <div />
        <div />
        <FlowNode
          label="Solar"
          value={formatKw(solar)}
          caption={solar > FLOW_W ? "producing" : "idle"}
          tone="solar"
          icon={SunMedium}
        />
        <div />
        <div />
        <div />
        <div />
        <FlowSegment watts={solar} tone="solar" orientation="v" className="h-8" />
        <div />
        <div />
        <FlowNode
          label="Grid"
          value={formatKw(grid)}
          caption={gridDir}
          tone="grid"
          icon={UtilityPole}
        />
        {/* positive grid = importing: flows right, toward home */}
        <FlowSegment watts={grid} tone="grid" orientation="h" />
        <FlowNode label="Home" value={formatKw(home)} caption="using" tone="home" icon={Home} />
        {/* positive battery = discharging: flows left, toward home — so negate */}
        <FlowSegment watts={-battery} tone="battery" orientation="h" />
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
