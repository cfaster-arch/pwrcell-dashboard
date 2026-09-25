// @ts-check
/**
 * PGlite resolves its WASM/data artifacts at runtime relative to the bundled
 * chunk (`new URL("./pglite.data", import.meta.url)`), but vite/rolldown does
 * not emit them into `.output`. Without these files beside the chunk, PGlite
 * bootstrap fails with ENOENT and every DB-backed route 500s.
 *
 * Run after `vite build` (wired into the `build` script). Locates the emitted
 * pglite chunk under `.output/server/_libs/` and copies the artifacts next to
 * it. Warns instead of failing so a future PGlite layout change degrades to a
 * loud runtime error rather than a broken deploy pipeline.
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const ARTIFACTS = ["pglite.data", "pglite.wasm", "initdb.wasm"];

function main() {
  const libsDir = join(process.cwd(), ".output", "server", "_libs");
  if (!existsSync(libsDir)) {
    console.warn("[pglite-assets] .output/server/_libs not found — skipping.");
    return;
  }
  const chunk = readdirSync(libsDir).find((f) => /pglite.*\.mjs$/.test(f));
  if (!chunk) {
    console.warn("[pglite-assets] no pglite chunk found in _libs — skipping.");
    return;
  }
  const require = createRequire(join(process.cwd(), "package.json"));
  // Resolve via the package main entry (its ./package.json subpath is not exported).
  const distDir = dirname(require.resolve("@electric-sql/pglite"));
  let copied = 0;
  for (const name of ARTIFACTS) {
    const src = join(distDir, name);
    if (!existsSync(src)) {
      console.warn(`[pglite-assets] missing ${src} — skipping.`);
      continue;
    }
    cpSync(src, join(libsDir, name));
    copied++;
  }
  console.log(`[pglite-assets] copied ${copied}/${ARTIFACTS.length} artifacts next to ${chunk}`);
}

main();
