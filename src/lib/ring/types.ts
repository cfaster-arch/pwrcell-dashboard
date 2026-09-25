/** Shared Ring/camera types — safe to import from client components. */

export type CameraMode = "live" | "snap" | "off";

export interface CameraSlot {
  deviceId: number;
  name: string;
  /** Battery camera (no Protect plan) = live-only; wired = live + snapshots. */
  wired: boolean;
  mode: CameraMode;
  intervalSec: number;
}

export interface DiscoveredCamera {
  deviceId: number;
  name: string;
  model: string;
}

export interface CameraSettings {
  enabled: boolean;
  cam1: CameraSlot | null;
  cam2: CameraSlot | null;
  discovered: DiscoveredCamera[];
  discoveredAt: number | null;
}

export interface RingUiState {
  configured: boolean;
  bridge: { running: boolean; streams: string[] };
  settings: CameraSettings;
}
