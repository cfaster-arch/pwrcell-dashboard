# Phase 3 (slim) — completion report

**Date:** 2026-09-25
**Branch:** `multi-user-plan` (repo `cfaster-arch/pwrcell-dashboard`, private)
**Scope:** Connor's "slim three" — minimal seed/CLI user management, operator-triggerable
immediate session revocation, append-only admin logging with minimal review/export,
confirmation for destructive actions wherever UI exists. Phase 4 (kiosk pairing) deferred.
**Production branch `pwrcell-dashboard-security-combo`: untouched.**

## What was built

**New files**
- `scripts/admin-user.mjs` — CLI user management: `list`, `create` (--role, --org/--org-role),
  `disable` (ban + session revoke), `enable`, `reset-password` (forces must-change-password +
  session revoke), `revoke-sessions`. Password only via `ADMIN_USER_PASSWORD` env (never argv,
  never logged). Every mutation appends to `audit_log` with `actor_type='cli'` in the same
  hash-chain format the server verifier accepts.
- `src/routes/api/admin/audit.ts` — platform-admin-only audit review/export:
  `GET /api/admin/audit` (paginated, newest-first, action/orgId/actor filters;
  the JSON response *is* the export format) and `?verify=1` (runs `verifyAuditChain()`).
  Every read is itself audit-logged as `audit.exported`.
- `src/routes/api/admin/users.$userId.revoke-sessions.ts` — platform-admin-only
  immediate session revocation; delete + audit in one transaction.
- `scripts/phase3-admin.test.mjs` — 10 end-to-end CLI tests against throwaway PGlite.

**Modified**
- `src/lib/authn/audit.server.ts` — new canonical actions `user.enabled`, `admin.api_call`,
  `session.revoked`, `audit.exported`; `auditEvent` now wraps read-tail + insert in a
  transaction holding `pg_advisory_xact_lock(hashtext('audit_log_append'))` (cross-process
  chain-fork fix); `verifyAuditChain` no longer holds the write mutex during reads,
  caps limit at 5000, and reports `reachedGenesis`.
- `src/routes/api/auth/$.ts` — every gated `/api/auth/admin/*` invocation is audit-logged
  as `admin.api_call` (Better Auth 1.6.33's admin plugin exposes no `onAdminCall` hook —
  verified against installed types; logging at the route mount). Added SINGLE-MOUNT
  INVARIANT comment.
- `src/components/dashboard/credentials-dialog.tsx` — PWRview credential disconnect now
  asks for confirmation. `display-settings-context.tsx` — custom-background removal confirms.
  (Ring disconnect already confirmed; org deletion has no UI surface.)
- `scripts/crypto-audit.test.mjs` — updated for the new action set / verify result shape;
  the DB shim gained `.transaction()`.
- `docs/multi-user-auth-plan.md` — Phase 3 items + full DeepSeek review dispositions.

## DeepSeek review (V4 Flash only — Pro retired 2026-09-25)

Three briefs; every finding verified against installed dependency sources, not taken on faith.

**Brief 1 — admin mount gate/audit (8 findings, no code changes needed):**
- F1 (claimed CRITICAL path-normalization bypass): **not exploitable.** Verified against
  better-auth 1.6.33's actual router (better-call + rou3): `new URL().pathname` never
  percent-decodes, dot-segments normalize identically both sides, better-call 404s on `//`,
  rou3 does zero decoding. The gate's decode-once + lowercase only ever *widens* it
  (fail-closed). The finding's premise ("rou3-style router decodes and collapses") is
  factually wrong for this dependency tree.
- F2 (`instanceof Response`): dismissed — single Node realm; codebase-wide convention.
- F3 (audit throw → DoS / mutex): premises false — mutex releases on failure (both
  branches resolve); no unauthenticated path calls `auditEvent` (verified by grep).
  Fail-closed is the deliberate codebase pattern.
- F4 (XFF spoofing): bounded residual, same as Phase 1's documented acknowledgment;
  audit-informational only.
- F5 (mount-scoped audit): accepted as maintenance caveat → SINGLE-MOUNT INVARIANT
  comment added.
- F6/F8: accepted slim-scope trade-offs, noted. F7 (denied attempts not audited):
  intentional oracle protection.

