import { useEffect, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { LivePayload, SeriesPayload } from "@/lib/pwrcell/types";
import {
  METRIC_RANGES,
  METRIC_CFG,
  type ChartPoint,
  type MetricKey,
  type MetricRangeMinutes,
} from "@/components/dashboard/metric-detail";
import { MetricDetail } from "@/components/dashboard/metric-detail";
import type { DayAggregate, HistoryPoint } from "@/routes/api/history";

const VALID = new Set(Object.keys(METRIC_CFG));

const loadMetric = createServerFn({ method: "GET" })
  .validator((d: { metric: string }) => d)
  .handler(async ({ data }) => {
    if (!VALID.has(data.metric)) throw notFound();
    const { requireOrgServerFn } = await import("@/lib/authn/guard.server");
    const { orgId } = await requireOrgServerFn();
    const { getLivePayload, getSeriesPayload } = await import("@/lib/pwrcell/poller.server");
    const [live, series] = await Promise.all([
      getLivePayload(orgId),
      getSeriesPayload(orgId, 720),
    ]);
    return { live, series };
  });

export const Route = createFileRoute("/_authed/graphs/$metric")({
  loader: ({ params }) => loadMetric({ data: { metric: params.metric } }),
  component: MetricPage,
});

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

function MetricPage() {
  const { metric } = Route.useParams();
  const key = metric as MetricKey;
  const initial = Route.useLoaderData() as {
    live: LivePayload;
    series: SeriesPayload;
  };
  return <MetricView metricKey={key} initialLive={initial.live} initialSeries={initial.series} />;
}

function MetricView({
  metricKey,
  initialLive,
  initialSeries,
}: {
  metricKey: MetricKey;
  initialLive: LivePayload;
  initialSeries: SeriesPayload;
}) {
  const [live, setLive] = useState<LivePayload>(initialLive);
  const [points, setPoints] = useState<ChartPoint[]>(initialSeries.points);
  const [days, setDays] = useState<DayAggregate[] | undefined>(undefined);
  const [bucketSeconds, setBucketSeconds] = useState(30);
  const [minutes, setMinutes] = useState<MetricRangeMinutes>(720);

  useEffect(() => {
    document.title = `${METRIC_CFG[metricKey].label} charts`;
  }, [metricKey]);

  useEffect(() => {
    let cancelled = false;
    const historyKey = METRIC_RANGES.find((r) => r.minutes === minutes)?.history ?? null;
    async function poll() {
      try {
        const nextLive = await fetchJson<LivePayload>("/api/live");
        if (cancelled) return;
        setLive(nextLive);
        if (historyKey) {
          // Long range: DB-backed history (one sample/min, two-year retention).
          // Day bucketing uses the org's timezone server-side; no tz param.
          const body = await fetchJson<{
            points: HistoryPoint[];
            days: DayAggregate[];
            bucketSeconds: number;
          }>(`/api/history?range=${historyKey}`);
          if (cancelled) return;
          setPoints(body.points);
          setDays(body.days);
          setBucketSeconds(body.bucketSeconds);
        } else {
          const nextSeries = await fetchJson<SeriesPayload>(`/api/series?minutes=${minutes}`);
          if (cancelled) return;
          setPoints(nextSeries.points);
          setDays(undefined);
          setBucketSeconds(30);
        }
      } catch {
        if (!cancelled) return;
      }
    }
    void poll();
    // History barely moves: poll it once a minute, live data every 5 seconds.
    const id = window.setInterval(() => void poll(), historyKey ? 60_000 : 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [minutes]);

  const cfg = METRIC_CFG[metricKey];

  return (
    <div className="metric-root">
      <style>{`
        .metric-root { min-height: 100dvh; background: #0b0d0c; color: #e8ede9;
          padding: clamp(12px, 2.5vmin, 28px); box-sizing: border-box; }
        .metric-head { display: flex; align-items: center; gap: clamp(12px, 2vmin, 24px);
          margin-bottom: clamp(10px, 2vmin, 20px); flex-wrap: wrap; }
        .metric-back { display: inline-flex; align-items: center; gap: 10px;
          min-height: 60px; padding: 12px 30px; border-radius: 999px;
          background: #1c211e; border: 2px solid rgb(232 237 233 / 0.25);
          color: #e8ede9; font-size: 22px; font-weight: 800; letter-spacing: 0.04em;
          text-decoration: none; }
        .metric-back:active { transform: scale(0.97); }
        .metric-back:focus-visible { outline: 3px solid #e8ede9; outline-offset: 3px; }
        .metric-title { font-size: clamp(28px, 4.5vmin, 54px); font-weight: 900;
          letter-spacing: 0.06em; margin: 0; }
        .metric-blurb { color: #8b958e; font-size: clamp(13px, 2vmin, 18px);
          margin: 0 0 clamp(10px, 2vmin, 20px); max-width: 70ch; }
      `}</style>
      <div className="metric-head">
        <Link to="/flow" className="metric-back" aria-label="Back to energy flow">
          <span aria-hidden="true">←</span> Back
        </Link>
        <h1 className="metric-title" style={{ color: cfg.color }}>
          {cfg.label.toUpperCase()}
        </h1>
      </div>
      <p className="metric-blurb">{cfg.blurb}</p>
      <MetricDetail
        metric={metricKey}
        points={points}
        days={days}
        bucketSeconds={bucketSeconds}
        timeZone={live.point?.timezone}
        minutes={minutes}
        onMinutes={setMinutes}
      />
    </div>
  );
}
