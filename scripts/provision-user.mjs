#!/usr/bin/env node
/**
 * Provision a dashboard user + org + owner membership directly in PGlite.
 *
 * Why this exists: the dashboard is a closed system — Google sign-in and
 * email signup both refuse unknown emails, and there is no self-service
 * provisioning. The FIRST human account has to be created out-of-band.
 * After this runs, the user signs in with "Sign in with Google" (their
 * verified Google email matches the pre-provisioned row, so better-auth's
 * trusted-provider account linking signs them straight in — the
 * user.create gate never fires because the user already exists).
 *
 * Usage (on the VPS, with the app STOPPED — PGlite dataDir is single-writer):
 *   cd /opt/pwrcell && node provision-user.mjs "you@example.com" ["Org Name"] [password] [user_role] [member_role]
 *
 * With a password: enables email+password login and forces a password change
 * on first sign-in. Without: Google-only (verified email must match).
 * Roles default to platform "user" + org "member".
 *
 * Env:
 *   PGLITE_DIR  — defaults to /opt/pwrcell/data/pglite
 *
 * Idempotent: re-running for an existing email only repairs missing
 * org/membership rows. Prints PROVISION_OK on success.
 */
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";

const email = (process.argv[2] || process.env.PROVISION_EMAIL || "").trim().toLowerCase();
const orgName = (process.argv[3] || process.env.PROVISION_ORG || "Strider Built").trim();
const password = (process.argv[4] || process.env.PROVISION_PASSWORD || "").trim(); // optional: enables email+password login
const userRole = (process.argv[5] || process.env.PROVISION_USER_ROLE || "user").trim(); // platform role: user|admin
const memberRole = (process.argv[6] || process.env.PROVISION_MEMBER_ROLE || "member").trim(); // org role: member|admin|owner
if (!email || !email.includes("@")) {
  console.error("provision-user: need an email address (argv[1] or PROVISION_EMAIL)");
  process.exit(2);
}
const orgSlug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org";

const dir = process.env.PGLITE_DIR?.trim() || "/opt/pwrcell/data/pglite";
const pg = new PGlite({ dataDir: dir });
await pg.waitReady;

try {
  // Fail loud if the auth tables were never migrated.
  const tables = await pg.query(
    `select tablename from pg_tables where schemaname='public' and tablename in ('user','organization','member')`
  );
  const have = new Set(tables.rows.map((r) => r.tablename));
  for (const t of ["user", "organization", "member"]) {
    if (!have.has(t)) {
      console.error(`provision-user: table "${t}" missing — run the app once so migrations apply, then retry.`);
      process.exit(3);
    }
  }

  // 1. Org (one default org; reuse by slug if it exists).
  let org = (await pg.query(`select id, slug from organization where slug = $1 limit 1`, [orgSlug])).rows[0];
  if (!org) {
    const id = randomUUID();
    await pg.query(`insert into organization (id, name, slug, created_at) values ($1, $2, $3, now())`, [id, orgName, orgSlug]);
    org = { id, slug: orgSlug };
    console.log(`provision-user: created org "${orgName}" (${orgSlug})`);
  } else {
    console.log(`provision-user: org "${org.slug}" already exists`);
  }

  // 2. User. emailVerified=true so Google linking trusts it.
  let user = (await pg.query(`select id, email, role from "user" where lower(email) = lower($1) limit 1`, [email])).rows[0];
  if (!user) {
    const id = randomUUID();
    const name = email.split("@")[0];
    await pg.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at, role, must_change_password)
       values ($1, $2, $3, true, now(), now(), $4, $5)`,
      [id, name, email, userRole, Boolean(password)]
    );
    user = { id, email, role: userRole };
    console.log(`provision-user: created user ${email} (platform role: ${userRole})`);
  } else {
    if (userRole === "admin" && user.role !== "admin") {
      await pg.query(`update "user" set role = 'admin', updated_at = now() where id = $1`, [user.id]);
      console.log(`provision-user: promoted ${email} to platform admin`);
    } else {
      console.log(`provision-user: user ${email} already exists (${user.role})`);
    }
    await pg.query(
      `update "user" set email_verified = true, must_change_password = $2, updated_at = now() where id = $1`,
      [user.id, Boolean(password)]
    );
  }

  // 2b. Credential account (email+password login). must_change_password forces
  // the user to pick their own password on first sign-in.
  if (password) {
    const { hashPassword } = await import("better-auth/crypto");
    const hash = await hashPassword(password);
    const existing = (await pg.query(
      `select id from account where provider_id = 'credential' and user_id = $1 limit 1`, [user.id]
    )).rows[0];
    if (existing) {
      await pg.query(`update account set password = $2, updated_at = now() where id = $1`, [existing.id, hash]);
      console.log(`provision-user: reset password for ${email} (change required on next login)`);
    } else {
      await pg.query(
        `insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         values ($1, $2, 'credential', $3, $4, now(), now())`,
        [randomUUID(), user.id, user.id, hash]
      );
      console.log(`provision-user: enabled email+password login for ${email} (change required on first login)`);
    }
  }

  // 3. Membership.
  const mem = (await pg.query(
    `select id, role from member where organization_id = $1 and user_id = $2 limit 1`, [org.id, user.id]
  )).rows[0];
  if (!mem) {
    await pg.query(
      `insert into member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())`,
      [randomUUID(), org.id, user.id, memberRole]
    );
    console.log(`provision-user: ${email} is now ${memberRole} of "${org.slug}"`);
  } else {
    console.log(`provision-user: membership already exists (${mem.role})`);
  }

  console.log("PROVISION_OK");
} finally {
  await pg.close();
}
