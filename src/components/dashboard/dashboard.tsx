import { useEffect, useState } from "react";
import { BatteryCharging, Home, KeyRound, SunMedium, UtilityPole } from "lucide-react";
import {
  batteryDirection,
  clockLabel,
  gridDirection,
  prettyMode,
  weekdayLabel,
} from "@/lib/pwrcell/format";
import type { LivePayload, SeriesPayload, SeriesPoint } from "@/lib/pwrcell/types";
import type { DisplayMode, DisplaySettings } from "@/lib/display-settings";
import { backgroundStyle } from "@/lib/display-settings";
import { cn } from "@/lib/utils";
import { AlertBanner } from "./alerts-panel";
import { CamerasSection } from "./cameras-section";
import { CredentialsDialog } from "./credentials-dialog";
import { ClassicTile } from "./classic-tile";
import {
  DisplaySettingsProvider,
  useDisplaySettings,
} from "./display-settings-context";
import { GraphsMode } from "./graphs-mode";
import { NavMenu } from "./nav-menu";
import { type RangeMinutes } from "./power-chart";
import { PowerFlow } from "./power-flow";
import { PowerTile } from "./power-tile";
import { SystemPanel } from "./system-panel";

/** Round a target up to a 1/2/2.5/5×10ⁿ scale step. */
function niceCeil(target: number): number {
  if (target <= 0) return 1;
  const exp = Math.floor(Math.log10(target));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * base >= target) return m * base;
  }
  return 10 * base;
}

