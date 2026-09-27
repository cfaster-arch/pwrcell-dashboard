import { useEffect, useState } from "react";
import { BatteryCharging, Home, SunMedium, UtilityPole } from "lucide-react";
import {
  batteryDirection,
  clockLabel,
  gridDirection,
  prettyMode,
  weekdayLabel,
} from "@/lib/pwrcell/format";
import type { LivePayload, SeriesPayload, SeriesPoint } from "@/lib/pwrcell/types";
import type { DisplayMode, DisplaySettings } from "@/lib/display-settings";
import type { TouSettings } from "@/lib/tou-types";
import { describeRatePeriod, isNightHour } from "@/lib/tou-period";
import { backgroundStyle } from "@/lib/display-settings";
import { cn } from "@/lib/utils";
import { AlertBanner } from "./alerts-panel";
import { CredentialsDialog } from "./credentials-dialog";
import { ClassicTile } from "./classic-tile";
import { OutageBanner, formatBackupTime, isGridOutage } from "./outage-banner";
import { SetupWizard } from "./setup-wizard";
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
        ? "PWRview login isn't working — showing a demo day (see PWRview login for details)"
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
  const [tou, setTou] = useState<TouSettings | null>(null);

  // Rate plan for the period pill + setup wizard (fetched once).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tou", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!cancelled && b?.settings) setTou(b.settings as TouSettings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Stale-data watchdog: ticking age of the last sample; danger past 5 min.
  const sampleAgeS =
    now != null && point?.ts ? Math.max(0, Math.round((now - point.ts) / 1000)) : null;
  const staleDanger = sampleAgeS != null && sampleAgeS > 300;
  const statusTone = staleDanger ? "danger" : status.tone;

  // Rate period pill from the configured TOU plan.
  const period = tou ? describeRatePeriod(tou, clockTs, tz) : null;
  // Night dim for the wall tablet (22:00–06:00 local).
  const { settings } = useDisplaySettings();
  const dimmed = settings.nightDim && isNightHour(clockTs, tz);
  // Battery time-remaining, from the inverter's own estimate when available.
  const backupLabel = formatBackupTime(point?.batteryBackupSeconds);
  const outage = isGridOutage(point);

  // Gauge full-scales adapt to the recent peaks in the series buffer.
  const solarMax = scaleMax(series.points, (p) => p.solarW, 6000);
  const homeMax = scaleMax(series.points, (p) => p.homeW, 6000);
  const batteryMax = scaleMax(series.points, (p) => p.batteryW, 4000);
  const gridMax = scaleMax(series.points, (p) => p.gridW, 8000);

  return (
    <div
      className="min-h-dvh bg-bg text-fg"
      style={{ ...backgroundStyle(settings), ...(dimmed ? { filter: "brightness(0.55) saturate(0.85)" } : null) }}
    >
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col gap-4 px-4 py-4 sm:gap-5 sm:px-6 sm:py-5 2xl:max-w-[104rem] 2xl:px-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-start gap-1">
            <div className="-ml-2.5 mt-0.5">
              <NavMenu timeZone={tz} onOpenLogin={() => setCredsOpen(true)} />
            </div>
            <div>
              <p className="text-kicker tracking-[0.22em] text-muted uppercase">Generac PWRcell</p>
            <h1 className="mt-1 text-h1 font-medium tracking-tight text-fg">
              {point?.address ?? "Energy dashboard"}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {mode}
              {point?.gridState ? ` · ${prettyMode(point.gridState.replace(/^GRID_/, ""))}` : ""}
            </p>
            </div>
          </div>
          <div className="flex items-end gap-5">
            <div className="text-right">
              <p className="font-mono text-clock leading-none font-medium tracking-tight tabular-nums" suppressHydrationWarning>
                {clockLabel(clockTs, tz)}
              </p>
              <p className="mt-1 text-sm text-muted" suppressHydrationWarning>
                {weekdayLabel(clockTs, tz)}
              </p>
            </div>
            <div
              className={cn(
                "min-w-28 rounded-lg bg-surface px-3 py-2 shadow-[var(--shadow-border)]",
                staleDanger && "animate-pulse border border-danger",
              )}
              role="status"
              aria-live="polite"
            >
              <p className="flex items-center gap-2 text-sm font-medium">
                <span
                  className={cn(
                    "size-2 rounded-full status-dot",
                    statusTone === "ok" && "bg-ok",
                    statusTone === "warn" && "bg-warn",
                    statusTone === "danger" && "bg-danger",
                    statusTone === "muted" && "bg-muted",
                  )}
                />
                {status.label}
              </p>
              <p className="mt-1 max-w-52 text-xs leading-snug text-subtle">
                {status.detail}
                {sampleAgeS != null && statusTone === "ok" ? ` · ${sampleAgeS}s ago` : ""}
              </p>
              {period && settings.showRates ? (
                <p
                  className={cn(
                    "mt-1.5 inline-block rounded-full px-2 py-0.5 text-xs font-semibold",
                    period.peak ? "bg-danger/20 text-danger" : "bg-ok/15 text-ok",
                  )}
                  title={period.detail}
                >
                  {period.label}
                </p>
              ) : null}
            </div>
          </div>
        </header>

        <AlertBanner timeZone={tz} />

        <OutageBanner point={point} />

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
                  ? backupLabel
                    ? `Discharging · ≈${backupLabel} left`
                    : "Discharging"
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

        <SystemPanel point={point} />
      </div>
      <CredentialsDialog open={credsOpen} onClose={() => setCredsOpen(false)} />
      <SetupWizard
        pwrviewConfigured={live.configured}
        touLabel={tou?.label ?? null}
        onOpenLogin={() => setCredsOpen(true)}
      />
    </div>
  );
}
