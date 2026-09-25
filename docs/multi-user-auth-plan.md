# Multi-User Auth — Development Plan

**Goal:** market the dashboard as a multi-user tool. Multiple customers, each with
their own Generac PWRview-linked solar system, fully isolated from each other,
plus an admin panel for managing accounts.

**Status:** plan only — no code written yet. Branch: `multi-user-plan`.

---

## 1. Recommended stack (from background research)

| Piece | Choice |
|---|---|
| Auth library | `better-auth` v1.6+ (`emailAndPassword`, scrypt hashing built in) |
| Tenancy | `organization()` plugin — one org = one customer + their solar system |
| Account admin | `admin()` plugin — list/create/disable/delete users, roles, password resets, session revocation |
| TanStack Start wiring | `tanstackStartCookies()` from `better-auth/tanstack-start`, **last** in the plugins array |
| Kiosk tablets | `apiKey()` plugin — scoped, revocable device credentials (not user sessions) |
| DB access | `drizzle-orm` + drizzle adapter on the existing PGlite instance |
| Schema | `npx @better-auth/cli generate` + `drizzle-kit` migrations |
| Handler mount | `src/routes/api/auth/$.ts` delegating GET/POST to `auth.handler(request)` |

How org + admin compose: `admin` is the platform axis (you as super-admin managing
all accounts); `organization` is the tenant axis (customer owner/admin/member inside
their org). A user has a global role **and** per-org memberships. Sessions carry
`activeOrganizationId` — treat that as UI state, **not** authorization. Every API
route must explicitly verify org membership for the org ID in the request. Better Auth
gives identity, not row-level isolation; tenant scoping stays in our query layer
(`organizationId` on telemetry, history, and credential tables).

## 2. Single-tenant assumptions in the current codebase

These six surfaces are global today and must be scoped per org:

1. **PWRview credentials** — `dashboard.env` (`GENERAC_EMAIL`/`GENERAC_PASSWORD`) via
   `src/lib/pwrcell/credentials.server.ts`. → per-org credential set, **encrypted at
   rest** with a server key (these are third-party creds — encryption, not just hashing).
2. **Poller** — module-level singleton state + one `setInterval` in
   `src/lib/pwrcell/poller.server.ts`. → `Map<orgId, pollerState>`, one interval per
   org, each with its own credentials, buffer, and history writes.
3. **History DB** — PGlite tables with no tenant column (`src/lib/db.ts`,
   `src/routes/api/history.ts`, `src/routes/api/series.ts`). → add `organizationId`
   to tables, scope every query.
4. **Display settings** — global `display-settings.json`
   (`src/lib/display-settings.server.ts`). → per-org settings (kiosk wall display
   config belongs to the site, not the viewer).
5. **Ring cameras** — refresh token in `dashboard.env`
   (`src/lib/ring/ring-store.server.ts`). → per-org camera config + tokens.
6. **Alerts / TOU / rate settings** — `src/lib/alerts.server.ts`,
   `src/lib/tou-settings.server.ts`, `/api/cost`, `/api/tou`. → per-org.

## 3. Phased build plan

### Phase 0 — Persist the database (1–2 h)
- [x] Point PGlite at a persistent `dataDir` (`src/lib/db.ts` already supports it —
      verified enabled: `dataDir` is always set, override via `PGLITE_DIR`).
- [x] Env-selectable DB client already exists (`DATABASE_URL` → Neon/`pg`, else
      PGlite) — this is the Postgres escape hatch; no rewrite needed later.
- [x] Graceful shutdown: `closeDb()` + SIGTERM/SIGINT handlers in `src/lib/db.ts`
      (`await pg.close()`, bounded 8s force-exit; systemd must not `kill -9`).
- [ ] Add the data dir to the encrypted off-site backup job → **deploy checklist**
      (§6), dump-based, restore-tested.
- [ ] Restart-test: data survives a service restart → covered during Phase 1+
      integration testing (dev server start/stop cycles with auth tables).

