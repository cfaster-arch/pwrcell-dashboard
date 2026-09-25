import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { clockLabel } from "@/lib/pwrcell/format";
import type { SeriesPoint } from "@/lib/pwrcell/types";
import { cn } from "@/lib/utils";

const RANGES = [
  { label: "30 m", minutes: 30 },
  { label: "2 h", minutes: 120 },
  { label: "12 h", minutes: 720 },
] as const;

type RangeMinutes = (typeof RANGES)[number]["minutes"];

function toKw(w: number): number {
  return Math.round((w / 1000) * 100) / 100;
}

function ChartTooltip({
  active,
  payload,
  label,
  timeZone,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
  timeZone?: string | null;
}) {
  if (!active || !payload?.length || label == null) return null;
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2 shadow-[var(--shadow-border)]">
      <p className="mb-1 font-mono text-xs text-muted">{clockLabel(label, timeZone)}</p>
      <ul className="space-y-0.5">
        {payload.map((row) => (
          <li key={row.name} className="flex items-center justify-between gap-6 text-sm">
            <span className="flex items-center gap-2 text-muted">
              <span className="size-2 rounded-full" style={{ background: row.color }} />
              {row.name}
            </span>
            <span className="font-mono tabular-nums text-fg">{Number(row.value).toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PowerChart({
  points,
  minutes,
  onRange,
  timeZone,
}: {
  points: SeriesPoint[];
  minutes: RangeMinutes;
  onRange: (minutes: RangeMinutes) => void;
  timeZone?: string | null;
}) {
  const data = useMemo(
    () =>
      points.map((p) => ({
        ts: p.ts,
        Solar: toKw(p.solarW),
        Home: toKw(p.homeW),
        Battery: toKw(p.batteryW),
        Grid: toKw(p.gridW),
      })),
    [points],
  );

  return (
    <section className="flex flex-col rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-tile-label font-medium tracking-[0.16em] text-muted uppercase">
          Production vs load
        </h2>
        <div className="flex rounded-md bg-surface-2 p-1" role="tablist" aria-label="Chart range">
          {RANGES.map((r) => (
            <button
              key={r.minutes}
              type="button"
              role="tab"
              aria-selected={minutes === r.minutes}
              onClick={() => onRange(r.minutes)}
              className={cn(
                "min-h-11 min-w-16 rounded-sm px-3 font-medium tracking-wide transition-[background-color,color,transform] duration-150 ease-out",
                "active:scale-[0.96]",
                minutes === r.minutes ? "bg-fg text-bg" : "text-muted hover:text-fg",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pb-2 text-xs tracking-wide text-muted">
        <LegendSwatch color="var(--color-solar)" label="Solar" />
        <LegendSwatch color="var(--color-home)" label="Home" />
        <LegendSwatch color="var(--color-battery)" label="Battery" />
        <LegendSwatch color="var(--color-grid)" label="Grid" />
      </div>
      <div className="h-56 w-full sm:h-64">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height={256} debounce={50}>
            <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v) => clockLabel(Number(v), timeZone)}
                tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis
                tickFormatter={(v) => `${v}`}
                tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={36}
              />
              <ReferenceLine y={0} stroke="var(--color-border-strong)" />
              <Tooltip
                content={<ChartTooltip timeZone={timeZone} />}
                cursor={{ stroke: "var(--color-border-strong)" }}
              />
              <Area type="monotone" dataKey="Solar" stroke="var(--color-solar)" fill="var(--color-solar)" fillOpacity={0.18} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="Home" stroke="var(--color-home)" fill="var(--color-home)" fillOpacity={0.08} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="Battery" stroke="var(--color-battery)" fill="var(--color-battery)" fillOpacity={0.14} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="Grid" stroke="var(--color-grid)" fill="var(--color-grid)" fillOpacity={0.12} strokeWidth={2} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            Waiting for the first samples…
          </div>
        )}
      </div>
    </section>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

export { RANGES };
export type { RangeMinutes };