/** Gauge full-scale from the recent peak in the series buffer (never below floor). */
function scaleMax(
  points: SeriesPoint[],
  pick: (p: SeriesPoint) => number | null | undefined,
  floor: number,
): number {
  const peak = points.reduce(
    (m, p) => Math.max(m, Math.abs(pick(p) ?? 0)),
    0,
  );
  return niceCeil(Math.max(peak * 1.15, floor));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

function statusCopy(live: LivePayload, fetchError: string | null): { label: string; detail: string; tone: "ok" | "warn" | "danger" | "muted" } {
  if (fetchError) {
    return { label: "Error", detail: fetchError, tone: "danger" };
  }
  if (live.status === "demo") {
    return {
      label: "Demo",
      detail: live.configured
        ? (live.error ?? "Simulated feed")
        : "PWRview credentials not configured — showing a demo day",
      tone: "warn",
    };
  }
  if (live.status === "error") {
    return { label: "Error", detail: live.error ?? "Poll failed", tone: "danger" };
  }
  if (live.status === "stale") {
    return {
      label: "Stale",
      detail: live.error ?? `Last sample ${live.staleSeconds}s ago`,
      tone: "warn",
    };
  }
  return { label: "Live", detail: "Cloud poll every 30s", tone: "ok" };
}

export function Dashboard({
  initialLive,
  initialSeries,
  initialSettings,
}: {
  initialLive: LivePayload;
  initialSeries: SeriesPayload;
  initialSettings: DisplaySettings;
}) {
  return (
    <DisplaySettingsProvider initial={initialSettings}>
      <DashboardView initialLive={initialLive} initialSeries={initialSeries} />
    </DisplaySettingsProvider>
  );
}

/** Switches between analog gauges (gauges mode) and classic number tiles (tiles mode). */
function MetricTile({
  tone,
  label,
  watts,
  maxW,
  centerZero = false,
  caption,
  icon,
  socPct = null,
}: {
  tone: "solar" | "home" | "battery" | "grid";
  label: string;
  watts: number | null;
  maxW: number;
  centerZero?: boolean;
  caption: string;
  icon: React.ReactNode;
  socPct?: number | null;
}) {
  const { settings } = useDisplaySettings();
  if (settings.displayMode === "tiles") {
    return (
      <ClassicTile
        tone={tone}
        label={label}
        icon={icon}
        watts={watts}
        caption={caption}
        socPct={socPct}
      />
    );
  }
  return (
    <PowerTile
      tone={tone}
      label={label}
      watts={watts}
      maxW={maxW}
      centerZero={centerZero}
      caption={caption}
      icon={icon}
      socPct={socPct}
    />
  );
}

function DashboardView({
  initialLive,
  initialSeries,
}: {
  initialLive: LivePayload;
  initialSeries: SeriesPayload;
}) {
  const [live, setLive] = useState(initialLive);
  const [series, setSeries] = useState(initialSeries);
  const [minutes, setMinutes] = useState<RangeMinutes>(720);
  const [now, setNow] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [credsOpen, setCredsOpen] = useState(false);

  useEffect(() => {
    setNow(Date.now());
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

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
        setFetchError(null);
      } catch (err) {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : "Dashboard poll failed");
      }
    }
    void poll();
    const id = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [minutes]);

  const point = live.point;
  const tz = point?.timezone;
  const battDir = batteryDirection(point?.batteryW);
  const gridDir = gridDirection(point?.gridW);
  const status = statusCopy(live, fetchError);
  const mode = prettyMode(point?.sysMode);
  const clockTs = now ?? point?.ts ?? Date.now();

  // Gauge full-scales adapt to the recent peaks in the series buffer.
  const solarMax = scaleMax(series.points, (p) => p.solarW, 6000);
  const homeMax = scaleMax(series.points, (p) => p.homeW, 6000);
  const batteryMax = scaleMax(series.points, (p) => p.batteryW, 4000);
  const gridMax = scaleMax(series.points, (p) => p.gridW, 8000);

  const { settings } = useDisplaySettings();

  return (
    <div className="min-h-dvh bg-bg text-fg" style={backgroundStyle(settings)}>
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col gap-4 px-4 py-4 sm:gap-5 sm:px-6 sm:py-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-start gap-1">
            <div className="-ml-2.5 mt-0.5">
              <NavMenu timeZone={tz} />
            </div>
            <div>
              <p className="text-kicker tracking-[0.22em] text-muted uppercase">Generac PWRcell</p>
            <h1 className="mt-1 text-2xl font-medium tracking-tight text-fg sm:text-3xl">
              {point?.address ?? "Energy dashboard"}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {mode}
              {point?.gridState ? ` · ${prettyMode(point.gridState.replace(/^GRID_/, ""))}` : ""}
            </p>
            </div>
          </div>
          <div className="flex items-end gap-5">
            <button
              onClick={() => setCredsOpen(true)}
              className="mb-0.5 flex items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-sm font-medium text-muted shadow-[var(--shadow-border)] hover:bg-surface-2 hover:text-fg"
              aria-haspopup="dialog"
            >
              <KeyRound className="size-4" />
              PWRview login
            </button>
            <div className="text-right">
              <p className="font-mono text-3xl leading-none font-medium tracking-tight tabular-nums sm:text-4xl" suppressHydrationWarning>
                {clockLabel(clockTs, tz)}
              </p>
              <p className="mt-1 text-sm text-muted" suppressHydrationWarning>
                {weekdayLabel(clockTs, tz)}
              </p>
            </div>
            <div
              className="min-w-28 rounded-lg bg-surface px-3 py-2 shadow-[var(--shadow-border)]"
              role="status"
              aria-live="polite"
            >
              <p className="flex items-center gap-2 text-sm font-medium">
                <span
                  className={cn(
                    "size-2 rounded-full status-dot",
                    status.tone === "ok" && "bg-ok",
                    status.tone === "warn" && "bg-warn",
                    status.tone === "danger" && "bg-danger",
                    status.tone === "muted" && "bg-muted",
                  )}
                />
                {status.label}
              </p>
              <p className="mt-1 max-w-52 text-xs leading-snug text-subtle">{status.detail}</p>
            </div>
          </div>
        </header>

        <AlertBanner timeZone={tz} />

        {settings.displayMode === "graphs" ? (
          <GraphsMode
            livePoints={series.points}
            liveMinutes={minutes}
            onLiveRange={setMinutes}
            timeZone={tz}
          />
        ) : settings.displayMode === "flow" ? (
          <div className="flex flex-1 flex-col">
            <PowerFlow point={point} className="flex-1" />
          </div>
        ) : (
          <section className="grid flex-1 grid-cols-1 content-stretch gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            tone="solar"
            label="Solar"
            watts={point?.solarW ?? null}
            maxW={solarMax}
            caption={(point?.solarW ?? 0) > 50 ? "Producing" : "Idle"}
            icon={<SunMedium className="size-full" />}
          />
          <MetricTile
            tone="home"
            label="Home"
            watts={point?.homeW ?? null}
            maxW={homeMax}
            caption="Consumption"
            icon={<Home className="size-full" />}
          />
          <MetricTile
            tone="battery"
            label="Battery"
            watts={point?.batteryW ?? null}
            maxW={batteryMax}
            centerZero
            caption={
              battDir === "charging"
                ? "Charging"
                : battDir === "discharging"
                  ? "Discharging"
                  : "Idle"
            }
            icon={<BatteryCharging className="size-full" />}
            socPct={point?.batterySoc ?? null}
          />
          <MetricTile
            tone="grid"
            label="Grid"
            watts={point?.gridW ?? null}
            maxW={gridMax}
            centerZero
            caption={
              gridDir === "importing"
                ? "Importing"
                : gridDir === "exporting"
                  ? "Exporting"
                  : "Idle"
            }
            icon={<UtilityPole className="size-full" />}
          />
        </section>
        )}

        <CamerasSection />

        <SystemPanel point={point} />
      </div>
      <CredentialsDialog open={credsOpen} onClose={() => setCredsOpen(false)} />
    </div>
  );
}
