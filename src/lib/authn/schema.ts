/**
 * Drizzle schema for multi-user auth (Phase 1).
 *
 * This file is the SOURCE OF TRUTH for the better-auth drizzle adapter at
 * runtime (passed to `drizzleAdapter` in `server.ts`). The plain-SQL
 * migrations in `migrations/0003_auth_core.sql` / `0004_auth_tenant.sql` /
 * `0005_energy_org.sql` must create tables/columns matching these names.
 *
 * Column list was derived from `getAuthTables()` on the installed
 * better-auth 1.6.33 (+ @better-auth/api-key 1.6.x) with the exact plugin set
 * used in `server.ts` (organization, admin, apiKey). If better-auth is ever
 * upgraded, regenerate the schema + a new migration (research §1e) and run
 * the sign-in smoke test.
 */
import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/* ------------------------------------------------------------------ */
/* better-auth core tables                                            */
/* ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  // admin plugin fields
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  // Phase 1: force password change on first login for admin-created users
  mustChangePassword: boolean("must_change_password").notNull().default(false),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
  impersonatedBy: text("impersonated_by"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

/* ------------------------------------------------------------------ */
/* organization plugin tables                                         */
/* ------------------------------------------------------------------ */

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: ts("created_at").notNull(),
  metadata: text("metadata"),
  // Phase 2 amendment (research §8c): per-org timezone for history bucketing.
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  role: text("role").notNull().default("member"),
  createdAt: ts("created_at").notNull(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id),
});

/* ------------------------------------------------------------------ */
/* apiKey plugin table (@better-auth/api-key)                         */
/* ------------------------------------------------------------------ */

export const apikey = pgTable("apikey", {
  id: text("id").primaryKey(),
  configId: text("config_id").notNull().default("default"),
  name: text("name"),
  start: text("start"),
  referenceId: text("reference_id").notNull(),
  prefix: text("prefix"),
  key: text("key").notNull(),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: ts("last_refill_at"),
  enabled: boolean("enabled").default(true),
  rateLimitEnabled: boolean("rate_limit_enabled").default(true),
  rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
  rateLimitMax: integer("rate_limit_max").default(10),
  requestCount: integer("request_count").default(0),
  remaining: integer("remaining"),
  lastRequest: ts("last_request"),
  expiresAt: ts("expires_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  permissions: text("permissions"),
  metadata: text("metadata"),
});

/* ------------------------------------------------------------------ */
/* App tables (Phase 1+: rate limiting, audit, per-org config, kiosk)  */
/* ------------------------------------------------------------------ */

/** DB-backed KV for the better-auth rateLimit customStorage (research §7d). */
export const kvStore = pgTable("kv_store", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at"),
});

/** Append-only, hash-chained audit log (research §7a). Never UPDATE/DELETE. */
export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  ts: ts("ts").notNull().defaultNow(),
  actorUserId: text("actor_user_id"),
  actorType: text("actor_type").notNull().default("user"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  orgId: text("org_id"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  prevHash: text("prev_hash"),
  rowHash: text("row_hash").notNull(),
});

/** Per-org PWRview credentials, encrypted at rest (Phase 2 moves these here). */
export const orgCredentials = pgTable("org_credentials", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  passwordEnc: text("password_enc").notNull(),
  keyId: text("key_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Per-org Ring refresh tokens, encrypted at rest (same DEK scheme). */
export const orgRingTokens = pgTable("org_ring_tokens", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  keyId: text("key_id").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Per-org display/kiosk settings (replaces global display-settings.json). */
export const orgSettings = pgTable("org_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  settings: jsonb("settings").notNull().default({}),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Kiosk tablets bound to one org via an apiKey row (Phase 4 pairing). */
export const kioskDevices = pgTable("kiosk_devices", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull().default(""),
  apiKeyId: text("api_key_id")
    .notNull()
    .references(() => apikey.id, { onDelete: "cascade" }),
  lastSeenAt: ts("last_seen_at"),
  lastSeenIp: text("last_seen_ip"),
  lastSeenUa: text("last_seen_ua"),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Single-use kiosk pairing codes (hash stored, ≥128-bit entropy). */
export const pairingCodes = pgTable("pairing_codes", {
  codeHash: text("code_hash").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  createdBy: text("created_by"),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Login attempts for brute-force visibility (research §7d). */
export const loginAttempts = pgTable("login_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  email: text("email"),
  ip: text("ip"),
  attemptedAt: ts("attempted_at").notNull().defaultNow(),
  success: boolean("success").notNull().default(false),
});
