-- 0003_auth_core.sql
-- better-auth core tables (user/session/account/verification).
-- Column names mirror src/lib/authn/schema.ts (the adapter's source of truth).
-- Regenerate + add a new migration (never edit) when better-auth is upgraded.

create table if not exists "user" (
  id text primary key,
  name text not null,
  email text not null unique,
  email_verified boolean not null default false,
  image text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  role text,
  banned boolean default false,
  ban_reason text,
  ban_expires timestamptz,
  must_change_password boolean not null default false
);

create table if not exists session (
  id text primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  ip_address text,
  user_agent text,
  user_id text not null references "user"(id) on delete cascade,
  active_organization_id text,
  impersonated_by text
);
create index if not exists idx_session_user_id on session (user_id);
create index if not exists idx_session_token on session (token);

create table if not exists account (
  id text primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references "user"(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists idx_account_user_id on account (user_id);

create table if not exists verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists idx_verification_identifier on verification (identifier);
