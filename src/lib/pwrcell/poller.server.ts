import { generac, hasCredentials } from "./client.server";
import { demoPoint, seedDemoHistory } from "./demo.server";
import { mergePoint, parseHomes, parseTelemetry } from "./parse";
import type {
  HealthPayload,
  HomesPayload,
  LivePayload,
  PowerPoint,
  SeriesPayload,
} from "./types";

const POLL_MS = 30_000;
const BUFFER_MAX = 1440;
const STALE_AFTER_MS = 90_000;
const TELEMETRY_LOOKBACK_MS = 90_000;

type State = {
  mode: "live" | "demo";
  buffer: PowerPoint[];
  lastError: string | null;
  lastPollAt: number | null;
  lastPollDurationMs: number | null;
  lastHomesRaw: unknown;
  homeId: string | null;
  intervalStarted: boolean;
};

const state: State = {
  mode: hasCredentials() ? "live" : "demo",
  buffer: [],
  lastError: null,
  lastPollAt: null,
  lastPollDurationMs: null,
  lastHomesRaw: null,
  homeId: null,
  intervalStarted: false,
};

let inflight: Promise<void> | null = null;

/**
 * Called when the PWRview credentials change via the login menu.
 * Drops cached tokens so the next poll re-authenticates from scratch.
 */
export function resetAuth(): void {
  generac.clearTokens();
}

function configured(): boolean {
  return hasCredentials();
}

function latest(): PowerPoint | null {
  return state.buffer.length ? state.buffer[state.buffer.length - 1]! : null;
}

function pushPoint(point: PowerPoint): void {
  state.buffer.push(point);
  if (state.buffer.length > BUFFER_MAX) {
    state.buffer.splice(0, state.buffer.length - BUFFER_MAX);
  }
}

function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(items[Math.round(i * step)]!);
  }
  return out;
}

async function pollLive(): Promise<void> {
  const started = Date.now();
  const homesRaw = await generac.fetchHomes();
  state.lastHomesRaw = homesRaw;
  const homes = parseHomes(homesRaw);
  if (homes?.homeId) state.homeId = homes.homeId;
  const homeId = homes?.homeId ?? state.homeId;
  let telemetry = null;
  if (homeId) {
    const fromIso = new Date(Date.now() - TELEMETRY_LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
    const telemetryRaw = await generac.fetchTelemetry(homeId, fromIso);
    telemetry = parseTelemetry(telemetryRaw);
  }
  const point = mergePoint({
    now: Date.now(),
    homes,
    telemetry,
    previous: latest(),
  });
  pushPoint(point);
  state.lastError = null;
  state.lastPollAt = Date.now();
  state.lastPollDurationMs = Date.now() - started;
  state.mode = "live";
}

function pollDemo(): void {
  const started = Date.now();
  if (!state.buffer.length) {
    state.buffer = seedDemoHistory(started);
  } else {
    pushPoint(demoPoint(started, latest()));
  }
  state.lastHomesRaw = {
    demo: true,
    note: "GENERAC_EMAIL / GENERAC_PASSWORD are not set — serving a local solar-day simulation.",
    homeId: latest()?.homeId ?? "demo-home",
  };
  state.homeId = latest()?.homeId ?? "demo-home";
  state.lastError = configured()
    ? state.lastError
    : "PWRview credentials not configured — showing a demo day";
  state.lastPollAt = started;
  state.lastPollDurationMs = Date.now() - started;
  state.mode = "demo";
}

async function tick(): Promise<void> {
  let ok = false;
  try {
    if (configured()) {
      await pollLive();
      ok = true;
    } else {
      pollDemo();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    state.lastPollAt = Date.now();
    if (!state.buffer.length && !configured()) {
      pollDemo();
      state.lastError = message;
    }
    console.warn("[pwrcell] poll failed:", message);
  }
  // Post-poll bookkeeping: long-term history sampling, retention sweeps, and
  // alert evaluation. Wrapped so it can never break polling.
  try {
    const { afterPoll } = await import("../alerts.server");
    await afterPoll({ point: latest(), mode: state.mode, ok, lastError: state.lastError });
  } catch (err) {
    console.warn("[pwrcell] post-poll bookkeeping failed:", err instanceof Error ? err.message : err);
  }
}

function ensureInterval(): void {
  if (state.intervalStarted) return;
  if (typeof setInterval === "undefined") return;
  state.intervalStarted = true;
  setInterval(() => {
    void tick();
  }, POLL_MS);
}

export async function ensureFresh(): Promise<void> {
  ensureInterval();
  const age = state.lastPollAt ? Date.now() - state.lastPollAt : Number.POSITIVE_INFINITY;
  if (age < POLL_MS - 2000 && state.buffer.length) return;
  if (inflight) {
    await inflight;
    return;
  }
  inflight = tick().finally(() => {
    inflight = null;
  });
  await inflight;
}

function statusOf(): LivePayload["status"] {
  if (state.mode === "demo") return "demo";
  if (state.lastError && !latest()) return "error";
  if (state.lastError) return "stale";
  const age = state.lastPollAt ? Date.now() - state.lastPollAt : Number.POSITIVE_INFINITY;
  if (age > STALE_AFTER_MS) return "stale";
  return "live";
}

export async function getLivePayload(): Promise<LivePayload> {
  await ensureFresh();
  const point = latest();
  const staleSeconds = state.lastPollAt
    ? Math.max(0, Math.round((Date.now() - state.lastPollAt) / 1000))
    : 0;
  return {
    point,
    error: state.lastError,
    status: statusOf(),
    staleSeconds,
    mode: state.mode,
    configured: configured(),
  };
}

export async function getSeriesPayload(minutesRaw: number | string | null): Promise<SeriesPayload> {
  await ensureFresh();
  const minutes = Math.min(12 * 60, Math.max(5, Number(minutesRaw) || 30));
  const cutoff = Date.now() - minutes * 60_000;
  const sliced = state.buffer
    .filter((p) => p.ts >= cutoff)
    .map((p) => ({
      ts: p.ts,
      solarW: p.solarW,
      homeW: p.homeW,
      batteryW: p.batteryW,
      gridW: p.gridW,
    }));
  return { minutes, points: downsample(sliced, 240) };
}

export async function getHealthPayload(): Promise<HealthPayload> {
  await ensureFresh();
  return {
    configured: configured(),
    mode: state.mode,
    lastPollAt: state.lastPollAt ? new Date(state.lastPollAt).toISOString() : null,
    lastError: state.lastError,
    upstreamCalls: generac.upstreamCalls,
    tokenValid: generac.tokenValid,
    homeId: state.homeId,
    bufferSize: state.buffer.length,
    lastPollDurationMs: state.lastPollDurationMs,
  };
}

export async function getHomesPayload(): Promise<HomesPayload> {
  await ensureFresh();
  return {
    homes: state.lastHomesRaw,
    error: state.lastError,
    configured: configured(),
    mode: state.mode,
  };
}
