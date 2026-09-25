/**
 * Per-organization PWRcell telemetry poller (Phase 2).
 *
 * Each organization gets its own poller state: its own GeneracClient (auth
 * tokens), ring buffer, demo fallback, home id, and interval. State for an
 * org is created lazily on first use and survives HMR via globalThis.
 * Deleting an organization stops and drops its poller (see stopOrgPoller).
 */
import { GeneracClient, type GeneracCredentials } from "./client.server";
import { getOrgCredentials, orgCredentialsConfigured } from "./org-credentials.server";
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

type OrgState = {
  orgId: string;
  client: GeneracClient;
  mode: "live" | "demo";
  buffer: PowerPoint[];
  lastError: string | null;
  lastPollAt: number | null;
  lastPollDurationMs: number | null;
  lastHomesRaw: unknown;
  homeId: string | null;
  inflight: Promise<void> | null;
  intervalStarted: boolean;
  timer: ReturnType<typeof setInterval> | null;
};

function newOrgState(orgId: string): OrgState {
  return {
    orgId,
    client: new GeneracClient(),
    mode: "demo",
    buffer: [],
    lastError: null,
    lastPollAt: null,
    lastPollDurationMs: null,
    lastHomesRaw: null,
    homeId: null,
    inflight: null,
    intervalStarted: false,
    timer: null,
  };
}

const globalRef = globalThis as unknown as {
  __pwrcellOrgPollers__?: Map<string, OrgState>;
};

function pollers(): Map<string, OrgState> {
  if (!globalRef.__pwrcellOrgPollers__) globalRef.__pwrcellOrgPollers__ = new Map();
  return globalRef.__pwrcellOrgPollers__;
}

/** Test hook: reach an org's poller state for assertions. */
export function __getOrgState(orgId: string): OrgState {
  return getOrgState(orgId);
}

function getOrgState(orgId: string): OrgState {
  const map = pollers();
  let st = map.get(orgId);
  if (!st) {
    st = newOrgState(orgId);
    map.set(orgId, st);
  }
  return st;
}

/** Drop an org's poller entirely (org deletion). Clears its interval and tokens. */
export function stopOrgPoller(orgId: string): void {
  const st = pollers().get(orgId);
  if (!st) return;
  if (st.timer) clearInterval(st.timer);
  st.client.clearTokens();
  pollers().delete(orgId);
}

/**
 * Called when an org's PWRview credentials change via the login menu.
 * Drops cached tokens so the next poll re-authenticates from scratch.
 */
export function resetOrgAuth(orgId: string): void {
  getOrgState(orgId).client.clearTokens();
}

/**
 * Called when the user disconnects via the login menu.
 * Drops tokens, the home id, and any auth error, and settles back into
 * demo mode immediately instead of waiting for the next poll tick.
 */
export function resetOrgToDemo(orgId: string): void {
  const st = getOrgState(orgId);
  st.client.clearTokens();
  st.lastError = null;
  st.lastHomesRaw = null;
  st.homeId = null;
  st.mode = "demo";
}

function latest(st: OrgState): PowerPoint | null {
  return st.buffer.length ? st.buffer[st.buffer.length - 1]! : null;
}

