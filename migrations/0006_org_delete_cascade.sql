-- 0006_org_delete_cascade.sql
-- Complete the organization-deletion cascade (Phase 2): member and invitation
-- rows reference organization(id) WITHOUT on delete cascade (0004 used the
-- inline "references" form, which defaults to NO ACTION). A direct delete of
-- an organization row would fail or orphan those rows; the app-level
-- deleteOrg() also deletes them explicitly, but the DB must enforce the
-- invariant on its own.
--
-- audit_log intentionally has no FK to organization: it is append-only and
-- survives org deletion (the org_id column just becomes historical).
--
-- The existing FK constraint names are Postgres-generated
-- ("<table>_organization_id_fkey"), so look them up rather than assuming.
-- Idempotent: a previous partial run that already installed the new named
-- constraints is detected and skipped (security review 2026-09-25 R2.11).

do $$
declare
  cname text;
begin
  -- member.organization_id -> organization(id) ON DELETE CASCADE
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = current_schema()
      and table_name = 'member'
      and constraint_name = 'fk_member_org'
  ) then
    select tc.constraint_name into cname
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.table_schema = tc.table_schema
     and kcu.table_name = tc.table_name
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = current_schema()
      and tc.table_name = 'member'
      and kcu.column_name = 'organization_id'
    limit 1;
    if cname is not null then
      execute format('alter table member drop constraint %I', cname);
    end if;
    alter table member
      add constraint fk_member_org
      foreign key (organization_id) references organization(id) on delete cascade;
  end if;

  -- invitation.organization_id -> organization(id) ON DELETE CASCADE
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = current_schema()
      and table_name = 'invitation'
      and constraint_name = 'fk_invitation_org'
  ) then
    select tc.constraint_name into cname
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.table_schema = tc.table_schema
     and kcu.table_name = tc.table_name
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = current_schema()
      and tc.table_name = 'invitation'
      and kcu.column_name = 'organization_id'
    limit 1;
    if cname is not null then
      execute format('alter table invitation drop constraint %I', cname);
    end if;
    alter table invitation
      add constraint fk_invitation_org
      foreign key (organization_id) references organization(id) on delete cascade;
  end if;
end $$;
