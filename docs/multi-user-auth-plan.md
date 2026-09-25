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

### Phase 2 — Multi-tenancy — implemented 2026-09-25 (branch `multi-user-plan`, commit pending)

Built in full (Connor's "defer four, slim three" scope). Implemented and
reviewed; commit + push happen only after the phase boundary below is met.

- [x] Tenant scoping on every route/query: `requireOrgApi(request)` resolves
      the org from the caller's membership (the request never names the org)
      and re-verifies with `requireOrgAccess`; `requireOrgServerFn()` for
      server functions; `requireOrgManager(orgId)` gates credential/camera/org-
      destructive writes to owner/admin roles (platform-admin branch also
      enforces the 12h session-freshness policy).
- [x] Per-org encrypted PWRview credentials (`org_credentials`, AES-256-GCM,
      AAD = org id + secret purpose via `orgAad()`) with one-time default-org
      migration from `dashboard.env`; plaintext keys removed only after a
      verified DB round-trip; sign-in probe validates before persisting so a
      typo can't poison the poller. Env rewrite preserves all other lines and
      writes atomically.
- [x] Per-org encrypted Ring refresh tokens (`org_ring_tokens`, same
      AAD scheme), one-time migration from `dashboard.env`.
- [x] Per-org settings: display/alerts/TOU/camera in `org_settings` sections;
      one-time legacy import for `org_default`; per-org background files
      (`display-background-<org>.<ext>`), served through a restored
      `/api/display-background` route (org-scoped, manager-gated upload).
- [x] Per-org poller registry: per-org GeneracClient/credentials, token state,
      history buffer, home id, errors, timer, inflight; simple retries;
      `resetOrgAuth`/`resetOrgToDemo`/`stopOrgPoller`.
- [x] Per-org energy history + alerts; history/cost SQL filtered by
      `organization_id`; the org's timezone is authoritative for bucketing
      (client `tz` param removed — never trusted).
- [x] Ring multi-org: pending-2FA map keyed by org+user; one shared go2rtc
      bridge aggregating per-org streams with hash-namespaced names
      (`org_<16 hex of sha256(orgId)>__cam1/cam2`) and per-stream refresh
      tokens; `/api/rtc/*` validates `src` against the caller's org (single
      `src` only, required for stream endpoints), strips session headers, and
      filters `api/streams`; bridge mutations serialized, config written
      atomically with 0600; `sync` action manager-gated; disconnecting one org
      drops only its streams.
- [x] `src/lib/orgs.server.ts`: `createOrg`/`deleteOrg` — full cascade in ONE
      DB transaction (member/invitation deletes, orphaned kiosk apikey cleanup,
      org row with FK cascades for settings/credentials/ring tokens/energy/
      alerts/kiosk/pairing, audit row in the same tx); poller stop,
      background-file removal, and bridge re-sync outside the tx (best-effort).
      `audit_log` is append-only and survives.
- [x] Migration `0006_org_delete_cascade.sql`: member/invitation FKs upgraded
      to `ON DELETE CASCADE` (0004 used inline references = NO ACTION);
      idempotent and schema-qualified.
- [x] Audit actions added: `credentials.set/cleared`, `ring.connected/disconnected`.
- [x] Two-org isolation tests (`scripts/phase2-isolation.test.mjs`, 9 tests):
      cross-org route/query denial, credential/settings/history/alerts
      isolation, AES-GCM wrong-org AND wrong-purpose AAD failure, hash-based
      Ring stream namespacing, complete deletion cascade — all passing.
- [x] Gates: typecheck + production build green. Full suite: 218/224 — the 6
      failures are pre-existing Grok PWA/plugin tests that fail identically on
      the untouched Phase 1 baseline (verified on a pristine `7cd95a2`
      worktree); documented as baseline failures, not Phase 2 regressions.
- [x] DeepSeek security review: V4 **Flash** substituted — V4 Pro repeatedly
      returned empty answers (`finish_reason=length`, reasoning loop) on three
      attempts incl. a narrowed reframe; same substitution as Phase 1.
      3 focused briefs (authz / crypto+cascade / bridge+proxy). Findings and
      dispositions in the build log (§7 below).

### Phase 3 — slim (Connor's 2026-09-25 scope: "slim three")
No polished/full admin panel. Minimal viable admin surface:
- [ ] Minimal seed/CLI user management (create/disable users, reset passwords).
- [ ] Immediate session revocation (already works via `cookieCache: false`; needs
      a minimal operator path to trigger it).
