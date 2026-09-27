import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The energy-flow view is the main screen: the site root bounces
 * straight to /flow. The full dashboard (gauges, settings) lives
 * at /dashboard.
 */
export const Route = createFileRoute("/_authed/")({
  beforeLoad: () => {
    throw redirect({ to: "/flow", search: { font: undefined } });
  },
});
