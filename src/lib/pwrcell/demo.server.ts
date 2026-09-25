import type { PowerPoint } from "./types";

const TZ = "America/Los_Angeles";
const STEP_MS = 30_000;
const HISTORY = 1440;

function hourInTz(ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour + minute / 60;
}

function noise(ts: number, periodMs: number, amplitude: number): number {
  return amplitude * Math.sin(ts / periodMs);
}

function solarKwAt(ts: number): number {
  const h = hourInTz(ts);
  const sunrise = 6.35;
  const sunset = 19.15;
  if (h < sunrise || h > sunset) return 0;
  const t = (h - sunrise) / (sunset - sunrise);
  const bell = Math.sin(Math.PI * t);
  const clouds = 0.88 + noise(ts, 540_000, 0.08) + noise(ts, 180_000, 0.04);
  return Math.max(0, 6.4 * bell * bell * clouds);
}

function homeKwAt(ts: number): number {
  const h = hourInTz(ts);
  let base = 0.55;
  if (h >= 6 && h < 9) base = 1.15;
  else if (h >= 11 && h < 14) base = 0.85;
  else if (h >= 17 && h < 21.5) base = 2.05;
  else if (h >= 21.5 || h < 5.5) base = 0.42;
  return Math.max(0.2, base + noise(ts, 240_000, 0.12) + noise(ts, 90_000, 0.05));
}

function emptyPoint(ts: number): PowerPoint {
  return {
    ts,
    solarW: 0,
    homeW: 0,
    batteryW: 0,
    gridW: 0,
    generatorW: 0,
    batterySoc: 62,
    batteryTempC: 23.4,
    batteryVoltage: 378.6,
    batteryBackupSeconds: 18 * 3600,
    batteryState: null,
    solarLifetimeKwh: 18420.4,
    batteryLifetimeKwh: 6120.1,
    inverterLifetimeKwh: 17680.8,
    inverterW: 0,
    inverterTempC: 36.2,
    inverterVoltage: 241.4,
    inverterHeadroomW: 5200,
    gridState: "GRID_CONNECTED",
    sysMode: "SELF_SUPPLY",
    homeId: "demo-home",
    timezone: TZ,
    address: "Demo home",
    serialNumber: "X7602-DEMO",
  };
}

export function demoPoint(ts: number, previous: PowerPoint | null): PowerPoint {
  const prev = previous ?? emptyPoint(ts - STEP_MS);
  const solarKw = solarKwAt(ts);
  const homeKw = homeKwAt(ts);
  let soc = prev.batterySoc ?? 62;
  const surplus = solarKw - homeKw;
  let batteryKw = 0;
  if (surplus > 0.08 && soc < 96) {
    batteryKw = -Math.min(surplus, 3.4, ((96 - soc) / 100) * 12);
  } else if (surplus < -0.08 && soc > 12) {
    batteryKw = Math.min(-surplus, 3.2, ((soc - 12) / 100) * 10);
  }
  const gridKw = homeKw - solarKw - batteryKw;
  const hours = STEP_MS / 3_600_000;
  soc = Math.min(96, Math.max(12, soc - batteryKw * hours * (100 / 13)));
  const usableKwh = 13 * ((soc - 8) / 92);
  const backupSeconds = batteryKw > 0.05 ? Math.round((usableKwh / Math.max(homeKw, 0.3)) * 3600) : Math.round((usableKwh / Math.max(homeKw, 0.4)) * 3600);

  const solarW = Math.round(solarKw * 1000);
  const homeW = Math.round(homeKw * 1000);
  const batteryW = Math.round(batteryKw * 1000);
  const gridW = Math.round(gridKw * 1000);

  return {
    ...prev,
    ts,
    solarW,
    homeW,
    batteryW,
    gridW,
    generatorW: 0,
    batterySoc: Math.round(soc * 10) / 10,
    batteryTempC: Math.round((22.5 + (batteryKw !== 0 ? 1.8 : 0) + noise(ts, 1_200_000, 0.6)) * 10) / 10,
    batteryVoltage: Math.round((352 + soc * 0.42 + noise(ts, 600_000, 1.2)) * 10) / 10,
    batteryBackupSeconds: Math.max(0, backupSeconds),
    solarLifetimeKwh: (prev.solarLifetimeKwh ?? 18420) + solarKw * hours,
    batteryLifetimeKwh: (prev.batteryLifetimeKwh ?? 6120) + Math.abs(batteryKw) * hours,
    inverterLifetimeKwh: (prev.inverterLifetimeKwh ?? 17680) + Math.max(solarKw - Math.max(-batteryKw, 0), 0) * hours,
    inverterW: Math.round(Math.max(solarW + Math.min(batteryW, 0), 0)),
    inverterTempC: Math.round((32 + solarKw * 1.4 + noise(ts, 900_000, 0.8)) * 10) / 10,
    inverterHeadroomW: Math.round(Math.max(0, 7600 - Math.max(solarW, homeW))),
    gridState: "GRID_CONNECTED",
    sysMode: soc < 30 ? "PRIORITY_BACKUP" : "SELF_SUPPLY",
  };
}

export function seedDemoHistory(now = Date.now()): PowerPoint[] {
  const points: PowerPoint[] = [];
  let prev: PowerPoint | null = null;
  const start = now - (HISTORY - 1) * STEP_MS;
  for (let i = 0; i < HISTORY; i++) {
    const p = demoPoint(start + i * STEP_MS, prev);
    points.push(p);
    prev = p;
  }
  return points;
}
