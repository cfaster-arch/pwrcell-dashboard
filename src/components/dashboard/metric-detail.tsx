import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { clockLabel, formatKwh } from "@/lib/pwrcell/format";
import type { SeriesPoint } from "@/lib/pwrcell/types";
import { cn } from "@/lib/utils";
import { RANGES, type RangeMinutes } from "./power-chart";

export type MetricKey = "solar" | "home" | "battery" | "grid";

type MetricCfg = {
  label: string;
  color: string;
  pick: (p: SeriesPoint) => number | null | undefined;
  signed: boolean;
  negLabel: string;
  posLabel: string;
  blurb: string;
};

export const METRIC_CFG: Record<MetricKey, MetricCfg> = {
  solar: {
    label: "Solar",
    color: "var(--color-solar)",
    pick: (p) => p.solarW,
    signed: false,
    negLabel: "",
    posLabel: "Produced",
    blurb: "Array output over time. Energy is integrated from the 30-second samples kept on the laptop.",
  },
  home: {
    label: "Home",
    color: "var(--color-home)",
    pick: (p) => p.homeW,
    signed: false,
    negLabel: "",
    posLabel: "Consumed",
    blurb: "Whole-home consumption over time, integrated from the 30-second samples.",
  },
  battery: {
    label: "Battery",
    color: "var(--color-battery)",
    pick: (p) => p.batteryW,
    signed: true,
    negLabel: "Charged",
    posLabel: "Discharged",
    blurb: "Positive is discharging, negative is charging. Energy totals are split by direction.",
  },
  grid: {
    label: "Grid",
    color: "var(--color-grid)",
    pick: (p) => p.gridW,
    signed: true,
    negLabel: "Exported",
    posLabel: "Imported",
    blurb: "Positive is importing from the grid, negative is exporting to it.",
  },
};

type Stats = {
  current: number | null;
  peak: number | null;
  avg: number | null;
  min: number | null;
  totalKwh: number;
  posKwh: number;
  negKwh: number;
  samples: number;
};

function computeStats(points: SeriesPoint[], pick: (p: SeriesPoint) => number | null | undefined): Stats {
  const vals = points
    .map((p) => pick(p))
    .filter((v): v is number => v != null && !Number.isNaN(v));
  if (!vals.length) {
    return { current: null, peak: null, avg: null, min: null, totalKwh: 0, posKwh: 0, negKwh: 0, samples: 0 };
  }
  let totalKwh = 0;
  let posKwh = 0;
  let negKwh = 0;
  for (let i = 1; i < points.length; i++) {
    const a = pick(points[i - 1]!);
    const b = pick(points[i]!);
    if (a == null || b == null) continue;
    const dtH = (points[i]!.ts - points[i - 1]!.ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.25) continue; // skip gaps
    const avgW = (a + b) / 2;
    const kwh = (avgW * dtH) / 1000;
    totalKwh += kwh;
    if (avgW >= 0) posKwh += kwh;
    else negKwh += -kwh;
  }
  const sum = vals.reduce((s, v) => s + v, 0);
  return {
    current: vals[vals.length - 1]!,
    peak: Math.max(...vals),
    avg: sum / vals.length,
    min: Math.min(...vals),
    totalKwh,
    posKwh,
    negKwh,
    samples: vals.length,
  };
}

type HourBucket = { ts: number; pos: number; neg: number; net: number };

function hourlyBuckets(points: SeriesPoint[], pick: (p: SeriesPoint) => number | null | undefined): HourBucket[] {
  const buckets = new Map<number, { pos: number; neg: number }>();
  for (let i = 1; i < points.length; i++) {
    const a = pick(points[i - 1]!);
    const b = pick(points[i]!);
    if (a == null || b == null) continue;
    const dtH = (points[i]!.ts - points[i - 1]!.ts) / 3_600_000;
    if (dtH <= 0 || dtH > 0.25) continue;
    const hour = Math.floor(points[i]!.ts / 3_600_000) * 3_600_000;
    const avgW = (a + b) / 2;
    const kwh = (avgW * dtH) / 1000;
    const bucket = buckets.get(hour) ?? { pos: 0, neg: 0 };
    if (avgW >= 0) bucket.pos += kwh;
    else bucket.neg += -kwh;
    buckets.set(hour, bucket);
  }
  return [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([ts, b]) => ({ ts, pos: b.pos, neg: b.neg, net: b.pos - b.neg }));
}

function toKw(w: number | null): number | null {
  return w == null ? null : Math.round((w / 1000) * 100) / 100;
}

function fmtSignedKw(w: number | null): string {
  if (w == null) return "—";
  const kw = w / 1000;
  const mag = Math.abs(kw) >= 10 ? Math.abs(kw).toFixed(1) : Math.abs(kw).toFixed(2);
  return `${kw < 0 ? "−" : ""}${mag}`;
}

function StatTile({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
      <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">{label}</p>
      <p className="mt-2 font-mono text-2xl font-medium tracking-tight tabular-nums" style={accent ? { color: accent } : undefined}>
        {value}
        {unit ? <span className="ml-1 text-sm font-normal text-muted">{unit}</span> : null}
      </p>
    </div>
  );
}

