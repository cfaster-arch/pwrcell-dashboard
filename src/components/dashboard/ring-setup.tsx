import { useCallback, useEffect, useState } from "react";
import { Loader2, LogOut, RefreshCw, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CameraSlot, DiscoveredCamera, RingUiState } from "@/lib/ring/types";

function notifyChanged() {
  window.dispatchEvent(new Event("ring-changed"));
}

async function ringPost(action: string, extra: Record<string, unknown> = {}) {
  const res = await fetch("/api/ring", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `Request failed (${res.status})`));
  return json;
}

async function ringPut(patch: Record<string, unknown>) {
  const res = await fetch("/api/ring", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `Request failed (${res.status})`));
  return json;
}

function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        {...props}
        className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-subtle focus:ring-2 focus:ring-fg/30"
      />
    </label>
  );
}

/** Step 1+2: Ring email/password, then the 2FA code Ring texts/emails. */
function AuthFlow({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"login" | "code">("login");
  const [code, setCode] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await ringPost("auth-start", { email, password });
      setPassword("");
      if (j.need2fa) {
        setPrompt(typeof j.prompt === "string" ? j.prompt : null);
        setStep("code");
      } else {
        onDone();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await ringPost("auth-verify", { code });
      setCode("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Code rejected.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-subtle">
        Sign in with the Ring account that owns the cameras. Ring sends a
        two-factor code — enter it on the next step. Only the session token is
        kept, on this server; the password is never stored.
      </p>
      {step === "login" ? (
        <>
          <Field
            label="Ring email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Field
            label="Ring password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void start();
            }}
          />
          <button
            onClick={() => void start()}
            disabled={busy || !email || !password}
            className="flex items-center justify-center gap-2 rounded-lg bg-fg px-4 py-2.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Sign in to Ring
          </button>
        </>
      ) : (
        <>
          {prompt ? <p className="text-xs text-muted">{prompt}</p> : null}
          <Field
            label="Two-factor code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            onKeyDown={(e) => {
              if (e.key === "Enter") void verify();
            }}
          />
          <button
            onClick={() => void verify()}
            disabled={busy || !code}
            className="flex items-center justify-center gap-2 rounded-lg bg-fg px-4 py-2.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Verify code
          </button>
          <button
            onClick={() => {
              setStep("login");
              setError(null);
            }}
            className="text-xs text-muted underline"
          >
            Back to sign-in
          </button>
        </>
      )}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function SlotPicker({
  label,
  slot,
  discovered,
  onChange,
}: {
  label: string;
  slot: CameraSlot | null;
  discovered: DiscoveredCamera[];
  onChange: (slot: CameraSlot | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <select
        value={slot?.deviceId ?? ""}
        onChange={(e) => {
          const id = Number(e.target.value);
          if (!id) {
            onChange(null);
            return;
          }
          const d = discovered.find((x) => x.deviceId === id);
          onChange({
            deviceId: id,
            name: d?.name ?? `Camera ${id}`,
            wired: slot?.wired ?? false,
            mode: slot?.mode ?? "live",
            intervalSec: slot?.intervalSec ?? 30,
          });
        }}
        className="rounded-lg bg-surface px-2.5 py-2 text-sm text-fg"
      >
        <option value="">Unassigned</option>
        {discovered.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.name}
          </option>
        ))}
      </select>
      {slot ? (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={slot.wired}
            onChange={(e) => onChange({ ...slot, wired: e.target.checked })}
            className="size-4 accent-current"
          />
          Wired camera (unlocks snapshots)
        </label>
      ) : null}
    </div>
  );
}

/** Menu section: link the Ring account, assign cameras, enable the section. */
export function RingSetupSection() {
  const [data, setData] = useState<RingUiState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ring", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as RingUiState);
    } catch {
      /* menu stays usable offline */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
    notifyChanged();
  }, [load ]);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await ringPut(patch);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="px-2 py-3">
        <p className="text-xs text-subtle">Loading cameras…</p>
      </div>
    );
  }

  if (!data.configured) {
    return (
      <div className="flex flex-col gap-3 px-2 py-1">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <Video className="size-4 text-muted" aria-hidden="true" />
          Cameras
        </p>
        <AuthFlow onDone={() => void refresh()} />
      </div>
    );
  }

  const s = data.settings;
  return (
    <div className="flex flex-col gap-3 px-2 py-1">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <Video className="size-4 text-muted" aria-hidden="true" />
          Cameras
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={busy}
            onChange={(e) => void save({ enabled: e.target.checked })}
            className="size-4 accent-current"
          />
          Show on dashboard
        </label>
      </div>

      <p className="text-xs leading-relaxed text-subtle">
        Ring is connected
        {data.bridge.running ? " · bridge running" : " · bridge starting…"}.
        Battery cameras without a Protect plan are live-view only — mark the
        wired one below to unlock snapshots.
      </p>

      <SlotPicker
        label="Camera 1"
        slot={s.cam1}
        discovered={s.discovered}
        onChange={(slot) => void save({ cam1: slot })}
      />
      <SlotPicker
        label="Camera 2"
        slot={s.cam2}
        discovered={s.discovered}
        onChange={(slot) => void save({ cam2: slot })}
      />

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setBusy(true);
            ringPost("rediscover")
              .then(() => refresh())
              .catch((e: unknown) =>
                setError(e instanceof Error ? e.message : "Couldn't refresh."),
              )
              .finally(() => setBusy(false));
          }}
          disabled={busy}
          className={cn(
            "flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs font-medium text-muted hover:text-fg",
          )}
        >
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden="true" />
          Find cameras
        </button>
        <button
          onClick={() => {
            if (!window.confirm("Disconnect the Ring account and stop the camera bridge?")) return;
            setBusy(true);
            ringPost("disconnect")
              .then(() => refresh())
              .catch((e: unknown) =>
                setError(e instanceof Error ? e.message : "Couldn't disconnect."),
              )
              .finally(() => setBusy(false));
          }}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs font-medium text-muted hover:text-danger"
        >
          <LogOut className="size-3.5" aria-hidden="true" />
          Disconnect
        </button>
      </div>
      <p className="text-xs text-subtle">
        Siren, floodlight and motion snooze need the ring-mqtt bridge — planned,
        not in this build.
      </p>
    </div>
  );
}
