import { formatHours, formatKwh, prettyMode, prettyState } from "@/lib/pwrcell/format";
import type { PowerPoint } from "@/lib/pwrcell/types";

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] tracking-[0.14em] text-subtle uppercase">{label}</p>
      <p className="mt-1 truncate font-mono text-base font-medium tracking-tight text-fg tabular-nums sm:text-lg">
        {value}
      </p>
    </div>
  );
}

export function SystemPanel({ point }: { point: PowerPoint | null }) {
  const temp =
    point?.batteryTempC == null ? "—" : `${point.batteryTempC.toFixed(1)} °C`;
  const volts =
    point?.batteryVoltage == null ? "—" : `${point.batteryVoltage.toFixed(0)} V`;
  const invTemp =
    point?.inverterTempC == null ? "—" : `${point.inverterTempC.toFixed(1)} °C`;

  return (
    <section className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5">
      <h2 className="mb-4 text-tile-label font-medium tracking-[0.16em] text-muted uppercase">
        System
      </h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <Cell label="Solar lifetime" value={formatKwh(point?.solarLifetimeKwh)} />
        <Cell label="Battery lifetime" value={formatKwh(point?.batteryLifetimeKwh)} />
        <Cell label="Inverter lifetime" value={formatKwh(point?.inverterLifetimeKwh)} />
        <Cell label="Battery" value={`${temp} · ${volts}`} />
        <Cell label="Grid / mode" value={`${prettyState(point?.gridState)} · ${prettyMode(point?.sysMode)}`} />
        <Cell label="Est. backup" value={formatHours(point?.batteryBackupSeconds)} />
      </div>
      {point?.serialNumber || point?.address ? (
        <p className="mt-4 truncate text-xs tracking-wide text-subtle">
          {[point.serialNumber, point.address].filter(Boolean).join(" · ")}
          {point.inverterTempC != null ? ` · inverter ${invTemp}` : ""}
        </p>
      ) : null}
    </section>
  );
}
