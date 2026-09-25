export type PowerPoint = {
  ts: number;
  solarW: number;
  homeW: number;
  batteryW: number;
  gridW: number;
  generatorW: number;
  batterySoc: number | null;
  batteryTempC: number | null;
  batteryVoltage: number | null;
  batteryBackupSeconds: number | null;
  batteryState: string | null;
  solarLifetimeKwh: number | null;
  batteryLifetimeKwh: number | null;
  inverterLifetimeKwh: number | null;
  inverterW: number | null;
  inverterTempC: number | null;
  inverterVoltage: number | null;
  inverterHeadroomW: number | null;
  gridState: string | null;
  sysMode: string | null;
  homeId: string | null;
  timezone: string | null;
  address: string | null;
  serialNumber: string | null;
};

export type DashStatus = "live" | "stale" | "error" | "demo";

export type LivePayload = {
  point: PowerPoint | null;
  error: string | null;
  status: DashStatus;
  staleSeconds: number;
  mode: "live" | "demo";
  configured: boolean;
};

export type HealthPayload = {
  configured: boolean;
  mode: "live" | "demo";
  lastPollAt: string | null;
  lastError: string | null;
  upstreamCalls: number;
  tokenValid: boolean;
  homeId: string | null;
  bufferSize: number;
  lastPollDurationMs: number | null;
};

export type SeriesPoint = {
  ts: number;
  solarW: number;
  homeW: number;
  batteryW: number;
  gridW: number;
};

export type SeriesPayload = {
  minutes: number;
  points: SeriesPoint[];
};

export type HomesPayload = {
  homes: unknown;
  error: string | null;
  configured: boolean;
  mode: "live" | "demo";
};
