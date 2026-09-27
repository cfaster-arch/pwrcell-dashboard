# Build report — Remove Grok live-preview integration (dead sandbox workflow)

**Date:** 2026-09-27
**Branch:** `multi-user-plan` (commit created locally; **not pushed** — push coordinated by parent with parallel work on the same branch)
**Requested by:** Connor — "Also remove old grok integration garbage"
**Commit:** `Remove Grok live-preview integration (dead sandbox workflow)`

## What this was

The repo carried a full Grok live-preview authentication stack: a sandbox OAuth
popup flow (`/auth/popup` dev middleware), a legacy `src/lib/auth/` client/server
(email+password, sign-in gates, provider popup, preview identity helpers), and a
`PreviewHostBridge` component injected into the app root. None of it is used by
production, which authenticates through `src/lib/authn/` (Better Auth
email/password + Google OAuth, cookie sessions, organization guards,
must-change-password enforcement). The preview stack was dead weight and a
confusing second auth surface — it was removed.

## Initial audit

A grep for live-preview auth references (`grok-sandbox`, `GROK_PREVIEW`,
`PREVIEW_CLIENT`, `preview-host-bridge`, `popup.server`, `/auth/popup`) found
these files:

- `src/components/preview-host-bridge.tsx`
- `src/lib/app-data/app-data.test.ts`
- `src/lib/app-data/client.server.ts`
- `src/lib/auth/client.ts`
- `src/lib/auth/gate-identity.server.ts`
- `src/lib/auth/gate-identity.test.ts`
- `src/lib/auth/gate-session-marker.ts`
- `src/lib/auth/gates.tsx`
- `src/lib/auth/isolation.server.ts`
- `src/lib/auth/popup.server.ts`
- `src/lib/auth/preview.ts`
- `src/lib/auth/providers.ts`
- `src/lib/auth/server.ts`
- `src/lib/env.server.ts`
- `src/lib/preview-embedder-origin.ts`
- `src/routes/__root.tsx`

## Files removed (23)

- `scripts/sign-out-plan.mjs`
- `scripts/sign-out-plan.test.mjs`
- `src/components/preview-host-bridge.tsx`
- `src/lib/preview-host-bridge.ts`
- `src/lib/preview-embedder-origin.ts`
- `src/lib/auth/client.ts`
- `src/lib/auth/email-password.ts`
- `src/lib/auth/gate-identity.server.ts`
- `src/lib/auth/gate-identity.test.ts`
- `src/lib/auth/gate-session-marker.ts`
- `src/lib/auth/gate-session.server.ts`
- `src/lib/auth/gates.tsx`
- `src/lib/auth/middleware.ts`
- `src/lib/auth/pglite-dialect.ts`
- `src/lib/auth/popup.server.ts`
- `src/lib/auth/preview.ts`
- `src/lib/auth/provider.tsx`
- `src/lib/auth/providers.ts`
- `src/lib/auth/server.ts`
- `src/lib/auth/sign-in-gate.ts`
- `src/lib/auth/sign-in-gate.test.ts`
- `src/lib/auth/use-current-user.ts`
- `src/lib/auth/verify.server.ts`

`src/lib/auth/` now contains only `isolation.server.ts` (see retained items).

## Files changed (4)

- `src/routes/__root.tsx` — removed `PreviewHostBridge` and the obsolete
  passthrough `AuthProvider`; `<Outlet />` renders directly.
- `vite.config.ts` — removed the development-only `/auth/popup` middleware
  plugin (`authPopupPlugin`).
- `package.json` — removed the deleted legacy-auth test files from the `test`
  script (only the test-script line; no dependency changes in this commit).
- `scripts/check-auth-invariant.mjs` — updated a stale comment referencing the
  removed legacy auth client/server.

## Retained — uncertain references (left in place deliberately)

- `src/lib/app-data/` (the Grok app-data connector: `client.server.ts`,
  `app-data.test.ts`) still references preview-auth concepts, and
  `client.server.ts` imports the tenant-isolation utility from
  `src/lib/auth/isolation.server.ts`. This is a **separate connector surface**,
  not clearly part of the live-preview auth flow, so it was kept. Flagging for
  Connor/a follow-up rather than guessing.
- `src/lib/auth/isolation.server.ts` — kept: still imported by the app-data
  connector.

## Production dependency check (VPS, 2026-09-27)

- Current production auth lives under `src/lib/authn/`; the production API
  route `src/routes/api/auth/$.ts` imports `@/lib/authn/server`. Untouched.
- The VPS `dashboard.env` contains no `GROK_AUTH_*` configuration.
- The old `src/lib/auth/` tree had no production route/component consumers
  except the passthrough `AuthProvider` in `__root.tsx` (removed) and the
  preview popup plugin (removed).
- `src/routes/_authed/flow.tsx` was not touched. `src/components/dashboard/nav-menu.tsx`,
  `src/routes/_authed/flow.tsx`, and `src/routes/_authed/index.tsx` were
  explicitly excluded from this cleanup per parent instruction.

## Verification

- Final targeted grep for `grok-sandbox`, `GROK_PREVIEW`, `PREVIEW_CLIENT`,
  `preview-host-bridge`, `popup.server`, `/auth/popup` across `src/`,
  `scripts/`, `vite.config.ts`: **zero hits**.
- `npx tsc --noEmit`: **passed** (exit 0).
- `npx vite build`: **passed** (exit 0) — `✓ built in 8.79s`, Nitro output
  generated; only the existing TanStack `"use client"` bundling warnings.
- `node --experimental-strip-types --test src/lib/app-data/app-data.test.ts
  src/lib/app-data/readiness-schedule.test.ts`: **28/28 pass**.
- `node --test 'scripts/**/*.test.mjs'`: one failure in
  `scripts/grok-pwa-plugin.test.mjs` ("uses the app name in the injected title
  tag") — **pre-existing, unrelated to this cleanup**: the test hardcodes an
  expected app name of "Wild Race" while the repo's `src/lib/og/site.json`
  declares `"title": "PWRcell"`, which the plugin correctly prefers. Verified
  failing on the pristine tree (changes stashed) with the same diff.

## Delivery notes

- Committed locally on `multi-user-plan` as `Remove Grok live-preview
  integration (dead sandbox workflow)`. **Not pushed** — parent is
  coordinating the push with other parallel work on the same branch.
- Staged only this cleanup's files plus this report. Pre-existing working-tree
  items (`src/routeTree.gen.ts`, `.github/workflows/provision-user.yml`) and
  another agent's concurrent changes on the same branch were left untouched.
