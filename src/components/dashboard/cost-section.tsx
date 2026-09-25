import { useEffect, useState } from "react";
import { DEFAULT_TOU_SETTINGS, type TouSeason, type TouSettings } from "@/lib/tou-types";
import { cn } from "@/lib/utils";

interface CostPeriod {
  importKwh: number;
  importCost: number;
  exportKwh: number;
  exportCredit: number;
  net: number;
}

interface CostPayload {
  timeZone: string;
  today: CostPeriod & { date: string };
  month: CostPeriod & { month: string };
  rates: TouSettings & { season?: TouSeason };
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Today + month-to-date grid cost, from the long-term history. */
export function CostSection({ timeZone }: { timeZone?: string | null }) {
  const [cost, setCost] = useState<CostPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const tz = timeZone || "America/Los_Angeles";
        const res = await fetch(`/api/cost?tz=${encodeURIComponent(tz)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as CostPayload;
        if (!cancelled) setCost(body);
      } catch {
        /* history may be empty; stay silent */
      }
    };
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [timeZone]);

  const cards: Array<{
    title: string;
    period: CostPeriod;
    sub: string;
  }> = cost
    ? [
        { title: "Today", period: cost.today, sub: cost.today.date },
        { title: "This month", period: cost.month, sub: cost.month.month },
      ]
    : [];

  return (
    <section className="plate p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="eyebrow">
          Grid cost
        </h2>
        {cost && (
          <p className="text-xs text-muted" title={cost.rates.label}>
            {cost.rates.label}
            {cost.rates.season ? ` · ${cost.rates.season} rates` : ""}
          </p>
        )}
      </header>
      {cards.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cards.map((c) => (
            <div key={c.title} className="rounded-lg bg-surface-2 p-4">
              <p className="text-sm font-medium text-fg">
                {c.title} <span className="font-mono text-xs text-muted">{c.sub}</span>
              </p>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Imported</dt>
                  <dd className="font-mono tabular-nums text-fg">
                    {c.period.importKwh.toFixed(2)} kWh · {money(c.period.importCost)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Exported</dt>
                  <dd className="font-mono tabular-nums text-fg">
                    {c.period.exportKwh.toFixed(2)} kWh · −{money(c.period.exportCredit)}
                  </dd>
                </div>
                <div className="flex justify-between border-t border-border pt-1 font-medium">
                  <dt className="text-fg">Net</dt>
                  <dd
                    className={cn(
                      "font-mono tabular-nums",
                      c.period.net < 0 ? "text-profit" : "text-fg",
                    )}
                  >
                    {c.period.net < 0 ? "−" : ""}
                    {money(Math.abs(c.period.net))}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">
          No energy history yet — cost totals build up as samples accumulate.
        </p>
      )}
    </section>
  );
}

/** Rate-plan editor for the nav drawer. */
export function TouSettingsSection() {
  const [settings, setSettings] = useState<TouSettings>(DEFAULT_TOU_SETTINGS);
  const [draft, setDraft] = useState<TouSettings>(DEFAULT_TOU_SETTINGS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tou", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { settings?: TouSettings } | null) => {
        if (!cancelled && body?.settings) {
          setSettings(body.settings);
          setDraft(body.settings);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    try {
      const res = await fetch("/api/tou", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { settings: TouSettings };
      setSettings(body.settings);
      setDraft(body.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      /* stay silent */
    }
  };

  const num = (
    key:
      | "summerPeak"
      | "summerOffPeak"
      | "summerExport"
      | "winterPeak"
      | "winterOffPeak"
      | "winterExport",
  ) => ({
    type: "number" as const,
    step: "0.01",
    min: "0",
    value: draft[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [key]: Number(e.target.value) }),
  });

  return (
    <section aria-label="Electricity rates">
      <h3 className="mb-1 eyebrow">
        Electricity rates
      </h3>
      <p className="mb-3 text-xs text-muted">{draft.label}</p>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="menu-field">
            <span className="menu-field-label">Peak start</span>
            <input
              type="time"
              className="menu-input font-mono"
              value={draft.peakStart}
              onChange={(e) => setDraft({ ...draft, peakStart: e.target.value })}
            />
          </label>
          <label className="menu-field">
            <span className="menu-field-label">Peak end</span>
            <input
              type="time"
              className="menu-input font-mono"
              value={draft.peakEnd}
              onChange={(e) => setDraft({ ...draft, peakEnd: e.target.value })}
            />
          </label>
        </div>
        <p className="pt-1 text-xs font-semibold tracking-wide text-muted uppercase">
          Summer · Jun–Sep
        </p>
        <label className="menu-field">
          <span className="menu-field-label">Peak rate ($/kWh)</span>
          <input className="menu-input w-28 font-mono" {...num("summerPeak")} />
        </label>
        <label className="menu-field">
          <span className="menu-field-label">Off-peak rate ($/kWh)</span>
          <input className="menu-input w-28 font-mono" {...num("summerOffPeak")} />
        </label>
        <label className="menu-field">
          <span className="menu-field-label">Export credit ($/kWh)</span>
          <input className="menu-input w-28 font-mono" {...num("summerExport")} />
        </label>
        <p className="pt-1 text-xs font-semibold tracking-wide text-muted uppercase">
          Winter · Oct–May
        </p>
        <label className="menu-field">
          <span className="menu-field-label">Peak rate ($/kWh)</span>
          <input className="menu-input w-28 font-mono" {...num("winterPeak")} />
        </label>
        <label className="menu-field">
          <span className="menu-field-label">Off-peak rate ($/kWh)</span>
          <input className="menu-input w-28 font-mono" {...num("winterOffPeak")} />
        </label>
        <label className="menu-field">
          <span className="menu-field-label">Export credit ($/kWh)</span>
          <input className="menu-input w-28 font-mono" {...num("winterExport")} />
        </label>
        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            className="btn min-h-11 px-4"
            disabled={!dirty}
            onClick={() => void save()}
          >
            Save rates
          </button>
          {saved && <span className="text-sm text-profit">Saved</span>}
        </div>
      </div>
    </section>
  );
}
