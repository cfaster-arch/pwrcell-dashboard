import { useEffect, useState } from "react";
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
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    // Show the Google button only when the server has OAuth configured.
    // A failed social callback lands back here with ?error= — surface the
    // same generic message (no account oracle).
    const params = new URLSearchParams(window.location.search);
    if (params.get("error")) {
      setError("Sign-in failed. Check your email and password and try again.");
      window.history.replaceState(null, "", window.location.pathname);
    }
    fetch("/api/auth-config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { googleEnabled: false }))
      .then((j) => setGoogleEnabled(Boolean(j.googleEnabled)))
      .catch(() => setGoogleEnabled(false));
  }, []);

  async function googleSignIn() {
    setError(null);
    setBusy(true);
    try {
      // Redirect flow: the browser leaves for Google; a linked existing
      // account lands on "/" (the _authed guard enforces mustChangePassword).
      // Unknown Google emails are rejected server-side by the signup gate.
      await authClient.signIn.social({ provider: "google", callbackURL: "/" });
      setBusy(false);
    } catch {
      setError("Google sign-in failed. Try again.");
      setBusy(false);
    }
  }

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
          Google sign-in works with an existing account.
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
        {googleEnabled ? (
          <div className="mt-4">
            <div className="flex items-center gap-3 text-xs text-subtle">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <button
              type="button"
              onClick={googleSignIn}
              disabled={busy}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-[15px] font-medium text-fg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.5h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.1.1 3.5 2.7.2.1c2.2-2 3.8-5 3.8-8.9z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.1.1-3.7 2.9v.1C3.4 21.3 7.4 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-.1-.1-3.7-2.9-.1.1C.5 8.3 0 10.1 0 12s.5 3.7 1.3 5.3l3.9-2.9z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.4 0 3.4 2.7 1.3 6.7l3.9 2.9c1-2.8 3.7-4.9 6.8-4.9z"
                />
              </svg>
              Sign in with Google
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
