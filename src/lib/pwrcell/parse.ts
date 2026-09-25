import type { PowerPoint } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function kwToW(value: unknown): number | null {
  const n = num(value);
  return n == null ? null : Math.round(n * 1000);
}

export function formatAddress(home: Record<string, unknown>): string | null {
  const parts = [home.address1, home.city, home.state]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function firstSystemSerial(home: Record<string, unknown>): string | null {
  const systems = home.systems;
  if (!Array.isArray(systems)) return null;
  for (const system of systems) {
    const rec = asRecord(system);
    const serial = rec ? str(rec.serialNumber) : null;
    if (serial) return serial;
  }
  return null;
}

export type HomesParse = {
  homeId: string | null;
  timezone: string | null;
  address: string | null;
  serialNumber: string | null;
  solarW: number;
  solarLifetimeKwh: number | null;
  batteryW: number | null;
  batterySoc: number | null;
  batteryLifetimeKwh: number | null;
  batteryTempC: number | null;
  batteryVoltage: number | null;
  inverterW: number | null;
  inverterLifetimeKwh: number | null;
  inverterTempC: number | null;
  inverterVoltage: number | null;
};

export function parseHomes(raw: unknown): HomesParse | null {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const home = asRecord(list[0]);
  if (!home) return null;

  const pvl: Record<string, unknown>[] = [];
  let battery: Record<string, unknown> | null = null;
  let inverter: Record<string, unknown> | null = null;

  const systems = Array.isArray(home.systems) ? home.systems : [];
  for (const system of systems) {
    const sys = asRecord(system);
    const devices = sys && Array.isArray(sys.systemDevices) ? sys.systemDevices : [];
    for (const device of devices) {
      const dev = asRecord(device);
      if (!dev) continue;
      const dtype = str(dev.deviceType);
      const status = asRecord(dev.deviceStatus) ?? {};
      if (dtype === "PVL") pvl.push(status);
      else if (dtype === "BATTERY" && !battery) battery = status;
      else if (dtype === "INVERTER" && !inverter) inverter = status;
    }
  }

  const solarW = pvl.reduce((sum, d) => sum + (num(d.powerInWatts) ?? 0), 0);
  const solarWh = pvl.reduce((sum, d) => sum + (num(d.lifeTimeEnergyInWh) ?? 0), 0);
  const battWh = battery ? num(battery.lifeTimeEnergyInWh) : null;
  const invWh = inverter ? num(inverter.lifeTimeEnergyInWh) : null;

  return {
    homeId: str(home.homeId),
    timezone: str(home.timezone),
    address: formatAddress(home),
    serialNumber: firstSystemSerial(home),
    solarW,
    solarLifetimeKwh: solarWh ? solarWh / 1000 : pvl.length ? 0 : null,
    batteryW: battery ? num(battery.powerInWatts) : null,
    batterySoc: battery ? num(battery.soc) : null,
    batteryLifetimeKwh: battWh == null ? null : battWh / 1000,
    batteryTempC: battery ? num(battery.temperatureInCelsius) : null,
    batteryVoltage: battery ? num(battery.voltage) : null,
    inverterW: inverter ? num(inverter.powerInWatts) : null,
    inverterLifetimeKwh: invWh == null ? null : invWh / 1000,
    inverterTempC: inverter ? num(inverter.temperatureInCelsius) : null,
    inverterVoltage: inverter ? num(inverter.voltage) : null,
  };
}

export type TelemetryParse = {
  ts: number | null;
  solarW: number | null;
  homeW: number | null;
  batteryW: number | null;
  gridW: number | null;
  generatorW: number | null;
  batterySoc: number | null;
  batteryBackupSeconds: number | null;
  batteryState: string | null;
  gridState: string | null;
  sysMode: string | null;
  inverterHeadroomW: number | null;
};

export function parseTelemetry(raw: unknown): TelemetryParse | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const entry = asRecord(raw[raw.length - 1]);
  if (!entry) return null;

  const section = (key: string) => asRecord(entry[key]);
  const solar = section("solar");
  const grid = section("grid");
  const consumption = section("consumption");
  const generator = section("generator");
  const battery = section("battery");

  let gridState: string | null = null;
  let sysMode: string | null = null;
  let inverterHeadroomW: number | null = null;
  const systemMap = asRecord(entry.system);
  if (systemMap) {
    for (const value of Object.values(systemMap)) {
      const rec = asRecord(value);
      if (!rec) continue;
      gridState = str(rec.gridState);
      sysMode = str(rec.sysMode);
      inverterHeadroomW = kwToW(rec.inverterHeadRoomKw);
      break;
    }
  }

  const dateRaw = entry.date;
  let ts: number | null = null;
  if (typeof dateRaw === "string" && /^\d+$/.test(dateRaw)) {
    ts = Number(dateRaw) * 1000;
  } else if (typeof dateRaw === "number") {
    ts = dateRaw < 1e12 ? dateRaw * 1000 : dateRaw;
  }

  const backup = battery ? num(battery.batteryBackupTimeInSeconds) : null;

  return {
    ts,
    solarW: solar ? kwToW(solar.powerKw) : null,
    homeW: consumption ? kwToW(consumption.powerKw) : null,
    batteryW: battery ? kwToW(battery.powerKw) : null,
    gridW: grid ? kwToW(grid.powerKw) : null,
    generatorW: generator ? kwToW(generator.powerKw) : null,
    batterySoc: battery ? num(battery.soC) : null,
    batteryBackupSeconds: backup == null ? null : Math.round(backup),
    batteryState: battery ? str(battery.batteryState) : null,
    gridState,
    sysMode,
    inverterHeadroomW,
  };
}

