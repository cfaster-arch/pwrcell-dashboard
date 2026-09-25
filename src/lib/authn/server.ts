/**
 * better-auth server instance (Phase 1 auth core). SERVER-ONLY — never import
 * this from client components; the browser bundle must never see the secret,
 * the drizzle client, or the rate-limit storage.
 *
 * Research amendments folded in (§ = docs/multi-user-auth-research.md):
 *  §1a  tanstackStartCookies() is LAST in plugins[] + boot assertion.
 *  §1c  session.cookieCache.enabled = false (stale revocation bug class gone).
 *  §1d  better-auth >= 1.3.26 floor (CVE-2025-61928) — asserted in
 *        scripts/check-auth-invariant.mjs (`npm run check:auth`).
 *  §1e  schema regenerated from the installed 1.6.33 (see schema.ts header);
 *        never hand-edit auth tables, never reuse migrations/auth/0001_auth.sql.
 *  §1f  drizzle-orm >= 0.45 in lockstep with better-auth 1.6.x.
 *  §1g  session.activeOrganizationId is UI state, NEVER authorization —
 *        see guard.server.ts requireOrgAccess().
 *  §1h  admin impersonation endpoint is disabled at the handler mount
 *        (src/routes/api/auth/$.ts returns 404 for impersonate paths).
 *  §7d  rateLimit uses DB-backed customStorage (kv_store) — memory resets on
 *        restart and would silently lift brute-force protection.
 *  §7e  platform-admin sessions get a 12h TTL (enforced in guard.server.ts).
 */
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { admin } from "better-auth/plugins/admin";
import { apiKey } from "@better-auth/api-key";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getPglite, getSql } from "../db";
import * as authSchema from "./schema";
import { ensureSweepInterval } from "./sweep.server";

/* ------------------------------------------------------------------ */
/* drizzle client, selected by backend (env escape hatch, research §3c) */
/* ------------------------------------------------------------------ */

const globalRef = globalThis as typeof globalThis & {
  __authnPgPool__?: import("pg").Pool;
  __authnDrizzleDb__?: unknown;
};

async function createDrizzleDb() {
  if (globalRef.__authnDrizzleDb__) return globalRef.__authnDrizzleDb__ as never;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  let db: unknown;
  if (databaseUrl) {
    const { Pool } = await import("pg");
    globalRef.__authnPgPool__ ??= new Pool({ connectionString: databaseUrl });
    const { drizzle } = await import("drizzle-orm/node-postgres");
    db = drizzle(globalRef.__authnPgPool__, { schema: authSchema });
  } else {
    const { drizzle } = await import("drizzle-orm/pglite");
    db = drizzle(await getPglite(), { schema: authSchema });
  }
  globalRef.__authnDrizzleDb__ = db;
  return db as never;
}

const db = await createDrizzleDb();

/* ------------------------------------------------------------------ */
/* secret                                                             */
/* ------------------------------------------------------------------ */

const globalSecret = globalThis as typeof globalThis & { __authnSecret__?: string };

function resolveSecret(): string {
  const fromEnv = process.env.BETTER_AUTH_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    // Fail loud: an ephemeral per-process secret would silently invalidate
    // every session on each restart (and across instances). The deploy
    // checklist requires BETTER_AUTH_SECRET in the environment.
    throw new Error("[authn] BETTER_AUTH_SECRET is not set (required in production)");
  }
  // Dev-only fallback: random per process, persisted on globalThis so HMR
  // doesn't rotate sessions out from under the dev server. NEVER in prod.
  globalSecret.__authnSecret__ ??= randomBytes(32).toString("hex");
  console.warn(
    "[authn] BETTER_AUTH_SECRET is not set — using an ephemeral dev secret. " +
      "Sessions will not survive restarts and this MUST NOT be used in production.",
  );
  return globalSecret.__authnSecret__;
}

