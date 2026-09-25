import { createFileRoute } from "@tanstack/react-router";
import { requireSessionApi } from "@/lib/authn/guard.server";
import { getSql } from "@/lib/db";

export type HistoryRange = "24h" | "7d" | "30d" | "365d";

const RANGE_SECONDS: Record<HistoryRange, number> = {
  "24h": 86_400,
  "7d": 604_800,
  "30d": 2_592_000,
  "365d": 31_536_000,
};

// Downsample buckets sized so the returned series stays near ~1,500 points.
const BUCKET_SECONDS: Record<HistoryRange, number> = {
  "24h": 900, // 15 min → 96 pts
  "7d": 3_600, // 1 h → 168 pts
  "30d": 3_600, // 1 h → 720 pts
  "365d": 21_600, // 6 h → ~1,460 pts
};

export interface HistoryPoint {
  ts: number;
  solarW: number | null;
  homeW: number | null;
  batteryW: number | null;
  gridW: number | null;
  soc: number | null;
}

export interface DayAggregate {
  day: string;
  solarKwh: number;
  homeKwh: number;
  batteryChargedKwh: number;
  batteryDischargedKwh: number;
  gridImportKwh: number;
  gridExportKwh: number;
  avgSoc: number | null;
  minSoc: number | null;
  maxSoc: number | null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r1 = (n: number) => Math.round(n * 10) / 10;

function dayKey(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

function aggregateDays(points: HistoryPoint[], bucketSec: number, timeZone: string): DayAggregate[] {
  const days = new Map<string, DayAggregate & { socSum: number; socN: number }>();
  const get = (day: string): DayAggregate & { socSum: number; socN: number } => {
    let d = days.get(day);
    if (!d) {
      d = {
        day,
        solarKwh: 0,
        homeKwh: 0,
        batteryChargedKwh: 0,
        batteryDischargedKwh: 0,
        gridImportKwh: 0,
        gridExportKwh: 0,
        avgSoc: null,
        minSoc: null,
        maxSoc: null,
        socSum: 0,
        socN: 0,
      };
      days.set(day, d);
    }
    return d;
  };

  // Trapezoidal integration between consecutive buckets. Gaps wider than two
  // buckets are skipped rather than interpolated across an outage.
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dtH = (b.ts - a.ts) / 3_600_000;
    if (!(dtH > 0) || dtH > (bucketSec * 2) / 3600) continue;
    const day = get(dayKey((a.ts + b.ts) / 2, timeZone));
    const integrate = (w1: number | null, w2: number | null) =>
      w1 == null || w2 == null ? null : ((w1 + w2) / 2) * (dtH / 1000);

    const solar = integrate(a.solarW, b.solarW);
    if (solar != null) day.solarKwh += Math.max(0, solar);
    const home = integrate(a.homeW, b.homeW);
    if (home != null) day.homeKwh += Math.max(0, home);
    const batt = integrate(a.batteryW, b.batteryW);
    if (batt != null) {
      if (batt >= 0) day.batteryDischargedKwh += batt;
      else day.batteryChargedKwh += -batt;
    }
    const grid = integrate(a.gridW, b.gridW);
    if (grid != null) {
      if (grid >= 0) day.gridImportKwh += grid;
      else day.gridExportKwh += -grid;
    }
  }

  for (const p of points) {
    if (p.soc == null || !Number.isFinite(p.soc)) continue;
    const day = get(dayKey(p.ts, timeZone));
    day.socSum += p.soc;
    day.socN += 1;
    day.minSoc = day.minSoc == null ? p.soc : Math.min(day.minSoc, p.soc);
    day.maxSoc = day.maxSoc == null ? p.soc : Math.max(day.maxSoc, p.soc);
  }

  return [...days.values()]
    .sort((x, y) => (x.day < y.day ? -1 : 1))
    .map((d) => ({
      day: d.day,
      solarKwh: r3(d.solarKwh),
      homeKwh: r3(d.homeKwh),
      batteryChargedKwh: r3(d.batteryChargedKwh),
      batteryDischargedKwh: r3(d.batteryDischargedKwh),
      gridImportKwh: r3(d.gridImportKwh),
      gridExportKwh: r3(d.gridExportKwh),
      avgSoc: d.socN ? r1(d.socSum / d.socN) : null,
      minSoc: d.minSoc == null ? null : r1(d.minSoc),
      maxSoc: d.maxSoc == null ? null : r1(d.maxSoc),
    }));
}

export const Route = createFileRoute("/api/history")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authz = await requireSessionApi();
        if (authz instanceof Response) return authz;
        const url = new URL(request.url);
        const q = url.searchParams.get("range");
        const range: HistoryRange =
          q === "7d" || q === "30d" || q === "365d" ? q : "24h";
        const timeZone = url.searchParams.get("tz") || "America/Los_Angeles";

        const end = Date.now();
        const start = end - RANGE_SECONDS[range] * 1000;
        const bucketSec = BUCKET_SECONDS[range];

        const sql = await getSql();
        const rows = await sql.query(
          `select
             to_timestamp(floor(extract(epoch from ts) / $3) * $3) as bucket,
             avg(solar_w) as solar_w,
             avg(home_w) as home_w,
             avg(battery_w) as battery_w,
             avg(grid_w) as grid_w,
             avg(soc) as soc
           from energy_samples
           where ts >= to_timestamp($1 / 1000.0) and ts < to_timestamp($2 / 1000.0)
           group by bucket
           order by bucket`,
          [start, end, bucketSec],
        );

        const points: HistoryPoint[] = rows.map((r) => {
          const t = r.bucket as unknown;
          const ts = t instanceof Date ? t.getTime() : Number(t) * 1000;
          const num = (v: unknown) => (v == null ? null : Number(v));
          return {
            ts,
            solarW: num(r.solar_w) == null ? null : r1(num(r.solar_w)!),
            homeW: num(r.home_w) == null ? null : r1(num(r.home_w)!),
            batteryW: num(r.battery_w) == null ? null : r1(num(r.battery_w)!),
            gridW: num(r.grid_w) == null ? null : r1(num(r.grid_w)!),
            soc: num(r.soc) == null ? null : r1(num(r.soc)!),
          };
        });

        return Response.json(
          {
            range,
            bucketSeconds: bucketSec,
            points,
            days: aggregateDays(points, bucketSec, timeZone),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
