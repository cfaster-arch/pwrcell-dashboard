# Responsive QA + control audit — 2026-09-25

Branch: `multi-user-plan` · Repo: `~/workspace/pwrcell-dashboard`
Ask: make box formatting scale with viewport, make fonts scale with the boxes,
fix the broken custom-background button, and check every link/button.

## Verdict

- **66/66 Playwright control checks pass** (`scripts/qa-audit.mjs`, fresh run
  against the final build).
- **Gates:** `npm run typecheck` ✅ · `npm run build` ✅ ·
  `npm test` ✅ — **283 passing**, 6 failing, all 6 the known stale
  `grok-pwa-plugin` "Wild Race" assertions (file untouched, per instructions).
- **8 required screenshots** (4 personalities × 390×844 / 1920×1080) inspected
  visually — no clipped text, no overlaps, no undersized desktop type.
- **2 real defects found and fixed** (custom-background chicken-and-egg;
  hardware-personality status-ticker overlap/viewport push).

## Defects found → fixes

1. **Custom background button broken (the reported bug).** Root cause in
   `src/lib/display-settings.server.ts`: selecting "Image" saved
   `backgroundMode: "image"`, but server-side sanitization immediately reverted
   it to `"default"` when no image existed yet — the upload control only renders
   in Image mode, so there was no way to ever upload. Fix: Image mode is now
   sticky with no image; `backgroundStyle()` keeps falling back to the default
   backdrop until `hasBackgroundImage` is true. Verified end-to-end: select
   Image → upload works → image serves over `/api/display-background` →
   persists across reload → remove clears it.
2. **Hardware (XP) personality status badge.** The scrolling demo-status ticker
   (`xp-ticker` marquee) was `inline-block`, so it shared a line with the
   Off-peak pill and slid underneath it, and its nowrap width pushed the badge
   24px past the viewport edge on 390px phones. Fix in `src/styles.css`: ticker
   is now `display: block` with `overflow: hidden` (scrolls inside the badge),
   badge gets `min-width: 0; max-width: 58vw`. Verified: badge right edge at
   353px on a 390px viewport; pill on its own line.

## Responsive work (fonts scale with their boxes)

Fluid `clamp()` type tokens added in `src/styles.css` and applied across the
dashboard, graph pages, power-flow, and metric details:

- `--text-hero`, `--text-tile-label`, `--text-kicker` (reworked to true fluid
  ramps), plus new `--text-h1`, `--text-clock`, `--text-flow-value`.
- Hardware title-button glyphs switched from fixed `11px` to relative `0.72em`.
- Clippy balloon font/width fluid (`clamp()` + `min(62vw, 15rem)`).
- Dashboard container widened on very large screens (`2xl:max-w-[104rem]`).
- Gauges already scale via SVG viewBoxes — no change needed.

## Control audit (scripts/qa-audit.mjs — 66/66)

Exercised with a real Chromium against an isolated local build
(`~/workspace/qa-pwrcell`, PGlite + DEK isolated from dev):

- **Auth:** sign-in, forced password change on first login, sign-out.
- **Setup wizard:** Next/Back, PWRview-launch, Close, Skip (fresh + resumed).
- **Menu:** opens; closes via X, Escape, and overlay click.
- **Personalities:** all four buttons select on phone and desktop, persist.
- **Display:** dark/light themes; Gauges/Tiles/Graphs/Flow modes persist;
  night dim on/off persists; Default/Color/Image backgrounds; color presets +
  custom color input; image upload/serve/persist/remove.
- **PWRview dialog:** opens, bad credentials show a clean inline error
  (Generac 404 → "Couldn't sign in"), Close works. Real-login success not
  testable without real credentials.
- **Graphs:** all four `/graphs/<metric>` routes load; the Chart-range
  `<select>` (30m→1y) switches data on every route; bad metric 404s cleanly.
- **Account:** page loads, change-password link navigates.
- **Alerts:** section present, 6 interactive toggles.
- **Electricity rates:** section present, 6 editable inputs; Save enables only
  when dirty and persists (verified via API round-trip).
- **Ring/cameras:** section present. Full Ring pairing/2FA/live-stream not
  testable without real Ring credentials — stated as a limitation, not a pass.
- **Layout:** zero horizontal overflow at 390px and 1920px.
- **Console/network:** no unexpected console errors; no failed app requests.
  (Intentional bad-creds 400 and intentional `/graphs/nope` 404 allowlisted;
  Google-Fonts/Grok-extension proxy artifacts excluded — local-QA-only noise.)

Static scan found no `href="#"`, no empty click handlers, no placeholder links.

## Screenshots

`qa-shots/` (all visually inspected):

- `dashboard-standard-390x844.png` / `dashboard-standard-1920x1080.png`
- `dashboard-hardware-390x844.png` / `dashboard-hardware-1920x1080.png`
- `dashboard-workbench-390x844.png` / `dashboard-workbench-1920x1080.png`
- `dashboard-crt-390x844.png` / `dashboard-crt-1920x1080.png`
- plus `00-signin.png`, `50-menu-open-desktop.png`, and `findings.json`
  (machine-readable per-check results).

## Limitations (not testable in QA)

- Real PWRview sign-in success (needs Connor's installer credentials, in-app only).
- Real Ring pairing / 2FA / live WebRTC (needs his Ring account + cameras).
- The QA server ran the production build in dev mode because Chromium's
  loopback restrictions and the `__Secure-` session cookie don't mix on plain
  local HTTP — a local-test artifact; production runs HTTPS.

## Files changed

- `src/lib/display-settings.server.ts` — Image-mode stickiness fix.
- `src/styles.css` — fluid type tokens, hardware glyph/ticker/badge fixes,
  Clippy fluid sizing.
- `src/components/dashboard/dashboard.tsx` — fluid h1/clock, wider 2xl container.
- `src/routes/_authed/graphs/$metric.tsx` — fluid heading, wider desktop.
- `src/components/dashboard/power-flow.tsx` — fluid flow values.
- `src/components/dashboard/metric-detail.tsx` — fluid stat values.
- `scripts/qa-audit.mjs` — new, 66-check Playwright audit (kept in repo).
- `qa-shots/` — new, screenshots + findings.json.

Not deployed — parent agent handles that.
