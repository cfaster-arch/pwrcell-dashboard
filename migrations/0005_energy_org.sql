-- 0005_energy_org.sql
-- Rebuild energy_samples with a composite (organization_id, ts) primary key
-- (research §8a) and add the nullable organization_id column to alerts.
--
-- Existing rows are backfilled into 'org_default' here; scripts/seed-default-org.mjs
-- creates that organization row and then adds the FK constraints
-- energy_samples.organization_id -> organization(id) ON DELETE CASCADE and
-- alerts.organization_id -> organization(id) ON DELETE CASCADE.
-- The FKs are NOT created here because the seed org row does not exist yet.

create table if not exists energy_samples_new (
  -- NOT NULL, no default: every writer must set the org explicitly.
  -- The pre-Phase-2 single-org writer (alerts.server.ts) inserts
  -- 'org_default' literally; Phase 2's per-org poller passes its own org.
  organization_id text not null,
  ts timestamptz not null,
  solar_w double precision,
  home_w double precision,
  battery_w double precision,
  grid_w double precision,
  soc double precision,
  sys_mode text,
  grid_state text,
  primary key (organization_id, ts)
);

-- Backfill existing history into the default org exactly once.
insert into energy_samples_new
  (organization_id, ts, solar_w, home_w, battery_w, grid_w, soc, sys_mode, grid_state)
select 'org_default', ts, solar_w, home_w, battery_w, grid_w, soc, sys_mode, grid_state
from energy_samples
on conflict (organization_id, ts) do nothing;

drop table if exists energy_samples;
alter table energy_samples_new rename to energy_samples;
create index if not exists idx_energy_samples_org_ts on energy_samples (organization_id, ts desc);

alter table alerts add column if not exists organization_id text;
create index if not exists idx_alerts_org on alerts (organization_id);