### Phase 1 — Auth core (3–4 h) — DONE 2026-09-25 (branch `multi-user-plan`)
- [x] Installed `better-auth@1.6.33`, `drizzle-orm`; migrations
      `0003_auth_core.sql` (better-auth schema), `0004_auth_tenant.sql`
      (organization/member/invitation/apikey), `0005_energy_org.sql`
      (`organization_id` on energy/alerts, composite PK on energy_samples).
- [x] `src/lib/authn/server.ts` (better-auth instance: organization, admin,
      apiKey, `tanstackStartCookies()` last — boot-asserted; `cookieCache`
      disabled so revocation/role-change/ban take effect on the next request;
      DB-backed rate-limit storage; `trustedProxies` so nginx XFF resolves to
      the real client IP; `useSecureCookies` pinned for production;
      fail-loud when `BETTER_AUTH_SECRET` is unset in production).
- [x] `src/routes/api/auth/$.ts` mount: impersonation 404s, public sign-up
      404s, sign-in wrapped with DB login throttling; guards match on a
      normalized (decoded, trailing-slash-stripped) path; `/api/auth/admin/*`
      enforces the same platform-admin gate + 12h freshness as app routes.
- [x] Sign-in page + sign-out; session cookie config (HttpOnly, SameSite=Lax).
- [x] `src/lib/authn/guard.server.ts`: `requireOrgAccess()` (DB membership
      check, 404 on cross-org — never 403), `getMyOrgId()` (validates against
      `member`, returns 401/404 Responses — never throws page redirects),
      `requirePlatformAdmin()` (404 oracle protection + 12h session freshness).
- [x] Login throttling (`login-throttle.server.ts`): DB-backed
      `login_attempts`; 5+ failures → progressive delay (≤8s), 10+ → 15-min
      lockout; counted per email OR IP; `Retry-After` computed in SQL;
      non-enumerating (unknown vs wrong-password identical 401s). Composes with
      better-auth's built-in 3-per-10s sign-in burst rule.
- [x] `scripts/seed-default-org.mjs`: idempotent admin/org/owner-membership
      seed, history backfill, delayed FK constraints with `ON DELETE CASCADE`.
- [x] `npm run check:auth` static invariants (15 tests) + crypto/audit tests
      (16 tests) — 31/31 passing; typecheck + production build pass.
- [x] Live smoke: sign-in → session → API 200; sign-up/impersonate (+encoded)
      404; admin endpoints gated; sign-out → immediate 401 (session
      invalidated); lockout → 429 with `Retry-After`.
- [ ] **Replace nginx Basic Auth — do not stack it** (deploy-time, §6).
- [ ] Expired-session sweep (Better Auth does not reliably sweep; the table
      grows unbounded otherwise) — deferred to Phase 2/3.

**Phase 1 DeepSeek review (V4 Flash; Pro repeatedly returned empty answers on
these inputs — substitution logged).** Fixed: (1) fail-loud on missing
`BETTER_AUTH_SECRET` in production; (2) `useSecureCookies` pinned for prod;
(3) `trustedProxies` for XFF (else all users share one 3-per-10s sign-in
bucket); (4) `/api/auth/admin/*` now enforces `requirePlatformAdmin` (12h
freshness was bypassable via the raw mount); (5) path normalization before
filter matching (encoded/trailing-slash bypasses); (6) `getMyOrgId` returns
401/404 Responses instead of throwing redirects; (7) `Retry-After` computed
in SQL (no V8 date-parsing); (8) seed idempotency (no membership-id churn,
case-insensitive email, `RETURNING` backfill counts, conrelid-scoped FK
checks). Acknowledged (not fixed — bounded residual, matches the
no-gold-plating directive): rate-limit/throttle check-then-act races
(better-auth documents best-effort; built-in 3-per-10s burst rule bounds
parallelism; sustained attacks still lock out), `getClientIp` trust depends on
the nginx `$proxy_add_x_forwarded_for` topology (verified in setup script).

### Phase 2 — Multi-tenancy (4–6 h, the meat)
- [ ] Enable `organization()` plugin; org-per-customer model.
- [ ] Scope the six surfaces from §2 to `organizationId`.
- [ ] Refactor the poller to per-org instances (biggest single chunk of work).
- [ ] Migration: existing production data → a default org owned by your admin account.
- [ ] Verify: two test orgs, each seeing only their own live data, history, and settings.

