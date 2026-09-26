# Build report: Google OAuth sign-in (2026-09-25)

Branch: `multi-user-plan` → commit `94bb6c2` (pushed). Deployed to production VPS.

## What was built

"Sign in with Google" on `/signin`, closed-system model preserved:

- `src/lib/authn/server.ts`
  - `socialProviders.google` wired from `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
    (env-driven; provider omitted entirely when unconfigured).
  - `account.accountLinking` with `trustedProviders: ["google"]` — a Google
    sign-in whose verified email matches an existing account links to it
    instead of minting a new one.
  - `databaseHooks.user.create.before` gate: any user.create NOT from an
    `/api/auth/admin/` path is a social-signup attempt and is rejected with
    403 unless the email is already provisioned. Fail-closed when there is no
    request context. Provisioning stays via admin CLI (raw SQL, bypasses hook)
    or the platform-admin-gated admin API.
- `src/routes/api/auth-config.ts` — public endpoint returning
  `{ googleEnabled: boolean }` (boolean only, no secret material).
- `src/routes/signin.tsx` — "Sign in with Google" button (shown only when
  configured), `?error=` handling for failed social callbacks (generic message,
  no account oracle), copy updated.
- `src/routes/_authed.tsx` — `mustChangePassword` now enforced in `beforeLoad`
  for ALL authed routes (exempting `/account/password` itself). The social flow
  is redirect-based so `signin.tsx` can't catch it; this also hardens the email
  flow.

## Verification

- `tsc --noEmit` clean, `vite build` clean (route tree regenerated).
- Auth unit tests: 27/27 pass. Full suite: 228 pass, 6 fail — the 6 are the
  known stale `grok-pwa-plugin` "Wild Race" assertions (pre-existing).
- Live: `/api/auth-config` → `{"googleEnabled":true}`; `/signin` → 200 with the
  Google button rendered (browser screenshot verified).

## Known limitations / follow-ups

- The custom login-throttle wrapper (`api/auth/$.ts`) only covers
  `POST /api/auth/sign-in/email`. Social initiation (`/sign-in/social`) and the
  OAuth callback rely on better-auth's built-in DB-backed rate limit (10/min).
  Acceptable: no password to brute-force on the social path; Google handles
  their side. Revisit if abuse observed.
- `admin@example.test` (test admin, must-change-password) still exists.
- Norm's account was recreated with a fresh temp password after the data
  incident below (must-change-password=true, owner of org_norm_sixriverssolar).

## INCIDENT: deploy tarball clobbered the production database (2026-09-25)

**What happened:** The manual deploy tarball was built with
`tar --exclude=.git --exclude=node_modules` from the repo root. The repo
working tree contains a local dev `data/pglite/` cluster (from `npm run dev`
runs). The tarball included it; extracting over `/opt/pwrcell` overlaid the
dev cluster onto the production cluster → PGlite WASM `Aborted()` at bootstrap
on every start, all routes 500.

**Recovery:**
1. `systemctl stop pwrcell`; preserved damaged dir to
   `/root/pwrcell-data-post-damage-2026-09-26.tgz`.
2. Fresh-cluster boot test confirmed the data dir was the sole cause
   (PGlite booted clean, endpoints 200).
3. Restored `/opt/pwrcell/data/pglite` from `/root/pwrcell-bak/data/pglite`
   (pre-deploy backup, 21:57 UTC Sep 25) via `cp -a`.
4. Service booted clean, 0 bootstrap failures.
5. Recreated what post-dated the backup: Norm's user
   (`smartgasandelectric@gmail.com`, role=user, must-change-password) with a
   fresh temp password, and org `org_norm_sixriverssolar`
   ("norm:SixRiversSolar", slug `norm-sixriverssolar`, Norm as owner).
6. `dek.key` was untouched throughout (dated Sep 25 20:41, never overwritten —
   dev tree has no dek.key); encrypted PWRview/Ring credentials intact.
7. Data lost: sessions and login_attempts between 21:57 UTC Sep 25 and the
   incident (ephemeral — users just sign in again). No telemetry/config loss
   (display settings live per-org; nothing else was written in that window).

**Lesson (added to AGENTS.md):** deploy tarballs must exclude state —
`--exclude=.git --exclude=node_modules --exclude=data`. Never tar the repo
root blindly; `data/` is gitignored but tar doesn't respect .gitignore.
