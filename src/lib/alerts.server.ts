/**
 * Alert engine + energy-history sampler (Phase 2: per-organization).
 *
 * Each organization gets its own engine state (transition memory, push
 * cooldowns) keyed by org id, its own settings section ("alerts" in
 * org_settings), and its own rows in alerts / energy_samples filtered by
 * organization_id. Demo data never touches history or fires alerts.
 *
 * Push delivery is via ntfy; the DB is the source of truth for alert history.
 */
import { getSql } from "@/lib/db";
import { getOrgSection, setOrgSection } from "@/lib/org-settings.server";
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

/** Load an org's alert settings. First load persists a generated ntfy topic so it stays stable across restarts. */
export async function loadAlertSettings(orgId: string): Promise<AlertSettings> {
  const raw = await getOrgSection(orgId, "alerts");
  if (raw === undefined) {
    const fresh = sanitize(null);
    await setOrgSection(orgId, "alerts", fresh);
    return fresh;
  }
  return sanitize(raw);
}

export async function saveAlertSettings(orgId: string, patch: Partial<AlertSettings>): Promise<AlertSettings> {
  const current = await loadAlertSettings(orgId);
  const merged = sanitize({
    ...current,
    ...patch,
    rules: { ...current.rules, ...(patch.rules ?? {}) },
  });
  await setOrgSection(orgId, "alerts", merged);
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

export async function getAlerts(orgId: string, limit = 100): Promise<AlertRow[]> {
  const sql = await getSql();
  const rows = await sql.query(
    "select id, ts, rule, severity, message, acknowledged from alerts where organization_id = $1 order by ts desc limit $2",
    [orgId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map(toRow);
}

export async function getUnacknowledged(orgId: string, limit = 25): Promise<AlertRow[]> {
  const sql = await getSql();
  const rows = await sql.query(
    "select id, ts, rule, severity, message, acknowledged from alerts where organization_id = $1 and acknowledged = false order by ts desc limit $2",
    [orgId, Math.min(100, Math.max(1, limit))],
  );
  return rows.map(toRow);
}

export async function acknowledgeAlert(orgId: string, id: number): Promise<void> {
  const sql = await getSql();
  await sql.query("update alerts set acknowledged = true where id = $1 and organization_id = $2", [id, orgId]);
}

export async function acknowledgeAll(orgId: string): Promise<void> {
  const sql = await getSql();
  await sql.query(
    "update alerts set acknowledged = true where organization_id = $1 and acknowledged = false",
    [orgId],
  );
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

function newEngineState(): EngineState {
  return {
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
}

const globalRef = globalThis as unknown as { __alertEngines__?: Map<string, EngineState> };

function engineFor(orgId: string): EngineState {
  if (!globalRef.__alertEngines__) globalRef.__alertEngines__ = new Map();
  let eng = globalRef.__alertEngines__.get(orgId);
  if (!eng) {
    eng = newEngineState();
    globalRef.__alertEngines__.set(orgId, eng);
  }
  return eng;
}

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

async function recordAlert(orgId: string, rule: AlertRuleKey, message: string): Promise<void> {
  const meta = ALERT_RULES.find((r) => r.key === rule);
  try {
    const sql = await getSql();
    await sql.query(
      "insert into alerts (organization_id, rule, severity, message) values ($1, $2, $3, $4)",
      [orgId, rule, meta?.severity ?? "info", message],
    );
  } catch (err) {
    console.warn("[alerts] failed to record alert:", err instanceof Error ? err.message : err);
  }
}

async function fire(
  eng: EngineState,
  settings: AlertSettings,
  orgId: string,
  rule: AlertRuleKey,
  message: string,
  now: number,
): Promise<void> {
  await recordAlert(orgId, rule, message);
  if (!settings.enabled || !settings.rules[rule].enabled || !settings.ntfyTopic) return;
  if (now - eng.lastPushAt[rule] < PUSH_COOLDOWN_MS) return;
  eng.lastPushAt[rule] = now;
  const label = ALERT_RULES.find((r) => r.key === rule)?.label ?? rule;
  await pushNtfy(settings.ntfyTopic, `[PWRcell] ${label}`, message);
}

/** Reminder while a condition persists — at most one push per cooldown window,
 *  and only when a push would actually go out (no DB spam when push is off). */
function dueForReminder(
  eng: EngineState,
  settings: AlertSettings,
  rule: AlertRuleKey,
  now: number,
): boolean {
  return (
    settings.enabled &&
    settings.rules[rule].enabled &&
    !!settings.ntfyTopic &&
    now - eng.lastPushAt[rule] >= PUSH_COOLDOWN_MS
  );
}

async function writeSample(orgId: string, point: PowerPoint): Promise<void> {
  try {
    const sql = await getSql();
    await sql.query(
      `insert into energy_samples (organization_id, ts, solar_w, home_w, battery_w, grid_w, soc, sys_mode, grid_state)
       values ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9)
       on conflict (organization_id, ts) do nothing`,
      [
        orgId,
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
  orgId: string;
  point: PowerPoint | null;
  mode: "live" | "demo";
  ok: boolean;
  lastError: string | null;
}): Promise<void> {
  const now = Date.now();
  const { orgId, point, mode, ok, lastError } = opts;
  const eng = engineFor(orgId);

  // Demo data must never pollute the long-term history or fire real alerts.
  if (mode !== "live" || !point) return;

  if (ok) eng.lastLiveSuccessAt = now;

  // Energy history: one sample per poll, throttled to 1/minute.
  if (now - eng.lastSampleAt >= SAMPLE_MS) {
    eng.lastSampleAt = now;
    await writeSample(orgId, point);
  }

  // Retention: one sweep per day.
  if (now - eng.lastRetentionAt >= RETENTION_SWEEP_MS) {
    eng.lastRetentionAt = now;
    await sweepRetention();
  }

  // Alerts.
  const settings = await loadAlertSettings(orgId);

  // Grid outage / restored (transition on classified state). A bad condition
  // already active at startup notifies immediately — staying silent about an
  // ongoing outage would defeat the monitor.
  const gridOutage = classifyGrid(point.gridState);
  if (gridOutage !== null) {
    if (eng.prevGridOutage === null) {
      if (gridOutage) {
        await fire(eng, settings, orgId, "gridOutage", `Grid outage detected (grid state: ${point.gridState}).`, now);
        eng.notified.gridOutage = true;
      }
    } else if (gridOutage !== eng.prevGridOutage) {
      if (gridOutage) {
        await fire(eng, settings, orgId, "gridOutage", `Grid outage detected (grid state: ${point.gridState}).`, now);
        eng.notified.gridOutage = true;
      } else {
        await fire(eng, settings, orgId, "gridRestored", "Grid power restored.", now);
        eng.notified.gridOutage = false;
      }
    } else if (
      gridOutage &&
      eng.notified.gridOutage &&
      dueForReminder(eng, settings, "gridOutage", now)
    ) {
      await fire(eng, settings, orgId, "gridOutage", `Grid still out (grid state: ${point.gridState}).`, now);
    }
    eng.prevGridOutage = gridOutage;
  }

  // Battery low.
  const soc = point.batterySoc;
  if (soc != null && Number.isFinite(soc)) {
    const low = soc < settings.lowSocThreshold;
    if (eng.prevLowSoc === null) {
      if (low) {
        await fire(
          eng,
          settings,
          orgId,
          "lowSoc",
          `Battery at ${Math.round(soc)}% — below the ${settings.lowSocThreshold}% threshold.`,
          now,
        );
        eng.notified.lowSoc = true;
      }
    } else if (low !== eng.prevLowSoc) {
      if (low) {
        await fire(
          eng,
          settings,
          orgId,
          "lowSoc",
          `Battery at ${Math.round(soc)}% — below the ${settings.lowSocThreshold}% threshold.`,
          now,
        );
        eng.notified.lowSoc = true;
      } else {
        eng.notified.lowSoc = false;
      }
    } else if (low && eng.notified.lowSoc && dueForReminder(eng, settings, "lowSoc", now)) {
      await fire(
        eng,
        settings,
        orgId,
        "lowSoc",
        `Battery still low at ${Math.round(soc)}% (threshold ${settings.lowSocThreshold}%).`,
        now,
      );
    }
    eng.prevLowSoc = low;
  }

  // Feed stale: no successful cloud poll for 10+ minutes.
  const stale =
    eng.lastLiveSuccessAt !== null && now - eng.lastLiveSuccessAt > STALE_AFTER_MS;
  if (eng.prevStale === null) {
    if (stale) {
      const mins = Math.round((now - (eng.lastLiveSuccessAt ?? now)) / 60000);
      await fire(eng, settings, orgId, "feedStale", `No successful cloud poll for ${mins}+ minutes.`, now);
      eng.notified.feedStale = true;
    }
  } else if (stale !== eng.prevStale) {
    if (stale) {
      const mins = Math.round((now - (eng.lastLiveSuccessAt ?? now)) / 60000);
      await fire(eng, settings, orgId, "feedStale", `No successful cloud poll for ${mins}+ minutes.`, now);
      eng.notified.feedStale = true;
    } else {
      eng.notified.feedStale = false;
    }
  } else if (stale && eng.notified.feedStale && dueForReminder(eng, settings, "feedStale", now)) {
    await fire(eng, settings, orgId, "feedStale", "Cloud feed still stale — check the PWRview connection.", now);
  }
  eng.prevStale = stale;

  // Poll / inverter error.
  const invErr = inverterError(point.sysMode);
  const errSig = lastError ?? (invErr ? `Inverter reports: ${invErr}` : null);
  if (eng.prevError === null) {
    if (errSig) {
      await fire(eng, settings, orgId, "pollError", errSig.slice(0, 300), now);
      eng.notified.pollError = true;
    }
  } else if (errSig !== eng.prevError) {
    if (errSig) {
      await fire(eng, settings, orgId, "pollError", errSig.slice(0, 300), now);
      eng.notified.pollError = true;
    } else {
      eng.notified.pollError = false;
    }
  } else if (errSig && eng.notified.pollError && dueForReminder(eng, settings, "pollError", now)) {
    await fire(eng, settings, orgId, "pollError", `Still failing: ${errSig.slice(0, 300)}`, now);
  }
  eng.prevError = errSig;
}
