#!/usr/bin/env node
/**
 * Auth invariant checks (`npm run check:auth`).
 *
 * Two suites:
 *  1. **Phase 1 authn invariants** (static, no dev server needed) — always run:
 *     - `tanstackStartCookies()` is the LAST plugin in `src/lib/authn/server.ts`
 *       (research §1a: otherwise session cookies are silently dropped);
 *     - `session.cookieCache.enabled` is `false` (research §1c: stale
 *       revocation/role-change/ban);
 *     - version floors: better-auth >= 1.3.26 (CVE-2025-61928, research §1d)
 *       and drizzle-orm >= 0.45 (research §1f);
 *     - `src/lib/authn/guard.server.ts` never trusts
 *       `session.activeOrganizationId` for authorization (research §1g) — the
 *       only allowed use is inside `getMyOrgId()`, validated against the
 *       member table;
 *     - the impersonation endpoint is blocked in `src/routes/api/auth/$.ts`
 *       (research §1h).
 *     Any failure exits 1.
 *  2. **Legacy VITE_AUTH_ENABLED comparison** (needs a live dev server):
 *     the running dev server and the next build must agree about the flag.
 *     Skipped with a warning when no dev server answers; a real divergence
 *     exits 1.
 *
 * The exported helpers below the line are also used by
 * `scripts/browser-smoke.mjs` — keep their signatures stable.
 *
 * Legacy detail (suite 2): `npm run dev`, `npm run build` and `npm run preview`
 * all get the flag from `scripts/with-app-env.mjs`, so they agree by
 * construction — but a dev server started outside npm (`npx vite dev`) does
 * not, and the result is sign-in visible in the live preview and absent from
 * the built output, or the reverse.
 * The two sides compared:
 *  - **dev**: what the running server resolved, read from the `/__app-env`
 *    endpoint the template's dev-only `appEnvPlugin` serves.
 *  - **build**: what the wrapper hands `vite build` / `vite preview`.
 *
 * The built bundle is not read: Vite inlines the flag and the minifier folds
 * `"false" !== "false"` away, so the built client JS carries no marker to
 * compare against unless the app is made to emit one.
 *
 * `scripts/browser-smoke.mjs` runs the comparison on every smoke; run it
 * standalone against a live dev server with `npm run check:auth`.
 */
import { APP_ENV_ROUTE } from "./app-env-plugin.mjs";
import { isMainModule, mergeAppEnv, projectRoot, readAppEnv } from "./with-app-env.mjs";

const DEFAULT_DEV_URL = "http://127.0.0.1:8080";

/** The predicate the (now-removed) legacy Grok auth client/server applied to the
 * flag — kept for the dev/build agreement check. */
export function authEnabledFromEnvValue(value) {
  return value !== "false";
}

/**
 * Compare the two resolved values. `null` means "could not observe" — reported
 * as indeterminate rather than as agreement.
 */
export function compareAuthInvariant({ devAuthEnabled, buildAuthEnabled }) {
  const label = (value) => (value ? "on" : "off");
  if (devAuthEnabled === null || devAuthEnabled === undefined) {
    return {
      status: "indeterminate",
      message: "[auth-invariant] could not read the dev server's resolved VITE_AUTH_ENABLED",
    };
  }
  if (devAuthEnabled === buildAuthEnabled) {
    return {
      status: "ok",
      message: `[auth-invariant] dev and build agree: sign-in ${label(devAuthEnabled)}`,
    };
  }
  return {
    status: "diverged",
    message:
      `[auth-invariant] dev server has sign-in ${label(devAuthEnabled)} but the next ` +
      `build has it ${label(buildAuthEnabled)}. Start the app with \`npm run dev\` — ` +
      "invoking vite directly skips scripts/with-app-env.mjs, so the dev server and " +
      "the built output resolve .grok/app-env.json differently.",
  };
}

/**
 * Ask the dev server which env it resolved. Anything but a JSON object from
 * `/__app-env` (no server, a built-output preview, an older workspace without
 * the plugin) is "could not observe".
 */
export async function probeDevAuthEnabled(devUrl, fetchImpl = fetch) {
  let env;
  try {
    const response = await fetchImpl(new URL(APP_ENV_ROUTE, devUrl).href);
    if (!response.ok) return null;
    env = JSON.parse(await response.text());
  } catch {
    return null;
  }
  if (env === null || typeof env !== "object") return null;
  return authEnabledFromEnvValue(env.VITE_AUTH_ENABLED);
}

/** The smoke-verdict warnings for a comparison: a real divergence only. */
export function authInvariantWarnings(result) {
  return result.status === "diverged" ? [result.message] : [];
}

/** What `vite build` / `vite preview` will resolve, via the same wrapper. */
export function buildAuthEnabled(root = projectRoot(), processEnv = process.env) {
  const env = mergeAppEnv(readAppEnv(root), processEnv);
  return authEnabledFromEnvValue(env.VITE_AUTH_ENABLED);
}

