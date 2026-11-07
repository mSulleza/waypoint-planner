begin;
select plan(104);

insert into auth.users (id, aud, role, email) values
  ('0000000a-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test'),
  ('0000000b-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000a-0000-0000-0000-000000000000', 'EUR', 'Europe/Berlin', 'de-DE', '2026-09-01'),
  ('0000000b-0000-0000-0000-000000000000', 'USD', 'America/Chicago', 'en-US', '2026-09-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_date, funded_from_account_id, terms) values
  ('0000000a-0001-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Current', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000a-0001-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '{}'),
  ('0000000b-0001-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', 'Checking', 'cash', 'USD', '2026-09-01', null, null);

insert into waypoint.categories (id, household_id, name) values
  ('0000000a-0002-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Food'),
  ('0000000b-0002-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', 'Food');

insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on) values
  ('0000000a-0003-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000a-0001-0000-0000-000000000001', 90000, '2026-09-01'),
  ('0000000b-0003-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000b-0001-0000-0000-000000000001', 120000, '2026-09-01');

insert into waypoint.statements (id, household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values
  ('0000000a-0005-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 30000, 3000);

insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id, plan_item_id, period) values
  ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-09-01', -90000, 'expense', null, '0000000a-0003-0000-0000-000000000001', '2026-09-01'),
  ('0000000b-0004-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', '0000000b-0001-0000-0000-000000000001', '2026-09-03', -4500, 'expense', '0000000b-0002-0000-0000-000000000001', null, null);

insert into waypoint.meal_settings (household_id, category_id, currency) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0002-0000-0000-000000000001', 'EUR');
insert into waypoint.items (id, household_id, name, kind, unit, pack_size) values ('0000000a-0006-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Rice', 'stock', 'g', 1000);
insert into waypoint.item_purchases (household_id, item_id, bought_on) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0006-0000-0000-000000000001', '2026-09-05');
insert into waypoint.recipes (id, household_id, name, portions, prep_minutes) values ('0000000a-0007-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Fried rice', 4, 20);
insert into waypoint.recipe_items (household_id, recipe_id, item_id, quantity) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0007-0000-0000-000000000001', '0000000a-0006-0000-0000-000000000001', 300);
insert into waypoint.meals (household_id, day, slot, recipe_id, leftovers) values ('0000000a-0000-0000-0000-000000000000', '2026-09-07', 'lunch', '0000000a-0007-0000-0000-000000000001', true);
insert into waypoint.trips (household_id, day) values ('0000000a-0000-0000-0000-000000000000', '2026-09-05');

set constraints all immediate;
set constraints all deferred;

-- Structure

select tables_are(
  'waypoint',
  array['accounts', 'categories', 'households', 'plan_items', 'statements', 'transactions', 'meal_settings', 'items', 'item_purchases', 'recipes', 'recipe_items', 'meals', 'trips'],
  'waypoint holds exactly the thirteen tables'
);
select functions_are(
  'waypoint', array['delete_my_account', 'export_household', 'import_household', 'post_batch', 'split_plan_item', 'export_meals', 'import_meals'],
  'waypoint holds exactly the seven functions'
);

-- A shared project's public schema keeps its own tables, so none of Waypoint's may land there.
select is_empty(
  $$ select relname::text from pg_class where relnamespace = 'public'::regnamespace
       and relname in ('households', 'accounts', 'categories', 'plan_items', 'statements', 'transactions', 'meal_settings', 'items', 'item_purchases', 'recipes', 'recipe_items', 'meals', 'trips')
     union all select proname::text from pg_proc where pronamespace = 'public'::regnamespace
       and proname in ('post_batch', 'split_plan_item', 'import_household', 'export_household', 'delete_my_account', 'export_meals', 'import_meals') $$,
  'public holds no Waypoint table or function'
);

select schema_privs_are('waypoint', r, array['USAGE'], format('%s can use the waypoint schema and not create in it', r))
from unnest(array['anon', 'authenticated', 'service_role']) r;

select is(
  (select count(*)::int from pg_class where relnamespace = 'waypoint'::regnamespace and relkind = 'r' and not relrowsecurity),
  0,
  'row level security is on for every waypoint table'
);

select results_eq(
  $$ select tablename::text collate "default", policyname::text collate "default", cmd, roles::text[] collate "default" from pg_policies where schemaname = 'waypoint' order by 1 $$,
  $$ values
    ('accounts', 'accounts_own', 'ALL', array['authenticated']),
    ('categories', 'categories_own', 'ALL', array['authenticated']),
    ('households', 'households_own', 'ALL', array['authenticated']),
    ('item_purchases', 'item_purchases_own', 'ALL', array['authenticated']),
    ('items', 'items_own', 'ALL', array['authenticated']),
    ('meal_settings', 'meal_settings_own', 'ALL', array['authenticated']),
    ('meals', 'meals_own', 'ALL', array['authenticated']),
    ('plan_items', 'plan_items_own', 'ALL', array['authenticated']),
    ('recipe_items', 'recipe_items_own', 'ALL', array['authenticated']),
    ('recipes', 'recipes_own', 'ALL', array['authenticated']),
    ('statements', 'statements_own', 'ALL', array['authenticated']),
    ('transactions', 'transactions_own', 'ALL', array['authenticated']),
    ('trips', 'trips_own', 'ALL', array['authenticated']) $$,
  'every policy names the authenticated role and each table has exactly one'
);

select results_eq(
  $$ select tablename::text collate "default", qual collate "default", with_check collate "default" from pg_policies where schemaname = 'waypoint' order by 1 $$,
  $$ values
    ('accounts', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('categories', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('households', '(id = ( SELECT auth.uid() AS uid))', '(id = ( SELECT auth.uid() AS uid))'),
    ('item_purchases', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('items', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('meal_settings', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('meals', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('plan_items', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('recipe_items', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('recipes', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('statements', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('transactions', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))'),
    ('trips', '(household_id = ( SELECT auth.uid() AS uid))', '(household_id = ( SELECT auth.uid() AS uid))') $$,
  'every policy filters reads and writes on the signed-in household'
);

select table_privs_are(
  'waypoint', t, r,
  case when r = 'authenticated' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] else array[]::text[] end,
  format('%s holds %s on %s', r, case when r = 'authenticated' then 'select, insert, update and delete' else 'no rights' end, t)
)
from unnest(array['households', 'accounts', 'categories', 'plan_items', 'statements', 'transactions', 'meal_settings', 'items', 'item_purchases', 'recipes', 'recipe_items', 'meals', 'trips']) t,
  unnest(array['anon', 'authenticated', 'service_role']) r;

select schema_privs_are('private', 'anon', array[]::text[], 'anon cannot use the private schema');
select schema_privs_are('private', 'authenticated', array[]::text[], 'authenticated cannot use the private schema');

select results_eq(
  $$ select proname::text collate "default", prosecdef, proowner::regrole::text collate "default", proconfig collate "default" from pg_proc where pronamespace = 'private'::regnamespace order by 1 $$,
  $$ values
    ('check_link', true, 'postgres', array['search_path=""']),
    ('check_plan_item', true, 'postgres', array['search_path=""']),
    ('transfer_pair', true, 'postgres', array['search_path=""']) $$,
  'the three check functions run with the owner rights of postgres and an empty search path'
);

select results_eq(
  $$ select c.relname::text collate "default", t.tgname::text collate "default", t.tgdeferrable, t.tginitdeferred, t.tgfoid::regproc::text collate "default"
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relnamespace = 'waypoint'::regnamespace and not t.tgisinternal order by 1, 2 $$,
  $$ values
    ('plan_items', 'check_plan_item', true, true, 'private.check_plan_item'),
    ('transactions', 'check_link', true, true, 'private.check_link'),
    ('transactions', 'transfer_pair', true, true, 'private.transfer_pair') $$,
  'three deferred constraint triggers and none on accounts'
);

select indexes_are('waypoint', 'households', array['households_pkey'], 'households has only its primary key index');
select indexes_are('waypoint', 'accounts', array['accounts_pkey', 'accounts_household_id_id_key'], 'accounts has only the indexes in the schema');
select indexes_are('waypoint', 'categories', array['categories_pkey', 'categories_household_id_id_key', 'categories_household_id_name_key'], 'categories has only the indexes in the schema');
select indexes_are('waypoint', 'plan_items', array['plan_items_pkey', 'plan_items_household_id_id_key'], 'plan_items has only the indexes in the schema');
select indexes_are('waypoint', 'statements', array['statements_pkey', 'statements_account_id_cut_date_key'], 'statements has only the indexes in the schema');
select indexes_are(
  'waypoint', 'transactions',
  array[
    'transactions_pkey', 'transactions_account_id_external_id_key', 'transactions_account_id_posted_on_idx', 'transactions_household_id_posted_on_idx',
    'transactions_transfer_id_idx', 'transactions_batch_id_idx', 'transactions_plan_item_id_period_idx'
  ],
  'transactions has only the indexes in the schema'
);

select is(
  (select array_agg(format('%s.%s', table_name, column_name) order by table_name, column_name)
   from information_schema.columns where table_schema = 'waypoint' and column_name like '%balance%'),
  array['accounts.opening_balance_minor', 'statements.previous_balance_minor'],
  'no table stores a balance, only the opening balance and the printed previous balance'
);

select is(
  (select count(*)::int from pg_class
   where relnamespace = 'waypoint'::regnamespace and relkind in ('v', 'm') and not coalesce(reloptions @> array['security_invoker=true'], false)),
  0,
  'every view in waypoint runs as the caller'
);

select is(
  (select count(*)::int from pg_class
   where relnamespace = 'waypoint'::regnamespace and relkind in ('r', 'v', 'm', 'p', 'f')
     and has_table_privilege('anon', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')),
  0,
  'anon holds no rights on any table or view in waypoint'
);

-- B against A's rows

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000b-0000-0000-0000-000000000000", "role": "authenticated"}';

select results_eq(
  $$ select 'households', count(*)::int from waypoint.households where id = '0000000a-0000-0000-0000-000000000000'
     union all select 'accounts', count(*)::int from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'categories', count(*)::int from waypoint.categories where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'plan_items', count(*)::int from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'statements', count(*)::int from waypoint.statements where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'transactions', count(*)::int from waypoint.transactions where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'meal_settings', count(*)::int from waypoint.meal_settings where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'items', count(*)::int from waypoint.items where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'item_purchases', count(*)::int from waypoint.item_purchases where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'recipes', count(*)::int from waypoint.recipes where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'recipe_items', count(*)::int from waypoint.recipe_items where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'meals', count(*)::int from waypoint.meals where household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 'trips', count(*)::int from waypoint.trips where household_id = '0000000a-0000-0000-0000-000000000000' $$,
  $$ values ('households', 0), ('accounts', 0), ('categories', 0), ('plan_items', 0), ('statements', 0), ('transactions', 0), ('meal_settings', 0), ('items', 0), ('item_purchases', 0), ('recipes', 0), ('recipe_items', 0), ('meals', 0), ('trips', 0) $$,
  'B reads 0 rows of A in every table'
);

select results_eq(
  $$ select 'households', count(*)::int from waypoint.households
     union all select 'accounts', count(*)::int from waypoint.accounts
     union all select 'categories', count(*)::int from waypoint.categories
     union all select 'plan_items', count(*)::int from waypoint.plan_items
     union all select 'statements', count(*)::int from waypoint.statements
     union all select 'transactions', count(*)::int from waypoint.transactions $$,
  $$ values ('households', 1), ('accounts', 1), ('categories', 1), ('plan_items', 1), ('statements', 0), ('transactions', 1) $$,
  'B reads exactly its own rows'
);

select throws_ok(
  $$ insert into waypoint.households (id, base_currency, timezone, locale, track_from)
     values ('0000000a-0000-0000-0000-000000000000', 'EUR', 'UTC', 'en', '2026-09-01') $$,
  '42501', 'new row violates row-level security policy for table "households"',
  'B cannot insert a household with the id of A'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date)
     values ('0000000a-0000-0000-0000-000000000000', 'Stash', 'cash', 'EUR', '2026-09-01') $$,
  '42501', 'new row violates row-level security policy for table "accounts"',
  'B cannot insert an account with the household of A'
);
select throws_ok(
  $$ insert into waypoint.categories (household_id, name) values ('0000000a-0000-0000-0000-000000000000', 'Travel') $$,
  '42501', 'new row violates row-level security policy for table "categories"',
  'B cannot insert a category with the household of A'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on)
     values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', 3000, '2026-10-01') $$,
  '42501', 'new row violates row-level security policy for table "plan_items"',
  'B cannot insert a plan item with the household of A'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor)
     values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-20', '2026-11-10', 1000, 100) $$,
  '42501', 'new row violates row-level security policy for table "statements"',
  'B cannot insert a statement with the household of A'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind)
     values ('0000000b-0004-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -100, 'expense') $$,
  '42501', 'new row violates row-level security policy for table "transactions"',
  'B cannot insert a transaction with the household of A'
);

select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, funded_from_account_id, terms)
     values ('0000000b-0000-0000-0000-000000000000', 'Card', 'credit_card', 'USD', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '{}') $$,
  '23503', 'insert or update on table "accounts" violates foreign key constraint "accounts_funded_from_fkey"',
  'B cannot fund an account from an account of A'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on)
     values ('0000000b-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', 3000, '2026-10-01') $$,
  '23503', 'insert or update on table "plan_items" violates foreign key constraint "plan_items_from_account_fkey"',
  'B cannot plan a bill from an account of A'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor)
     values ('0000000b-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-20', '2026-11-10', 1000, 100) $$,
  '23503', 'insert or update on table "statements" violates foreign key constraint "statements_account_fkey"',
  'B cannot file a statement on a card of A'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind)
     values ('0000000b-0004-0000-0000-000000000003', '0000000b-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -100, 'expense') $$,
  '23503', 'insert or update on table "transactions" violates foreign key constraint "transactions_account_fkey"',
  'B cannot record a transaction on an account of A'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id)
     values ('0000000b-0004-0000-0000-000000000004', '0000000b-0000-0000-0000-000000000000', '0000000b-0001-0000-0000-000000000001', '2026-10-01', -100, 'expense', '0000000a-0002-0000-0000-000000000001') $$,
  '23503', 'insert or update on table "transactions" violates foreign key constraint "transactions_category_fkey"',
  'B cannot tag a transaction with a category of A'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period)
     values ('0000000b-0004-0000-0000-000000000005', '0000000b-0000-0000-0000-000000000000', '0000000b-0001-0000-0000-000000000001', '2026-10-01', -100, 'expense', '0000000a-0003-0000-0000-000000000001', '2026-10-01') $$,
  '23503', 'insert or update on table "transactions" violates foreign key constraint "transactions_plan_item_fkey"',
  'B cannot link a transaction to a plan item of A'
);
select lives_ok(
  $$ insert into waypoint.accounts (id, household_id, name, kind, currency, opening_date, funded_from_account_id, terms)
     values ('0000000b-0001-0000-0000-000000000002', '0000000b-0000-0000-0000-000000000000', 'Card', 'credit_card', 'USD', '2026-09-01', '0000000b-0001-0000-0000-000000000001', '{}');
     insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on)
     values ('0000000b-0003-0000-0000-000000000002', '0000000b-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000b-0001-0000-0000-000000000001', 3000, '2026-10-01');
     insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor)
     values ('0000000b-0000-0000-0000-000000000000', '0000000b-0001-0000-0000-000000000002', '2026-10-20', '2026-11-10', 1000, 100);
     insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id, plan_item_id, period)
     values ('0000000b-0004-0000-0000-000000000006', '0000000b-0000-0000-0000-000000000000', '0000000b-0001-0000-0000-000000000001', '2026-10-01', -3000, 'expense', '0000000b-0002-0000-0000-000000000001', '0000000b-0003-0000-0000-000000000002', '2026-10-01');
     set constraints all immediate;
     set constraints all deferred $$,
  'B funds, plans, files and links within its own household, and the deferred checks pass for B'
);

