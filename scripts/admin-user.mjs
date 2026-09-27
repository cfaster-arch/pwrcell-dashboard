#!/usr/bin/env node --experimental-strip-types
/**
 * Minimal admin user management (Phase 3 slim — no admin UI).
 *
 *   node --experimental-strip-types scripts/admin-user.mjs list
 *   node --experimental-strip-types scripts/admin-user.mjs create --email a@b.c [--role admin|user] [--org ORG_ID --org-role owner|admin|member]
 *   node --experimental-strip-types scripts/admin-user.mjs disable --email a@b.c [--reason "..."]
 *   node --experimental-strip-types scripts/admin-user.mjs enable --email a@b.c
 *   node --experimental-strip-types scripts/admin-user.mjs reset-password --email a@b.c
 *   node --experimental-strip-types scripts/admin-user.mjs revoke-sessions --email a@b.c [--reason "..."]
 *
 * Secrets come ONLY from the environment — never argv, never logged:
 *   ADMIN_USER_EMAIL     (or --email flag; env wins if both are set)
 *   ADMIN_USER_PASSWORD  (required for create and reset-password; 4-digit PIN, not trivial)
 *
 * Every mutating command appends to audit_log with actor_type='cli', using
 * the same hash-chain format as src/lib/authn/audit.server.ts (canonical
 * field order ts, actor_type, actor_user_id, action, target_type, target_id,
 * org_id, ip, user_agent; row_hash = sha256hex(prev_hash + '|' + canonical)).
 * Disabling / resetting a password / revoking sessions also deletes the
 * user's session rows — with cookieCache disabled this takes effect on the
 * very next request.
 *
 * OPERATIONAL CONSTRAINT (PGlite path): PGlite is an embedded database — one
 * process may hold the data directory. The CLI refuses to run while the
 * dashboard app holds it (postmaster.pid present); stop the app first, or
 * pass --force if the lock is stale after a crash. Verified 2026-09-25: two
 * concurrent PGlite backends on one dataDir diverge (no coherent view).
 * With DATABASE_URL set (Neon/real Postgres) this guard is skipped —
 * concurrent use is safe there and the audit advisory lock serializes
 * appends across processes.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { closeDb, getSql } from "../src/lib/db.ts";

const AUDIT_GENESIS_HASH = "GENESIS";
const CANON_FIELDS = [
  "ts",
  "actor_type",
  "actor_user_id",
  "action",
  "target_type",
  "target_id",
  "org_id",
  "ip",
  "user_agent",
];

const ACTIONS = {
  USER_CREATED: "user.created",
  USER_DISABLED: "user.disabled",
  USER_ENABLED: "user.enabled",
  AUTH_PASSWORD_RESET: "auth.password_reset",
  SESSION_REVOKED: "session.revoked",
};

class CliError extends Error {}

/** Throw (don't process.exit): main() catches this, closes the DB so the
 * PGlite postmaster.pid lock is released, then exits nonzero. */
function fail(msg) {
  throw new CliError(msg);
}

// PIN scheme (2026-09-27): the credential is a 4-digit PIN, not a password.
function checkPin(pin, envName) {
  if (!/^\d{4}$/.test(pin)) fail(`${envName} must be exactly 4 digits`);
  if (/^(\d)\1{3}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin))
    fail(`${envName} is trivially guessable (repeated digit or sequence)`);
}

/** Minimal --flag value parser: --flag value, --flag=value, boolean --flag. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

function canonicalJson(fields) {
  const ordered = {};
  for (const key of CANON_FIELDS) ordered[key] = fields[key] ?? null;
  return JSON.stringify(ordered);
}

/** Mirror of the audit server's chain append — same format, so verification holds.
 *
 * Takes the same pg_advisory_xact_lock('audit_log_append') the server takes
 * (src/lib/authn/audit.server.ts): the CLI is a separate process against the
 * same database, and without the lock a concurrent server append could read
 * the same tail row_hash and fork the chain. The in-process mutex in the
 * server does NOT protect against this process.
 */
const AUDIT_APPEND_LOCK = `select pg_advisory_xact_lock(hashtext('audit_log_append'))`;

