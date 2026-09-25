import type { CSSProperties } from "react";

export type ThemeName = "dark" | "light";
export type GaugeStyle = "analog" | "tiles";
/** Exclusive main-view mode. Supersedes the old binary `gaugeStyle` toggle. */
export type DisplayMode = "graphs" | "tiles" | "gauges" | "flow";
export type BackgroundMode = "default" | "color" | "image";

export interface DisplaySettings {
  theme: ThemeName;
  /** Which main view is shown. Migrated from `gaugeStyle` when absent. */
  displayMode: DisplayMode;
  /**
   * @deprecated Superseded by `displayMode`. Kept (synced) so old
   * display-settings.json files still migrate cleanly.
   */
  gaugeStyle: GaugeStyle;
  backgroundMode: BackgroundMode;
  /** Hex color used when backgroundMode === "color". */
  backgroundColor: string;
  /** True when a custom background image has been uploaded. */
  hasBackgroundImage: boolean;
  /** Auto-dim the display late at night (22:00–06:00 local). */
  nightDim: boolean;
  /** True once the first-run setup wizard has been completed. */
  setupComplete: boolean;
  /** Show rate/cost calculations (Graphs view cost section + TOU settings). */
  showRates: boolean;
  /** Show the Ring camera section and its menu setup. */
  showCameras: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  theme: "dark",
  displayMode: "gauges",
  gaugeStyle: "analog",
  backgroundMode: "default",
  backgroundColor: "#1a2f24",
  hasBackgroundImage: false,
  nightDim: true,
  setupComplete: false,
  showRates: true,
  showCameras: true,
};

/** Inline style for the page root behind the tiles/gauges. */
export function backgroundStyle(s: DisplaySettings): CSSProperties {
  if (s.backgroundMode === "color") {
    return { backgroundColor: s.backgroundColor };
  }
  if (s.backgroundMode === "image" && s.hasBackgroundImage) {
    return {
      backgroundImage: "url(/api/display-background)",
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundAttachment: "fixed",
    };
  }
  return {};
}

/** Translucent surface so a custom backdrop shows through slightly. */
export function tileSurfaceStyle(customBackdrop: boolean): CSSProperties | undefined {
  if (!customBackdrop) return undefined;
  return {
    background: "color-mix(in srgb, var(--color-surface) 84%, transparent)",
    backdropFilter: "blur(2px)",
    WebkitBackdropFilter: "blur(2px)",
  };
}
