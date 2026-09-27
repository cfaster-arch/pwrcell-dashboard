# Remove Ring camera integration — 2026-09-27

Connor asked for the Ring camera integration to be fully removed from the
dashboard repo (`multi-user-plan` branch). Done in the working tree —
**not committed, not pushed** (per task instructions; parent handles that).

## Files deleted

- `src/lib/ring/` — entire directory:
  - `ring-api.server.ts` (Ring sign-in/2FA, discovery, stream namespacing, go2rtc bridge sync)
  - `go2rtc.server.ts` (go2rtc binary download + supervision on 127.0.0.1:1984)
  - `org-ring-tokens.server.ts` (per-org encrypted refresh tokens)
  - `ring-store.server.ts` (per-org camera slot settings)
  - `types.ts` (`CameraSlot`, `CameraMode`, `DiscoveredCamera`, `RingUiState`)
- `src/components/dashboard/camera-card.tsx` (WebRTC live view + snapshots + PTT mic)
- `src/components/dashboard/cameras-section.tsx` (Cam1/Cam2/Both section)
- `src/components/dashboard/ring-setup.tsx` (Ring sign-in/2FA + camera picker)
- `src/routes/api/ring.ts` (the whole `/api/ring` API: status, login, 2FA, discovery, slots)
- `src/routes/api/rtc.$.ts` (same-origin proxy to the go2rtc bridge)
- `docs/ring-setup.md` (user-facing Ring setup doc — described a feature that no longer exists)

## Files changed

- `package.json` — removed `"ring-client-api": "^14.3.0"` dependency
- `src/components/dashboard/dashboard.tsx` — removed `CamerasSection` import and the `{settings.showCameras ? <CamerasSection /> : null}` render
- `src/components/dashboard/settings-panel.tsx` — removed the "Cameras" toggle from Extras
- `src/components/dashboard/setup-wizard.tsx` — removed the "Cameras" wizard step (was step 2 of 4); steps are now Connect PWRview / Rate plan / Display mode, "of 3", next-button threshold `step < 2`
- `src/lib/display-settings.ts` — removed `showCameras` from the `DisplaySettings` interface and from `DEFAULT_DISPLAY_SETTINGS`
- `src/lib/display-settings.server.ts` — removed `showCameras` from settings sanitize
- `src/routes/api/display.ts` — removed the `showCameras` patch branch
- `src/lib/orgs.server.ts` — removed the `syncBridge` import and the post-deleteOrg bridge re-sync; doc comment updated (no longer claims a Ring bridge re-sync)
- `src/lib/authn/audit.server.ts` — removed `RING_CONNECTED` / `RING_DISCONNECTED` audit actions
- `src/lib/authn/crypto.server.ts` — startup banner comment now says the DEK encrypts "PWRview logins" (dropped "Ring tokens")
- `src/lib/org-settings.server.ts` — removed `camera: "camera-settings.json"` from the legacy-import map and from the doc comment
- `src/routeTree.gen.ts` — removed the `/api/ring` and `/api/rtc/$` route registrations (imports, consts, type maps, unions, manifest). Hand-edited because `@tanstack/router-generator` isn't installed standalone; the vite router plugin will regenerate this file on the next build and produce the same result since the route files are gone
- `scripts/phase2-isolation.test.mjs` — removed the `org-ring-tokens.server` and `ring-api.server` imports, the "ring tokens: per-org isolation" test, the "ring: stream names are namespaced" test; the purpose-binding test now uses a generic `other.purpose` AAD instead of `ring.refresh`; header comments de-ringed
- `scripts/crypto-audit.test.mjs` — removed `RING_CONNECTED`/`RING_DISCONNECTED` from the expected `AUDIT_ACTIONS` map (it does a `deepEqual`)
- `scripts/qa-audit.mjs` — removed the "Ring/cameras section present" menu check; section header comment updated
- `scripts/gen-dek.mjs` — key-loss help text no longer says "Ring cameras re-paired"

## Boundary files — nothing left for the parent

The task said to leave `nav-menu.tsx` (and `flow.tsx`, `index.tsx`) alone and
flag any Ring wiring inside. When I got there, the parent's own parallel work
had already removed all of it from `nav-menu.tsx`: the `RingSetupSection`
import, the conditional render block, and the four graph links are gone (the
Dashboard link now points at `/dashboard`). Verified with grep — zero
Ring/camera references remain in any of the three boundary files.

## Intentionally left in place

- `src/lib/authn/schema.ts` — the `org_ring_tokens` table definition stays.
  Dropping it requires a DB migration; the table is inert (nothing reads or
  writes it now). The phase-2 cascade test's `org_ring_tokens` row-count
  assertion still passes and still validates the FK cascade.
- `docs/multi-user-auth-plan.md` — historical plan doc with `[x]` items about
  Ring (same category as build-reports history; left untouched).
- `docs/build-reports/` — untouched, per instructions.
- `src/lib/multiplayer/p2p.ts` — its `/api/rtc` references are the multiplayer
  P2P signaling feature (per the multiplayer-p2p skill), unrelated to the Ring
  camera bridge (`/api/rtc/$` splat, now deleted). Left alone.
- `src/lib/pwrcell/poller.server.ts` — "ring buffer" is a data-structure term,
  not Ring cameras. Left alone.
- `src/components/dashboard/gauge.tsx` — "SoC ring" is a UI shape description.
  Left alone.

## Verification

- `npx tsc --noEmit`: **zero errors related to this removal** (no ring/camera/
  go2rtc/showCameras errors). The only errors are in the parent's in-progress
  files: `nav-menu.tsx(122,23)` (`"/dashboard"` not yet in the generated route
  types — the routeTree regen happens on the parent's build) and
  `src/routes/_authed/dashboard.tsx` (new route file: not yet registered in
  routeTree + a loader-data union typing issue). Both pre-date/are independent
  of this removal.
- `vite build` was intentionally **not** run (per instructions — parent builds
  once after all parallel work lands).

## House-rules note

The runtime asked me to read `~/workspace/pwrcell-dashboard/AGENTS.md` before
working there. I read it — it is a stale leftover from the original Grok App
Builder sandbox era (references `/workspace` as project root, Grok preview
proxy, Vercel deploys) and does not describe this repo's actual workflow
(VPS deploy, Better Auth, multi-user plan). Nothing in it blocked or changed
this removal; flagging in case Connor wants it updated or deleted.
