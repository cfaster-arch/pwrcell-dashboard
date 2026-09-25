import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Mic, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CameraMode, CameraSlot } from "@/lib/ring/types";

const MAX_RECONNECTS = 3;
const RETRY_DELAY_MS = 2500;
const DISCONNECT_GRACE_MS = 6000;

type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "ended";

const INTERVALS = [
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
  { value: 300, label: "5m" },
];

const MODES: { value: CameraMode; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "snap", label: "Snaps" },
  { value: "off", label: "Off" },
];

/**
 * Live WebRTC view against the go2rtc bridge (same-origin /api/rtc/*).
 * Ring ends live sessions after ~10 minutes; the peer connection is
 * re-negotiated automatically (up to 3 tries) and the bridge re-dials Ring.
 */
function LiveView({ src, name }: { src: string; name: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<StreamState>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [micReady, setMicReady] = useState(false);
  const [talking, setTalking] = useState(false);
  const pttRef = useRef<(on: boolean) => void>(() => {});
  const restartRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let mic: MediaStreamTrack | null = null;
    let attempts = 0;
    let dropTimer = 0;
    let retryTimer = 0;

    const cleanupPc = () => {
      if (dropTimer) window.clearTimeout(dropTimer);
      dropTimer = 0;
      try {
        pc?.close();
      } catch {
        /* noop */
      }
      pc = null;
      mic?.stop();
      mic = null;
      setMicReady(false);
      setTalking(false);
    };

    const scheduleRetry = (why: string) => {
      if (cancelled) return;
      cleanupPc();
      if (attempts < MAX_RECONNECTS) {
        attempts += 1;
        setState("reconnecting");
        setDetail(`Connection lost — retry ${attempts} of ${MAX_RECONNECTS}…`);
        retryTimer = window.setTimeout(() => void connect(), RETRY_DELAY_MS);
      } else {
        setState("ended");
        setDetail(why);
      }
    };

    const connect = async () => {
      if (cancelled) return;
      setState(attempts === 0 ? "connecting" : "reconnecting");
      setDetail(null);
      try {
        const thisPc = new RTCPeerConnection();
        pc = thisPc;
        thisPc.ontrack = (e) => {
          if (cancelled || pc !== thisPc) return;
          if (e.track.kind === "video" && videoRef.current) {
            videoRef.current.srcObject = e.streams[0];
            setState("live");
            attempts = 0;
          }
        };
        // Microphone for push-to-talk. Best effort: if the kiosk denies it,
        // the stream still works receive-only.
        let hasMic = false;
        try {
          const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (cancelled) {
            ms.getTracks().forEach((t) => t.stop());
            return;
          }
          const track = ms.getAudioTracks()[0] ?? null;
          if (track) {
            track.enabled = false;
            thisPc.addTrack(track, ms);
            mic = track;
            hasMic = true;
            setMicReady(true);
          }
        } catch {
          /* receive-only */
        }
        thisPc.addTransceiver("video", { direction: "recvonly" });
        thisPc.addTransceiver("audio", {
          direction: hasMic ? "sendrecv" : "recvonly",
        });
        const offer = await thisPc.createOffer();
        await thisPc.setLocalDescription(offer);
        const res = await fetch(
          `/api/rtc/api/webrtc?src=${encodeURIComponent(src)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/sdp" },
            body: offer.sdp ?? "",
            cache: "no-store",
          },
        );
        if (cancelled) return;
        if (!res.ok) throw new Error(`camera bridge answered ${res.status}`);
        await thisPc.setRemoteDescription({
          type: "answer",
          sdp: await res.text(),
        });
        thisPc.onconnectionstatechange = () => {
          if (cancelled || pc !== thisPc) return;
          const st = thisPc.connectionState;
          if (st === "failed") {
            scheduleRetry("The camera connection failed.");
          } else if (st === "disconnected") {
            if (dropTimer) window.clearTimeout(dropTimer);
            dropTimer = window.setTimeout(() => {
              const cur = thisPc.connectionState;
              if (cur === "disconnected" || cur === "failed") {
                scheduleRetry("The camera connection dropped.");
              }
            }, DISCONNECT_GRACE_MS);
          } else if (st === "connected") {
            if (dropTimer) {
              window.clearTimeout(dropTimer);
              dropTimer = 0;
            }
          }
        };
      } catch (err) {
        scheduleRetry(
          err instanceof Error ? err.message : "Couldn't reach the camera.",
        );
      }
    };

    pttRef.current = (on: boolean) => {
      if (mic) {
        mic.enabled = on;
        setTalking(on);
      }
    };
    restartRef.current = () => {
      attempts = 0;
      cleanupPc();
      if (videoRef.current) videoRef.current.srcObject = null;
      void connect();
    };

    void connect();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      cleanupPc();
      setState("idle");
    };
  }, [src]);

  const busy = state === "connecting" || state === "reconnecting";

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      <video
        ref={videoRef}
        className="size-full object-cover"
        muted
        autoPlay
        playsInline
      />
      {state !== "live" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 p-4 text-center">
          {busy ? (
            <RefreshCw className="size-8 animate-spin text-muted" aria-hidden="true" />
          ) : (
            <CameraOff className="size-8 text-muted" aria-hidden="true" />
          )}
          <p className="text-sm text-muted">
            {busy ? "Connecting…" : "Stream stopped"}
          </p>
          {detail ? (
            <p className="max-w-64 text-xs leading-snug text-subtle">{detail}</p>
          ) : null}
          {state === "ended" ? (
            <button
              onClick={() => restartRef.current()}
              className="flex items-center gap-2 rounded-lg bg-surface-2 px-4 py-2.5 text-sm font-medium text-fg hover:bg-surface"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Restart stream
            </button>
          ) : null}
        </div>
      ) : null}
      {state === "live" && micReady ? (
        <button
          className={cn(
            "absolute bottom-3 right-3 flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium shadow-lg transition-colors",
            talking
              ? "bg-danger text-white"
              : "bg-surface/90 text-fg hover:bg-surface",
          )}
          onPointerDown={(e) => {
            e.preventDefault();
            pttRef.current(true);
          }}
          onPointerUp={() => pttRef.current(false)}
          onPointerLeave={() => pttRef.current(false)}
          onPointerCancel={() => pttRef.current(false)}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={`Hold to talk through ${name}`}
        >
          <Mic className="size-4" aria-hidden="true" />
          {talking ? "Talking…" : "Hold to talk"}
        </button>
      ) : null}
      {state === "live" ? (
        <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white">
          <span className="size-1.5 animate-pulse rounded-full bg-danger" />
          LIVE
        </span>
      ) : null}
    </div>
  );
}

/** Still snapshots polled from the bridge (wired cameras only). */
function SnapshotView({
  src,
  intervalSec,
}: {
  src: string;
  intervalSec: number;
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const tick = () => {
      if (!alive) return;
      setUrl(
        `/api/rtc/api/frame.jpeg?src=${encodeURIComponent(src)}&t=${Date.now()}`,
      );
    };
    tick();
    const id = window.setInterval(tick, intervalSec * 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [src, intervalSec]);

  if (failed) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg bg-black/40 p-4 text-center">
        <CameraOff className="size-8 text-muted" aria-hidden="true" />
        <p className="text-sm text-muted">Snapshot unavailable</p>
        <p className="text-xs text-subtle">The camera may be offline or waking up.</p>
      </div>
    );
  }
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      {url ? (
        <img
          src={url}
          alt="Camera snapshot"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : null}
      <span className="absolute top-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white">
        Snapshot · every {intervalSec >= 60 ? `${intervalSec / 60}m` : `${intervalSec}s`}
      </span>
    </div>
  );
}

export function CameraCard({
  slot,
  stream,
  onUpdate,
}: {
  slot: CameraSlot;
  stream: string;
  onUpdate: (patch: Partial<CameraSlot>) => void;
}) {
  const setMode = useCallback(
    (mode: CameraMode) => onUpdate({ mode }),
    [onUpdate],
  );

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-base font-medium text-fg">
          <Camera className="size-4 text-muted" aria-hidden="true" />
          {slot.name}
          <span className="text-xs font-normal text-subtle">
            {slot.wired ? "wired" : "battery"}
          </span>
        </p>
        <div
          className="flex overflow-hidden rounded-lg bg-surface-2"
          role="group"
          aria-label={`${slot.name} mode`}
        >
          {MODES.map((m) => {
            if (m.value === "snap" && !slot.wired) return null;
            const active = slot.mode === m.value;
            return (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                aria-pressed={active}
                className={cn(
                  "px-3.5 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-fg text-bg"
                    : "text-muted hover:text-fg",
                )}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {slot.mode === "live" ? (
        <LiveView src={stream} name={slot.name} />
      ) : slot.mode === "snap" && slot.wired ? (
        <>
          <SnapshotView src={stream} intervalSec={slot.intervalSec} />
          <div className="flex items-center gap-2">
            <span className="text-xs text-subtle">Every</span>
            <div className="flex overflow-hidden rounded-lg bg-surface-2" role="group" aria-label="Snapshot interval">
              {INTERVALS.map((iv) => (
                <button
                  key={iv.value}
                  onClick={() => onUpdate({ intervalSec: iv.value })}
                  aria-pressed={slot.intervalSec === iv.value}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium transition-colors",
                    slot.intervalSec === iv.value
                      ? "bg-fg text-bg"
                      : "text-muted hover:text-fg",
                  )}
                >
                  {iv.label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg bg-black/40">
          <CameraOff className="size-8 text-muted" aria-hidden="true" />
          <p className="text-sm text-muted">Camera off</p>
        </div>
      )}
    </div>
  );
}
