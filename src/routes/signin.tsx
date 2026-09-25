import { useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { authClient } from "@/lib/authn/client";

/** Already signed in? Skip the form entirely. */
const getSessionState = createServerFn({ method: "GET" }).handler(async () => {
  const { getSessionFromRequest } = await import("@/lib/authn/guard.server");
  const ctx = await getSessionFromRequest();
  return ctx ? { email: ctx.user.email } : null;
});

export const Route = createFileRoute("/signin")({
  beforeLoad: async () => {
    const session = await getSessionState();
    if (session) throw redirect({ to: "/" });
  },
  component: SignInPage,
});

function SignInPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { data, error: signInError } = await authClient.signIn.email({
        email: email.trim(),
        password,
      });
      if (signInError) {
        // Identical message for bad-email vs bad-password (no account oracle).
        setError("Sign-in failed. Check your email and password and try again.");
        return;
      }
      const mustChange = (data?.user as { mustChangePassword?: boolean } | undefined)
        ?.mustChangePassword;
      navigate({ to: mustChange ? "/account/password" : "/" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-xl bg-surface p-6 shadow-[var(--shadow-border)]">
        <p className="text-kicker font-medium tracking-[0.22em] text-muted uppercase">PWRcell</p>
        <h1 className="mt-2 text-xl font-semibold text-fg">Sign in</h1>
        <p className="mt-1 text-sm text-muted">
          Accounts are created by your administrator — there is no public sign-up.
        </p>
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">Email</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[15px] text-fg outline-none placeholder:text-subtle focus:border-border-strong"
              placeholder="you@example.com"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[15px] text-fg outline-none placeholder:text-subtle focus:border-border-strong"
              placeholder="••••••••"
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
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
