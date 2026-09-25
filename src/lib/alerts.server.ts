import fs from "node:fs";
import path from "node:path";
import { getSql } from "@/lib/db";
import type { PowerPoint } from "./pwrcell/types";
import {
  ALERT_RULES,
  type AlertRow,
  type AlertRuleKey,
  type AlertSettings,
  type AlertSeverity,
} from "./alert-types";

export { ALERT_RULES };
export type { AlertRow, AlertRuleKey, AlertSettings, AlertSeverity };

const SETTINGS_FILE = path.resolve(process.cwd(), "alert-settings.json");

/** Max one push notification per rule per hour while a condition persists. */
const PUSH_COOLDOWN_MS = 60 * 60 * 1000;
/** Feed counts as stale after this long without a successful cloud poll. */
const STALE_AFTER_MS = 10 * 60 * 1000;
/** Energy-history sampling cadence. */
const SAMPLE_MS = 60 * 1000;
/** Retention sweep cadence. */
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

function randomTopic(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `pwrcell-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function sanitize(raw: unknown): AlertSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rr = (r.rules ?? {}) as Record<string, { enabled?: unknown }>;
  const ruleEnabled = (k: AlertRuleKey): boolean => {
    const v = rr[k]?.enabled;
    return typeof v === "boolean" ? v : true;
  };
  const threshold =
    typeof r.lowSocThreshold === "number" &&
    Number.isFinite(r.lowSocThreshold) &&
    r.lowSocThreshold >= 5 &&
    r.lowSocThreshold <= 95
      ? Math.round(r.lowSocThreshold)
      : 20;
  const topic =
    typeof r.ntfyTopic === "string" && r.ntfyTopic.trim()
      ? r.ntfyTopic.trim().slice(0, 64)
      : randomTopic();
  return {
    enabled: r.enabled !== false,
    lowSocThreshold: threshold,
    ntfyTopic: topic,
    rules: {
      gridOutage: { enabled: ruleEnabled("gridOutage") },
      gridRestored: { enabled: ruleEnabled("gridRestored") },
      lowSoc: { enabled: ruleEnabled("lowSoc") },
      feedStale: { enabled: ruleEnabled("feedStale") },
      pollError: { enabled: ruleEnabled("pollError") },
    },
  };
}

export function loadAlertSettings(): AlertSettings {
  try {
    return sanitize(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as unknown);
  } catch {
    const fresh = sanitize(null);
    // Persist the generated topic so it stays stable across restarts.
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fresh, null, 2) + "\n", "utf8");
    } catch {
      /* best effort */
    }
    return fresh;
  }
}

export function saveAlertSettings(patch: Partial<AlertSettings>): AlertSettings {
  const current = loadAlertSettings();
  const merged = sanitize({
    ...current,
    ...patch,
    rules: { ...current.rules, ...(patch.rules ?? {}) },
  });
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
  } catch {
    /* best effort: keep running with in-memory values */
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Alert history (Postgres via the shared Sql surface)
// ---------------------------------------------------------------------------

function toRow(r: Record<string, unknown>): AlertRow {
  return {
    id: Number(r.id),
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    rule: r.rule as AlertRuleKey,
    severity: (r.severity as AlertSeverity) ?? "info",
    message: String(r.message ?? ""),
    acknowledged: r.acknowledged === true,
  };
}

export async function getAlerts(limit = 100): Promise<AlertRow[]> {
  const sql = await getSql();
  const rows = await sql.query(
    "select id, ts, rule, severity, message, acknowledged from alerts order by ts desc limit $1",
    [Math.min(500, Math.max(1, limit))],
  );
  return rows.map(toRow);
}

export async function getUnacknowledged(limit = 25): Promise<AlertRow[]> {
  const sql = await getSql();
  const rows = await sql.query(
    "select id, ts, rule, severity, message, acknowledged from alerts where acknowledged = false order by ts desc limit $1",
    [Math.min(100, Math.max(1, limit))],
  );
  return rows.map(toRow);
}

export async function acknowledgeAlert(id: number): Promise<void> {
  const sql = await getSql();
  await sql.query("update alerts set acknowledged = true where id = $1", [id]);
}

export async function acknowledgeAll(): Promise<void> {
  const sql = await getSql();
  await sql.query("update alerts set acknowledged = true where acknowledged = false");
}

// ---------------------------------------------------------------------------
// ntfy.sh push (no new dependencies — plain fetch)
// ---------------------------------------------------------------------------

async function pushNtfy(topic: string, title: string, message: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: { Title: title },
      body: message,
      signal: ctrl.signal,
    });
  } catch (err) {
    console.warn("[alerts] ntfy push failed:", err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Engine — evaluated by the poller after every poll. Transition-triggered with
// a per-rule push cooldown; DB writes and pushes never break polling.
// ---------------------------------------------------------------------------

type EngineState = {
  prevGridOutage: boolean | null;
  prevLowSoc: boolean | null;
  prevStale: boolean | null;
  prevError: string | null;
  /** Whether the current episode of each condition has been notified. Gates reminders. */
  notified: Record<AlertRuleKey, boolean>;
  lastPushAt: Record<AlertRuleKey, number>;
  lastSampleAt: number;
  lastRetentionAt: number;
  lastLiveSuccessAt: number | null;
};

const engine: EngineState = {
  prevGridOutage: null,
  prevLowSoc: null,
  prevStale: null,
  prevError: null,
  notified: {
    gridOutage: false,
    gridRestored: false,
    lowSoc: false,
    feedStale: false,
    pollError: false,
  },
  lastPushAt: {
    gridOutage: 0,
    gridRestored: 0,
    lowSoc: 0,
    feedStale: 0,
    pollError: 0,
  },
  lastSampleAt: 0,
  lastRetentionAt: 0,
  lastLiveSuccessAt: null,
};

/**
 * Grid state classification. Returns null when the value is missing or
 * unrecognized — unknown values never trigger a transition.
 */
function classifyGrid(gridState: string | null | undefined): boolean | null {
  if (gridState == null) return null;
  const s = gridState.toUpperCase();
  if (/ISLAND|OUTAGE|DISCONNECT/.test(s)) return true;
  if (/CONNECT/.test(s)) return false;
  return null;
}

function inverterError(sysMode: string | null | undefined): string | null {
  if (sysMode && /ERROR|FAULT|FAIL/.test(sysMode.toUpperCase())) return sysMode;
  return null;
}

async function recordAlert(rule: AlertRuleKey, message: string): Promise<void> {
  const meta = ALERT_RULES.find((r) => r.key === rule);
  try {
    const sql = await getSql();
    await sql.query(
      "insert into alerts (rule, severity, message) values ($1, $2, $3)",
      [rule, meta?.severity ?? "info", message],
    );
  } catch (err) {
    console.warn("[alerts] failed to record alert:", err instanceof Error ? err.message : err);
  }
}

async function fire(
  settings: AlertSettings,
  rule: AlertRuleKey,
  message: string,
  now: number,
): Promise<void> {
  await recordAlert(rule, message);
  if (!settings.enabled || !settings.rules[rule].enabled || !settings.ntfyTopic) return;
  if (now - engine.lastPushAt[rule] < PUSH_COOLDOWN_MS) return;
  engine.lastPushAt[rule] = now;
  const label = ALERT_RULES.find((r) => r.key === rule)?.label ?? rule;
  await pushNtfy(settings.ntfyTopic, `[PWRcell] ${label}`, message);
}

/** Reminder while a condition persists — at most one push per cooldown window,
 *  and only when a push would actually go out (no DB spam when push is off). */
function dueForReminder(settings: AlertSettings, rule: AlertRuleKey, now: number): boolean {
  return (
    settings.enabled &&
    settings.rules[rule].enabled &&
    !!settings.ntfyTopic &&
    now - engine.lastPushAt[rule] >= PUSH_COOLDOWN_MS
  );
}

async function writeSample(point: PowerPoint, now: number): Promise<void> {
  try {
    const sql = await getSql();
    // Phase 1: single-org writer — rows land in the default org. Phase 2's
    // per-org poller will pass the org explicitly (no default in the DDL).
    await sql.query(
      `insert into energy_samples (organization_id, ts, solar_w, home_w, battery_w, grid_w, soc, sys_mode, grid_state)
       values ('org_default', to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8)
       on conflict (organization_id, ts) do nothing`,
      [
        point.ts,
        point.solarW,
        point.homeW,
        point.batteryW,
        point.gridW,
        point.batterySoc,
        point.sysMode,
        point.gridState,
      ],
    );
  } catch (err) {
    console.warn("[alerts] failed to write energy sample:", err instanceof Error ? err.message : err);
  }
}

async function sweepRetention(): Promise<void> {
  try {
    const sql = await getSql();
    await sql.query("delete from energy_samples where ts < now() - interval '2 years'");
  } catch (err) {
    console.warn("[alerts] retention sweep failed:", err instanceof Error ? err.message : err);
  }
}

export async function afterPoll(opts: {
  point: PowerPoint | null;
  mode: "live" | "demo";
  ok: boolean;
  lastError: string | null;
}): Promise<void> {
  const now = Date.now();
  const { point, mode, ok, lastError } = opts;

  // Demo data must never pollute the long-term history or fire real alerts.
  if (mode !== "live" || !point) return;

  if (ok) engine.lastLiveSuccessAt = now;

  // Energy history: one sample per poll, throttled to 1/minute.
  if (now - engine.lastSampleAt >= SAMPLE_MS) {
    engine.lastSampleAt = now;
    await writeSample(point, now);
  }

  // Retention: one sweep per day.
  if (now - engine.lastRetentionAt >= RETENTION_SWEEP_MS) {
    engine.lastRetentionAt = now;
    await sweepRetention();
  }

  // Alerts.
  const settings = loadAlertSettings();

  // Grid outage / restored (transition on classified state). A bad condition
  // already active at startup notifies immediately — staying silent about an
  // ongoing outage would defeat the monitor.
  const gridOutage = classifyGrid(point.gridState);
  if (gridOutage !== null) {
    if (engine.prevGridOutage === null) {
      if (gridOutage) {
        await fire(settings, "gridOutage", `Grid outage detected (grid state: ${point.gridState}).`, now);
        engine.notified.gridOutage = true;
      }
    } else if (gridOutage !== engine.prevGridOutage) {
      if (gridOutage) {
        await fire(settings, "gridOutage", `Grid outage detected (grid state: ${point.gridState}).`, now);
        engine.notified.gridOutage = true;
      } else {
        await fire(settings, "gridRestored", "Grid power restored.", now);
        engine.notified.gridOutage = false;
      }
    } else if (
      gridOutage &&
      engine.notified.gridOutage &&
      dueForReminder(settings, "gridOutage", now)
    ) {
      await fire(settings, "gridOutage", `Grid still out (grid state: ${point.gridState}).`, now);
    }
    engine.prevGridOutage = gridOutage;
  }

  // Battery low.
  const soc = point.batterySoc;
  if (soc != null && Number.isFinite(soc)) {
    const low = soc < settings.lowSocThreshold;
    if (engine.prevLowSoc === null) {
      if (low) {
        await fire(
          settings,
          "lowSoc",
          `Battery at ${Math.round(soc)}% — below the ${settings.lowSocThreshold}% threshold.`,
          now,
        );
        engine.notified.lowSoc = true;
      }
    } else if (low !== engine.prevLowSoc) {
      if (low) {
        await fire(
          settings,
          "lowSoc",
          `Battery at ${Math.round(soc)}% — below the ${settings.lowSocThreshold}% threshold.`,
          now,
        );
        engine.notified.lowSoc = true;
      } else {
        engine.notified.lowSoc = false;
      }
    } else if (low && engine.notified.lowSoc && dueForReminder(settings, "lowSoc", now)) {
      await fire(
        settings,
        "lowSoc",
        `Battery still low at ${Math.round(soc)}% (threshold ${settings.lowSocThreshold}%).`,
        now,
      );
    }
    engine.prevLowSoc = low;
  }

  // Feed stale: no successful cloud poll for 10+ minutes.
  const stale =
    engine.lastLiveSuccessAt !== null && now - engine.lastLiveSuccessAt > STALE_AFTER_MS;
  if (engine.prevStale === null) {
    if (stale) {
      const mins = Math.round((now - (engine.lastLiveSuccessAt ?? now)) / 60000);
      await fire(settings, "feedStale", `No successful cloud poll for ${mins}+ minutes.`, now);
      engine.notified.feedStale = true;
    }
  } else if (stale !== engine.prevStale) {
    if (stale) {
      const mins = Math.round((now - (engine.lastLiveSuccessAt ?? now)) / 60000);
      await fire(settings, "feedStale", `No successful cloud poll for ${mins}+ minutes.`, now);
      engine.notified.feedStale = true;
    } else {
      engine.notified.feedStale = false;
    }
  } else if (stale && engine.notified.feedStale && dueForReminder(settings, "feedStale", now)) {
    await fire(settings, "feedStale", "Cloud feed still stale — check the PWRview connection.", now);
  }
  engine.prevStale = stale;

  // Poll / inverter error.
  const invErr = inverterError(point.sysMode);
  const errSig = lastError ?? (invErr ? `Inverter reports: ${invErr}` : null);
  if (engine.prevError === null) {
    if (errSig) {
      await fire(settings, "pollError", errSig.slice(0, 300), now);
      engine.notified.pollError = true;
    }
  } else if (errSig !== engine.prevError) {
    if (errSig) {
      await fire(settings, "pollError", errSig.slice(0, 300), now);
      engine.notified.pollError = true;
    } else {
      engine.notified.pollError = false;
    }
  } else if (errSig && engine.notified.pollError && dueForReminder(settings, "pollError", now)) {
    await fire(settings, "pollError", `Still failing: ${errSig.slice(0, 300)}`, now);
  }
  engine.prevError = errSig;
}
