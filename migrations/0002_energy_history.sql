-- 0002_energy_history.sql
-- Long-term energy history (one sample per minute from the poller) and the
-- alert log. Purely additive.

create table if not exists energy_samples (
  ts timestamptz primary key,
  solar_w double precision,
  home_w double precision,
  battery_w double precision,
  grid_w double precision,
  soc double precision,
  sys_mode text,
  grid_state text
);
create index if not exists idx_energy_samples_ts on energy_samples (ts);

create table if not exists alerts (
  id serial primary key,
  ts timestamptz not null default now(),
  rule text not null,
  severity text not null default 'info',
  message text not null,
  acknowledged boolean not null default false
);
create index if not exists idx_alerts_ts on alerts (ts desc);
create index if not exists idx_alerts_unacked on alerts (acknowledged, ts desc) where (acknowledged = false);
