import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The energy-flow view is the dashboard now: /dashboard bounces straight
 * to /flow. The previous gauges dashboard (PWRview login, display settings,
 * cameras) lives at /classic.
 */
export const Route = createFileRoute("/_authed/dashboard")({
  beforeLoad: () => {
    throw redirect({ to: "/flow", search: { font: undefined } });
  },
});
