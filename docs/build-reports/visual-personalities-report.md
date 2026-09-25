# Build report — visual personalities (Hardware / Workbench / CRT)

Date: 2026-09-25. Branch: `multi-user-plan`. Design-only change; no auth, API, or polling logic touched.

## What Connor asked for

Three selectable visual themes as user-facing display settings, after rejecting the
`visual-refresh` branch as still reading "agent-made" (too traditional, too efficient —
missing the human touch of dysfunction). Taste guidance: idiosyncrasy WITH INTENT —
asymmetry, texture, personality; dysfunction that feels human, not sloppy.

## What was built

A **Personality** picker in Display settings (menu → Display), persisted **per-organization**
through the existing org-settings `display` section (`PUT /api/display` accepts
`personality`; sanitized server-side; synced to `document.documentElement.dataset.personality`
and rendered into `<html data-personality>` by the root loader, so it survives reloads
and applies on first paint). Four options, shown as a 2×2 card grid with live-styled
mini previews:

- **Standard** — the existing clean look, unchanged.
- **Hardware** — skeuomorphic instrument panel: brushed-metal body, metric tiles as
  screwed-down metal plates (corner screws via layered radial-gradients), engraved
  silkscreen labels (inset text-shadow), Barlow Condensed type everywhere, squarish
  radii, machined-edge shadows.
- **Workbench** — brutalist engineering notebook: graph-paper background, Space Mono
  throughout, tiles as pinned spec cards (dashed cut-line borders, tape strip holding
  the top edge), rubber-stamp rotated labels, hard offset shadows.
- **CRT** — phosphor terminal: VT323 type, green-phosphor palette (amber solar),
  scanline + vignette overlays across the whole viewport, text glow, blinking block
  cursor after the headline, terminal-window tiles with ghost frames, zero radii.

### How it works technically

- New `PersonalityName` (`"standard" | "hardware" | "workbench" | "crt"`) on
  `DisplaySettings`, default `"standard"` — old saved settings migrate cleanly.
- All styling is CSS-token driven: `[data-personality="…"]` blocks in `src/styles.css`
  override the design tokens (colors, fonts, radii, shadows, `--gauge-*` vars), so
  tiles, gauges (SVG), charts (recharts, var-driven), power flow, nav, dialogs, and
  settings all restyle with zero component edits. Personality blocks sit after the
  light-theme block so they win on equal specificity.
- Structural textures hook onto `article` (the four metric tiles — the only
  `article` users) and `body::before/::after` (CRT scanlines/vignette).
- Self-hosted fonts via fontsource (cherry-picked pattern from the rejected
  `visual-refresh` branch — the only thing taken from it): Barlow Condensed
  (500/600/700), Space Mono (400/700), VT323 (400). Bundled as woff2 in the
  production build; no Google Fonts dependency for personalities.
- When a personality is active, the Dark/Light theme toggle is disabled with the
  note "The active personality sets its own palette" — personalities own the full
  palette (all three are inherently dark aesthetics).
- The rejected `visual-refresh` branch was NOT merged.

## Verification

- Screenshots at 390×844 (phone viewport) of a markup harness using the real
  compiled production CSS + fonts: all three personalities immediately and
  unmistakably themselves (see `~/workspace/theme-shots/{hardware,workbench,crt,standard}.png`).
- Works across Gauges/Tiles/Graphs/Flow modes by construction (token-driven; no
  per-mode code).

## Gate results

- Typecheck: clean (`tsc --noEmit`).
- Production build: clean (nitro + PGlite assets).
- Tests: **283 pass, 6 fail** — the 6 failures are the pre-existing stale
  `scripts/grok-pwa-plugin.test.mjs` tests expecting the old "Wild Race" template
  name (identical on the Phase 1 baseline; file untouched per instructions).
- Secrets: no secrets added (CSS + settings plumbing only).

## Notes / follow-ups

- Test hygiene: the suite leaks ~39M PGlite dirs per run into /tmp (known Phase 3
  issue); /tmp is a 512M tmpfs, so two runs fill it and later tests fail
  spuriously. Cleaned `/tmp/phase3-*` after the runs.
- Possible polish (not done): per-personality light variants; personality-aware
  camera section styling (token-driven already, fine as-is).
