# Multi-User Auth — Deep Research: Issues & Improvements

Companion to `docs/multi-user-auth-plan.md` (read that first). Research-only: no code.
Each issue is tagged **(a)** what can go wrong, **(b)** likelihood / severity,
**(c)** recommended mitigation. A "→ Plan change" line flags anything that should
alter the phased plan.

Context: better-auth v1.6+, organization()/admin()/apiKey() plugins, drizzle-orm on
PGlite (persistent dataDir), per-org 30s poller against `generac-api.neur.io`,
single 1 GB Ubuntu VPS, kiosk tablets on long-lived device credentials.

---

## 1. better-auth plugin gotchas

### 1a. `tanstackStartCookies()` not last → silently dropped sessions
**(a)** TanStack Start does not forward `Set-Cookie` from server responses automatically.
The cookie plugin only forwards cookies for plugins whose `hooks.after` ran *before*
it. If it isn't last, cookies set by later plugins (sign-in, session refresh) are
silently dropped: sessions don't persist, redirect loops, "null session" ghosts.
**(b)** Likelihood: high if anyone reorders plugins later. Severity: high (auth
completely broken, hard to debug). **(c)** Keep it last, always; better-auth now
emits a boot warning (`warnIfCookiePluginNotLast`) — treat that warning as a
deploy-blocking CI check (fail the build if it appears in startup logs).
→ Plan change: add the CI/log check to Phase 1.

### 1b. Client-bundle leak of server code on older versions
**(a)** Before 1.6.x the cookie plugin statically imported `@tanstack/react-start/server`,
leaking server-only code into the client bundle. **(b)** Low on 1.6+ (fixed via
dynamic `await import`), but regressions happen. Severity: medium (secret/config
exposure surface). **(c)** After every better-auth upgrade: build, then grep client
chunks (`.output/public/assets/*.js`) for `react-start/server` / server markers.
→ Plan change: add to the upgrade checklist in Phase 1.

### 1c. `session.cookieCache` makes revocation/role-change/ban stale
**(a)** With `cookieCache` enabled, `getSession` returns the session from a signed
cookie **without a DB lookup** for up to `maxAge` (commonly 5 min). Force sign-out,
role demotion, or a ban therefore don't take effect until the cache expires — a
revoked admin keeps admin for the whole window. The documented mitigation
(`query: { disableCookieCache: true }`) is easy to forget on one code path.
**(b)** Likelihood: medium. Severity: high for incident response (offboarding a
compromised account). **(c)** For this app, **disable `cookieCache` entirely**:
user count is tiny, the DB is local, and a per-request session lookup is cheap.
That deletes the whole bug class instead of mitigating it per-endpoint.
→ Plan change: Phase 1 — set `session.cookieCache.enabled: false`, skip the
per-endpoint `disableCookieCache` dance.

### 1d. apiKey plugin: CVE-2025-61928 (critical)
**(a)** In affected versions, an unauthenticated attacker could POST to
`/api/auth/api-key/create` with a victim's `userId` in the body and receive a valid
API key for that account — full account takeover, MFA bypass (CVSS 9.3).
**(b)** Likelihood: n/a if patched; severity: critical. **(c)** Pin
`better-auth >= 1.3.26` (plan already says v1.6+, fine) and add a dependency-audit
step (e.g. `npm audit` / Dependabot) to the deploy pipeline. After any future
apiKey-plugin incident: rotate all device keys.
→ Plan change: Phase 1 — version floor + audit step.

### 1e. Schema drift across better-auth upgrades
**(a)** Plugin upgrades add/rename columns (e.g. 1.5.x renamed apiKey `userId` →
`referenceId`, added `configId`). Hand-maintained schemas throw
`BetterAuthError: The field "configId" does not exist` at runtime — sign-in breaks.
**(b)** Likelihood: high over the project's lifetime. Severity: high (auth outage
after a routine upgrade). **(c)** Never hand-edit auth tables: regenerate with
`npx @better-auth/cli generate` + drizzle-kit migration on **every** better-auth
upgrade, and run a sign-up/sign-in smoke test post-upgrade. Do **not** reuse the
legacy `migrations/auth/0001_auth.sql` in this repo (that's the old Grok-sandbox
"Sign in with Grok" schema — wrong tables, wrong era); generate fresh.
→ Plan change: Phase 1 — upgrade procedure + "ignore legacy auth migration" note.

