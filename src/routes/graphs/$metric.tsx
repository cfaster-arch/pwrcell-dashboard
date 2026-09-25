import { useEffect, useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { LivePayload, SeriesPayload } from "@/lib/pwrcell/types";
import type { DisplaySettings } from "@/lib/display-settings";
import { backgroundStyle } from "@/lib/display-settings";
import { MetricDetail, METRIC_CFG, type MetricKey } from "@/components/dashboard/metric-detail";
import { NavMenu } from "@/components/dashboard/nav-menu";
import {
  DisplaySettingsProvider,
  useDisplaySettings,
} from "@/components/dashboard/display-settings-context";
import type { RangeMinutes as ChartRange } from "@/components/dashboard/power-chart";

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
  const [live, setLive] = useState<LivePayload>(initialLive);
  const [series, setSeries] = useState<SeriesPayload>(initialSeries);
  const [minutes, setMinutes] = useState<ChartRange>(720);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [nextLive, nextSeries] = await Promise.all([
          fetchJson<LivePayload>("/api/live"),
          fetchJson<SeriesPayload>(`/api/series?minutes=${minutes}`),
        ]);
        if (cancelled) return;
        setLive(nextLive);
        setSeries(nextSeries);
      } catch {
        if (!cancelled) return;
      }
    }
    void poll();
    const id = window.setInterval(() => void poll(), 5000);
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
          <NavMenu />
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
          points={series.points}
          timeZone={live.point?.timezone}
          minutes={minutes}
          onMinutes={(m: ChartRange) => setMinutes(m as ChartRange)}
        />
      </div>
    </div>
  );
}