export function monotonicKwh(prev: number | null, next: number | null): number | null {
  if (next == null) return prev;
  if (prev == null) return next;
  return next < prev ? prev : next;
}

export function mergePoint(args: {
  now: number;
  homes: HomesParse | null;
  telemetry: TelemetryParse | null;
  previous: PowerPoint | null;
}): PowerPoint {
  const { now, homes, telemetry, previous } = args;
  const solarLifetime = monotonicKwh(
    previous?.solarLifetimeKwh ?? null,
    homes?.solarLifetimeKwh ?? null,
  );
  const batteryLifetime = monotonicKwh(
    previous?.batteryLifetimeKwh ?? null,
    homes?.batteryLifetimeKwh ?? null,
  );
  const inverterLifetime = monotonicKwh(
    previous?.inverterLifetimeKwh ?? null,
    homes?.inverterLifetimeKwh ?? null,
  );

  return {
    ts: telemetry?.ts ?? now,
    solarW: telemetry?.solarW ?? homes?.solarW ?? previous?.solarW ?? 0,
    homeW: telemetry?.homeW ?? previous?.homeW ?? 0,
    batteryW: telemetry?.batteryW ?? homes?.batteryW ?? previous?.batteryW ?? 0,
    gridW: telemetry?.gridW ?? previous?.gridW ?? 0,
    generatorW: telemetry?.generatorW ?? previous?.generatorW ?? 0,
    batterySoc: telemetry?.batterySoc ?? homes?.batterySoc ?? previous?.batterySoc ?? null,
    batteryTempC: homes?.batteryTempC ?? previous?.batteryTempC ?? null,
    batteryVoltage: homes?.batteryVoltage ?? previous?.batteryVoltage ?? null,
    batteryBackupSeconds:
      telemetry?.batteryBackupSeconds ?? previous?.batteryBackupSeconds ?? null,
    batteryState: telemetry?.batteryState ?? previous?.batteryState ?? null,
    solarLifetimeKwh: solarLifetime,
    batteryLifetimeKwh: batteryLifetime,
    inverterLifetimeKwh: inverterLifetime,
    inverterW: homes?.inverterW ?? previous?.inverterW ?? null,
    inverterTempC: homes?.inverterTempC ?? previous?.inverterTempC ?? null,
    inverterVoltage: homes?.inverterVoltage ?? previous?.inverterVoltage ?? null,
    inverterHeadroomW: telemetry?.inverterHeadroomW ?? previous?.inverterHeadroomW ?? null,
    gridState: telemetry?.gridState ?? previous?.gridState ?? null,
    sysMode: telemetry?.sysMode ?? previous?.sysMode ?? null,
    homeId: homes?.homeId ?? previous?.homeId ?? null,
    timezone: homes?.timezone ?? previous?.timezone ?? null,
    address: homes?.address ?? previous?.address ?? null,
    serialNumber: homes?.serialNumber ?? previous?.serialNumber ?? null,
  };
}
