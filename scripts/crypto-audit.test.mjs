/**
 * Tests for src/lib/authn/crypto.server.ts and src/lib/authn/audit.server.ts.
 *
 * All fixtures — no real secrets, no network, no SSH.
 *
 * Test infrastructure note: audit.server.ts imports getSql() from "@/lib/db"
 * (tsconfig paths), and the real src/lib/db.ts cannot load under plain node
 * (it uses the Vite-only import.meta.glob for migrations). So this file
 * registers a module-resolve hook mapping "@/lib/db" to a hermetic shim: a
 * real, in-memory PGlite Postgres behind the same Sql interface. The modules
 * under test are the real source files; only their DB dependency is
 * substituted, and the audit_log table is created here from the contract DDL
 * (the parallel agent owns the real migration — this test never writes one).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

// ---------------------------------------------------------------------------
// "@/lib/db" shim: in-memory PGlite behind the repo's Sql interface.
// ---------------------------------------------------------------------------
const shimDir = mkdtempSync(join(tmpdir(), "crypto-audit-"));
const shimPath = join(shimDir, "db-shim.mjs");
const shimSource = [
  "import { createRequire } from 'node:module';",
  `const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});`,
  "const { PGlite } = require('@electric-sql/pglite');",
  "let pg = null;",
  "async function getPg() {",
  "  if (!pg) { pg = new PGlite(); await pg.waitReady; }",
  "  return pg;",
  "}",
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
  "  const db = await getPg();",
  "  const sql = toSql(async (text, params) => (await db.query(text, params)).rows);",
  "  sql.transaction = async (fn) => {",
  "    return db.transaction(async (ptx) => {",
  "      const tx = toSql(async (text, params) => (await ptx.query(text, params)).rows);",
  "      return fn(tx);",
  "    });",
  "  };",
  "  return sql;",
  "}",
  "",
].join("\n");
writeFileSync(shimPath, shimSource);

const hookPath = join(shimDir, "alias-hook.mjs");
const hookSource = [
  "export async function resolve(specifier, context, nextResolve) {",
  `  if (specifier === '@/lib/db') return { url: ${JSON.stringify(pathToFileURL(shimPath).href)}, shortCircuit: true };`,
  "  return nextResolve(specifier, context);",
  "}",
  "",
].join("\n");
writeFileSync(hookPath, hookSource);
register(pathToFileURL(hookPath).href);

// The real modules under test (Node 24 strips types on import).
const crypto = await import("../src/lib/authn/crypto.server.ts");
const audit = await import("../src/lib/authn/audit.server.ts");
const shim = await import(pathToFileURL(shimPath).href);
const sql = await shim.getSql();

// Contract DDL (owned by the parallel agent's migration — reproduced here only
// as a test fixture).
const AUDIT_DDL = `create table if not exists audit_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  actor_user_id text,
  actor_type text not null default 'user',
  action text not null,
  target_type text,
  target_id text,
  org_id text,
  ip text,
  user_agent text,
  prev_hash text,
  row_hash text not null
)`;

// Main-process DEK lives in a temp dir so the repo's ./data/ is never touched.
const mainDekDir = mkdtempSync(join(tmpdir(), "dek-main-"));
process.env.DEK_FILE = join(mainDekDir, "dek.key");

// ---------------------------------------------------------------------------
// crypto.server.ts
// ---------------------------------------------------------------------------

test("crypto: string round-trips with AAD binding", () => {
  const enc = crypto.encryptString("fixture-password-123", "org-9");
  assert.equal(enc.keyId, "k1");
  assert.match(enc.payload, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(crypto.decryptString(enc.payload, enc.keyId, "org-9"), "fixture-password-123");

  // Random 96-bit nonce per call: same input -> different payloads, both valid.
  const enc2 = crypto.encryptString("fixture-password-123", "org-9");
  assert.notEqual(enc.payload, enc2.payload);
  assert.equal(crypto.decryptString(enc2.payload, enc2.keyId, "org-9"), "fixture-password-123");

  // Empty string round-trips too.
  const empty = crypto.encryptString("", "org-9");
  assert.equal(crypto.decryptString(empty.payload, empty.keyId, "org-9"), "");
});

test("crypto: decryption fails with wrong AAD (org binding)", () => {
  const enc = crypto.encryptString("fixture-secret", "org-A");
  assert.throws(
    () => crypto.decryptString(enc.payload, enc.keyId, "org-B"),
    /authentication error/,
    "ciphertext from org-A must not decrypt under org-B",
  );
});

test("crypto: decryption fails on tampered payload", () => {
  const enc = crypto.encryptString("fixture-secret", "org-A");
  const raw = Buffer.from(enc.payload, "base64");
  raw[20] ^= 0xff; // flip a ciphertext byte
  assert.throws(
    () => crypto.decryptString(raw.toString("base64"), enc.keyId, "org-A"),
    /authentication error/,
  );
});

test("crypto: decryption fails on unknown keyId", () => {
  const enc = crypto.encryptString("fixture-secret", "org-A");
  assert.throws(() => crypto.decryptString(enc.payload, "k-nope", "org-A"), /unknown DEK id/);
});

test("crypto: decryption fails on malformed payload", () => {
  assert.throws(() => crypto.decryptString("aGVsbG8=", "k1", "org-A"), /too short/);
});

test("crypto: buffer variants round-trip and can be wiped", () => {
  const secret = Buffer.from("buffer-fixture-secret", "utf8");
  const enc = crypto.encryptBuffer(secret, "org-7");
  const out = crypto.decryptBuffer(enc.payload, enc.keyId, "org-7");
  assert.equal(out.toString("utf8"), "buffer-fixture-secret");
  crypto.zeroBuffer(out);
  assert.ok(out.every((b) => b === 0), "zeroBuffer must wipe every byte");
  crypto.zeroBuffer(secret);
});

test("crypto: zeroString is best-effort and documented", () => {
  // JS strings are immutable — this is a no-op guard, it must at least not throw.
  assert.doesNotThrow(() => crypto.zeroString("fixture"));
});

test("crypto: DEK file auto-generates at DEK_FILE with mode 0600 + loud warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dek-gen-"));
  const dekPath = join(dir, "nested", "dek.key"); // nested dir: exercises mkdir -p
  const modUrl = pathToFileURL(join(repoRoot, "src/lib/authn/crypto.server.ts")).href;
  const childSrc = [
    `process.env.DEK_FILE = ${JSON.stringify(dekPath)};`,
    `const m = await import(${JSON.stringify(modUrl)});`,
    `const enc = m.encryptString("child-fixture", "org-child");`,
    `if (m.decryptString(enc.payload, enc.keyId, "org-child") !== "child-fixture") throw new Error("round-trip failed");`,
    `console.log("CHILD_ROUNDTRIP_OK " + enc.keyId);`,
  ].join("\n");
  const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", childSrc], {
    cwd: repoRoot,
  });
  assert.match(child.stderr, /NEW DATA-ENCRYPTION KEY GENERATED/, "must warn loudly on stderr");
  assert.match(child.stderr, /BACK IT UP NOW/);
  assert.match(child.stdout, /CHILD_ROUNDTRIP_OK k1/);

  const st = statSync(dekPath);
  assert.equal(st.mode & 0o777, 0o600, "DEK file must be mode 0600");
  const doc = JSON.parse(readFileSync(dekPath, "utf8"));
  assert.equal(doc.activeKeyId, "k1");
  assert.equal(Buffer.from(doc.keys.k1, "base64").length, 32);

  // A second process reuses the file — no regeneration, no warning.
  const child2 = await execFileAsync(process.execPath, ["--input-type=module", "-e", childSrc], {
    cwd: repoRoot,
  });
  assert.doesNotMatch(child2.stderr, /NEW DATA-ENCRYPTION KEY GENERATED/);
  assert.match(child2.stdout, /CHILD_ROUNDTRIP_OK k1/);
});

test("crypto: corrupt DEK file throws without leaking key material", () => {
  const dir = mkdtempSync(join(tmpdir(), "dek-bad-"));
  const badPath = join(dir, "dek.key");
  writeFileSync(badPath, JSON.stringify({ activeKeyId: "k1", keys: { k1: "dG9vc2hvcnQ=" } }));
  process.env.DEK_FILE = badPath;
  crypto.reloadDek();
  assert.throws(() => crypto.encryptString("x", "org"), /must decode to 32 bytes/);
  // restore the good DEK path for the remaining tests
  process.env.DEK_FILE = join(mainDekDir, "dek.key");
  crypto.reloadDek();
});

// ---------------------------------------------------------------------------
// audit.server.ts
// ---------------------------------------------------------------------------

test("audit: AUDIT_ACTIONS covers the required set", () => {
  assert.deepEqual(audit.AUDIT_ACTIONS, {
    AUTH_LOGIN: "auth.login",
    AUTH_LOGOUT: "auth.logout",
    AUTH_LOGIN_FAILED: "auth.login_failed",
    AUTH_PASSWORD_CHANGED: "auth.password_changed",
    AUTH_PASSWORD_RESET: "auth.password_reset",
    USER_CREATED: "user.created",
    USER_DISABLED: "user.disabled",
    USER_DELETED: "user.deleted",
    USER_ROLE_CHANGED: "user.role_changed",
    ORG_CREATED: "org.created",
    ORG_DELETED: "org.deleted",
    CREDENTIALS_SET: "credentials.set",
    CREDENTIALS_CLEARED: "credentials.cleared",
    KIOSK_PAIRED: "kiosk.paired",
    KIOSK_REVOKED: "kiosk.revoked",
    KIOSK_PAIR_CODE_CREATED: "kiosk.pair_code_created",
    ADMIN_API_CALL: "admin.api_call",
    SESSION_REVOKED: "session.revoked",
    USER_ENABLED: "user.enabled",
    AUDIT_EXPORTED: "audit.exported",
    SECURITY_CROSS_ORG_DENIED: "security.cross_org_denied",
  });
});

test("audit: verifyAuditChain passes on an empty table", async () => {
  await sql.query(AUDIT_DDL);
  await sql.query("delete from audit_log");
  const v = await audit.verifyAuditChain();
  assert.deepEqual(v, { ok: true, checked: 0, reachedGenesis: true });
});

test("audit: events append with a hash chain; verification passes", async () => {
  await sql.query("delete from audit_log");
  await audit.auditEvent({
    action: audit.AUDIT_ACTIONS.AUTH_LOGIN,
    actorUserId: "user-1",
    orgId: "org-1",
    ip: "127.0.0.1",
    userAgent: "test-agent",
  });
  await audit.auditEvent({
    action: audit.AUDIT_ACTIONS.USER_ROLE_CHANGED,
    actorUserId: "user-1",
    targetType: "user",
    targetId: "user-2",
    orgId: "org-1",
  });
  await audit.auditEvent({ action: audit.AUDIT_ACTIONS.AUTH_LOGOUT, actorType: "kiosk" });

  const rows = await sql.query("select * from audit_log order by id asc");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].prev_hash, "GENESIS", "first row chains from GENESIS");
  assert.equal(rows[1].prev_hash, rows[0].row_hash);
  assert.equal(rows[2].prev_hash, rows[1].row_hash);
  assert.equal(rows[0].action, "auth.login");
  assert.equal(rows[0].ip, "127.0.0.1");
  assert.equal(rows[2].actor_type, "kiosk");

  const v = await audit.verifyAuditChain();
  assert.deepEqual(v, { ok: true, checked: 3, reachedGenesis: true });

  // Windowed verification uses the anchor row before the window.
  const w = await audit.verifyAuditChain(2);
  assert.deepEqual(w, { ok: true, checked: 2, reachedGenesis: false });
});

test("audit: verifyAuditChain detects a tampered action field", async () => {
  const rows = await sql.query("select id from audit_log order by id asc");
  const victim = rows[1].id;
  await sql.query("update audit_log set action = 'tampered.action' where id = $1", [victim]);
  const v = await audit.verifyAuditChain();
  assert.equal(v.ok, false);
  assert.equal(v.breakAt, victim);
});

test("audit: verifyAuditChain detects a tampered row_hash", async () => {
  await sql.query("delete from audit_log");
  await audit.auditEvent({ action: audit.AUDIT_ACTIONS.ORG_CREATED, orgId: "org-2" });
  const rows = await sql.query("select id from audit_log order by id asc");
  await sql.query("update audit_log set row_hash = '00' || substring(row_hash from 3) where id = $1", [
    rows[0].id,
  ]);
  const v = await audit.verifyAuditChain();
  assert.equal(v.ok, false);
  assert.equal(v.breakAt, rows[0].id);
});

test("audit: verifyAuditChain detects a broken prev_hash link", async () => {
  await sql.query("delete from audit_log");
  await audit.auditEvent({ action: audit.AUDIT_ACTIONS.KIOSK_PAIRED });
  await audit.auditEvent({ action: audit.AUDIT_ACTIONS.KIOSK_REVOKED });
  const rows = await sql.query("select id from audit_log order by id asc");
  await sql.query("update audit_log set prev_hash = 'forged' where id = $1", [rows[1].id]);
  const v = await audit.verifyAuditChain();
  assert.equal(v.ok, false);
  assert.equal(v.breakAt, rows[1].id);
});

test("audit: auditEvent requires an action", async () => {
  await assert.rejects(audit.auditEvent({ action: "" }), /action is required/);
});