### 1f. drizzle-orm version coupling
**(a)** better-auth 1.6.x requires drizzle-orm ≥ 0.45; a mismatch produces HTTP 500s
on sign-up/sign-in from inside the adapter (seen in the wild). **(b)** Likelihood:
medium. Severity: high. **(c)** Upgrade `better-auth` and `drizzle-orm`/
`drizzle-kit` in lockstep; the post-upgrade smoke test (1e) catches it.

### 1g. Organization plugin: `activeOrganizationId` is UI state, not authorization
**(a)** The session's `activeOrganizationId` can be stale or client-influenced, and
its TypeScript inference is flaky across versions. Code that trusts it for
authorization is an IDOR waiting to happen. **(b)** Likelihood: medium (it's the
"easy" way to write the check). Severity: high. **(c)** Every API route resolves
the org from the request target and verifies membership via a DB query — never
from the session's active org. (The base plan already states this; restating
because it's the single most-violated rule in better-auth multi-tenant apps.)

### 1h. Admin plugin ships impersonation enabled, unaudited
**(a)** An admin can become any user with no trail by default. **(b)** Likelihood:
certain if left on. Severity: medium-high (insider/credential-theft abuse).
**(c)** Either disable the impersonation endpoint or wrap it in audit logging
(§7). Base plan already flags this — keep it.

---

## 2. IDOR / tenant-isolation failure modes

### 2a. The missed `organizationId` on one query
**(a)** Nineteen routes correctly scoped, one (`/api/series`, a CSV export, the
alerts feed…) missing its `WHERE organizationId = ?` → full cross-customer data
leak. This is the #1 real-world multi-tenant breach pattern. **(b)** Likelihood:
high over time as features are added. Severity: critical. **(c)** Systematic
defenses, in order of value:
1. **Tenant-scoping wrapper**: all tenant data access goes through one helper
   (e.g. `dbForOrg(orgId)`) that injects the org predicate; raw unscoped queries
   to tenant tables are a code-review red flag.
2. **Never take orgId from the client.** Routes resolve the org from the
   authenticated session's memberships. If a route accepts an org identifier
   (kiosk pairing, admin views), verify membership first, then use the
   *verified* id.
3. **Adversarial tests**: for every API route, a test where user A (org 1)
   requests org 2's resource → expect 404 (not 403 — 403 confirms existence, an
   oracle). Run as non-member, ex-member, and unauthenticated.
4. **Deny-by-default audit**: a periodic (CI or startup) check that every route
   under `/api/*` appears in an allowlist with its authz test.
5. Log cross-org denials as security events (§7).

### 2b. Nested-object traversal
**(a)** `/api/orgs/:orgId/cameras/:cameraId` checks the org but not that the
camera belongs to it. **(b)** Medium. Severity: high. **(c)** Ownership checks at
every level of nesting, or resolve child → parent and check the parent.

### 2c. Kiosk device keys bypass user-org checks
**(a)** Device-key auth resolves to an org directly; if any route checks "has
user session" instead of "has org access", kiosk keys either break or overreach.
**(b)** Medium. Severity: medium. **(c)** One authorization primitive used by
both session-auth and key-auth paths: `requireOrgAccess(ctx, orgId)` regardless
of credential type.

---

## 3. PGlite production risks

