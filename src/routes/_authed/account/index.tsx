import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { LogOut } from "lucide-react";
import { authClient } from "@/lib/authn/client";

/** Stub account page (Phase 1): identity summary + sign out. Admin UI is Phase 3. */
const getAccountInfo = createServerFn({ method: "GET" }).handler(async () => {
  const { getSessionFromRequest } = await import("@/lib/authn/guard.server");
  const ctx = await getSessionFromRequest();
  if (!ctx) return null;
  return {
    email: ctx.user.email,
    name: ctx.user.name,
    role: (ctx.user as { role?: string | null }).role ?? "user",
  };
});

export const Route = createFileRoute("/_authed/account/")({
  loader: () => getAccountInfo(),
  component: AccountPage,
});

function AccountPage() {
  const navigate = useNavigate();
  const info = Route.useLoaderData();

  async function onSignOut() {
    await authClient.signOut();
    navigate({ to: "/signin" });
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-xl bg-surface p-6 shadow-[var(--shadow-border)]">
        <p className="text-kicker font-medium tracking-[0.22em] text-muted uppercase">Account</p>
        <h1 className="mt-2 text-xl font-semibold text-fg">Your account</h1>
        <dl className="mt-4 flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Email</dt>
            <dd className="text-fg">{info?.email}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Name</dt>
            <dd className="text-fg">{info?.name}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Role</dt>
            <dd className="text-fg">{info?.role}</dd>
          </div>
        </dl>
        <div className="mt-6 flex flex-col gap-2">
          <Link
            to="/account/password"
            className="rounded-lg border border-border px-4 py-2.5 text-center text-[15px] font-medium text-fg hover:bg-surface-2"
          >
            Change password
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            className="flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-[15px] font-medium text-danger hover:bg-surface-2"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