/* ------------------------------------------------------------------ */
/* DB-backed rate-limit storage (research §7d)                         */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_WINDOW_S = 60;
const KV_PREFIX = "ratelimit:";

const dbRateLimitStorage = {
  async get(key: string) {
    const sql = await getSql();
    const rows = await sql<{ value: string; expires_at: string | null }>`
      select value, expires_at from kv_store where key = ${KV_PREFIX + key}`;
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      await sql`delete from kv_store where key = ${KV_PREFIX + key}`;
      return null;
    }
    try {
      return JSON.parse(row.value) as { key: string; count: number; lastRequest: number };
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown) {
    const sql = await getSql();
    const expiresAt = new Date(Date.now() + RATE_LIMIT_WINDOW_S * 1000).toISOString();
    await sql`
      insert into kv_store (key, value, expires_at)
      values (${KV_PREFIX + key}, ${JSON.stringify(value)}, ${expiresAt})
      on conflict (key) do update
        set value = excluded.value, expires_at = excluded.expires_at`;
  },
};

/* ------------------------------------------------------------------ */
/* the instance                                                       */
/* ------------------------------------------------------------------ */

export const auth = betterAuth({
  secret: resolveSecret(),
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  user: {
    additionalFields: {
      mustChangePassword: { type: "boolean", defaultValue: false, required: false, input: false },
    },
  },
  session: {
    expiresIn: 7 * 24 * 3600,
    updateAge: 86400,
    // §1c: cookieCache OFF is non-negotiable. A cached session would let a
    // revoked/banned/demoted user keep acting until the cache expired.
    cookieCache: { enabled: false },
  },
  rateLimit: {
    enabled: true,
    window: RATE_LIMIT_WINDOW_S,
    max: 10,
    customStorage: dbRateLimitStorage,
  },
  advanced: {
    ipAddress: {
      // nginx (same host) appends to X-Forwarded-For; strip it from the
      // right so rate limiting keys on the real client IP. Without this,
      // better-auth can't resolve an IP and all users share one global
      // sign-in bucket (3 per 10s) — one user's typos would 429 everyone.
      trustedProxies: ["127.0.0.1/32", "::1/128"],
    },
    // Don't rely on BETTER_AUTH_URL being set to get Secure cookies:
    // pin it for production explicitly (dev stays http-friendly).
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  plugins: [
    organization(),
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    // Kiosk device keys; detailed scope config is Phase 4 — enabled here only.
    apiKey(),
    // §1a: MUST be last — it forwards Set-Cookie for every plugin before it.
    tanstackStartCookies(),
  ],
});

/* ------------------------------------------------------------------ */
/* boot assertions (research §1a/§1c) — fail loud, never silently       */
/* ------------------------------------------------------------------ */

function assertAuthInvariants() {
  const problems: string[] = [];
  const plugins = (auth.options.plugins ?? []) as { id?: string }[];
  const lastId = plugins[plugins.length - 1]?.id;
  if (lastId !== "tanstack-start-cookies") {
    problems.push(
      `tanstackStartCookies() is not last in plugins[] (last=${lastId ?? "none"}). ` +
        "Sessions would be silently dropped.",
    );
  }
  const cookieCacheEnabled = (auth.options.session as { cookieCache?: { enabled?: boolean } } | undefined)
    ?.cookieCache?.enabled;
  if (cookieCacheEnabled !== false) {
    problems.push(
      "session.cookieCache.enabled must be false — revocation/role-change/ban must take effect immediately.",
    );
  }
  if (problems.length === 0) return;
  const message = `[authn] invariant violation:\n- ${problems.join("\n- ")}`;
  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
  console.error(message);
}

assertAuthInvariants();

// Session/table hygiene sweep (expired sessions, kv rows, pairing codes,
// old login attempts). Guarded server-only: this module never ships to the
// browser, but the check keeps the interval out of any client bundle path.
if (typeof window === "undefined") {
  ensureSweepInterval();
}

export type Auth = typeof auth;
