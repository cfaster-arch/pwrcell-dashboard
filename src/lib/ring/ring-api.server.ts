import { createRequire } from "node:module";
import type { RingApi } from "ring-client-api";
import type { RingRestClient } from "ring-client-api/rest-client";
import {
  clearRingToken,
  getRingToken,
  loadCameraSettings,
  resetCameraSettings,
  saveDiscovered,
  setRingToken,
  type DiscoveredCamera,
} from "./ring-store.server";
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

/**
 * Ring account link + camera discovery + bridge sync.
 *
 * Auth is a two-step flow because Ring requires 2FA:
 *   1. ringAuthStart(email, password) -> { need2fa } (holds a pending client)
 *   2. ringAuthVerify(code) -> saves the refresh token, discovers cameras
 *
 * The email/password live only in the pending in-memory client for the few
 * seconds between the steps; only the refresh token is persisted.
 */

interface PendingAuth {
  client: RingRestClient;
  createdAt: number;
}

let pending: PendingAuth | null = null;
const PENDING_TTL_MS = 10 * 60 * 1000;

export async function ringAuthStart(
  email: string,
  password: string,
): Promise<{ need2fa: boolean; prompt?: string }> {
  const { RingRestClient } = loadRing();
  const client = new RingRestClient({ email, password });
  try {
    const auth = await client.getCurrentAuth();
    pending = null;
    setRingToken(auth.refresh_token);
    return { need2fa: false };
  } catch {
    if (client.promptFor2fa) {
      pending = { client, createdAt: Date.now() };
      return { need2fa: true, prompt: client.promptFor2fa };
    }
    throw new Error("Ring sign-in failed — check the email and password.");
  }
}

export async function ringAuthVerify(code: string): Promise<DiscoveredCamera[]> {
  const p = pending;
  pending = null;
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) {
    throw new Error("That step expired — start the sign-in over.");
  }
  let auth;
  try {
    auth = await p.client.getAuth(code.trim());
  } catch {
    throw new Error("Wrong code — check the text from Ring and try again.");
  }
  setRingToken(auth.refresh_token);
  const cams = await discoverCameras();
  saveDiscovered(cams);
  await syncBridge();
  return cams;
}

export async function discoverCameras(): Promise<DiscoveredCamera[]> {
  const { RingApi } = loadRing();
  const token = getRingToken();
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
 * Make go2rtc match the saved settings: running with one stream per assigned
 * slot when enabled + token present, stopped otherwise.
 */
export async function syncBridge(): Promise<void> {
  const token = getRingToken();
  const s = loadCameraSettings();
  // Stream names track slot positions (cam1/cam2) even when a slot is empty,
  // so the UI always knows which stream is which camera.
  const slots = [s.cam1, s.cam2]
    .map((slot, i) => (slot ? { name: `cam${i + 1}`, deviceId: slot.deviceId } : null))
    .filter((x): x is { name: string; deviceId: number } => x !== null);
  if (!token || !s.enabled || slots.length === 0) {
    await stopBridge();
    return;
  }
  await startBridge(slots, token);
}

export async function ringDisconnect(): Promise<void> {
  pending = null;
  clearRingToken();
  resetCameraSettings();
  await stopBridge();
}

export interface RingStatus {
  configured: boolean;
  bridge: { running: boolean; streams: string[] };
}

export async function ringStatus(): Promise<RingStatus> {
  const running = bridgeRunning();
  const raw = running ? await bridgeStreams() : null;
  return {
    configured: getRingToken() !== null,
    bridge: { running, streams: raw ? Object.keys(raw) : [] },
  };
}
