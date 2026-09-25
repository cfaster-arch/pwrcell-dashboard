#!/usr/bin/env node --experimental-strip-types
/**
 * Seed the default organization + platform admin (Phase 1).
 *
 * Idempotent: safe to re-run. Run manually at deploy AND locally:
 *   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='...' node --experimental-strip-types scripts/seed-default-org.mjs
 *
 * What it does:
 *  1. Creates (or updates) the platform admin user: role='admin',
 *     mustChangePassword=true (forced change on first sign-in), emailVerified=true.
 *     The password is hashed with better-auth's scrypt (better-auth/crypto) —
 *     never stored or logged in plaintext.
 *  2. Creates organization id='org_default', name='Default Site',
 *     slug='default-site', timezone='America/Los_Angeles'.
 *  3. Adds the admin as member with role='owner'.
 *  4. Backfills energy_samples.organization_id and alerts.organization_id to
 *     'org_default' where null (0005 already defaults new energy rows).
 *  5. Adds the FK constraints energy_samples.organization_id ->
 *     organization(id) ON DELETE CASCADE and alerts.organization_id ->
 *     organization(id) ON DELETE CASCADE (created here, not in the migration,
 *     because the org row must exist first).
 *
 * Credentials come ONLY from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD env vars.
 * There are no defaults — the script refuses to run without them.
 */
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { closeDb, getSql } from "../src/lib/db.ts";

const email = process.env.SEED_ADMIN_EMAIL?.trim();
const password = process.env.SEED_ADMIN_PASSWORD ?? "";
if (!email || !password) {
  console.error(
    "[seed] SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must both be set in the environment.\n" +
      "[seed] Refusing to run with defaults — no admin account was created.",
  );
  process.exit(1);
}
if (password.length < 12) {
  console.error("[seed] SEED_ADMIN_PASSWORD must be at least 12 characters.");
  process.exit(1);
}

const ORG_ID = "org_default";

async function main() {
  const sql = await getSql();

  // --- 1. admin user -------------------------------------------------
  // Email match is case-insensitive: better-auth normalizes to lowercase,
  // so a re-run with different casing must find the same row, not create
  // a duplicate.
  const existing = await sql`select id from "user" where lower(email) = lower(${email})`;
  let userId;
  const passwordHash = await hashPassword(password);
  if (existing.length > 0) {
    userId = existing[0].id;
    await sql`update "user" set role = 'admin', must_change_password = true, email_verified = true, updated_at = now() where id = ${userId}`;
    const acct = await sql`select id from account where user_id = ${userId} and provider_id = 'credential'`;
    if (acct.length > 0) {
      await sql`update account set password = ${passwordHash}, updated_at = now() where id = ${acct[0].id}`;
    } else {
      await sql`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
        values (${randomUUID()}, ${userId}, 'credential', ${userId}, ${passwordHash}, now(), now())`;
    }
    console.log(`[seed] admin user already existed — role/password refreshed for ${email}`);
  } else {
    userId = randomUUID();
    const name = email.split("@")[0] || "Admin";
    await sql`insert into "user" (id, name, email, email_verified, created_at, updated_at, role, banned, must_change_password)
      values (${userId}, ${name}, ${email.toLowerCase()}, true, now(), now(), 'admin', false, true)`;
    await sql`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
      values (${randomUUID()}, ${userId}, 'credential', ${userId}, ${passwordHash}, now(), now())`;
    console.log(`[seed] created admin user ${email} (must change password on first sign-in)`);
  }

  // --- 2. default organization ----------------------------------------
  await sql`insert into organization (id, name, slug, created_at, timezone)
    values (${ORG_ID}, 'Default Site', 'default-site', now(), 'America/Los_Angeles')
    on conflict (id) do update set timezone = excluded.timezone`;
  console.log(`[seed] organization '${ORG_ID}' ensured`);

  // --- 3. membership ---------------------------------------------------
  // Select-then-insert (member has no unique constraint on (org, user), so
  // on-conflict can't target it): re-runs must NOT churn the membership row
  // id, so only insert when no membership exists yet.
  const existingMember = await sql`
    select id, role from member
    where organization_id = ${ORG_ID} and user_id = ${userId}
    order by created_at asc, id asc`;
  if (existingMember.length === 0) {
    await sql`insert into member (id, organization_id, user_id, role, created_at)
      values (${randomUUID()}, ${ORG_ID}, ${userId}, 'owner', now())`;
  } else {
    if (existingMember[0].role !== "owner") {
      await sql`update member set role = 'owner' where id = ${existingMember[0].id}`;
    }
    // Prune any stray duplicates deterministically (keep the oldest row).
    for (const d of existingMember.slice(1)) {
      await sql`delete from member where id = ${d.id}`;
    }
  }
  console.log(`[seed] admin is owner of '${ORG_ID}'`);

  // --- 4. backfill ------------------------------------------------------
  // The PGlite postgres.js driver returns a bare array with no .count, so
  // use RETURNING to get an honest affected-row count for the log.
  const e = await sql`update energy_samples set organization_id = ${ORG_ID} where organization_id is null returning 1`;
  const a = await sql`update alerts set organization_id = ${ORG_ID} where organization_id is null returning 1`;
  console.log(`[seed] backfilled ${e.length} energy rows, ${a.length} alerts into '${ORG_ID}'`);

  // --- 5. FK constraints (only after the org row exists) -----------------
  // Match on conrelid too — a same-named constraint on another table must
  // not make us skip the alter.
  await sql`do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'fk_energy_samples_org' and conrelid = 'energy_samples'::regclass) then
      alter table energy_samples add constraint fk_energy_samples_org
        foreign key (organization_id) references organization(id) on delete cascade;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'fk_alerts_org' and conrelid = 'alerts'::regclass) then
      alter table alerts add constraint fk_alerts_org
        foreign key (organization_id) references organization(id) on delete cascade;
    end if;
  end $$;`;
  console.log("[seed] FK constraints fk_energy_samples_org / fk_alerts_org ensured");

  console.log("");
  console.log("[seed] NEXT STEPS");
  console.log("  1. Start the app and open /signin — sign in as the admin.");
  console.log("  2. You will be sent to /account/password to set your own password");
  console.log("     (the seeded one is temporary).");
  console.log("  3. Production: set BETTER_AUTH_SECRET to a long random value in the");
  console.log("     service environment (never in the repo).");
  console.log("  4. Production: remove nginx Basic Auth — app auth replaces it, never stacks.");
}

await main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Release the PGlite handle so this standalone process exits promptly
    // and never holds the dataDir lock when the dev server starts next.
    try {
      await closeDb();
    } catch {
      /* best effort */
    }
  });
