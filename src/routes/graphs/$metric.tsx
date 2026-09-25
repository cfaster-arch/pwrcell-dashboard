import { useEffect, useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { LivePayload, SeriesPayload } from "@/lib/pwrcell/types";
import type { DisplaySettings } from "@/lib/display-settings";
import { backgroundStyle } from "@/lib/display-settings";
import {
  METRIC_RANGES,
  MetricDetail,
  METRIC_CFG,
  type ChartPoint,
  type MetricKey,
  type MetricRangeMinutes,
} from "@/components/dashboard/metric-detail";
import type { DayAggregate, HistoryPoint } from "@/routes/api/history";
import { NavMenu } from "@/components/dashboard/nav-menu";
import { CredentialsDialog } from "@/components/dashboard/credentials-dialog";
import {
  DisplaySettingsProvider,
  useDisplaySettings,
} from "@/components/dashboard/display-settings-context";

const VALID = new Set(Object.keys(METRIC_CFG));

const loadMetric = createServerFn({ method: "GET" })
  .validator((d: { metric: string }) => d)
  .handler(async ({ data }) => {
    if (!VALID.has(data.metric)) throw notFound();
    const { getLivePayload, getSeriesPayload } = await import("@/lib/pwrcell/poller.server");
    const { loadDisplaySettings } = await import("@/lib/display-settings.server");
    const [live, series, settings] = await Promise.all([
      getLivePayload(),
      getSeriesPayload(720),
      loadDisplaySettings(),
    ]);
    return { live, series, settings };
  });

export const Route = createFileRoute("/graphs/$metric")({
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
    settings: DisplaySettings;
  };
  return (
    <DisplaySettingsProvider initial={initial.settings}>
      <MetricView metricKey={key} initialLive={initial.live} initialSeries={initial.series} />
    </DisplaySettingsProvider>
  );
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
  const { settings } = useDisplaySettings();
  const [credsOpen, setCredsOpen] = useState(false);
  const [live, setLive] = useState<LivePayload>(initialLive);
  const [points, setPoints] = useState<ChartPoint[]>(initialSeries.points);
  const [days, setDays] = useState<DayAggregate[] | undefined>(undefined);
  const [bucketSeconds, setBucketSeconds] = useState(30);
  const [minutes, setMinutes] = useState<MetricRangeMinutes>(720);

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
          const tz = nextLive.point?.timezone || "America/Los_Angeles";
          const body = await fetchJson<{
            points: HistoryPoint[];
            days: DayAggregate[];
            bucketSeconds: number;
          }>(`/api/history?range=${historyKey}&tz=${encodeURIComponent(tz)}`);
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
    <div className="min-h-dvh bg-bg text-fg" style={backgroundStyle(settings)}>
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-5">
        <header className="flex items-center gap-3">
          <NavMenu onOpenLogin={() => setCredsOpen(true)} />
          <div>
            <p className="text-kicker tracking-[0.22em] text-muted uppercase">Generac PWRcell</p>
            <h1 className="mt-1 text-2xl font-medium tracking-tight text-fg sm:text-3xl">
              {cfg.label}
            </h1>
          </div>
        </header>
        <p className="-mt-2 max-w-3xl text-sm leading-relaxed text-muted">{cfg.blurb}</p>
        <MetricDetail
          metric={metricKey}
          points={points}
          days={days}
          bucketSeconds={bucketSeconds}
          timeZone={live.point?.timezone}
          minutes={minutes}
          onMinutes={setMinutes}
        />
        <CredentialsDialog open={credsOpen} onClose={() => setCredsOpen(false)} />
      </div>
    </div>
  );
}
