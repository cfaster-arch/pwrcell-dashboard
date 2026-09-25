import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Dashboard } from "@/components/dashboard/dashboard";

const loadDashboard = createServerFn({ method: "GET" }).handler(async () => {
  const { getLivePayload, getSeriesPayload } = await import("@/lib/pwrcell/poller.server");
  const { loadDisplaySettings } = await import("@/lib/display-settings.server");
  const [live, series, settings] = await Promise.all([
    getLivePayload(),
    getSeriesPayload(720),
    loadDisplaySettings(),
  ]);
  return { live, series, settings };
});

export const Route = createFileRoute("/")({
  loader: () => loadDashboard(),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  return (
    <Dashboard
      initialLive={initial.live}
      initialSeries={initial.series}
      initialSettings={initial.settings}
    />
  );
}
