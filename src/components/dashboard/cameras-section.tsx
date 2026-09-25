import { useCallback, useEffect, useState } from "react";
import { Video } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CameraSlot, RingUiState } from "@/lib/ring/types";
import { CameraCard } from "./camera-card";

type CamView = "cam1" | "cam2" | "both";

async function fetchRing(): Promise<RingUiState> {
  const res = await fetch("/api/ring", { cache: "no-store" });
  if (!res.ok) throw new Error(`Ring status failed (${res.status})`);
  return (await res.json()) as RingUiState;
}

/**
 * Camera section: shares the viewport with the metrics when cameras are
 * enabled in the menu. Ring account linking happens in the menu; this
 * section only renders the assigned Camera 1 / Camera 2 / Both views.
 */
export function CamerasSection() {
  const [data, setData] = useState<RingUiState | null>(null);
  const [view, setView] = useState<CamView>("both");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchRing());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load camera status.");
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener("ring-changed", onChange);
    return () => window.removeEventListener("ring-changed", onChange);
  }, [load]);

  const updateSlot = useCallback(
    async (which: "cam1" | "cam2", patch: Partial<CameraSlot>) => {
      const res = await fetch("/api/ring", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [which]: patch }),
      });
      if (res.ok) {
        const j = (await res.json()) as { settings: RingUiState["settings"] };
        setData((d) => (d ? { ...d, settings: j.settings } : d));
      }
    },
    [],
  );

  if (error && !data) return null;
  if (!data) return null;
  if (!data.configured || !data.settings.enabled) return null;

  const { cam1, cam2 } = data.settings;
  const cams: { slot: CameraSlot; stream: string; key: "cam1" | "cam2" }[] = [];
  if (cam1) cams.push({ slot: cam1, stream: cam1.stream ?? "cam1", key: "cam1" });
  if (cam2) cams.push({ slot: cam2, stream: cam2.stream ?? "cam2", key: "cam2" });

  if (cams.length === 0) {
    return (
      <section aria-label="Cameras" className="rounded-xl bg-surface p-5 text-center shadow-[var(--shadow-border)]">
        <p className="text-sm text-muted">
          Ring is connected, but no cameras are assigned yet — pick them in the menu under Cameras.
        </p>
      </section>
    );
  }

  const visible =
    view === "both" ? cams : cams.filter((c) => c.key === view);
  const showSelector = cams.length === 2;

  return (
    <section aria-label="Cameras" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-kicker font-medium tracking-[0.22em] text-muted uppercase">
          <Video className="size-4" aria-hidden="true" />
          Cameras
        </h2>
        {showSelector ? (
          <div className="flex overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-border)]" role="group" aria-label="Camera view">
            {(
              [
                { value: "cam1", label: cam1?.name ?? "Camera 1" },
                { value: "cam2", label: cam2?.name ?? "Camera 2" },
                { value: "both", label: "Both" },
              ] as const
            ).map((o) => (
              <button
                key={o.value}
                onClick={() => setView(o.value)}
                aria-pressed={view === o.value}
                className={cn(
                  "max-w-36 truncate px-4 py-2 text-sm font-medium transition-colors",
                  view === o.value ? "bg-fg text-bg" : "text-muted hover:text-fg",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {!data.bridge.running ? (
        <p className="rounded-lg bg-surface px-4 py-3 text-sm text-warn shadow-[var(--shadow-border)]">
          The camera bridge is starting… streams appear automatically once it&apos;s up.
        </p>
      ) : null}
      <div
        className={cn(
          "grid gap-3",
          visible.length === 2 && "xl:grid-cols-2",
        )}
      >
        {visible.map((c) => (
          <CameraCard
            key={c.key}
            slot={c.slot}
            stream={c.stream}
            onUpdate={(patch) => void updateSlot(c.key, patch)}
          />
        ))}
      </div>
    </section>
  );
}
