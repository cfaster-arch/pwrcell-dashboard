/**
 * Per-organization Ring account link + camera discovery + bridge sync
 * (Phase 2).
 *
 * Pending 2FA state is keyed by org id. Refresh tokens are stored
 * AES-256-GCM encrypted per org (org-ring-tokens.server.ts). The single
 * go2rtc bridge aggregates streams across ALL organizations; stream names
 * are namespaced "<safeOrgId>__cam1/cam2" so orgs can never collide, and the
 * /api/rtc proxy only forwards an org's own stream names.
 *
 * Auth is a two-step flow because Ring requires 2FA:
 *   1. ringAuthStart(orgId, email, password) -> { need2fa } (holds a pending client)
 *   2. ringAuthVerify(orgId, code) -> saves the refresh token, discovers cameras
 *
 * The email/password live only in the pending in-memory client for the few
 * seconds between the steps; only the refresh token is persisted.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { RingApi } from "ring-client-api";
import type { RingRestClient } from "ring-client-api/rest-client";
import { getSql } from "@/lib/db";
import {
  loadCameraSettings,
  resetCameraSettings,
  saveDiscovered,
  type DiscoveredCamera,
} from "./ring-store.server";
import {
  clearOrgRingToken,
  getOrgRingToken,
  orgRingConfigured,
  setOrgRingToken,
} from "./org-ring-tokens.server";
import { bridgeRunning, bridgeStreams, startBridge, stopBridge } from "./go2rtc.server";

/**
 * ring-client-api is loaded with require() instead of import on purpose:
 * one of its transitive deps (@homebridge/camera-utils) uses __dirname,
 * which breaks when the Nitro production bundle inlines it as ESM.
 * Loaded this way, Node runs the real CommonJS files from node_modules.
 */
const _require = createRequire(import.meta.url);

function loadRing(): {
  RingApi: typeof RingApi;
  RingRestClient: typeof RingRestClient;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const main = _require("ring-client-api") as {
    RingApi: typeof RingApi;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rest = _require("ring-client-api/rest-client") as {
    RingRestClient: typeof RingRestClient;
  };
  return { RingApi: main.RingApi, RingRestClient: rest.RingRestClient };
}

interface PendingAuth {
  client: RingRestClient;
  createdAt: number;
}

const pending = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60 * 1000;

/** In-flight 2FA sessions are keyed by org AND user (security review 2026-09-25
 *  R3.5): two users of the same org racing sign-in must not overwrite or
 *  consume each other's pending auth. */
function pendingKey(orgId: string, userId: string): string {
  return `${orgId}\0${userId}`;
}

/**
 * Stream-name namespace prefix for an org. A SHA-256 hex digest of the org id
 * (not a lossy sanitization of the id itself): distinct org ids can never
 * collapse to the same prefix, so the /api/rtc exact-match check can't pass
 * for another org's stream (security review 2026-09-25 R3.2).
 */
function streamPrefix(orgId: string): string {
  const digest = createHash("sha256").update(orgId, "utf8").digest("hex").slice(0, 16);
  return `org_${digest}__`;
}

/** The go2rtc stream names belonging to an org — for status filtering and /api/rtc validation. */
export function orgStreamNames(orgId: string): string[] {
  const p = streamPrefix(orgId);
  return [`${p}cam1`, `${p}cam2`];
}

export async function ringAuthStart(
  orgId: string,
  userId: string,
  email: string,
  password: string,
): Promise<{ need2fa: boolean; prompt?: string }> {
  const { RingRestClient } = loadRing();
  const client = new RingRestClient({ email, password });
  const key = pendingKey(orgId, userId);
  try {
    const auth = await client.getCurrentAuth();
    pending.delete(key);
    await setOrgRingToken(orgId, auth.refresh_token);
    return { need2fa: false };
  } catch {
    if (client.promptFor2fa) {
      pending.set(key, { client, createdAt: Date.now() });
      return { need2fa: true, prompt: client.promptFor2fa };
    }
    throw new Error("Ring sign-in failed — check the email and password.");
  }
}

export async function ringAuthVerify(orgId: string, userId: string, code: string): Promise<DiscoveredCamera[]> {
  const key = pendingKey(orgId, userId);
  const p = pending.get(key);
  pending.delete(key);
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) {
    throw new Error("That step expired — start the sign-in over.");
  }
  let auth;
  try {
    auth = await p.client.getAuth(code.trim());
  } catch {
    throw new Error("Wrong code — check the text from Ring and try again.");
  }
  await setOrgRingToken(orgId, auth.refresh_token);
  const cams = await discoverCameras(orgId);
  await saveDiscovered(orgId, cams);
  await syncBridge();
  return cams;
}