- [ ] Append-only admin audit logging (already append-only via `audit_log` +
      hash chain; add the minimal review/export path).
- [ ] Confirmation for destructive actions wherever UI exists.

### Phase 4 — kiosk pairing — DEFERRED (Connor's 2026-09-25 call: "defer four")
Kiosk pairing (apiKey plugin devices, `/kiosk/pair` flow, revocation) is NOT
built now. The schema for it (`kiosk_devices`, `pairing_codes`, `apikey`)
exists from Phase 1 migrations and stays inert; `deleteOrg` already cleans up
kiosk rows/keys. Revisit when a wall tablet actually needs pairing.

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

- **Phase 2 security review (2026-09-25)**: DeepSeek V4 **Flash** — V4 Pro
  returned empty answers (`finish_reason=length`, reasoning loop) on three
  attempts including a narrowed reframe, so Flash was substituted per the
  Phase 1 precedent. Three focused briefs: (1) authorization layer
  (`guard.server.ts`, `/api/credentials`), (2) credential encryption + org
  deletion (crypto core, `org-credentials`, `orgs.deleteOrg`, migration 0006),
  (3) camera bridge + proxy (`rtc.$.ts`, `ring-api.server.ts`). Full briefs
  and raw reviews: `~/workspace/deepseek-reviews/`.
  - **Fixed**: R1.1 (12h admin session freshness now enforced in
    `requireOrgManager`'s platform-admin branch); R1.2 (`requireOrgApi`
    re-verifies the resolved org via `requireOrgAccess`); R2.1 (`deleteOrg`
    DB steps + audit row in one transaction — new `Sql.transaction()`
    on both Neon and PGlite backends); R2.3 (AAD now binds org id AND
    secret purpose via `orgAad()`; new wrong-purpose test); R2.5 (legacy
    env rewrite preserves all other lines, atomic temp+rename write);
    R2.8 (`legacyMigrated` flag set only after verified success); R2.10
    (audit row written inside the delete transaction via `auditEvent(e,
    tx)`); R2.11 (0006 idempotent, schema-qualified); R3.2 (stream
    namespace is `sha256(orgId)` hex, not a lossy sanitization —
    collisions impossible); R3.3 (`syncBridge` serialized through an
    in-process mutex; go2rtc.yaml written atomically, chmod 0600 every
    write); R3.4 (proxy rebuilds query from a whitelist — single `src`
    only, required for stream endpoints; strips cookie/authorization/
    x-forwarded-*; `redirect: "manual"`); R3.5 (pending 2FA keyed by
    org+user); R3.7 (`sync` action manager-gated). Also: client `tz`
    param removed — org timezone is authoritative for history/cost
    bucketing, never client-supplied.
  - **Already satisfied, no change**: R2.4 (public encrypt APIs already
    call `checkAad`); R2.6 (routes already resolve org via `requireOrgApi`
    — added a doc note that AAD is integrity, not authorization); R2.7
    (all child FKs verified `ON DELETE CASCADE` in 0004 + cascade
    covered by the isolation test); R3.1 (go2rtc.yaml already 0600 since
    the original Ring integration; residual plaintext-token risk
    documented — tokens must be present for go2rtc's ring source, file
    is 0600, backups encrypted, single-tenant VPS).
  - **Reasoned dismissals**: R1.3 (platform-admin cross-org via
    `requireOrgApi` is unreachable — the safer default; the admin branch
    still upgrades admin-members, so it stays); R1.4 (GET
    `/api/credentials` returns email/meta only, no secret — members need
    connection state for the UI); R2.2 (FK direction is
    kiosk_devices→apikey `ON DELETE CASCADE`, so deleting apikey rows
    first is safe — confirmed by the passing cascade test); R2.9
    (`deleteOrgBackgroundFiles` is sync and best-effort by design; a
    leftover image is not a secret leak). Bridge-init global boolean:
    kept — the aggregate bridge syncs ALL orgs in one pass, so init is
    inherently global; the new mutex removes the race. Browser-visible
    stream names: kept namespaced (now opaque hashes, server-validated)
    instead of local cam1/cam2 + server translation — translation would
    add complexity with no security benefit.
  - **Baseline failures (not Phase 2 regressions)**: 6 Grok PWA/plugin
    tests fail identically on the pristine `7cd95a2` worktree
    (og:title injector expectations vs this repo's "PWRcell" site
    identity — Grok template tests vs a customized repo). Full suite:
    218/224; isolation: 9/9; typecheck + production build green.