select is_empty($$ update waypoint.households set locale = 'en-GB' where id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B updates no household of A');
select is_empty($$ update waypoint.accounts set name = 'Taken' where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B updates no account of A');
select is_empty($$ update waypoint.categories set name = 'Taken' where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B updates no category of A');
select is_empty($$ update waypoint.plan_items set name = 'Taken' where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B updates no plan item of A');
select is_empty($$ update waypoint.statements set minimum_due_minor = 0 where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B updates no statement of A');
select is_empty($$ update waypoint.transactions set description = 'Taken' where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B updates no transaction of A');
select is_empty($$ delete from waypoint.transactions where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B deletes no transaction of A');
select is_empty($$ delete from waypoint.statements where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B deletes no statement of A');
select is_empty($$ delete from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B deletes no plan item of A');
select is_empty($$ delete from waypoint.categories where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B deletes no category of A');
select is_empty($$ delete from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B deletes no account of A');
select is_empty($$ delete from waypoint.households where id = '0000000a-0000-0000-0000-000000000000' returning id $$, 'B deletes no household of A');

select throws_ok(
  $$ select private.check_link() $$,
  '42501', 'permission denied for schema private',
  'a signed-in user cannot reach the private schema'
);

-- A still reads every one of its rows

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000a-0000-0000-0000-000000000000", "role": "authenticated"}';

select results_eq(
  $$ select 'households', count(*)::int from waypoint.households
     union all select 'accounts', count(*)::int from waypoint.accounts
     union all select 'categories', count(*)::int from waypoint.categories
     union all select 'plan_items', count(*)::int from waypoint.plan_items
     union all select 'statements', count(*)::int from waypoint.statements
     union all select 'transactions', count(*)::int from waypoint.transactions
     union all select 'Rent name', count(*)::int from waypoint.plan_items where name = 'Rent' $$,
  $$ values ('households', 1), ('accounts', 2), ('categories', 1), ('plan_items', 1), ('statements', 1), ('transactions', 1), ('Rent name', 1) $$,
  'A reads exactly its own rows, unchanged by B'
);

-- anon

reset role;
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';

select throws_ok($$ select count(*) from waypoint.households $$, '42501', 'permission denied for table households', 'anon cannot read households');
select throws_ok($$ select count(*) from waypoint.accounts $$, '42501', 'permission denied for table accounts', 'anon cannot read accounts');
select throws_ok($$ select count(*) from waypoint.categories $$, '42501', 'permission denied for table categories', 'anon cannot read categories');
select throws_ok($$ select count(*) from waypoint.plan_items $$, '42501', 'permission denied for table plan_items', 'anon cannot read plan_items');
select throws_ok($$ select count(*) from waypoint.statements $$, '42501', 'permission denied for table statements', 'anon cannot read statements');
select throws_ok($$ select count(*) from waypoint.transactions $$, '42501', 'permission denied for table transactions', 'anon cannot read transactions');
select throws_ok($$ select count(*) from waypoint.meal_settings $$, '42501', 'permission denied for table meal_settings', 'anon cannot read meal_settings');
select throws_ok($$ select count(*) from waypoint.items $$, '42501', 'permission denied for table items', 'anon cannot read items');
select throws_ok($$ select count(*) from waypoint.item_purchases $$, '42501', 'permission denied for table item_purchases', 'anon cannot read item_purchases');
select throws_ok($$ select count(*) from waypoint.recipes $$, '42501', 'permission denied for table recipes', 'anon cannot read recipes');
select throws_ok($$ select count(*) from waypoint.recipe_items $$, '42501', 'permission denied for table recipe_items', 'anon cannot read recipe_items');
select throws_ok($$ select count(*) from waypoint.meals $$, '42501', 'permission denied for table meals', 'anon cannot read meals');
select throws_ok($$ select count(*) from waypoint.trips $$, '42501', 'permission denied for table trips', 'anon cannot read trips');
select throws_ok($$ select private.transfer_pair() $$, '42501', 'permission denied for schema private', 'anon cannot reach the private schema');

reset role;

select * from finish();
rollback;
