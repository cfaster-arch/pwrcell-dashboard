import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  authEnabledFromEnvValue,
  authInvariantWarnings,
  buildAuthEnabled,
  checkAuthnInvariants,
  compareAuthInvariant,
  compareSemver,
  pluginFactoriesInOrder,
  probeDevAuthEnabled,
} from "./check-auth-invariant.mjs";
import { projectRoot } from "./with-app-env.mjs";

/**
 * The JSON body `/__app-env` would serve. Do not start a real Vite server —
 * `import { createServer } from "vite"` loads rolldown native bindings that
 * SIGSEGV the test worker under qemu-user (amd64 image builds).
 */
function appEnvFetch(env) {
  return async () => ({
    ok: true,
    text: async () => JSON.stringify(env),
  });
}

test("the flag predicate matches src/lib/auth", () => {
  assert.equal(authEnabledFromEnvValue("false"), false);
  assert.equal(authEnabledFromEnvValue("true"), true);
  assert.equal(authEnabledFromEnvValue(undefined), true);
});

test("reads the value a live dev server resolved", async () => {
  assert.equal(
    await probeDevAuthEnabled("http://127.0.0.1:8080", appEnvFetch({ VITE_AUTH_ENABLED: "false" })),
    false,
  );
});

test("a server started without the flag reads as sign-in on", async () => {
  assert.equal(await probeDevAuthEnabled("http://127.0.0.1:8080", appEnvFetch({})), true);
});

test("agreement passes", () => {
  assert.equal(
    compareAuthInvariant({ devAuthEnabled: false, buildAuthEnabled: false }).status,
    "ok",
  );
});

test("divergence fails in either direction", () => {
  const devOn = compareAuthInvariant({ devAuthEnabled: true, buildAuthEnabled: false });
  assert.equal(devOn.status, "diverged");
  assert.match(devOn.message, /dev server has sign-in on but the next build has it off/);
  assert.equal(
    compareAuthInvariant({ devAuthEnabled: false, buildAuthEnabled: true }).status,
    "diverged",
  );
});

test("an unobservable dev server is indeterminate, not agreement", () => {
  assert.equal(
    compareAuthInvariant({ devAuthEnabled: null, buildAuthEnabled: false }).status,
    "indeterminate",
  );
});

test("a dev server that cannot be reached probes as null", async () => {
  const unreachable = () => Promise.reject(new Error("ECONNREFUSED"));
  assert.equal(await probeDevAuthEnabled("http://127.0.0.1:1", unreachable), null);
});

test("a server without the endpoint probes as null, not as agreement", async () => {
  const notFound = async () => ({ ok: false, text: async () => "Not Found" });
  assert.equal(await probeDevAuthEnabled("http://127.0.0.1:8081", notFound), null);
  const html = async () => ({ ok: true, text: async () => "<!doctype html>" });
  assert.equal(await probeDevAuthEnabled("http://127.0.0.1:8081", html), null);
});

test("only a divergence warns the smoke verdict", () => {
  const diverged = compareAuthInvariant({ devAuthEnabled: true, buildAuthEnabled: false });
  assert.deepEqual(authInvariantWarnings(diverged), [diverged.message]);
  for (const result of [
    compareAuthInvariant({ devAuthEnabled: false, buildAuthEnabled: false }),
    compareAuthInvariant({ devAuthEnabled: null, buildAuthEnabled: false }),
  ]) {
    assert.deepEqual(authInvariantWarnings(result), []);
  }
});

test("the build side resolves the template's shipped app-env", () => {
  assert.equal(buildAuthEnabled(projectRoot(), {}), false);
  assert.equal(buildAuthEnabled(projectRoot(), { VITE_AUTH_ENABLED: "true" }), true);
});

test("unreachable dev server no longer fails the command once static checks pass", async () => {
  // Suite 1 (static Phase 1 invariants) is the primary signal now; suite 2
  // (live VITE_AUTH_ENABLED comparison) is skipped with a warning when no dev
  // server answers. A symlinked argv[1] must still resolve the project root
  // so the static checks run against the real repo.
  const link = join(mkdtempSync(join(tmpdir(), "auth-invariant-link-")), "scripts");
  symlinkSync(join(projectRoot(), "scripts"), link);
  const { stdout } = await promisify(execFile)(process.execPath, [
    join(link, "check-auth-invariant.mjs"),
    "--dev-url",
    "http://127.0.0.1:1",
  ]);
  assert.match(stdout, /Phase 1 authn invariants: ok/);
});

test("Phase 1 authn invariants pass on this repo", () => {
  assert.deepEqual(checkAuthnInvariants(projectRoot()), []);
});

test("plugin factory order parsing finds the last plugin", () => {
  const src = `
    plugins: [
      organization(),
      admin({ defaultRole: "user" }),
      apiKey(),
      // must stay last
      tanstackStartCookies(),
    ],
  `;
  assert.deepEqual(pluginFactoriesInOrder(src), [
    "organization",
    "admin",
    "apiKey",
    "tanstackStartCookies",
  ]);
});

test("plugin factory order parsing reports an empty list without a plugins array", () => {
  assert.deepEqual(pluginFactoriesInOrder("export const auth = betterAuth({});"), []);
});

test("semver comparison handles the version floors", () => {
  assert.equal(compareSemver("1.6.33", "1.3.26"), 1);
  assert.equal(compareSemver("1.3.26", "1.3.26"), 0);
  assert.equal(compareSemver("1.2.9", "1.3.26"), -1);
  assert.equal(compareSemver("0.45.3", "0.45"), 1);
  assert.equal(compareSemver("0.44.0", "0.45"), -1);
});