**Brief 2 — audit export + revoke-sessions (fixed):**
- `verifyAuditChain` dropped the write mutex for reads (single snapshot read needs none);
  limit capped at 5000 — a big verify can no longer stall audit logging.
- Result now reports `reachedGenesis`; the API surfaces it. A truncated window proves
  *internal* consistency only — a full-table rewrite by a DB writer needs an external
  checkpoint (accepted residual, documented in the route).
- Audit reads/exports are now audit-logged (`audit.exported`) — exfiltrating the trail
  leaves a trace. Export `offset` clamped.
- Revocation + audit in one transaction (repudiation fix); audit skipped when nothing
  deleted. `reason` persistence deferred (no details column in slim scope).
- Dismissed with verification: CSRF (session cookie is `SameSite=Lax` by default —
  cross-site POST carries no cookie); canonicalization (fixed field order, scalar
  columns, no jsonb); "incomplete revocation" (sessions are the only credential class;
  kiosk keys are Phase 4); cross-admin step-up (explicitly scoped out by Connor);
  401/404 semantics (deliberate Phase 1/2 oracle design).

**Brief 3 — CLI audit-chain replication + concurrency:**
- H1 (cross-process chain fork): **fixed** via the advisory-lock transaction above
  (server + CLI take the same lock). The verifier already enforced linkage, so a fork
  would have been *detected*; now it can't *happen*.
- M1/M2: GENESIS anchor byte-identical both sides; `ts` is `timestamptz` (round-trip stable).
- **Empirical finding during verification: two concurrent PGlite backends on one dataDir
  do NOT share a coherent view** (second instance saw 0 of the first's rows — silent
  divergence, corruption risk; stricter than the plan's "stale reads" note). Fix:
  the CLI now **refuses to run while `postmaster.pid` exists** (app holding the dataDir),
  with `--force` for a stale lock after a crash; guard skipped on the Neon path.
  Also fixed: `fail()` used `process.exit(1)`, skipping `closeDb()` and leaking the lock —
  now throws `CliError`, main() catches, closes the DB, sets `exitCode`. Covered by a test.

## Gate results

- Full test suite: **283 pass / 6 fail** — all 6 failures are the known pre-existing
  `scripts/grok-pwa-plugin.test.mjs` "Wild Race" title assertions (file untouched per
  instructions; fails identically on the base branch). Baseline was 273/6 — now 283/6.
  - `scripts/**/*.test.mjs`: 234 tests, 228 pass, 6 fail (all grok-pwa pre-existing)
  - `src` suites (app-data, readiness-schedule, gate-identity, sign-in-gate): 55/55 pass
- `scripts/phase3-admin.test.mjs`: 10/10 pass (incl. new single-process guard test)
- `scripts/crypto-audit.test.mjs`: 16/16 pass
- `npx tsc --noEmit`: clean (exit 0)
- `npm run build`: clean (exit 0)
- `npm run check:auth`: Phase 1 auth invariants ok
- Secrets scan: clean over the full diff (manual grep for secret patterns; no gitleaks
  in repo. Fixed fixture password `test-password-1234` in tests only, documented.)
- Production branch untouched: verified — tip `0054a6d`, never checked out or committed
  to during this work; all changes on `multi-user-plan` only.

## Commit

`21227b8` on `multi-user-plan`, pushed to `origin/multi-user-plan` 2026-09-25.
This report file (`docs/build-reports/phase3-report.md`) is included in the commit
per the 2026-09-25 builder dispatch protocol — the durable record.
Production branch `pwrcell-dashboard-security-combo` untouched (tip `0054a6d`).

## Open items / follow-ups

- `reason` on `session.revoked` is echoed to the caller but not persisted in the audit row
  (no details column in slim scope) — add if justification trails matter later.
- Full-table-rewrite tampering needs an external checkpoint anchor (accepted residual).
- The audit export has no UI — operators curl it (per slim scope).
- `/tmp` hygiene: the phase3/crypto-audit tests leak their mkdtemp dirs (~39M each on the
  512M tmpfs); a full /tmp caused spurious PGlite bootstrap failures mid-task. Worth a
  cleanup trap in the test files later.
- Time: tracking toward the 2–4h estimate; the H1 concurrency rabbit hole (empirical
  PGlite divergence probe + guard + fail() rework) was the largest single chunk.
