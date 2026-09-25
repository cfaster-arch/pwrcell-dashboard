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
import { cn } from "@/lib/utils";

export type HistoryRangeKey = "24h" | "7d" | "30d";

export const HISTORY_RANGES: Array<{ label: string; key: HistoryRangeKey }> = [
  { label: "24 h", key: "24h" },
  { label: "7 d", key: "7d" },
  { label: "30 d", key: "30d" },
];

export interface HistoryChartPoint {
  ts: number;
  solarW: number | null;
  homeW: number | null;
  batteryW: number | null;
  gridW: number | null;
  soc: number | null;
}

function SocTooltip({
  active,
  payload,
  label,
  timeZone,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: number;
  timeZone?: string | null;
}) {
  if (!active || !payload?.length || label == null) return null;
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2 shadow-[var(--shadow-border)]">
      <p className="mb-1 font-mono text-xs text-muted">{clockLabel(label, timeZone)}</p>
      <p className="font-mono text-sm tabular-nums text-fg">
        {Number(payload[0].value).toFixed(0)}% SoC
      </p>
    </div>
  );
}

export function HistoryRangeTabs({
  range,
  onRange,
  label,
}: {
  range: HistoryRangeKey;
  onRange: (r: HistoryRangeKey) => void;
  label: string;
}) {
  return (
    <div className="flex rounded-md bg-surface-2 p-1" role="tablist" aria-label={label}>
      {HISTORY_RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          role="tab"
          aria-selected={range === r.key}
          onClick={() => onRange(r.key)}
          className={cn(
            "min-h-11 min-w-16 rounded-sm px-3 font-medium tracking-wide transition-[background-color,color,transform] duration-150 ease-out",
            "active:scale-[0.96]",
            range === r.key ? "bg-fg text-bg" : "text-muted hover:text-fg",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function SocChart({
  points,
  timeZone,
}: {
  points: HistoryChartPoint[];
  timeZone?: string | null;
}) {
  const data = useMemo(
    () =>
      points
        .filter((p) => p.soc != null)
        .map((p) => ({ ts: p.ts, soc: Math.round((p.soc as number) * 10) / 10 })),
    [points],
  );

  return (
    <section className="flex flex-col rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-tile-label font-medium tracking-[0.16em] text-muted uppercase">
          Battery charge history
        </h2>
      </header>
      <div className="h-48 w-full sm:h-56">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%" debounce={50}>
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
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={44}
              />
              <Tooltip
                content={<SocTooltip timeZone={timeZone} />}
                cursor={{ stroke: "var(--color-border-strong)" }}
              />
              <ReferenceLine y={20} stroke="var(--color-danger)" strokeDasharray="4 4" />
              <Area
                type="monotone"
                dataKey="soc"
                name="SoC"
                stroke="var(--color-battery)"
                fill="var(--color-battery)"
                fillOpacity={0.22}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            No charge history yet — samples accumulate one per minute.
          </div>
        )}
      </div>
    </section>
  );
}
