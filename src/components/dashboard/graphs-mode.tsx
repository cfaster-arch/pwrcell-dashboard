import { useEffect, useState } from "react";
import type { SeriesPoint } from "@/lib/pwrcell/types";
import { CostSection } from "./cost-section";
import { METRIC_DEFS, MetricChart } from "./metric-chart";
import { PowerChart, type RangeMinutes } from "./power-chart";
import { HistoryRangeTabs, SocChart, type HistoryChartPoint, type HistoryRangeKey } from "./soc-chart";

/**
 * Graphs mode: the large live power chart, per-metric history charts,
 * battery charge history, and grid cost — rendered exclusively (no
 * tiles or gauges alongside it).
 */
export function GraphsMode({
  livePoints,
  liveMinutes,
  onLiveRange,
  timeZone,
}: {
  livePoints: SeriesPoint[];
  liveMinutes: RangeMinutes;
  onLiveRange: (m: RangeMinutes) => void;
  timeZone?: string | null;
}) {
  const [range, setRange] = useState<HistoryRangeKey>("24h");
  const [points, setPoints] = useState<HistoryChartPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const tz = timeZone || "America/Los_Angeles";
    fetch(`/api/history?range=${range}&tz=${encodeURIComponent(tz)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { points?: HistoryChartPoint[] } | null) => {
        if (!cancelled) {
          setPoints(body?.points ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, timeZone]);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PowerChart
        points={livePoints}
        minutes={liveMinutes}
        onRange={onLiveRange}
        timeZone={timeZone}
      />
      <section aria-label="History range">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-tile-label font-medium tracking-[0.16em] text-muted uppercase">
            History
          </h2>
          <HistoryRangeTabs range={range} onRange={setRange} label="History range" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
          {METRIC_DEFS.map((m) => (
            <MetricChart key={m.key} metric={m} points={points} timeZone={timeZone} />
          ))}
        </div>
      </section>
      {loading && points.length === 0 ? (
        <section className="rounded-xl bg-surface p-8 text-center text-sm text-muted shadow-[var(--shadow-border)]">
          Loading history…
        </section>
      ) : (
        <SocChart points={points} timeZone={timeZone} />
      )}
      <CostSection timeZone={timeZone} />
    </div>
  );
}
