import { useCallback, useEffect, useState } from "react";
import { ALERT_RULES, type AlertRow, type AlertSettings } from "@/lib/alert-types";
import { clockLabel } from "@/lib/pwrcell/format";
import { cn } from "@/lib/utils";

const SEVERITY_STYLE: Record<AlertRow["severity"], string> = {
  critical: "border-danger/60 bg-danger/10 text-fg",
  warning: "border-caution/60 bg-caution/10 text-fg",
  info: "border-border bg-surface-2 text-fg",
};

function severityDot(severity: AlertRow["severity"]): string {
  return severity === "critical"
    ? "bg-danger"
    : severity === "warning"
      ? "bg-caution"
      : "bg-muted";
}

/** Slim banner shown above the dashboard when unacknowledged alerts exist. */
export function AlertBanner({ timeZone }: { timeZone?: string | null }) {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts?unacknowledged=1", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { alerts: AlertRow[] };
      setAlerts(body.alerts ?? []);
    } catch {
      /* stay silent */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const dismiss = async () => {
    try {
      await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "acknowledgeAll" }),
      });
      setAlerts([]);
    } catch {
      /* stay silent */
    }
  };

  if (!alerts.length) return null;
  const top = alerts[0];
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center justify-between gap-4 rounded-xl border p-4 shadow-[var(--shadow-border)]",
        SEVERITY_STYLE[top.severity],
      )}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <span className={cn("size-2.5 rounded-full", severityDot(top.severity))} />
          {top.message}
          {alerts.length > 1 && (
            <span className="font-normal text-muted">+{alerts.length - 1} more</span>
          )}
        </p>
        <p className="mt-0.5 font-mono text-xs text-muted">
          {clockLabel(new Date(top.ts).getTime(), timeZone)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void dismiss()}
        className="btn min-h-11 shrink-0 px-4"
      >
        Dismiss
      </button>
    </div>
  );
}

/** Alert settings + history, rendered inside the nav drawer. */
export function AlertsSection({ timeZone }: { timeZone?: string | null }) {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [history, setHistory] = useState<AlertRow[]>([]);

  const load = useCallback(async () => {
    try {
      const [sRes, hRes] = await Promise.all([
        fetch("/api/alerts-settings", { cache: "no-store" }),
        fetch("/api/alerts?limit=50", { cache: "no-store" }),
      ]);
      if (sRes.ok) {
        const body = (await sRes.json()) as { settings: AlertSettings };
        setSettings(body.settings);
      }
      if (hRes.ok) {
        const body = (await hRes.json()) as { alerts: AlertRow[] };
        setHistory(body.alerts ?? []);
      }
    } catch {
      /* stay silent */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<AlertSettings>) => {
    const next = { ...(settings ?? {}), ...patch };
    setSettings(next as AlertSettings);
    try {
      const res = await fetch("/api/alerts-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const body = (await res.json()) as { settings: AlertSettings };
        setSettings(body.settings);
      }
    } catch {
      /* keep optimistic value */
    }
  };

  const acknowledge = async (id: number) => {
    setHistory((h) => h.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)));
    try {
      await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "acknowledge", id }),
      });
    } catch {
      /* keep optimistic value */
    }
  };

  return (
    <section aria-label="Alerts">
      <h3 className="mb-3 text-sm font-semibold tracking-wide text-fg uppercase">Alerts</h3>
      {!settings ? (
        <p className="text-sm text-muted">Loading alert settings…</p>
      ) : (
        <div className="space-y-4">
          <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
            <span className="text-sm text-fg">Alert notifications</span>
            <input
              type="checkbox"
              className="size-5 accent-[var(--color-profit)]"
              checked={settings.enabled}
              onChange={(e) => void save({ enabled: e.target.checked })}
            />
          </label>

          <div className="space-y-2">
            {ALERT_RULES.map((rule) => (
              <label
                key={rule.key}
                className="flex min-h-11 cursor-pointer items-start justify-between gap-3"
                title={rule.blurb}
              >
                <span>
                  <span className="block text-sm text-fg">{rule.label}</span>
                  <span className="block text-xs text-muted">{rule.blurb}</span>
                </span>
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0 accent-[var(--color-profit)]"
                  checked={settings.rules[rule.key]?.enabled ?? true}
                  onChange={(e) =>
                    void save({
                      rules: {
                        ...settings.rules,
                        [rule.key]: { enabled: e.target.checked },
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>

          <label className="menu-field">
            <span className="menu-field-label">Low-battery threshold (%)</span>
            <input
              type="number"
              min={5}
              max={95}
              step={1}
              className="menu-input w-24 font-mono"
              value={settings.lowSocThreshold}
              onChange={(e) => void save({ lowSocThreshold: Number(e.target.value) })}
            />
          </label>

          <div>
            <label className="menu-field">
              <span className="menu-field-label">ntfy topic (phone push)</span>
              <input
                type="text"
                className="menu-input w-full font-mono"
                value={settings.ntfyTopic}
                onChange={(e) => void save({ ntfyTopic: e.target.value })}
                placeholder="pwrcell-…"
                spellCheck={false}
              />
            </label>
            <p className="mt-1 text-xs text-muted">
              Install the ntfy app and subscribe to this topic to get push alerts.
            </p>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">
              Recent alerts
            </h4>
            {history.length === 0 ? (
              <p className="text-sm text-muted">No alerts recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {history.map((a) => (
                  <li
                    key={a.id}
                    className={cn(
                      "rounded-lg border border-border bg-surface-2 p-3",
                      a.acknowledged && "opacity-60",
                    )}
                  >
                    <p className="flex items-center gap-2 text-sm text-fg">
                      <span className={cn("size-2 shrink-0 rounded-full", severityDot(a.severity))} />
                      <span className="min-w-0 flex-1">{a.message}</span>
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted">
                        {clockLabel(new Date(a.ts).getTime(), timeZone)}
                      </span>
                      {!a.acknowledged && (
                        <button
                          type="button"
                          className="text-xs font-medium text-profit hover:underline"
                          onClick={() => void acknowledge(a.id)}
                        >
                          Acknowledge
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