export function MetricDetail({
  metric,
  points,
  timeZone,
  minutes,
  onMinutes,
}: {
  metric: MetricKey;
  points: SeriesPoint[];
  timeZone?: string | null;
  minutes: RangeMinutes;
  onMinutes: (m: RangeMinutes) => void;
}) {
  const cfg = METRIC_CFG[metric];
  const stats = useMemo(() => computeStats(points, cfg.pick), [points, cfg]);
  const hourly = useMemo(() => hourlyBuckets(points, cfg.pick), [points, cfg]);
  const chartData = useMemo(
    () =>
      points.map((p) => ({
        ts: p.ts,
        kw: toKw(cfg.pick(p) ?? null),
      })),
    [points, cfg],
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Current" value={fmtSignedKw(stats.current)} unit="kW" accent={cfg.color} />
        <StatTile label="Peak" value={fmtSignedKw(stats.peak)} unit="kW" />
        <StatTile label="Average" value={fmtSignedKw(stats.avg)} unit="kW" />
        <StatTile label="Minimum" value={fmtSignedKw(stats.min)} unit="kW" />
        {cfg.signed ? (
          <>
            <StatTile label={cfg.posLabel} value={formatKwh(stats.posKwh).replace(" kWh", "")} unit="kWh" />
            <StatTile label={cfg.negLabel} value={formatKwh(stats.negKwh).replace(" kWh", "")} unit="kWh" />
          </>
        ) : (
          <>
            <StatTile label={`Energy ${cfg.posLabel.toLowerCase()}`} value={formatKwh(stats.totalKwh).replace(" kWh", "")} unit="kWh" accent={cfg.color} />
            <StatTile label="Samples" value={String(stats.samples)} />
          </>
        )}
      </section>

      <section className="flex flex-col rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-tile-label font-medium tracking-[0.16em] text-muted uppercase">
            {cfg.label} power (kW)
          </h2>
          <div className="flex rounded-md bg-surface-2 p-1" role="tablist" aria-label="Chart range">
            {RANGES.map((r) => (
              <button
                key={r.minutes}
                type="button"
                role="tab"
                aria-selected={minutes === r.minutes}
                onClick={() => onMinutes(r.minutes)}
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
        <div className="h-72 w-full sm:h-80">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%" debounce={50}>
              <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--color-border)" vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(v) => clockLabel(Number(v), timeZone)}
                  tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={36}
                />
                <YAxis
                  tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <ReferenceLine y={0} stroke="var(--color-border-strong)" />
                <Tooltip
                  cursor={{ stroke: "var(--color-border-strong)" }}
                  content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length || label == null) return null;
                    return (
                      <div className="rounded-md bg-surface-2 px-3 py-2 shadow-[var(--shadow-border)]">
                        <p className="mb-1 font-mono text-xs text-muted">{clockLabel(Number(label), timeZone)}</p>
                        <p className="font-mono text-sm tabular-nums text-fg">
                          {Number(payload[0].value).toFixed(2)} kW
                        </p>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="kw"
                  stroke={cfg.color}
                  fill={cfg.color}
                  fillOpacity={0.18}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              Waiting for the first samples…
            </div>
          )}
        </div>
      </section>

      <section className="flex flex-col rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5">
        <h2 className="mb-3 text-tile-label font-medium tracking-[0.16em] text-muted uppercase">
          Energy per hour (kWh)
        </h2>
        <div className="h-56 w-full sm:h-64">
          {hourly.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%" debounce={50}>
              <BarChart data={hourly} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap="28%">
                <CartesianGrid stroke="var(--color-border)" vertical={false} />
                <XAxis
                  dataKey="ts"
                  tickFormatter={(v) => clockLabel(Number(v), timeZone).replace(/:\d\d\s?/, " ")}
                  tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={36}
                />
                <YAxis
                  tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <ReferenceLine y={0} stroke="var(--color-border-strong)" />
                <Tooltip
                  cursor={{ fill: "var(--color-border)" }}
                  content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length || label == null) return null;
                    const row = payload[0]?.payload as HourBucket | undefined;
                    if (!row) return null;
                    return (
                      <div className="rounded-md bg-surface-2 px-3 py-2 shadow-[var(--shadow-border)]">
                        <p className="mb-1 font-mono text-xs text-muted">{clockLabel(Number(label), timeZone)}</p>
                        {cfg.signed ? (
                          <>
                            <p className="font-mono text-sm tabular-nums text-fg">{cfg.posLabel}: {row.pos.toFixed(2)} kWh</p>
                            <p className="font-mono text-sm tabular-nums text-fg">{cfg.negLabel}: {row.neg.toFixed(2)} kWh</p>
                          </>
                        ) : (
                          <p className="font-mono text-sm tabular-nums text-fg">{row.net.toFixed(2)} kWh</p>
                        )}
                      </div>
                    );
                  }}
                />
                {cfg.signed ? (
                  <>
                    <Bar dataKey="pos" name={cfg.posLabel} fill={cfg.color} fillOpacity={0.85} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="neg" name={cfg.negLabel} fill={cfg.color} fillOpacity={0.35} radius={[3, 3, 0, 0]} />
                  </>
                ) : (
                  <Bar dataKey="net" name="kWh" fill={cfg.color} fillOpacity={0.85} radius={[3, 3, 0, 0]} />
                )}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              Not enough history yet — check back after an hour of polling.
            </div>
          )}
        </div>
        {cfg.signed ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-3 text-xs tracking-wide text-muted">
            <span className="inline-flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: cfg.color, opacity: 0.85 }} />
              {cfg.posLabel}
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: cfg.color, opacity: 0.35 }} />
              {cfg.negLabel}
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