async function auditCli(sql, action, targetId, targetType = "user") {
  const fields = {
    ts: new Date().toISOString(),
    actor_type: "cli",
    actor_user_id: null,
    action,
    target_type: targetType,
    target_id: targetId,
    org_id: null,
    ip: null,
    user_agent: null,
  };
  const canonical = canonicalJson(fields);
  await sql.transaction(async (tx) => {
    await tx.query(AUDIT_APPEND_LOCK);
    const prev = await tx.query("select row_hash from audit_log order by id desc limit 1");
    const prevHash = prev[0]?.row_hash ?? AUDIT_GENESIS_HASH;
    const rowHash = createHash("sha256").update(prevHash + "|" + canonical, "utf8").digest("hex");
    await tx.query(
      `insert into audit_log
         (ts, actor_user_id, actor_type, action, target_type, target_id, org_id, ip, user_agent, prev_hash, row_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        fields.ts,
        fields.actor_user_id,
        fields.actor_type,
        fields.action,
        fields.target_type,
        fields.target_id,
        fields.org_id,
        fields.ip,
        fields.user_agent,
        prevHash,
        rowHash,
      ],
    );
  });
}

async function findUser(sql, email) {
  const rows = await sql`select id, email, role, banned, must_change_password
    from "user" where lower(email) = lower(${email})`;
  return rows[0] ?? null;
}

/** Delete all session rows for a user; returns the count. */
async function revokeSessions(sql, userId) {
  const deleted = await sql`delete from session where user_id = ${userId} returning id`;
  return deleted.length;
}

async function cmdList(sql) {
  const rows = await sql`select id, email, role, banned, must_change_password, created_at
    from "user" order by created_at asc`;
  if (rows.length === 0) {
    console.log("[admin-user] no users");
    return;
  }
  for (const u of rows) {
    const flags = [
      u.role ? `role=${u.role}` : null,
      u.banned ? "BANNED" : null,
      u.must_change_password ? "must-change-password" : null,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`[admin-user] ${u.email}  ${u.id}${flags ? "  [" + flags + "]" : ""}`);
  }
}

async function cmdCreate(sql, args) {
  const email = (process.env.ADMIN_USER_EMAIL?.trim() || args.email || "").toLowerCase();
  const password = process.env.ADMIN_USER_PASSWORD ?? "";
  if (!email || !email.includes("@")) fail("email is required (--email or ADMIN_USER_EMAIL)");
  if (!password) fail("ADMIN_USER_PASSWORD must be set in the environment (never argv)");
  checkPin(password, "ADMIN_USER_PASSWORD");
  const role = (args.role || "user").toLowerCase();
  if (role !== "admin" && role !== "user") fail("--role must be admin or user");

  if (await findUser(sql, email)) fail(`user already exists: ${email}`);

  const userId = randomUUID();
  const name = email.split("@")[0] || "User";
  await sql`insert into "user" (id, name, email, email_verified, created_at, updated_at, role, banned, must_change_password)
    values (${userId}, ${name}, ${email}, true, now(), now(), ${role}, false, true)`;
  await sql`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
    values (${randomUUID()}, ${userId}, 'credential', ${userId}, ${await hashPassword(password)}, now(), now())`;

  if (args.org) {
    const orgId = String(args.org).slice(0, 128);
    const orgs = await sql`select id from organization where id = ${orgId}`;
    if (orgs.length === 0) fail(`no such organization: ${orgId}`);
    const orgRole = (args["org-role"] || "member").toLowerCase();
    if (!["owner", "admin", "member"].includes(orgRole)) fail("--org-role must be owner, admin, or member");
    await sql`insert into member (id, organization_id, user_id, role, created_at)
      values (${randomUUID()}, ${orgId}, ${userId}, ${orgRole}, now())`;
    console.log(`[admin-user] added to org ${orgId} as ${orgRole}`);
  }

  await auditCli(sql, ACTIONS.USER_CREATED, userId);
  console.log(`[admin-user] created ${email} (role=${role}, must change PIN on first sign-in)`);
}

async function cmdDisable(sql, args) {
  const email = (process.env.ADMIN_USER_EMAIL?.trim() || args.email || "").toLowerCase();
  if (!email) fail("email is required (--email or ADMIN_USER_EMAIL)");
  const user = await findUser(sql, email);
  if (!user) fail(`no such user: ${email}`);
  const reason = typeof args.reason === "string" ? args.reason.slice(0, 280) : null;
  await sql`update "user" set banned = true, ban_reason = ${reason}, updated_at = now() where id = ${user.id}`;
  const n = await revokeSessions(sql, user.id);
  await auditCli(sql, ACTIONS.USER_DISABLED, user.id);
  console.log(`[admin-user] disabled ${email} (banned, ${n} session(s) revoked)`);
}

async function cmdEnable(sql, args) {
  const email = (process.env.ADMIN_USER_EMAIL?.trim() || args.email || "").toLowerCase();
  if (!email) fail("email is required (--email or ADMIN_USER_EMAIL)");
  const user = await findUser(sql, email);
  if (!user) fail(`no such user: ${email}`);
  await sql`update "user" set banned = false, ban_reason = null, updated_at = now() where id = ${user.id}`;
  await auditCli(sql, ACTIONS.USER_ENABLED, user.id);
  console.log(`[admin-user] enabled ${email}`);
}

async function cmdResetPassword(sql, args) {
  const email = (process.env.ADMIN_USER_EMAIL?.trim() || args.email || "").toLowerCase();
  const password = process.env.ADMIN_USER_PASSWORD ?? "";
  if (!email) fail("email is required (--email or ADMIN_USER_EMAIL)");
  if (!password) fail("ADMIN_USER_PASSWORD must be set in the environment (never argv)");
  checkPin(password, "ADMIN_USER_PASSWORD");
  const user = await findUser(sql, email);
  if (!user) fail(`no such user: ${email}`);
  const acct = await sql`select id from account where user_id = ${user.id} and provider_id = 'credential'`;
  if (acct.length === 0) fail(`user ${email} has no credential account — cannot reset password`);
  await sql`update account set password = ${await hashPassword(password)}, updated_at = now() where id = ${acct[0].id}`;
  await sql`update "user" set must_change_password = true, updated_at = now() where id = ${user.id}`;
  const n = await revokeSessions(sql, user.id);
  await auditCli(sql, ACTIONS.AUTH_PASSWORD_RESET, user.id);
  console.log(`[admin-user] PIN reset for ${email} (${n} session(s) revoked, must change PIN on next sign-in)`);
}

async function cmdRevokeSessions(sql, args) {
  const email = (process.env.ADMIN_USER_EMAIL?.trim() || args.email || "").toLowerCase();
  if (!email) fail("email is required (--email or ADMIN_USER_EMAIL)");
  const user = await findUser(sql, email);
  if (!user) fail(`no such user: ${email}`);
  const n = await revokeSessions(sql, user.id);
  await auditCli(sql, ACTIONS.SESSION_REVOKED, user.id);
  console.log(`[admin-user] revoked ${n} session(s) for ${email}`);
}

/**
 * PGlite single-process guard (see header). Must run BEFORE getSql() opens
 * the embedded database: a second backend on the same dataDir gets an
 * incoherent view of the data. Skipped on the Neon path (DATABASE_URL), where
 * concurrent processes are safe.
 */
function guardPgliteSingleProcess(args) {
  if (process.env.DATABASE_URL?.trim()) return;
  const force = args.force === true || args.force === "1" || args.force === "true";
  if (force) {
    console.error("[admin-user] warning: --force given; proceeding as if no other process holds the PGlite data dir");
    return;
  }
  const dir = process.env.PGLITE_DIR?.trim() || "./data/pglite";
  if (existsSync(join(dir, "postmaster.pid"))) {
    fail(
      `PGlite data dir "${dir}" is held by another process (postmaster.pid exists).\n` +
        `Stop the dashboard app first — the CLI and the app cannot open the embedded database at the same time — then re-run.\n` +
        `If the app is definitely stopped and this is a stale lock from a crash, re-run with --force.`,
    );
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  let sql;
  try {
    guardPgliteSingleProcess(args);
    sql = await getSql();
    switch (cmd) {
      case "list":
        await cmdList(sql);
        break;
      case "create":
        await cmdCreate(sql, args);
        break;
      case "disable":
        await cmdDisable(sql, args);
        break;
      case "enable":
        await cmdEnable(sql, args);
        break;
      case "reset-password":
        await cmdResetPassword(sql, args);
        break;
      case "revoke-sessions":
        await cmdRevokeSessions(sql, args);
        break;
      default:
        fail("usage: admin-user.mjs <list|create|disable|enable|reset-password|revoke-sessions> [--email E] [--role admin|user] [--org ID] [--org-role R] [--reason R] [--force]");
    }
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`[admin-user] ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    await closeDb().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[admin-user] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