export async function discoverCameras(orgId: string): Promise<DiscoveredCamera[]> {
  const { RingApi } = loadRing();
  const token = await getOrgRingToken(orgId);
  if (!token) throw new Error("Ring isn't connected yet.");
  const api = new RingApi({ refreshToken: token, cameraStatusPollingSeconds: 30 });
  try {
    const cams = await api.getCameras();
    return cams.map((c) => ({
      deviceId: c.id,
      name: c.name || `Camera ${c.id}`,
      model: c.model || "",
    }));
  } finally {
    api.disconnect();
  }
}

/**
 * Make go2rtc match the saved settings across ALL organizations: one
 * namespaced stream per assigned slot wherever an org is enabled + has a
 * token. Stops the bridge when no org has any live stream.
 *
 * Serialized through an in-process mutex (security review 2026-09-25 R3.3):
 * syncBridge is read-all-then-write-all, so two concurrent runs (a connect
 * racing a disconnect) could interleave and resurrect a deleted org's
 * stream/token. The mutex makes each run's read-compute-write atomic, and
 * the config file itself is written atomically in startBridge.
 */
let bridgeMutex: Promise<void> = Promise.resolve();
export async function syncBridge(): Promise<void> {
  const run = bridgeMutex.then(doSyncBridge, doSyncBridge);
  bridgeMutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function doSyncBridge(): Promise<void> {
  const sql = await getSql();
  const orgs = await sql<{ id: string }>`select id from organization`;
  const streams: Array<{ name: string; deviceId: string | number; refreshToken: string }> = [];
  for (const { id } of orgs) {
    const token = await getOrgRingToken(id).catch(() => null);
    if (!token) continue;
    const s = await loadCameraSettings(id).catch(() => null);
    if (!s || !s.enabled) continue;
    // Stream names track slot positions (cam1/cam2) even when a slot is empty,
    // so the UI always knows which stream is which camera.
    const prefix = streamPrefix(id);
    [s.cam1, s.cam2].forEach((slot, i) => {
      if (slot) streams.push({ name: `${prefix}cam${i + 1}`, deviceId: slot.deviceId, refreshToken: token });
    });
  }
  if (streams.length === 0) {
    await stopBridge();
    return;
  }
  await startBridge(streams);
}

export async function ringDisconnect(orgId: string): Promise<void> {
  // Drop any in-flight 2FA sessions for this org (all users).
  for (const key of [...pending.keys()]) {
    if (key.startsWith(`${orgId} `)) pending.delete(key);
  }
  await clearOrgRingToken(orgId);
  await resetCameraSettings(orgId);
  await syncBridge();
}

export interface RingStatus {
  configured: boolean;
  bridge: { running: boolean; streams: string[] };
}

// After a VPS reboot the app process is fresh but go2rtc isn't running.
// The first status check re-syncs the bridge so cameras recover on their
// own instead of waiting for someone to touch a setting.
let bridgeInitDone = false;
async function ensureBridgeInit(): Promise<void> {
  if (bridgeInitDone) return;
  bridgeInitDone = true;
  try {
    await syncBridge();
  } catch {
    /* bridge stays down; the UI shows it and the next settings change retries */
  }
}

export async function ringStatus(orgId: string): Promise<RingStatus> {
  await ensureBridgeInit();
  const running = bridgeRunning();
  const raw = running ? await bridgeStreams() : null;
  const mine = new Set(orgStreamNames(orgId));
  return {
    configured: await orgRingConfigured(orgId),
    bridge: { running, streams: raw ? Object.keys(raw).filter((n) => mine.has(n)) : [] },
  };
}