### 3a. Crash-consistency is good-but-young
**(a)** PGlite is real Postgres (WAL + crash recovery), and past bugs are
instructive: 0.2.8 fixed `close()` not shutting Postgres down properly; 0.2.9
fixed a hang after DROP DATABASE + unclean shutdown. There is at least one
real-world report of WASM-layer corruption symptoms (`pgdata.crashed.*`
directories accumulating to 1.3 GB) under version-mismatched conditions.
**(b)** Likelihood: low-medium on matched, current versions. Severity: high
(auth + history live here). **(c)** Always `await pg.close()` on
SIGTERM/SIGINT — wire it into the systemd service (proper `ExecStop` behavior,
don't `kill -9` the service). Pin `@electric-sql/pglite` and test upgrades on
staging. Keep the host FS as ext4 on local disk — never a network filesystem
(they lie about fsync, the classic corruption vector).

### 3b. Backups must be dump-based and restore-tested
**(a)** Copying a live `dataDir` at the filesystem level risks a torn backup.
**(b)** Medium (it works until the one time it doesn't). Severity: high.
**(c)** Back up via a logical dump (pg_dump through a client connection, or
PGlite's dump API) → encrypt → off-site (the existing Drive backup job).
**Test the restore quarterly** — an untested backup is not a backup. Include in
the backup set: the DB dump, the data-encryption-key backup (§6, stored
separately), and `dashboard.env`-era config.

### 3c. Single-process ceiling
**(a)** Two processes can never open the same `dataDir`. **(b)** Certain the day
you try clustering. Severity: medium (architectural, not data loss). **(c)**
Build a `DATABASE_URL` escape hatch now: drizzle client selectable via env
(PGlite vs `postgres-js`), so moving to real Postgres later is a dump/restore +
config change, not a rewrite. What forces the move: sustained write volume
(single-threaded WASM; tens of orgs at 30–120s cadence is fine, hundreds get
uncomfortable), need for a second process/replica, or any corruption incident.
→ Plan change: Phase 0/1 — add the env-selectable DB client.

### 3d. Disk growth
**(a)** History retention is 2 years × N orgs; the dataDir grows monotonically
and a full disk corrupts writes. **(b)** Medium over a year+. Severity: medium.
**(c)** Monitor disk usage (alert at 80%); keep the retention sweep per-org;
size the VPS disk with headroom per expected org count.

---

## 4. Poller-per-org scaling

### 4a. Generac rate limits are undocumented — 30s/org is aggressive
**(a)** No published rate limit was found for `generac-api.neur.io`. The
community Home Assistant integration polls the cloud API at **120s**; 30s per
org is 4× that. Risk ranges from HTTP 429s to account-level throttling that
could degrade the customer's own PWRview app access. **(b)** Likelihood: medium,
rising with org count. Severity: medium-high (external dependency, customer-
visible). **(c)**
- **Adaptive cadence**: 30s for the org currently shown on a kiosk, 60–120s
  for background orgs. Biggest single reduction in API pressure.
- **Stagger + jitter**: don't let N orgs poll on the same second; spread across
  the window with ±5–10s jitter (thundering herd → 429 spike).
- **Respect `Retry-After`** on 429/503; exponential backoff with jitter.
→ Plan change: Phase 2 — adaptive cadence + stagger/jitter + Retry-After handling.

### 4b. One scheduler, not N intervals
**(a)** N independent `setInterval`s drift, overlap under load, and make
backoff/circuit-breaking per-org awkward. **(b)** Medium. Severity: medium.
**(c)** Single tick loop with per-org due-times; each org's next poll computed
from its own state (healthy → cadence; failing → backoff).

### 4c. Per-org fault isolation
**(a)** One org's dead credentials (401), expired refresh token, or Generac
outage must not affect other orgs — a shared client or shared catch block can
easily poison the pool. **(b)** High (credential churn is normal). Severity:
high if it cascades. **(c)** Per-org client instances, per-org try/catch,
per-org circuit breaker (e.g. 5 consecutive failures → back off to 5 min, then
15 min; 401 → mark org "auth failed", stop polling, raise an admin alert, never
retry the password blindly). Sign-in calls are the most rate-limited — cache
the `id_token` and refresh proactively via `/sessions/v2/refresh/token`
before expiry instead of re-signing-in per poll.

### 4d. Admin visibility
**(a)** Without per-org poller health (last success, consecutive failures, auth
state), failures are discovered by angry customers. **(b)** High. Severity:
medium. **(c)** Admin dashboard: per-org poller status + alerting on auth
failure and stale-data thresholds. Treat as operational necessity, not polish.

---

## 5. Kiosk device credential hardening

### 5a. Stolen tablet: blast radius
**(a)** A wall tablet is physically stealable. **(b)** Medium over the product's
life. Severity: medium *if* scoped correctly. **(c)** Device keys get minimum
scope: read telemetry/history/graphs for **one org only**. Explicitly exclude:
admin functions, credential management, key minting, other orgs, and —
important — **camera microphone / hold-to-talk** (a stolen tablet with PTT is a
harassment vector; cameras view-only on kiosk keys). Verify at the DB layer
that apiKey verification happens per request so **revocation is immediate**
(test it; don't assume).

### 5b. Rotation policy: event-driven, not time-driven
**(a)** Forcing periodic rotation means a physical re-pair visit each time —
operationally punishing and likely to be skipped. **(b)** High if time-based.
**(c)** Rotate on events: theft/loss report, staff turnover, any anomaly (§5c).
One-click revoke + re-pair from the admin panel.

### 5c. Clone detection (don't rely on IP pinning)
**(a)** IP pinning breaks on DHCP/NAT changes (brittle, false lockouts);
user-agent checks are trivially spoofed. **(b)** Medium. **(c)** Track
last-seen IP/UA per device key; alert (and optionally auto-suspend) on
divergence — same key active from two locations at once, or a sudden
geographic jump. Detection, not prevention.

### 5d. Pairing-code hygiene
**(a)** Short-lived pairing codes are brute-forceable if weak. **(b)** Low with
proper entropy. **(c)** High-entropy (≥128-bit), single-use, 5–10 min expiry,
rate-limited `/kiosk/pair` endpoint, audit-logged.

---

## 6. Third-party credential encryption at rest

### 6a. Use symmetric AEAD, not sealed boxes
**(a)** libsodium *sealed boxes* are for anonymous senders encrypting to someone
else's public key — the wrong primitive here, where the server both encrypts and
decrypts. **(b)** n/a (design choice). Severity: medium (misuse = subtle bugs).
**(c)** Use **AES-256-GCM via `node:crypto`** (zero new dependencies; the VPS
has AES-NI) or XChaCha20-Poly1305 via libsodium. Random 96-bit nonce per
encryption, stored alongside the ciphertext. **Bind `organizationId` as
Additional Authenticated Data (AAD)** — this makes a ciphertext copied from
org A's row undecryptable under org B, closing a ciphertext-swap attack.

### 6b. Key management on a single VPS
**(a)** The data-encryption key (DEK) has to live somewhere; each option has a
failure mode: env var (visible in `/proc`, core dumps, sloppy systemd units),
config file (on disk next to the DB it protects). **(b)** Medium. **(c)**
Recommended: DEK in a **0600 file owned by the service user, outside the repo**,
generated once at setup. Back it up **separately** from the DB dump, encrypted
with the existing backup passphrase, alongside the Drive backups. Support
**key versioning** (`key_id` column on credential rows) so rotation =
generate new key → re-encrypt rows → retire old key. Document the key-loss
recovery path honestly: **DEK loss = credentials unrecoverable = customers
re-enter their PWRview login** (acceptable, bounded, not silent corruption).

### 6c. Same treatment for Ring tokens
**(a)** Ring refresh tokens are bearer tokens — same sensitivity as passwords.
**(b)** Medium. Severity: high. **(c)** Encrypt with the same DEK/AAD scheme.

### 6d. Memory & log hygiene
**(a)** Decrypted passwords lingering in heap or landing in logs. **(b)** Low-
medium. Severity: medium. **(c)** Zero buffers after use where practical; keep
the codebase's existing redaction discipline (`[redacted]` in logs); never
include credential material in error messages or audit logs.

---

## 7. Admin panel attack surface

### 7a. Audit log (tamper-evident)
**(a)** Without an audit trail, a compromised admin account (or rogue action) is
undetectable and unrecoverable. **(b)** High value, low cost. **(c)** Append-only
`audit_log` table: timestamp, actor, action, target, IP, user-agent. Log:
logins/logouts, failed logins, password changes/resets, user
create/disable/delete, role changes, org create/delete, kiosk pair/revoke,
impersonation start/stop, cross-org denials. **Hash-chain** each row to the
previous (tamper-evident — detects silent edits; note it doesn't stop someone
with DB write access, it makes it detectable). Never allow UPDATE/DELETE on the
table from the app.
→ Plan change: Phase 3 — audit log is v1 scope, not a later nice-to-have.

### 7b. Invite flow vs admin-set password
**(a)** Admin-set passwords mean the admin knows the password (and users reuse
passwords). **(b)** Medium. Severity: medium. **(c)** No mail server exists on
this VPS, so email invites are v2. For v1: admin sets a **temporary password +
force-change-on-first-login flag**; log both events. Design the schema for
invites later (`emailVerified` already exists in the better-auth user table).

### 7c. Hardening `/api/auth/admin/*`
**(a)** These endpoints are the keys to the kingdom. **(b)** Medium. Severity:
critical. **(c)** Layered: allowlist only used endpoints (plan) + platform-
admin role checked server-side on every call (never trust the client) + fresh
(non-cached) session for the check (§1c) + dedicated rate limit + audit-log
every invocation. Consider **step-up re-authentication** for destructive
actions (delete org/user): require password re-entry within the last ~10 min.

### 7d. Brute force & enumeration
**(a)** Login endpoint hammered; or error messages distinguish "no such email"
from "wrong password" (account oracle). **(b)** High (bots scan everything).
Severity: medium. **(c)** better-auth rate-limit config with **database-backed**
storage (memory store resets on restart — and this box restarts); e.g. 5
failures → progressive delay, 10 → 15-min lockout + admin alert. Verify
identical responses for bad-email vs bad-password (better-auth default — verify,
don't assume).

### 7e. Admin session hygiene
**(a)** A 30-day admin session on a laptop is a long-lived skeleton key.
**(b)** Medium. Severity: medium. **(c)** Shorter session TTL for platform-admin
role (e.g. 12h), and revoke-all-sessions on password change / role demotion /
ban — verify better-auth does this, else do it explicitly via
`auth.api.revokeSessions`.

---

## 8. Things the base plan missed

### 8a. Org deletion cascade (customer churn)
**(a)** Deleting an org that leaves orphaned telemetry/history/credentials/Ring
tokens is both a privacy failure and a storage leak. Note the current
`energy_samples` table uses `ts` alone as primary key — per-org migration means
rebuilding it with a composite `(organization_id, ts)` PK and backfilling
existing rows into the default org. **(b)** Certain at churn time. Severity:
high (data-retention liability). **(c)** FK `ON DELETE CASCADE` everywhere +
a tested `deleteOrg` routine covering: telemetry, history, credentials, Ring
tokens, display settings, alerts, kiosk keys, poller state, better-auth org
rows. Offer an encrypted pre-delete export to the customer; confirm explicitly.
→ Plan change: Phase 2/3 — cascade design + export.

### 8b. Session invalidation on credential/role change (§7e)
Explicitly revoke all sessions on password change, role demotion, and ban.
Verify; don't assume the library does it.

### 8c. Per-org timezone
**(a)** History aggregation buckets by day (`dayKey(ts, timeZone)`) — whose
timezone? A customer in another zone gets wrong "today" boundaries and
misleading daily kWh. **(b)** Certain for non-local customers. Severity: low-
medium. **(c)** `timezone` column on the org; all aggregation and kiosk-clock
rendering uses it. Default `America/Los_Angeles`.
→ Plan change: Phase 2 — org record carries timezone.

### 8d. Consent & ToS for stored Generac passwords
**(a)** Storing customers' third-party passwords and polling Generac's cloud on
their behalf sits in a gray area of Generac's ToS, and customers should consent
explicitly. **(b)** Low legal risk at this scale, but nonzero. **(c)** At
credential entry, show explicit consent text ("we store your PWRview password
encrypted and poll your system on this schedule"); keep it honest and short.
Not a blocker — a disclosure.

### 8e. Rate/tariff data is per-org and customer-supplied
The plan already scopes TOU/cost per-org — correct. Note the rate sheet stays
"illustrative" until the customer provides a real bill; per-org notes field for
NEM status.

### 8f. Staging-first for auth
**(a)** Auth changes are the highest-blast-radius deploys in the plan.
**(b)** High. **(c)** The full sign-in → org scoping → kiosk pairing flow gets
tested on the staging instance before production, every time. (The staging
pattern already exists — use it.)

---

## Suggested plan amendments (summary)

1. **Phase 1**: disable `session.cookieCache` (kills stale-revocation bugs outright).
2. **Phase 1**: boot-log CI check that `tanstackStartCookies()` is last; client-bundle
   leak grep after every better-auth upgrade.
3. **Phase 1**: pin `better-auth >= 1.3.26` (CVE-2025-61928) + dependency audit in
   the deploy pipeline; `better-auth`/`drizzle-orm` upgraded in lockstep with a
   post-upgrade sign-in smoke test; regenerate schema via CLI on every upgrade;
   ignore the legacy `migrations/auth/0001_auth.sql`.
4. **Phase 0/1**: env-selectable DB client (`DATABASE_URL` escape hatch to real
   Postgres); dump-based encrypted backups + quarterly restore test; SIGTERM
   → `await pg.close()`.
5. **Phase 2**: single scheduler loop with per-org due-times (not N intervals);
   staggered/jittered polls; `Retry-After` + exponential backoff; per-org circuit
   breaker and auth-failure isolation; adaptive cadence (30s kiosk-visible,
   60–120s background).
6. **Phase 2**: `timezone` on the org; composite `(organization_id, ts)` PK
   rebuild of `energy_samples` with backfill into the default org.
7. **Phase 2/3**: org-deletion cascade + encrypted pre-delete export.
8. **Phase 3**: append-only hash-chained audit log as v1 scope; harden
   `/api/auth/admin/*` (allowlist + fresh-session + server-side role check +
   rate limit + audit); step-up re-auth for destructive actions; shorter admin
   session TTL; explicit session revocation on password/role/ban change.
9. **Phase 3/4**: kiosk keys read-only single-org, no PTT/mic, no admin;
   verify per-request verification (immediate revocation); event-driven rotation;
   clone detection via last-seen IP/UA anomaly alerts; hardened pairing codes.
10. **Credentials**: AES-256-GCM (`node:crypto`) with random nonces,
    `organizationId` as AAD, DEK in a 0600 file outside the repo with versioned
    rotation and separately-backed-up copies; same scheme for Ring tokens;
    explicit consent text at PWRview credential entry.
