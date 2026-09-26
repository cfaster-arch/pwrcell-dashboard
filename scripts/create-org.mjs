#!/usr/bin/env node --experimental-strip-types
/**
 * Create an organization and add a user as its owner (one-shot admin tool).
 *
 *   ORG_ID=org_x ORG_NAME="Acme" ORG_SLUG=acme MEMBER_EMAIL=a@b.c \
 *     node --experimental-strip-types scripts/create-org.mjs
 *
 * Idempotent: safe to re-run. The member is added as 'owner'; re-runs upgrade
 * an existing membership to owner and prune duplicates (same pattern as
 * scripts/seed-default-org.mjs).
 *
 * PGlite constraint: run with the dashboard service STOPPED (the embedded
 * database cannot be opened by two processes at once).
 */
import { randomUUID } from "node:crypto";
import { closeDb, getSql } from "../src/lib/db.ts";

const ORG_ID = process.env.ORG_ID?.trim();
const ORG_NAME = process.env.ORG_NAME?.trim();
const ORG_SLUG = process.env.ORG_SLUG?.trim();
const MEMBER_EMAIL = process.env.MEMBER_EMAIL?.trim().toLowerCase();
if (!ORG_ID || !ORG_NAME || !ORG_SLUG || !MEMBER_EMAIL) {
  console.error("[create-org] ORG_ID, ORG_NAME, ORG_SLUG and MEMBER_EMAIL are all required");
  process.exit(1);
}

let sql;
try {
  sql = await getSql();

  await sql`insert into organization (id, name, slug, created_at, timezone)
    values (${ORG_ID}, ${ORG_NAME}, ${ORG_SLUG}, now(), 'America/Los_Angeles')
    on conflict (id) do update set name = excluded.name, slug = excluded.slug`;
  console.log(`[create-org] organization '${ORG_ID}' ensured`);

  const users = await sql`select id from "user" where lower(email) = lower(${MEMBER_EMAIL})`;
  if (users.length === 0) {
    console.error(`[create-org] no such user: ${MEMBER_EMAIL}`);
    process.exit(1);
  }
  const userId = users[0].id;

  const existing = await sql`
    select id, role from member
    where organization_id = ${ORG_ID} and user_id = ${userId}
    order by created_at asc, id asc`;
  if (existing.length === 0) {
    await sql`insert into member (id, organization_id, user_id, role, created_at)
      values (${randomUUID()}, ${ORG_ID}, ${userId}, 'owner', now())`;
  } else {
    if (existing[0].role !== "owner") {
      await sql`update member set role = 'owner' where id = ${existing[0].id}`;
    }
    for (const d of existing.slice(1)) {
      await sql`delete from member where id = ${d.id}`;
    }
  }
  console.log(`[create-org] ${MEMBER_EMAIL} is owner of '${ORG_ID}'`);
} finally {
  await closeDb(sql);
}
