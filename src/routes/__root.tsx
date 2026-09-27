import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import appCss from "../styles.css?url";

const APP_NAME = "PWRcell";

const loadRootSettings = createServerFn({ method: "GET" }).handler(async () => {
  const disp = await import("@/lib/display-settings.server");
  try {
    // Signed-in users get their own org's theme; the signed-out shell (login
    // page) falls back to defaults — never another org's settings.
    const guard = await import("@/lib/authn/guard.server");
    const { getRequestHeaders } = await import("@tanstack/react-start/server");
    const orgId = await guard.getMyOrgId(getRequestHeaders());
    if (typeof orgId === "string") return disp.loadDisplaySettings(orgId);
  } catch {
    /* signed out or no org — fall through to defaults */
  }
  return disp.loadDisplayDefaults();
});

export const Route = createRootRoute({
  loader: () => loadRootSettings(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      { name: "theme-color", content: "#0b0d0c" },
      {
        name: "description",
        content: "Wall-mounted dashboard for a Generac PWRcell solar and battery system.",
      },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const settings = Route.useLoaderData();
  return (
    <html lang="en" className="antialiased" data-theme={settings.theme} data-personality={settings.personality} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-bg text-fg">
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
