-- postgres may not take the supabase_auth_admin role (Supabase reserves it), so this file connects as the local superuser.
\c - supabase_admin
begin;
select plan(7);

insert into auth.users (id, aud, role, email) values
  ('0000000a-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test'),
  ('0000000b-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000a-0000-0000-0000-000000000000', 'EUR', 'Europe/Berlin', 'de-DE', '2026-09-01'),
  ('0000000b-0000-0000-0000-000000000000', 'USD', 'America/Chicago', 'en-US', '2026-09-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_date, funded_from_account_id, terms) values
  ('0000000a-0001-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Current', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000a-0001-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'Savings', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000a-0001-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '{}'),
  ('0000000b-0001-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', 'Checking', 'cash', 'USD', '2026-09-01', null, null),
  ('0000000b-0001-0000-0000-000000000002', '0000000b-0000-0000-0000-000000000000', 'Card', 'credit_card', 'USD', '2026-09-01', '0000000b-0001-0000-0000-000000000001', '{}');

insert into waypoint.categories (id, household_id, name) values
  ('0000000a-0002-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Food'),
  ('0000000b-0002-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', 'Food');

insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
  ('0000000a-0003-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000a-0001-0000-0000-000000000001', null, 90000, '2026-09-01'),
  ('0000000a-0003-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'transfer', 'Card payment', null, '0000000a-0001-0000-0000-000000000003', 20000, '2026-09-10'),
  ('0000000b-0003-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000b-0001-0000-0000-000000000001', null, 120000, '2026-09-01');

insert into waypoint.statements (id, household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values
  ('0000000a-0005-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000003', '2026-09-20', '2026-10-10', 30000, 3000),
  ('0000000b-0005-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', '0000000b-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 15000, 1500);

insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id, transfer_id, plan_item_id, period) values
  ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-09-01', -90000, 'expense', '0000000a-0002-0000-0000-000000000001', null, '0000000a-0003-0000-0000-000000000001', '2026-09-01'),
  ('0000000a-0004-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-09-10', -20000, 'transfer', null, '0000000a-0006-0000-0000-000000000001', '0000000a-0003-0000-0000-000000000002', '2026-09-01'),
  ('0000000a-0004-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000003', '2026-09-11', 20000, 'transfer', null, '0000000a-0006-0000-0000-000000000001', null, null),
  ('0000000a-0004-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-09-28', -5000, 'transfer', null, '0000000a-0006-0000-0000-000000000002', null, null),
  ('0000000a-0004-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-28', 5000, 'transfer', null, '0000000a-0006-0000-0000-000000000002', null, null),
  ('0000000b-0004-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', '0000000b-0001-0000-0000-000000000001', '2026-09-03', -4500, 'expense', '0000000b-0002-0000-0000-000000000001', null, null, null);

set constraints all immediate;
set constraints all deferred;

create temp table household_rows on commit drop as
  select h.id as household, t.name as table_name,
    case t.name
      when 'households' then (select count(*) from waypoint.households x where x.id = h.id)
      when 'accounts' then (select count(*) from waypoint.accounts x where x.household_id = h.id)
      when 'categories' then (select count(*) from waypoint.categories x where x.household_id = h.id)
      when 'plan_items' then (select count(*) from waypoint.plan_items x where x.household_id = h.id)
      when 'statements' then (select count(*) from waypoint.statements x where x.household_id = h.id)
      else (select count(*) from waypoint.transactions x where x.household_id = h.id)
    end::int as before
  from waypoint.households h, unnest(array['households', 'accounts', 'categories', 'plan_items', 'statements', 'transactions']) t(name);

select is(
  (select count(*)::int from unnest(array['households', 'accounts', 'categories', 'plan_items', 'statements', 'transactions']) t
   where has_table_privilege('supabase_auth_admin', 'waypoint.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
  + (select count(*)::int from (values (1)) v where has_schema_privilege('supabase_auth_admin', 'private', 'USAGE')),
  0,
  'supabase_auth_admin holds no rights on the six tables or the private schema'
);

select results_eq(
  $$ select table_name, before from household_rows where household = '0000000a-0000-0000-0000-000000000000' order by table_name $$,
  $$ values ('accounts', 3), ('categories', 1), ('households', 1), ('plan_items', 2), ('statements', 1), ('transactions', 5) $$,
  'A has rows in all six tables, a linked expense and two transfers among them'
);

select throws_ok(
  $$ delete from waypoint.accounts where id = '0000000a-0001-0000-0000-000000000002'; set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000002 has 1 leg; a transfer has exactly 2',
  'a cascade that deletes one leg of a transfer fails at commit'
);

select lives_ok(
  $$ set local role supabase_auth_admin;
     delete from auth.users where id = '0000000a-0000-0000-0000-000000000000';
     set constraints all immediate;
     reset role $$,
  'Supabase Auth deletes user A as supabase_auth_admin and every deferred check passes'
);

select results_eq(
  $$ select 'households', count(*)::int from waypoint.households where id = '0000000a-0000-0000-0000-000000000000'
     union all select 'accounts', count(*)::int from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'categories', count(*)::int from waypoint.categories where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'plan_items', count(*)::int from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'statements', count(*)::int from waypoint.statements where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'transactions', count(*)::int from waypoint.transactions where household_id = '0000000a-0000-0000-0000-000000000000' $$,
  $$ values ('households', 0), ('accounts', 0), ('categories', 0), ('plan_items', 0), ('statements', 0), ('transactions', 0) $$,
  'after the Auth delete A has 0 rows in all six tables'
);

select results_eq(
  $$ select r.table_name, r.before,
       case r.table_name
         when 'households' then (select count(*) from waypoint.households x where x.id = r.household)
         when 'accounts' then (select count(*) from waypoint.accounts x where x.household_id = r.household)
         when 'categories' then (select count(*) from waypoint.categories x where x.household_id = r.household)
         when 'plan_items' then (select count(*) from waypoint.plan_items x where x.household_id = r.household)
         when 'statements' then (select count(*) from waypoint.statements x where x.household_id = r.household)
         else (select count(*) from waypoint.transactions x where x.household_id = r.household)
       end::int
     from household_rows r where r.household = '0000000b-0000-0000-0000-000000000000' order by r.table_name $$,
  $$ values ('accounts', 2, 2), ('categories', 1, 1), ('households', 1, 1), ('plan_items', 1, 1), ('statements', 1, 1), ('transactions', 1, 1) $$,
  'B keeps every row'
);

select results_eq(
  $$ select id from auth.users where id in ('0000000a-0000-0000-0000-000000000000', '0000000b-0000-0000-0000-000000000000') $$,
  $$ values ('0000000b-0000-0000-0000-000000000000'::uuid) $$,
  'only the auth user of A is gone'
);

select * from finish();
rollback;
