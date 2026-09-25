import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Dashboard } from "@/components/dashboard/dashboard";

const loadDashboard = createServerFn({ method: "GET" }).handler(async () => {
  const { requireOrgServerFn } = await import("@/lib/authn/guard.server");
  const { orgId } = await requireOrgServerFn();
  const { getLivePayload, getSeriesPayload } = await import("@/lib/pwrcell/poller.server");
  const { loadDisplaySettings } = await import("@/lib/display-settings.server");
  const [live, series, settings] = await Promise.all([
    getLivePayload(orgId),
    getSeriesPayload(orgId, 720),
    loadDisplaySettings(orgId),
  ]);
  return { live, series, settings };
});

export const Route = createFileRoute("/_authed/")({
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
