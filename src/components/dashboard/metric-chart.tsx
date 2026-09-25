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
import { clockLabel, formatKw } from "@/lib/pwrcell/format";
import type { HistoryChartPoint } from "./soc-chart";

export type MetricKey = "solarW" | "homeW" | "batteryW" | "gridW";

export const METRIC_DEFS: Array<{ key: MetricKey; label: string; color: string; unit: string }> = [
  { key: "solarW", label: "Solar", color: "var(--color-solar)", unit: "kW" },
  { key: "homeW", label: "Home", color: "var(--color-home)", unit: "kW" },
  { key: "batteryW", label: "Battery", color: "var(--color-battery)", unit: "kW" },
  { key: "gridW", label: "Grid", color: "var(--color-grid)", unit: "kW" },
];

function MetricTooltip({
  active,
  payload,
  label,
  timeZone,
  color,
  metricLabel,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
  timeZone?: string | null;
  color: string;
  metricLabel: string;
}) {
  if (!active || !payload?.length || label == null) return null;
  return (
    <div className="well px-3 py-2">
      <p className="mb-1 font-mono text-xs text-muted">{clockLabel(label, timeZone)}</p>
      <p className="flex items-center gap-2 font-mono text-sm tabular-nums text-fg">
        <span className="size-2 rounded-full" style={{ background: color }} />
        {metricLabel} {formatKw(Number(payload[0].value) * 1000)}
      </p>
    </div>
  );
}

/** Compact per-metric area chart, fed by downsampled history points. */
export function MetricChart({
  metric,
  points,
  timeZone,
}: {
  metric: (typeof METRIC_DEFS)[number];
  points: HistoryChartPoint[];
  timeZone?: string | null;
}) {
  const data = useMemo(
    () =>
      points
        .filter((p) => p[metric.key] != null)
        .map((p) => ({
          ts: p.ts,
          kw: Math.round(((p[metric.key] as number) / 1000) * 100) / 100,
        })),
    [points, metric.key],
  );

  return (
    <section className="flex flex-col plate p-4">
      <header className="mb-2 flex items-center justify-between gap-3">
        <h3 className="eyebrow">
          {metric.label}
        </h3>
        <span className="size-2.5 rounded-full" style={{ background: metric.color }} />
      </header>
      <div className="h-36 w-full">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%" debounce={50}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v) => clockLabel(Number(v), timeZone)}
                tick={{ fill: "var(--color-muted)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                tickFormatter={(v) => `${v}`}
                tick={{ fill: "var(--color-muted)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={32}
              />
              <ReferenceLine y={0} stroke="var(--color-border-strong)" />
              <Tooltip
                content={
                  <MetricTooltip
                    timeZone={timeZone}
                    color={metric.color}
                    metricLabel={metric.label}
                  />
                }
                cursor={{ stroke: "var(--color-border-strong)" }}
              />
              <Area
                type="monotone"
                dataKey="kw"
                name={metric.label}
                stroke={metric.color}
                fill={metric.color}
                fillOpacity={0.18}
                strokeWidth={1.75}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            No history yet.
          </div>
        )}
      </div>
    </section>
  );
}