function pushPoint(st: OrgState, point: PowerPoint): void {
  st.buffer.push(point);
  if (st.buffer.length > BUFFER_MAX) {
    st.buffer.splice(0, st.buffer.length - BUFFER_MAX);
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

async function pollLive(st: OrgState, creds: GeneracCredentials): Promise<void> {
  const started = Date.now();
  const homesRaw = await st.client.fetchHomes(creds);
  st.lastHomesRaw = homesRaw;
  const homes = parseHomes(homesRaw);
  if (homes?.homeId) st.homeId = homes.homeId;
  const homeId = homes?.homeId ?? st.homeId;
  let telemetry = null;
  if (homeId) {
    const fromIso = new Date(Date.now() - TELEMETRY_LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
    const telemetryRaw = await st.client.fetchTelemetry(homeId, fromIso, creds);
    telemetry = parseTelemetry(telemetryRaw);
  }
  const point = mergePoint({
    now: Date.now(),
    homes,
    telemetry,
    previous: latest(st),
  });
  pushPoint(st, point);
  st.lastError = null;
  st.lastPollAt = Date.now();
  st.lastPollDurationMs = Date.now() - started;
  st.mode = "live";
}

function pollDemo(st: OrgState, hasCreds: boolean, credErr: string | null): void {
  const started = Date.now();
  if (!st.buffer.length) {
    st.buffer = seedDemoHistory(started);
  } else {
    pushPoint(st, demoPoint(started, latest(st)));
  }
  st.lastHomesRaw = {
    demo: true,
    note: "PWRview credentials are not set for this organization — serving a local solar-day simulation.",
    homeId: latest(st)?.homeId ?? "demo-home",
  };
  st.homeId = latest(st)?.homeId ?? "demo-home";
  st.lastError =
    credErr ?? (hasCreds ? st.lastError : "PWRview credentials not configured — showing a demo day");
  st.lastPollAt = started;
  st.lastPollDurationMs = Date.now() - started;
  st.mode = "demo";
}

async function tick(st: OrgState): Promise<void> {
  let ok = false;
  try {
    let creds: GeneracCredentials | null = null;
    let credErr: string | null = null;
    try {
      creds = await getOrgCredentials(st.orgId);
    } catch (err) {
      // Configured but undecryptable (e.g. DEK lost): surface the error and
      // keep serving the demo buffer rather than crashing the tick.
      credErr = err instanceof Error ? err.message : String(err);
    }
    if (creds) {
      await pollLive(st, creds);
      ok = true;
    } else {
      pollDemo(st, credErr !== null, credErr);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    st.lastError = message;
    st.lastPollAt = Date.now();
    const hasCreds = await orgCredentialsConfigured(st.orgId).catch(() => true);
    if (!st.buffer.length && !hasCreds) {
      pollDemo(st, false, null);
      st.lastError = message;
    }
    console.warn(`[pwrcell:${st.orgId}] poll failed:`, message);
  }
  // Post-poll bookkeeping: long-term history sampling, retention sweeps, and
  // alert evaluation. Wrapped so it can never break polling.
  try {
    const { afterPoll } = await import("../alerts.server");
    await afterPoll({ orgId: st.orgId, point: latest(st), mode: st.mode, ok, lastError: st.lastError });
  } catch (err) {
    console.warn(`[pwrcell:${st.orgId}] post-poll bookkeeping failed:`, err instanceof Error ? err.message : err);
  }
}

function ensureOrgInterval(st: OrgState): void {
  if (st.intervalStarted) return;
  if (typeof setInterval === "undefined") return;
  st.intervalStarted = true;
  st.timer = setInterval(() => {
    void tick(st);
  }, POLL_MS);
  // Unref'd so test processes can exit; the app server keeps the loop alive.
  st.timer.unref?.();
}

export async function ensureOrgFresh(orgId: string): Promise<void> {
  const st = getOrgState(orgId);
  ensureOrgInterval(st);
  const age = st.lastPollAt ? Date.now() - st.lastPollAt : Number.POSITIVE_INFINITY;
  if (age < POLL_MS - 2000 && st.buffer.length) return;
  if (st.inflight) {
    await st.inflight;
    return;
  }
  st.inflight = tick(st).finally(() => {
    st.inflight = null;
  });
  await st.inflight;
}

function statusOf(st: OrgState): LivePayload["status"] {
  if (st.mode === "demo") return "demo";
  if (st.lastError && !latest(st)) return "error";
  if (st.lastError) return "stale";
  const age = st.lastPollAt ? Date.now() - st.lastPollAt : Number.POSITIVE_INFINITY;
  if (age > STALE_AFTER_MS) return "stale";
  return "live";
}

export async function getLivePayload(orgId: string): Promise<LivePayload> {
  await ensureOrgFresh(orgId);
  const st = getOrgState(orgId);
  const point = latest(st);
  const staleSeconds = st.lastPollAt
    ? Math.max(0, Math.round((Date.now() - st.lastPollAt) / 1000))
    : 0;
  return {
    point,
    error: st.lastError,
    status: statusOf(st),
    staleSeconds,
    mode: st.mode,
    configured: await orgCredentialsConfigured(orgId),
  };
}

export async function getSeriesPayload(
  orgId: string,
  minutesRaw: number | string | null,
): Promise<SeriesPayload> {
  await ensureOrgFresh(orgId);
  const st = getOrgState(orgId);
  const minutes = Math.min(12 * 60, Math.max(5, Number(minutesRaw) || 30));
  const cutoff = Date.now() - minutes * 60_000;
  const sliced = st.buffer
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

export async function getHealthPayload(orgId: string): Promise<HealthPayload> {
  await ensureOrgFresh(orgId);
  const st = getOrgState(orgId);
  return {
    configured: await orgCredentialsConfigured(orgId),
    mode: st.mode,
    lastPollAt: st.lastPollAt ? new Date(st.lastPollAt).toISOString() : null,
    lastError: st.lastError,
    upstreamCalls: st.client.upstreamCalls,
    tokenValid: st.client.tokenValid,
    homeId: st.homeId,
    bufferSize: st.buffer.length,
    lastPollDurationMs: st.lastPollDurationMs,
  };
}

export async function getHomesPayload(orgId: string): Promise<HomesPayload> {
  await ensureOrgFresh(orgId);
  const st = getOrgState(orgId);
  return {
    homes: st.lastHomesRaw,
    error: st.lastError,
    configured: await orgCredentialsConfigured(orgId),
    mode: st.mode,
  };
}
