import { useEffect, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
  BatteryCharging,
  Home,
  KeyRound,
  LayoutDashboard,
  Menu,
  SunMedium,
  UtilityPole,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AlertsSection } from "./alerts-panel";
import { TouSettingsSection } from "./cost-section";
import { useDisplaySettings } from "./display-settings-context";
import { RingSetupSection } from "./ring-setup";
import { SettingsPanel } from "./settings-panel";

const LINKS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/graphs/$metric", metric: "solar", label: "Solar graphs", icon: SunMedium },
  { to: "/graphs/$metric", metric: "home", label: "Home graphs", icon: Home },
  { to: "/graphs/$metric", metric: "battery", label: "Battery graphs", icon: BatteryCharging },
  { to: "/graphs/$metric", metric: "grid", label: "Grid graphs", icon: UtilityPole },
] as const;

export function NavMenu({
  timeZone,
  onOpenLogin,
}: {
  timeZone?: string | null;
  onOpenLogin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { settings } = useDisplaySettings();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open ]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg p-2.5 text-muted hover:bg-surface-2 hover:text-fg"
        aria-label="Open menu"
        aria-haspopup="dialog"
      >
        <Menu className="size-6" />
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 bg-black/70"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <nav
            className="flex h-full w-80 max-w-[88vw] flex-col overflow-y-auto border-r border-border-strong bg-[#100d0a] shadow-[var(--shadow-plate)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <p className="font-display text-2xl font-semibold tracking-wide text-fg">
                PWRcell
              </p>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
                aria-label="Close menu"
              >
                <X className="size-5" />
              </button>
            </div>
            <ul className="flex flex-col px-2 py-2">
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenLogin();
                  }}
                  aria-haspopup="dialog"
                  className="flex w-full items-center gap-3 rounded-md border border-solar/25 bg-solar-dim px-3 py-3 text-[15px] font-semibold text-solar transition-colors hover:bg-solar/20"
                >
                  <KeyRound className="size-5" aria-hidden="true" />
                  PWRview login
                </button>
              </li>
              {LINKS.map((l) => {
                const href = "metric" in l ? `/graphs/${l.metric}` : l.to;
                const active = pathname === href;
                const dest =
                  "metric" in l
                    ? ({ to: "/graphs/$metric", params: { metric: l.metric } }) as const
                    : ({ to: "/" }) as const;
                return (
                  <li key={l.label} className="border-b border-border/50 last:border-0">
                    <Link
                      {...dest}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "relative flex items-center gap-3 px-3 py-3 text-[15px] font-medium transition-colors",
                        active ? "text-fg" : "text-muted hover:text-fg",
                      )}
                      aria-current={active ? "page" : undefined}
                    >
                      <span
                        className={cn(
                          "absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-solar transition-opacity",
                          active ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden="true"
                      />
                      <l.icon className="size-5" aria-hidden="true" />
                      {l.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-border px-5 pt-4">
              <SettingsPanel />
            </div>
            <div className="border-t border-border px-5 pt-4">
              <AlertsSection timeZone={timeZone} />
            </div>
            {settings.showRates ? (
              <div className="border-t border-border px-5 pt-4">
                <TouSettingsSection />
              </div>
            ) : null}
            {settings.showCameras ? (
              <div className="border-t border-border px-5 pt-4">
                <RingSetupSection />
              </div>
            ) : null}
            <p className="mt-auto px-5 py-4 text-xs leading-relaxed text-subtle">
              Wall-mounted dashboard
              <br />
              served from the home laptop
            </p>
          </nav>
        </div>
      ) : null}
    </>
  );
}