/* ------------------------------------------------------------------ */
/* Suite 1: Phase 1 authn invariants (static — no dev server needed)  */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function repoFile(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

/**
 * Plugin factory names in `plugins: [...]` order, from
 * `src/lib/authn/server.ts`. Tracks bracket depth so nested calls
 * (e.g. `admin({ ... })`) don't confuse the scan.
 */
export function pluginFactoriesInOrder(serverSrc) {
  const start = serverSrc.indexOf("plugins: [");
  if (start === -1) return [];
  let depth = 0;
  let i = serverSrc.indexOf("[", start);
  const names = [];
  let buf = "";
  let inName = false;
  for (; i < serverSrc.length; i++) {
    const ch = serverSrc[i];
    if (ch === "[") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) {
      if (/[A-Za-z_$]/.test(ch)) {
        buf += ch;
        inName = true;
      } else {
        if (inName && ch === "(") names.push(buf);
        buf = "";
        inName = false;
      }
    } else {
      buf = "";
      inName = false;
    }
  }
  return names;
}

/** Numeric semver compare: -1 | 0 | 1. */
export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Run the static Phase 1 authn invariant checks. Returns an array of failure
 * messages (empty = all pass).
 */
export function checkAuthnInvariants(root = projectRoot()) {
  const failures = [];
  let serverSrc;
  try {
    serverSrc = repoFile(root, "src/lib/authn/server.ts");
  } catch {
    failures.push("src/lib/authn/server.ts is missing");
    return failures;
  }

  // §1a — tanstackStartCookies() must be LAST in plugins[].
  const plugins = pluginFactoriesInOrder(serverSrc);
  if (plugins.length === 0) {
    failures.push("could not parse plugins[] in src/lib/authn/server.ts");
  } else if (plugins[plugins.length - 1] !== "tanstackStartCookies") {
    failures.push(
      `tanstackStartCookies() is not last in plugins[] (order: ${plugins.join(", ")}) — ` +
        "session cookies from later plugins would be silently dropped (research §1a)",
    );
  }

  // §1c — session.cookieCache.enabled must be false.
  if (!/cookieCache:\s*\{\s*enabled:\s*false/.test(serverSrc)) {
    failures.push(
      "session.cookieCache.enabled is not false in src/lib/authn/server.ts " +
        "(research §1c — revocation/role-change/ban must take effect immediately)",
    );
  }

  // Secret handling: production must fail loud without BETTER_AUTH_SECRET —
  // an ephemeral per-process secret would silently invalidate all sessions
  // on every restart.
  if (!/NODE_ENV.*production.*BETTER_AUTH_SECRET|BETTER_AUTH_SECRET.*production/s.test(serverSrc)) {
    failures.push(
      "src/lib/authn/server.ts does not fail loud when BETTER_AUTH_SECRET " +
        "is unset in production — an ephemeral secret would silently drop all sessions",
    );
  }
  // Secure cookies must be pinned for production, not derived from a
  // possibly-unset BETTER_AUTH_URL.
  if (!/useSecureCookies/.test(serverSrc)) {
    failures.push(
      "src/lib/authn/server.ts does not pin useSecureCookies for production — " +
        "session cookies could be issued without the Secure flag",
    );
  }

  // §1d/§1f — version floors.
  for (const [pkg, floor, why] of [
    ["better-auth", "1.3.26", "CVE-2025-61928 (research §1d)"],
    ["drizzle-orm", "0.45", "better-auth 1.6.x coupling (research §1f)"],
  ]) {
    try {
      const { version } = JSON.parse(repoFile(root, `node_modules/${pkg}/package.json`));
      if (compareSemver(version, floor) < 0) {
        failures.push(`${pkg}@${version} is below the floor ${floor} — ${why}`);
      }
    } catch {
      failures.push(`could not read installed version of ${pkg}`);
    }
  }

  // §1g — activeOrganizationId must never be trusted for authorization.
  // The only sanctioned use is inside getMyOrgId(), validated against the
  // member table; requireOrgAccess() re-verifies in the DB.
  try {
    const guardRaw = repoFile(root, "src/lib/authn/guard.server.ts");
    // Strip comments so doc mentions of the field name don't count as uses.
    const guard = guardRaw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    const uses = [...guard.matchAll(/activeOrganizationId/g)].length;
    const getMyOrgIdBody = (guard.match(/export async function getMyOrgId\([\s\S]*?\)[\s\S]*?\n\}/) ?? [""])[0];
    const usesInGetMyOrgId = [...getMyOrgIdBody.matchAll(/activeOrganizationId/g)].length;
    if (uses !== usesInGetMyOrgId) {
      failures.push(
        "activeOrganizationId is referenced outside getMyOrgId() in guard.server.ts — " +
          "it must never be trusted for authorization (research §1g)",
      );
    }
    if (!/from member where/.test(getMyOrgIdBody)) {
      failures.push("getMyOrgId() does not validate against the member table (research §1g)");
    }
    // getMyOrgId is an API helper: it must return 401/404 Responses, never
    // throw a page redirect (a redirect thrown inside an API handler → 500).
    if (/throw redirect/.test(getMyOrgIdBody)) {
      failures.push(
        "getMyOrgId() throws a page redirect — API helpers must return " +
          "401/404 Responses instead",
      );
    }
  } catch {
    failures.push("src/lib/authn/guard.server.ts is missing");
  }

  // §1h — impersonation endpoint must be blocked at the handler mount.
  // Public sign-up is blocked the same way (users are admin-created).
  try {
    const mount = repoFile(root, "src/routes/api/auth/$.ts");
    if (!/impersonate/i.test(mount) || !/404/.test(mount)) {
      failures.push(
        "src/routes/api/auth/$.ts does not 404 impersonate paths — " +
          "the admin plugin's unaudited impersonation endpoint must stay disabled (research §1h)",
      );
    }
    if (!/sign-up/i.test(mount)) {
      failures.push(
        "src/routes/api/auth/$.ts does not block public sign-up paths — " +
          "no public sign-up route may be exposed (users are admin-created)",
      );
    }
    // §7a — login throttling must wrap the sign-in endpoint.
    if (!/login-throttle|checkLoginThrottle/.test(mount)) {
      failures.push(
        "src/routes/api/auth/$.ts does not wire login throttling — " +
          "sign-in/email must be wrapped with DB-backed progressive delay + lockout (research §7a)",
      );
    }
    // Guards must match on a normalized (decoded, trailing-slash-stripped)
    // path — matching raw pathname lets %2e/%2f encodings and trailing
    // slashes bypass the impersonate/sign-up/throttle filters.
    if (!/normalizedPath/.test(mount) || !/decodeURIComponent/.test(mount)) {
      failures.push(
        "src/routes/api/auth/$.ts does not normalize request paths before " +
          "matching — encoded/trailing-slash variants can bypass filters",
      );
    }
    // better-auth's own /api/auth/admin/* endpoints must honor the same
    // platform-admin gate (role 404-oracle + 12h freshness) as app routes —
    // otherwise the admin TTL is bypassable via the raw mount.
    if (!/isAdminPath/.test(mount) || !/requirePlatformAdmin/.test(mount)) {
      failures.push(
        "src/routes/api/auth/$.ts does not gate /api/auth/admin/* with " +
          "requirePlatformAdmin — admin-session freshness is bypassable via the raw mount",
      );
    }
  } catch {
    failures.push("src/routes/api/auth/$.ts is missing");
  }

  // §7a — the throttle module must exist with the required thresholds.
  try {
    const throttle = repoFile(root, "src/lib/authn/login-throttle.server.ts");
    if (!/LOCKOUT_AFTER_FAILURES\s*=\s*10/.test(throttle)) {
      failures.push("login-throttle.server.ts: lockout threshold must be 10 failures");
    }
    if (!/WINDOW_MINUTES\s*=\s*15/.test(throttle)) {
      failures.push("login-throttle.server.ts: lockout window must be 15 minutes");
    }
    if (!/login_attempts/.test(throttle)) {
      failures.push("login-throttle.server.ts must record attempts in login_attempts (DB-backed)");
    }
  } catch {
    failures.push("src/lib/authn/login-throttle.server.ts is missing");
  }

  return failures;
}

async function main(argv) {
  // Suite 1 always runs and always fails the command.
  const staticFailures = checkAuthnInvariants();
  for (const f of staticFailures) console.error(`[auth-invariant] FAIL: ${f}`);
  if (staticFailures.length > 0) {
    console.error(`[auth-invariant] ${staticFailures.length} Phase 1 authn invariant(s) violated`);
    process.exit(1);
  }
  console.log("[auth-invariant] Phase 1 authn invariants: ok");

  // Suite 2 needs a live dev server; skip (don't fail) when none answers.
  const devUrlFlag = argv.indexOf("--dev-url");
  const devUrl = devUrlFlag === -1 ? DEFAULT_DEV_URL : argv[devUrlFlag + 1];
  const devAuthEnabled = await probeDevAuthEnabled(devUrl);
  if (devAuthEnabled === null || devAuthEnabled === undefined) {
    console.log("[auth-invariant] no dev server answering — skipping VITE_AUTH_ENABLED comparison");
    process.exit(0);
  }
  const result = compareAuthInvariant({ devAuthEnabled, buildAuthEnabled: buildAuthEnabled() });
  if (result.status === "ok") {
    console.log(result.message);
    process.exit(0);
  }
  console.error(result.message);
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  await main(process.argv.slice(2));
}
