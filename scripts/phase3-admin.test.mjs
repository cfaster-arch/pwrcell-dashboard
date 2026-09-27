/**
 * Phase 3 (slim) admin-surface tests.
 *
 * Drives the real scripts/admin-user.mjs CLI end to end against a throwaway
 * PGlite dataDir (real migrations 0002–0006 build the schema), then verifies
 * the CLI's audit appends with the REAL src/lib/authn/audit.server.ts
 * verifyAuditChain() — the CLI mirrors the chain format, so the real
 * verifier must accept its rows.
 *
 * All fixtures — no real secrets (fixed test password), no network, no SSH.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

const pgDir = mkdtempSync(join(tmpdir(), "phase3-cli-db-"));
const EMAIL = "phase3-admin@example.com";
const PASSWORD = "4829"; // 4-digit PIN (PIN scheme 2026-09-27)

function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.DATABASE_URL; // must use the throwaway PGlite, never Neon
  env.PGLITE_DIR = pgDir;
  return env;
}

async function cli(args, extraEnv = {}) {
  return execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "scripts/admin-user.mjs", ...args],
    { cwd: repoRoot, env: cliEnv(extraEnv), timeout: 120000 },
  );
}

async function cliFails(args, extraEnv = {}) {
  await assert.rejects(() => cli(args, extraEnv), /./, `expected failure: ${args.join(" ")}`);
}

// ---------------------------------------------------------------------------
// CLI user management
// ---------------------------------------------------------------------------

test("cli: refuses to create without a PIN env var", async () => {
  await cliFails(["create", "--email", EMAIL], { ADMIN_USER_EMAIL: EMAIL });
});

test("cli: refuses a non-PIN credential", async () => {
  await cliFails(["create", "--email", EMAIL], {
    ADMIN_USER_EMAIL: EMAIL,
    ADMIN_USER_PASSWORD: "nope-not-a-pin",
  });
});

test("cli: create + list round-trip", async () => {
  const { stdout } = await cli(["create", "--email", EMAIL, "--role", "admin"], {
    ADMIN_USER_EMAIL: EMAIL,
    ADMIN_USER_PASSWORD: PASSWORD,
  });
  assert.match(stdout, /created phase3-admin@example\.com/);
  assert.match(stdout, /role=admin/);

  const listed = await cli(["list"]);
  assert.match(listed.stdout, /phase3-admin@example\.com/);
  assert.match(listed.stdout, /role=admin/);
  assert.match(listed.stdout, /must-change-password/);
});

test("cli: duplicate create is rejected", async () => {
  await cliFails(["create", "--email", EMAIL], {
    ADMIN_USER_EMAIL: EMAIL,
    ADMIN_USER_PASSWORD: PASSWORD,
  });
});

test("cli: disable bans and revokes sessions; enable unbans", async () => {
  const dis = await cli(["disable", "--email", EMAIL, "--reason", "test ban"]);
  assert.match(dis.stdout, /disabled phase3-admin@example\.com/);
  assert.match(dis.stdout, /BANNED|banned/);

  const listed = await cli(["list"]);
  const line = listed.stdout.split("\n").find((l) => l.includes(EMAIL));
  assert.ok(line && line.includes("BANNED"), `expected BANNED flag, got: ${line}`);

  const en = await cli(["enable", "--email", EMAIL]);
  assert.match(en.stdout, /enabled phase3-admin@example\.com/);
  const listed2 = await cli(["list"]);
  const line2 = listed2.stdout.split("\n").find((l) => l.includes(EMAIL));
  assert.ok(line2 && !line2.includes("BANNED"), `expected no BANNED flag, got: ${line2}`);
});

test("cli: reset-password forces a PIN change", async () => {
  const { stdout } = await cli(["reset-password", "--email", EMAIL], {
    ADMIN_USER_EMAIL: EMAIL,
    ADMIN_USER_PASSWORD: "7294",
  });
  assert.match(stdout, /PIN reset for phase3-admin@example\.com/);
  assert.match(stdout, /must change PIN on next sign-in/);
  const listed = await cli(["list"]);
  const line = listed.stdout.split("\n").find((l) => l.includes(EMAIL));
  assert.ok(line && line.includes("must-change-password"), `got: ${line}`);
});

test("cli: revoke-sessions reports a count", async () => {
  const { stdout } = await cli(["revoke-sessions", "--email", EMAIL]);
  assert.match(stdout, /revoked 0 session\(s\) for phase3-admin@example\.com/);
});

test("cli: unknown email fails cleanly", async () => {
  await cliFails(["disable", "--email", "nobody@example.com"]);
});

test("cli: refuses while another process holds the PGlite data dir", async () => {
  const lockedDir = mkdtempSync(join(tmpdir(), "phase3-cli-locked-"));
  writeFileSync(join(lockedDir, "postmaster.pid"), "-42\n");
  const env = cliEnv();
  env.PGLITE_DIR = lockedDir;
  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        ["--experimental-strip-types", "scripts/admin-user.mjs", "list"],
        { cwd: repoRoot, env, timeout: 60000 },
      ),
    /held by another process/,
    "expected the single-process guard to refuse",
  );
});

// ---------------------------------------------------------------------------
// Audit chain: the CLI's appends must verify with the real audit module.
// ---------------------------------------------------------------------------

test("audit: CLI appends verify with the real hash-chain verifier", async () => {
  const shimDir = mkdtempSync(join(tmpdir(), "phase3-verify-"));
  const shimPath = join(shimDir, "db-shim.mjs");
  writeFileSync(
    shimPath,
    [
      "import { createRequire } from 'node:module';",
      `const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});`,
      "const { PGlite } = require('@electric-sql/pglite');",
      `const pg = new PGlite({ dataDir: ${JSON.stringify(pgDir)} });`,
      "await pg.waitReady;",
      "function toSql(run) {",
      "  const sql = async (strings, ...values) => {",
      "    let text = strings[0];",
      "    for (let i = 0; i < values.length; i++) text += '$' + (i + 1) + strings[i + 1];",
      "    return run(text, values);",
      "  };",
      "  sql.query = (text, params = []) => run(text, params);",
      "  return sql;",
      "}",
      "export async function getSql() {",
      "  return toSql(async (text, params) => (await pg.query(text, params)).rows);",
      "}",
      "",
    ].join("\n"),
  );
  const hookPath = join(shimDir, "alias-hook.mjs");
  writeFileSync(
    hookPath,
    [
      "export async function resolve(specifier, context, nextResolve) {",
      `  if (specifier === '@/lib/db') return { url: ${JSON.stringify(pathToFileURL(shimPath).href)}, shortCircuit: true };`,
      "  return nextResolve(specifier, context);",
      "}",
      "",
    ].join("\n"),
  );
  const checkPath = join(shimDir, "check.mjs");
  writeFileSync(
    checkPath,
    [
      "import { register } from 'node:module';",
      `register(${JSON.stringify(pathToFileURL(hookPath).href)});`,
      "const audit = await import(" + JSON.stringify(join(repoRoot, "src/lib/authn/audit.server.ts")) + ");",
      "const v = await audit.verifyAuditChain(10000);",
      "const { PGlite } = (await import('node:module')).createRequire(" + JSON.stringify(join(repoRoot, "package.json")) + ")('@electric-sql/pglite');",
      "console.log('VERIFY:' + JSON.stringify(v));",
      "console.log('ACTIONS:' + JSON.stringify(Object.values(audit.AUDIT_ACTIONS)));",
      "process.exit(v.ok ? 0 : 1);",
    ].join("\n"),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", checkPath],
    { cwd: repoRoot, env: cliEnv(), timeout: 120000 },
  );
  const verifyLine = stdout.split("\n").find((l) => l.startsWith("VERIFY:"));
  const actionsLine = stdout.split("\n").find((l) => l.startsWith("ACTIONS:"));
  assert.ok(verifyLine, `no VERIFY line in output:\n${stdout}`);
  const v = JSON.parse(verifyLine.slice("VERIFY:".length));
  assert.equal(v.ok, true, `chain broken at row ${v.breakAt}`);
  assert.ok(v.checked >= 5, `expected >=5 CLI audit rows, checked ${v.checked}`);
  const actions = JSON.parse(actionsLine.slice("ACTIONS:".length));
  for (const a of ["user.created", "user.disabled", "user.enabled", "auth.password_reset", "session.revoked", "admin.api_call"]) {
    assert.ok(actions.includes(a), `missing canonical action ${a}`);
  }

  // The CLI's rows must include the new Phase 3 actions.
  const listPath = join(shimDir, "list.mjs");
  writeFileSync(
    listPath,
    [
      "import { register } from 'node:module';",
      `register(${JSON.stringify(pathToFileURL(hookPath).href)});`,
      "const { getSql } = await import('@/lib/db');",
      "const sql = await getSql();",
      "const rows = await sql.query('select action from audit_log order by id');",
      "console.log('ROWS:' + JSON.stringify(rows.map(r => r.action)));",
      "process.exit(0);",
    ].join("\n"),
  );
  const { stdout: listOut } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", listPath],
    { cwd: repoRoot, env: cliEnv(), timeout: 120000 },
  );
  const rowsLine = listOut.split("\n").find((l) => l.startsWith("ROWS:"));
  const logged = JSON.parse(rowsLine.slice("ROWS:".length));
  for (const a of ["user.created", "user.disabled", "user.enabled", "auth.password_reset", "session.revoked"]) {
    assert.ok(logged.includes(a), `CLI never logged ${a}; got ${JSON.stringify(logged)}`);
  }
});
