import { createFileRoute } from "@tanstack/react-router";
import { requireOrgApi } from "@/lib/authn/guard.server";
import { getOrgTimezone } from "@/lib/orgs.server";
import { getSql } from "@/lib/db";
import { loadTouSettings, timeToMinutes } from "@/lib/tou-settings.server";
import { seasonForMonth } from "@/lib/tou-types";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** (tz wall-clock read as UTC) − (true UTC) for an instant. */
function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - date.getTime();
}

function dayKey(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

function monthKey(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).format(new Date(ts));
}

function minutesOfDay(ts: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function monthNum(ts: number, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric" }).format(
      new Date(ts),
    ),
  );
}

export const Route = createFileRoute("/api/cost")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireOrgApi(request);
        if (authz instanceof Response) return authz;
        const url = new URL(request.url);
        // The org's timezone is authoritative for month boundaries. A client-
        // supplied tz is never trusted; the org admin sets the site timezone.
        const timeZone = await getOrgTimezone(authz.orgId);
        const rates = await loadTouSettings(authz.orgId);

        const now = Date.now();
        // First of the month in the site timezone.
        const monthFmt = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
        });
        const [my, mm] = monthFmt.format(new Date(now)).split("-").map(Number);
        const wallMonthStart = Date.UTC(my, mm - 1, 1);
        let monthStart = wallMonthStart - tzOffsetMs(timeZone, new Date(wallMonthStart));
        monthStart = wallMonthStart - tzOffsetMs(timeZone, new Date(monthStart));

        const sql = await getSql();
        const rows = await sql.query(
          `select
             to_timestamp(floor(extract(epoch from ts) / 3600) * 3600) as bucket,
             avg(grid_w) as grid_w
           from energy_samples
           where organization_id = $3
             and ts >= to_timestamp($1 / 1000.0) and ts < to_timestamp($2 / 1000.0)
           group by bucket
           order by bucket`,
          [monthStart, now, authz.orgId],
        );

        const buckets: Array<{ ts: number; gridW: number }> = rows
          .map((r) => {
            const t = r.bucket as unknown;
            const gw = r.grid_w == null ? null : Number(r.grid_w);
            if (gw == null || !Number.isFinite(gw)) return null;
            return { ts: t instanceof Date ? t.getTime() : Number(t) * 1000, gridW: gw };
          })
          .filter((b): b is { ts: number; gridW: number } => b !== null);

        const peakStartMin = timeToMinutes(rates.peakStart);
        const peakEndMin = timeToMinutes(rates.peakEnd);
        const isPeak = (min: number) =>
          peakStartMin <= peakEndMin
            ? min >= peakStartMin && min < peakEndMin
            : min >= peakStartMin || min < peakEndMin;

        const todayKey = dayKey(now, timeZone);
        const mKey = monthKey(now, timeZone);
        const acc = {
          today: { importKwh: 0, importCost: 0, exportKwh: 0, exportCredit: 0 },
          month: { importKwh: 0, importCost: 0, exportKwh: 0, exportCredit: 0 },
        };

        for (let i = 0; i + 1 < buckets.length; i++) {
          const a = buckets[i];
          const b = buckets[i + 1];
          const dtH = (b.ts - a.ts) / 3_600_000;
          if (!(dtH > 0) || dtH > 2) continue; // skip gaps, don't integrate across outages
          const mid = (a.ts + b.ts) / 2;
          const avgW = (a.gridW + b.gridW) / 2;
          const kwh = (avgW * dtH) / 1000;
          const isToday = dayKey(mid, timeZone) === todayKey;
          const targets = isToday ? [acc.today, acc.month] : [acc.month];
          const summer = seasonForMonth(monthNum(mid, timeZone)) === "summer";
          const peakR = summer ? rates.summerPeak : rates.winterPeak;
          const offR = summer ? rates.summerOffPeak : rates.winterOffPeak;
          const expR = summer ? rates.summerExport : rates.winterExport;
          const rate = isPeak(minutesOfDay(mid, timeZone)) ? peakR : offR;
          for (const t of targets) {
            if (kwh >= 0) {
              t.importKwh += kwh;
              t.importCost += kwh * rate;
            } else {
              t.exportKwh += -kwh;
              t.exportCredit += -kwh * expR;
            }
          }
        }

        const shape = (a: typeof acc.today) => ({
          importKwh: r3(a.importKwh),
          importCost: r2(a.importCost),
          exportKwh: r3(a.exportKwh),
          exportCredit: r2(a.exportCredit),
          net: r2(a.importCost - a.exportCredit),
        });

        return Response.json(
          {
            timeZone,
            today: { date: todayKey, ...shape(acc.today) },
            month: { month: mKey, ...shape(acc.month) },
            rates: { ...rates, season: seasonForMonth(monthNum(now, timeZone)) },
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