### Phase 3 — Admin panel (2–3 h)
- [ ] Enable `admin()` plugin; build the admin UI (users list, create, disable,
      delete, set role, password reset, session revoke) using `adminClient()`.
- [ ] Gate `/api/auth/admin/*` — allowlist only the endpoints actually used.
- [ ] Impersonation ships **enabled** with no audit trail by default: either add
      audit logging or disable the endpoint.
- [ ] No public self-signup: users are created by admins (or org-owner invites).

### Phase 4 — Kiosk pairing (~2 h)
- [ ] `apiKey()` plugin for wall tablets — never put tokens in URLs (they persist in
      history/logs) and never give the kiosk an admin-capable credential.
- [ ] Pairing flow: admin panel → "pair kiosk" generates a short-lived code; tablet
      visits `/kiosk/pair`, enters code; server validates once and sets a long-lived
      httpOnly session cookie (`expiresIn` ~1 year, sliding `updateAge`) bound to that org.
- [ ] Revocation from the admin panel (revoke session / delete key).

**Total estimate: ~12–17 h → 2–3 focused days.**

## 4. Gotchas (do not skip)

- **PGlite is single-process.** Persistent `dataDir` is fine on the 1 GB VPS for one
  Node instance, but a second process (PM2 cluster, second service) can never open
  the same data dir. If we ever outgrow one box, migrate to real Postgres.
- **In-memory PGlite must go before auth lands** — users/sessions/keys cannot live
  in a DB that evaporates on restart.
- **Session sweep** (Phase 1) — expired rows accumulate otherwise.
- **nginx Basic Auth** gets removed, not layered.
- **Impersonation** — disable or audit-log.
- **PWRview passwords are encrypted at rest**, not hashed — we need the plaintext to
  call Generac's API.

## 5. Explicit non-goals

- Postgres row-level security for a handful of tenants — a `WHERE organizationId = ?`
  the app enforces is the right machinery at this scale.
- Long-lived *user* sessions on kiosks — a stolen tablet cookie with a full user
  session is far worse than a revocable scoped device key.
- Public self-registration.

## 6. Deploy checklist (production cutover — VPS work, NOT done on this branch)

Do these at deploy time, after staging-first verification of the full
sign-in → org scoping → kiosk pairing flow:

- [ ] **Remove nginx Basic Auth** (it is replaced by app auth — never stack both).
- [ ] Add the PGlite `dataDir` (and the DEK file, encrypted separately) to the
      encrypted off-site backup job; backups must be **dump-based**
      (filesystem copies of a live dataDir risk torn backups); restore-test quarterly.
- [ ] systemd unit: `PGLITE_DIR` pointing at the persistent path, `DEK_FILE`
      pointing at the 0600 key file; `KillMode=mixed`, no `kill -9` (SIGTERM must
      reach Node so `closeDb()` runs).
- [ ] Generate the DEK once (`node scripts/gen-dek.mjs` — to be added), store at
      the `DEK_FILE` path with `0600` owned by the service user, **outside the repo**.
- [ ] Run `node scripts/seed-default-org.mjs` to create the platform
      admin + default org, then backfill/migrate existing history into it.
      **Run it while the app is STOPPED** — PGlite's dataDir is single-process;
      a second process writing while the app runs produces stale reads
      (observed: "Credential account not found" / "User not found" on a live
      server right after a concurrent seed; clean when seeded stopped).
- [ ] Set `BETTER_AUTH_SECRET` to a long random value (env, never in the repo).
      The app now **fails loud at boot** if it is unset in production
      (an ephemeral per-process secret would silently drop all sessions on
      every restart).
- [ ] Verify: sign-in, admin panel, per-org isolation, kiosk pairing, then DNS cutover.

## Build log

- **Phase 0**: `src/lib/db.ts` already had persistent `dataDir` and the
  `DATABASE_URL` escape hatch — only graceful shutdown (`closeDb()` +
  SIGTERM/SIGINT handlers) was added. No schema changes.
