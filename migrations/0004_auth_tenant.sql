-- 0004_auth_tenant.sql
-- better-auth tenant tables (organization/member/invitation/apikey) plus the
-- app tables Phase 1+ builds against. Column names mirror
-- src/lib/authn/schema.ts.
--
-- NOTE: the FKs from app tables (org_credentials, org_ring_tokens,
-- org_settings, kiosk_devices, pairing_codes) to organization(id) are created
-- here. The FKs from energy_samples/alerts to organization(id) are added by
-- scripts/seed-default-org.mjs AFTER the seed org row exists (see
-- migrations/0005_energy_org.sql).

create table if not exists organization (
  id text primary key,
  name text not null,
  slug text not null unique,
  logo text,
  created_at timestamptz not null,
  metadata text
);
-- Per-org timezone (research §8c): history bucketing and kiosk clocks.
alter table organization add column if not exists timezone text not null default 'America/Los_Angeles';

create table if not exists member (
  id text primary key,
  organization_id text not null references organization(id),
  user_id text not null references "user"(id),
  role text not null default 'member',
  created_at timestamptz not null
);
create index if not exists idx_member_org on member (organization_id);
create index if not exists idx_member_user on member (user_id);

create table if not exists invitation (
  id text primary key,
  organization_id text not null references organization(id),
  email text not null,
  role text,
  status text not null default 'pending',
  expires_at timestamptz not null,
  created_at timestamptz not null,
  inviter_id text not null references "user"(id)
);
create index if not exists idx_invitation_org on invitation (organization_id);

create table if not exists apikey (
  id text primary key,
  config_id text not null default 'default',
  name text,
  start text,
  reference_id text not null,
  prefix text,
  key text not null,
  refill_interval integer,
  refill_amount integer,
  last_refill_at timestamptz,
  enabled boolean default true,
  rate_limit_enabled boolean default true,
  rate_limit_time_window integer default 86400000,
  rate_limit_max integer default 10,
  request_count integer default 0,
  remaining integer,
  last_request timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  permissions text,
  metadata text
);
create index if not exists idx_apikey_key on apikey (key);
create index if not exists idx_apikey_reference on apikey (reference_id);

-- App tables (exact DDL; a parallel agent builds modules against these).

create table if not exists kv_store (key text primary key, value text not null, expires_at timestamptz);

create table if not exists audit_log (id bigserial primary key, ts timestamptz not null default now(), actor_user_id text, actor_type text not null default 'user', action text not null, target_type text, target_id text, org_id text, ip text, user_agent text, prev_hash text, row_hash text not null);
create index if not exists idx_audit_log_ts on audit_log (ts desc);

create table if not exists org_credentials (org_id text primary key references organization(id) on delete cascade, email text not null, password_enc text not null, key_id text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table if not exists org_ring_tokens (org_id text primary key references organization(id) on delete cascade, refresh_token_enc text not null, key_id text not null, updated_at timestamptz not null default now());

create table if not exists org_settings (org_id text primary key references organization(id) on delete cascade, settings jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());

create table if not exists kiosk_devices (id text primary key, org_id text not null references organization(id) on delete cascade, name text not null default '', api_key_id text not null references apikey(id) on delete cascade, last_seen_at timestamptz, last_seen_ip text, last_seen_ua text, revoked boolean not null default false, created_at timestamptz not null default now());

create table if not exists pairing_codes (code_hash text primary key, org_id text not null references organization(id) on delete cascade, created_by text, expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now());

create table if not exists login_attempts (id bigserial primary key, email text, ip text, attempted_at timestamptz not null default now(), success boolean not null default false);
create index if not exists idx_login_attempts_ip on login_attempts (ip, attempted_at desc);
