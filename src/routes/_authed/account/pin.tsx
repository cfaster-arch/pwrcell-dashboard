import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { authClient } from "@/lib/authn/client";
import { PIN_LENGTH, PIN_RULE_TEXT, isValidPin } from "@/lib/authn/pin";

export const Route = createFileRoute("/_authed/account/pin")({
  component: ChangePinPage,
});

/** Server-side: clear the force-change flag after a successful change. */
const clearMustChangePassword = createServerFn({ method: "POST" }).handler(async () => {
  const { getSessionFromRequest } = await import("@/lib/authn/guard.server");
  const { getSql } = await import("@/lib/db");
  const ctx = await getSessionFromRequest();
  if (!ctx) throw new Error("unauthorized");
  const sql = await getSql();
  await sql`update "user" set must_change_password = false, updated_at = now() where id = ${ctx.user.id}`;
  return { ok: true };
});

function ChangePinPage() {
  const navigate = useNavigate();
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scrub = (v: string) => v.replace(/\D/g, "").slice(0, PIN_LENGTH);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidPin(newPin)) {
      setError(PIN_RULE_TEXT);
      return;
    }
    if (newPin !== confirm) {
      setError("The new PINs don't match.");
      return;
    }
    setBusy(true);
    try {
      const { error: changeError } = await authClient.changePassword({
        currentPassword: currentPin,
        newPassword: newPin,
        revokeOtherSessions: true,
      });
      if (changeError) {
        setError("Couldn't change the PIN — the current PIN may be wrong.");
        return;
      }
      await clearMustChangePassword();
      navigate({ to: "/" });
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[15px] text-fg outline-none placeholder:text-subtle focus:border-border-strong";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-xl bg-surface p-6 shadow-[var(--shadow-border)]">
        <p className="text-kicker font-medium tracking-[0.22em] text-muted uppercase">Account</p>
        <h1 className="mt-2 text-xl font-semibold text-fg">Set a new PIN</h1>
        <p className="mt-1 text-sm text-muted">
          Your administrator set a temporary PIN. Choose your own {PIN_LENGTH}-digit PIN to
          continue.
        </p>
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">Current PIN</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={PIN_LENGTH}
              value={currentPin}
              onChange={(e) => setCurrentPin(scrub(e.target.value))}
              className={inputCls}
              placeholder="••••"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">New PIN</span>
            <input
              type="password"
              required
              autoComplete="new-password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={PIN_LENGTH}
              value={newPin}
              onChange={(e) => setNewPin(scrub(e.target.value))}
              className={inputCls}
              placeholder="••••"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">Confirm new PIN</span>
            <input
              type="password"
              required
              autoComplete="new-password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={PIN_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(scrub(e.target.value))}
              className={inputCls}
              placeholder="••••"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-battery px-4 py-2.5 text-[15px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Set PIN"}
          </button>
        </form>
      </div>
    </main>
  );
}
