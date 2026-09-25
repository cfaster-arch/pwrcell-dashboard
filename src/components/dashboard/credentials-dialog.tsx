import { useEffect, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Meta = { configured: boolean; email: string | null };

export function CredentialsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<Meta>({ configured: false, email: null });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  async function refreshLiveError(): Promise<void> {
    try {
      const r = await fetch("/api/live", { cache: "no-store" });
      const body = (await r.json()) as {
        configured?: boolean;
        mode?: string;
        error?: string | null;
      };
      setLiveError(
        body.configured && body.mode !== "live" && body.error
          ? body.error
          : null,
      );
    } catch {
      /* leave the previous value alone */
    }
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    setPassword("");
    setLiveError(null);
    let cancelled = false;
    fetch("/api/credentials", { cache: "no-store" })
      .then((r) => r.json())
      .then((m: Meta) => {
        if (cancelled) return;
        setMeta(m);
        setEmail(m.email ?? "");
        if (m.configured) void refreshLiveError();
      })
      .catch(() => {
        if (!cancelled) setError("Could not reach the server.");
      });
    return () => {
      cancelled = true;
    };
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json()) as Meta & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      setMeta(body);
      setPassword("");
      setSaved(true);
      setLiveError(null);
      // The poller signs in on its next tick (≤30s). Re-check a few times so
      // a rejected login shows up here instead of failing silently.
      for (let i = 0; i < 7; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const lr = await fetch("/api/live", { cache: "no-store" });
          const lb = (await lr.json()) as {
            mode?: string;
            error?: string | null;
          };
          if (lb.mode === "live") {
            setLiveError(null);
            break;
          }
          if (lb.error) {
            setLiveError(lb.error);
            break;
          }
        } catch {
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Remove the stored PWRview login? The dashboard will fall back to simulated data until you sign in again.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    setLiveError(null);
    try {
      const res = await fetch("/api/credentials", { method: "DELETE" });
      const body = (await res.json()) as Meta;
      setMeta(body);
      setEmail("");
      setPassword("");
      setSaved(false);
      setLiveError(null);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-sm rounded-xl bg-surface p-6 shadow-[var(--shadow-border)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="PWRview login"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="rounded-md bg-solar-dim p-2 text-solar" aria-hidden="true">
              <KeyRound className="size-5" />
            </span>
            <h2 className="text-lg font-medium tracking-tight">PWRview login</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-muted">
          {meta.configured ? (
            <>
              Connected as <span className="font-mono text-fg">{meta.email}</span>.
              Live data resumes automatically.
            </>
          ) : (
            "Enter the PWRview account for this system. Until then the dashboard shows a simulated day."
          )}
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg/90">Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-sm text-fg placeholder:text-subtle focus:border-solar focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg/90">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-sm text-fg placeholder:text-subtle focus:border-solar focus:outline-none"
            />
          </label>
        </div>

        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        {liveError ? (
          <p className="mt-3 text-sm text-danger">
            Generac rejected the login:{" "}
            <span className="font-mono">{liveError}</span>
          </p>
        ) : null}
        {saved ? (
          <p className="mt-3 text-sm text-ok">
            Saved — the next poll will sign in with these credentials.
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-3">
          {meta.configured ? (
            <button
              onClick={disconnect}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-sm font-medium text-danger hover:bg-surface-2 disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg"
            >
              Close
            </button>
            <button
              onClick={save}
              disabled={busy || !email.trim() || !password}
              className={cn(
                "rounded-lg bg-solar px-4 py-2 text-sm font-semibold text-black",
                "hover:brightness-110 disabled:opacity-50",
              )}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-subtle">
          Stored on this laptop only, used solely to sign in to Generac's cloud
          for this system's data.
        </p>
      </div>
    </div>
  );
}
