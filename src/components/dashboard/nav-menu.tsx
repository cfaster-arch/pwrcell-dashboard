import { useEffect, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
  BatteryCharging,
  Home,
  LayoutDashboard,
  Menu,
  SunMedium,
  UtilityPole,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AlertsSection } from "./alerts-panel";
import { TouSettingsSection } from "./cost-section";
import { SettingsPanel } from "./settings-panel";

const LINKS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/graphs/$metric", metric: "solar", label: "Solar graphs", icon: SunMedium },
  { to: "/graphs/$metric", metric: "home", label: "Home graphs", icon: Home },
  { to: "/graphs/$metric", metric: "battery", label: "Battery graphs", icon: BatteryCharging },
  { to: "/graphs/$metric", metric: "grid", label: "Grid graphs", icon: UtilityPole },
] as const;

export function NavMenu({ timeZone }: { timeZone?: string | null }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

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
            className="flex h-full w-80 max-w-[88vw] flex-col overflow-y-auto bg-surface p-4 shadow-[var(--shadow-border)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
          >
            <div className="flex items-center justify-between px-2 py-1">
              <p className="text-kicker font-medium tracking-[0.22em] text-muted uppercase">
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
            <ul className="mt-3 flex flex-col gap-1">
              {LINKS.map((l) => {
                const href = "metric" in l ? `/graphs/${l.metric}` : l.to;
                const active = pathname === href;
                const dest =
                  "metric" in l
                    ? ({ to: "/graphs/$metric", params: { metric: l.metric } }) as const
                    : ({ to: "/" }) as const;
                return (
                  <li key={l.label}>
                    <Link
                      {...dest}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-3 text-[15px] font-medium",
                        active
                          ? "bg-surface-2 text-fg"
                          : "text-muted hover:bg-surface-2 hover:text-fg",
                      )}
                      aria-current={active ? "page" : undefined}
                    >
                      <l.icon className="size-5" aria-hidden="true" />
                      {l.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <SettingsPanel />
            <div className="my-5 border-t border-border" role="separator" />
            <AlertsSection timeZone={timeZone} />
            <div className="my-5 border-t border-border" role="separator" />
            <TouSettingsSection />
            <p className="mt-auto px-2 pt-4 text-xs leading-relaxed text-subtle">
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
