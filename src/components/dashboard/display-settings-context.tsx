import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_DISPLAY_SETTINGS,
  type DisplaySettings,
} from "@/lib/display-settings";

type UpdatePatch = Partial<Omit<DisplaySettings, "hasBackgroundImage">>;

interface DisplaySettingsCtx {
  settings: DisplaySettings;
  update: (patch: UpdatePatch) => Promise<void>;
  uploadBackground: (file: File) => Promise<string | null>;
  removeBackground: () => Promise<void>;
}

const Ctx = createContext<DisplaySettingsCtx>({
  settings: DEFAULT_DISPLAY_SETTINGS,
  update: async () => {},
  uploadBackground: async () => null,
  removeBackground: async () => {},
});

export function useDisplaySettings(): DisplaySettingsCtx {
  return useContext(Ctx);
}

export function DisplaySettingsProvider({
  initial,
  children,
}: {
  initial: DisplaySettings;
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<DisplaySettings>(initial);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Keep the theme attribute in sync (covers changes from another tab/device).
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // Re-fetch once on mount so a second device sees the latest saved settings.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/display", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!cancelled && s) setSettings(s as DisplaySettings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: UpdatePatch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    try {
      const res = await fetch("/api/display", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok && mounted.current) {
        setSettings((await res.json()) as DisplaySettings);
      }
    } catch {
      /* optimistic value stays */
    }
  }, []);

  const uploadBackground = useCallback(async (file: File): Promise<string | null> => {
    try {
      const form = new FormData();
      form.append("image", file);
      const res = await fetch("/api/display-background", { method: "POST", body: form });
      const body = (await res.json()) as { error?: string } & Partial<DisplaySettings>;
      if (!res.ok) return body.error ?? "Upload failed.";
      if (mounted.current) setSettings(body as DisplaySettings);
      return null;
    } catch {
      return "Upload failed.";
    }
  }, []);

  const removeBackground = useCallback(async () => {
    if (!window.confirm("Remove the custom background image?")) return;
    try {
      const res = await fetch("/api/display-background", { method: "DELETE" });
      if (res.ok && mounted.current) {
        setSettings((await res.json()) as DisplaySettings);
      }
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <Ctx.Provider value={{ settings, update, uploadBackground, removeBackground }}>
      {children}
    </Ctx.Provider>
  );
}
