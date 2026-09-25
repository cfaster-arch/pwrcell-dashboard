import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * go2rtc lifecycle manager (Ring cloud -> go2rtc -> browser WebRTC).
 *
 * The app (running as root on the VPS) owns the whole bridge:
 *  - downloads the go2rtc binary on first use (pinned release, linux amd64/arm64)
 *  - writes go2rtc.yaml from the Ring refresh token + discovered device ids
 *  - spawns and supervises the process (127.0.0.1:1984, proxied by the app as /api/rtc/*)
 *  - opens the WebRTC UDP media port in ufw (best effort)
 *
 * The refresh token never leaves the server: the browser only talks to
 * same-origin /api/rtc/*, which forwards to go2rtc on localhost.
 */

const GO2RTC_VERSION = "v1.9.14";
const DIR = path.resolve(process.cwd(), "data/go2rtc");
const BIN = path.join(DIR, "go2rtc");
const CONF = path.join(DIR, "go2rtc.yaml");

export const GO2RTC_PORT = 1984;
export const WEBRTC_UDP_PORT = 8555;

const execFileAsync = promisify(execFile);

let child: ChildProcess | null = null;
let wantRunning = false;
let restartTimer: NodeJS.Timeout | null = null;
let failures = 0;
let lastConfig = "";

function assetName(): string {
  return `go2rtc_linux_${os.arch() === "arm64" ? "arm64" : "amd64"}`;
}

/** Download the pinned go2rtc release binary on first use. */
export async function ensureBinary(): Promise<string> {
  if (fs.existsSync(BIN)) return BIN;
  fs.mkdirSync(DIR, { recursive: true });
  const url = `https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VERSION}/${assetName()}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new Error(`go2rtc download failed: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw new Error(`go2rtc download failed (HTTP ${res.status})`);
  fs.writeFileSync(BIN, Buffer.from(await res.arrayBuffer()));
  fs.chmodSync(BIN, 0o755);
  return BIN;
}

export interface BridgeStream {
  /** Stable local name, e.g. "org_default__cam1" (namespaced per org). */
  name: string;
  deviceId: string | number;
  /** Ring refresh token of the org that owns this stream. */
  refreshToken: string;
}

function buildConfig(streams: BridgeStream[], publicIp: string): string {
  const lines = [
    "# Managed by pwrcell-dashboard — manual edits will be overwritten.",
    "api:",
    `  listen: "127.0.0.1:${GO2RTC_PORT}"`,
    "webrtc:",
    `  listen: ":${WEBRTC_UDP_PORT}"`,
    "  candidates:",
    `    - "${publicIp}:${WEBRTC_UDP_PORT}"`,
    "streams:",
  ];
  for (const s of streams) {
    // Single-quoted YAML scalar: refresh tokens are base64url, never contain "'".
    lines.push(
      `  ${s.name}: 'ring:?device_id=${s.deviceId}&refresh_token=${s.refreshToken}'`,
    );
  }
  return lines.join("\n") + "\n";
}

let cachedIp: string | null = null;

/** Public IP for WebRTC ICE candidates (env override, else auto-detect once). */
export async function publicIp(): Promise<string> {
  if (process.env.RING_PUBLIC_IP?.trim()) return process.env.RING_PUBLIC_IP.trim();
  if (cachedIp) return cachedIp;
  const res = await fetch("https://api.ipify.org", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error("public IP detection failed");
  cachedIp = (await res.text()).trim();
  if (!cachedIp) throw new Error("public IP detection returned empty");
  return cachedIp;
}

/** Open the WebRTC UDP media port in ufw. Best effort; needs root. */
export async function ensureUdpOpen(): Promise<boolean> {
  try {
    if (typeof process.getuid === "function" && process.getuid() !== 0) return false;
    await execFileAsync("ufw", ["allow", `${WEBRTC_UDP_PORT}/udp`]);
    return true;
  } catch {
    return false;
  }
}

function spawnBridge(): void {
  if (child || !wantRunning) return;
  try {
    child = spawn(BIN, ["-config", CONF], { stdio: "ignore" });
  } catch {
    scheduleRestart();
    return;
  }
  failures = 0;
  child.on("exit", () => {
    child = null;
    scheduleRestart();
  });
  child.on("error", () => {
    child = null;
    scheduleRestart();
  });
}

function scheduleRestart(): void {
  if (!wantRunning || restartTimer) return;
  failures += 1;
  const delay = Math.min(5_000 * failures, 60_000);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnBridge();
  }, delay);
  restartTimer.unref?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * (Re)start the bridge with the given streams. Only restarts go2rtc when the
 * config actually changed, so saving unrelated settings doesn't drop streams.
 */
export async function startBridge(streams: BridgeStream[]): Promise<void> {
  wantRunning = true;
  await ensureBinary();
  const ip = await publicIp().catch(() => "127.0.0.1");
  const cfg = buildConfig(streams, ip);
  if (cfg !== lastConfig) {
    lastConfig = cfg;
    fs.mkdirSync(DIR, { recursive: true });
    // Atomic replace (temp + rename) so a concurrent/failed write can't leave
    // go2rtc reading a truncated config; chmod every time because writeFileSync
    // mode only applies at creation (security review 2026-09-25 R3.1/R3.3).
    const tmp = `${CONF}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, cfg, { mode: 0o600 });
    fs.renameSync(tmp, CONF);
    try { fs.chmodSync(CONF, 0o600); } catch { /* best effort */ }
    await stopBridge();
    wantRunning = true;
    await ensureUdpOpen().catch(() => false);
    await sleep(1200); // let the old process release the ports
  }
  spawnBridge();
}

export async function stopBridge(): Promise<void> {
  wantRunning = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const c = child;
  child = null;
  if (c && c.exitCode === null) {
    c.kill("SIGTERM");
  }
}

export function bridgeRunning(): boolean {
  return child !== null && child.exitCode === null;
}

/** Live stream states from go2rtc, or null when the bridge is down. */
export async function bridgeStreams(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${GO2RTC_PORT}/api/streams`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
