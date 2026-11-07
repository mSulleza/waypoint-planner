begin;
select plan(49);

insert into auth.users (id, aud, role, email) values
  ('0000000a-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test'),
  ('0000000b-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test'),
  ('0000000c-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@example.test');

-- Document ids are words; the card comes before the account that funds it, and keys with a column default are left out here and there.
create temp table docs (name text primary key, doc jsonb not null);
insert into docs values ('a', '{
  "version": 1,
  "household": {"base_currency": "EUR", "timezone": "Europe/Berlin", "locale": "de-DE", "track_from": "2026-09-01"},
  "accounts": [
    {"id": "card", "name": "Card", "kind": "credit_card", "currency": "EUR", "opening_balance_minor": -40000, "opening_date": "2026-08-01",
     "funded_from_account_id": "main", "terms": {"cut_day": 20}, "sort_order": 2},
    {"id": "main", "name": "Current", "kind": "cash", "currency": "EUR", "opening_balance_minor": 500000, "opening_date": "2026-08-01",
     "floor_windows": [{"from_month": "2026-10", "to_month": null, "amount_minor": 100000}], "fx_fee_pct": 0.007, "csv_mapping": {"date": "Booking date"}},
    {"id": "savings", "name": "Savings", "kind": "cash", "currency": "EUR", "opening_date": "2026-08-01", "funded_from_account_id": "main", "sort_order": 1,
     "archived_at": "2026-10-01T00:00:00+00:00"}
  ],
  "categories": [{"id": "food", "name": "Food"}, {"id": "home", "name": "Home", "archived_at": "2026-09-15T12:00:00+00:00"}],
  "plan_items": [
    {"id": "rent", "kind": "bill", "name": "Rent", "from_account_id": "main", "amount_minor": 90000, "starts_on": "2026-09-01", "roll": "following"},
    {"id": "groceries", "kind": "allowance", "name": "Groceries", "from_account_id": "main", "category_id": "food", "amount_minor": 40000, "starts_on": "2026-09-01"},
    {"id": "card-payment", "kind": "transfer", "name": "Card payment", "to_account_id": "card", "amount_minor": 20000, "starts_on": "2026-09-10"},
    {"id": "salary", "kind": "income", "name": "Salary", "to_account_id": "main", "amount_minor": 300000, "starts_on": "2026-09-28", "confidence": "estimated",
     "skip_periods": ["2026-12-01"]},
    {"id": "laptop", "kind": "installment", "name": "Laptop", "from_account_id": "card", "amount_minor": 8000, "starts_on": "2026-06-01", "ends_on": "2027-05-01"}
  ],
  "statements": [
    {"id": "card-sep", "account_id": "card", "cut_date": "2026-09-20", "due_date": "2026-10-10", "previous_balance_minor": 40000, "payments_and_credits_minor": 20000,
     "charges_minor": 5000, "installments_minor": 8000, "interest_minor": 0, "fees_minor": 0, "total_due_minor": 33000, "minimum_due_minor": 3300, "available_credit_minor": 467000}
  ],
  "transactions": [
    {"id": "rent-sep", "account_id": "main", "posted_on": "2026-09-01", "amount_minor": -90000, "kind": "expense", "description": "Rent", "plan_item_id": "rent",
     "period": "2026-09-01", "batch_id": "sep-1"},
    {"id": "lunch", "account_id": "main", "posted_on": "2026-09-03", "amount_minor": -4500, "kind": "expense", "category_id": "food", "batch_id": "sep-1"},
    {"id": "pay-out", "account_id": "main", "posted_on": "2026-09-10", "amount_minor": -20000, "kind": "transfer", "transfer_id": "pay", "plan_item_id": "card-payment",
     "period": "2026-09-01", "batch_id": "sep-2"},
    {"id": "pay-in", "account_id": "card", "posted_on": "2026-09-11", "amount_minor": 20000, "kind": "transfer", "transfer_id": "pay", "batch_id": "sep-2"},
    {"id": "save-out", "account_id": "main", "posted_on": "2026-09-28", "amount_minor": -5000, "kind": "transfer", "transfer_id": "save", "external_id": "ref-1"},
    {"id": "save-in", "account_id": "savings", "posted_on": "2026-09-28", "amount_minor": 5000, "kind": "transfer", "transfer_id": "save"},
    {"id": "salary-sep", "account_id": "main", "posted_on": "2026-09-28", "amount_minor": 300000, "kind": "income", "plan_item_id": "salary", "period": "2026-09-01"}
  ]
}');
create temp table results (name text primary key, value jsonb);
grant select on docs to authenticated;
grant select, insert on results to authenticated;

-- The detail of the error a statement raises, which carries the issues as JSON.
create function pg_temp.error_detail(sql text) returns jsonb
language plpgsql
as $f$
declare
  detail text;
begin
  execute sql;
  return null;
exception when others then
  get stacked diagnostics detail = pg_exception_detail;
  return detail::jsonb;
end;
$f$;

create function pg_temp.counts(p_household uuid) returns table (table_name text, n int)
language sql
as $f$
  select 'households', count(*)::int from waypoint.households where id = p_household
  union all select 'accounts', count(*)::int from waypoint.accounts where household_id = p_household
  union all select 'categories', count(*)::int from waypoint.categories where household_id = p_household
  union all select 'plan_items', count(*)::int from waypoint.plan_items where household_id = p_household
  union all select 'statements', count(*)::int from waypoint.statements where household_id = p_household
  union all select 'transactions', count(*)::int from waypoint.transactions where household_id = p_household
$f$;

-- An export with every id swapped through an import's id map, each table re-sorted by the new ids.
create function pg_temp.translated(doc jsonb, ids jsonb) returns jsonb
language plpgsql
as $f$
declare
  out text := doc::text;
  m record;
begin
  for m in select x.key, x.value from jsonb_each(ids) t, jsonb_each_text(t.value) x loop
    out := replace(out, m.key, m.value);
  end loop;
  return out::jsonb || (
    select jsonb_object_agg(t, coalesce((select jsonb_agg(r order by (r ->> 'id')::uuid) from jsonb_array_elements(out::jsonb -> t) r), '[]'))
    from unnest(array['accounts', 'categories', 'plan_items', 'statements', 'transactions']) t
  );
end;
$f$;

-- Structure

select results_eq(
  $$ select proname::text collate "default", prosecdef, proowner::regrole::text collate "default", proconfig collate "default"
     from pg_proc where pronamespace = 'waypoint'::regnamespace and proname in ('delete_my_account', 'export_household', 'import_household') order by 1 $$,
  $$ values
    ('delete_my_account', true, 'postgres', array['search_path=""']),
    ('export_household', false, 'postgres', array['search_path=""']),
    ('import_household', false, 'postgres', array['search_path=""']) $$,
  'import_household and export_household run as the caller and delete_my_account as postgres, each with an empty search path'
);

select function_privs_are(
  'waypoint', f, a, r,
  case when r = 'authenticated' then array['EXECUTE'] else array[]::text[] end,
  format('%s %s %s', r, case when r = 'authenticated' then 'can execute' else 'cannot execute' end, f)
)
from (values ('import_household', array['jsonb']), ('export_household', array[]::text[]), ('delete_my_account', array[]::text[])) fn(f, a),
  unnest(array['anon', 'authenticated', 'service_role']) r;

select function_returns('waypoint', 'delete_my_account', array[]::text[], 'void', 'delete_my_account takes no arguments and returns void');

-- import_household, as A

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000a-0000-0000-0000-000000000000", "role": "authenticated"}';

select lives_ok(
  $$ insert into results select 'import a', waypoint.import_household(d.doc) from docs d where d.name = 'a';
     set constraints all immediate;
     set constraints all deferred $$,
  'A imports a document into a new household and every deferred check passes'
);

select is(
  (select value ->> 'household_id' from results where name = 'import a'),
  '0000000a-0000-0000-0000-000000000000',
  'the new household id is the user id of the caller'
);

reset role;

select results_eq(
  $$ select * from pg_temp.counts('0000000a-0000-0000-0000-000000000000') $$,
  $$ values ('households', 1), ('accounts', 3), ('categories', 2), ('plan_items', 5), ('statements', 1), ('transactions', 7) $$,
  'A holds every row of the document'
);

select results_eq(
  $$ select t.key, array(select k from jsonb_object_keys(t.value) k order by k collate "C")
     from results r, jsonb_each(r.value -> 'ids') t where r.name = 'import a' order by t.key collate "C" $$,
  $$ values
    ('accounts', array['card', 'main', 'savings']),
    ('batches', array['sep-1', 'sep-2']),
    ('categories', array['food', 'home']),
    ('plan_items', array['card-payment', 'groceries', 'laptop', 'rent', 'salary']),
    ('statements', array['card-sep']),
    ('transactions', array['lunch', 'pay-in', 'pay-out', 'rent-sep', 'salary-sep', 'save-in', 'save-out']),
    ('transfers', array['pay', 'save']) $$,
  'import_household maps every document id, transfer and batch to a uuid'
);

select is(
  (select count(*)::int
   from results r, jsonb_each(r.value -> 'ids') t, jsonb_each_text(t.value) m
   where r.name = 'import a' and t.key not in ('transfers', 'batches') and not exists (
     select 1 from waypoint.accounts x where t.key = 'accounts' and x.id = m.value::uuid and x.household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 1 from waypoint.categories x where t.key = 'categories' and x.id = m.value::uuid and x.household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 1 from waypoint.plan_items x where t.key = 'plan_items' and x.id = m.value::uuid and x.household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 1 from waypoint.statements x where t.key = 'statements' and x.id = m.value::uuid and x.household_id = '0000000a-0000-0000-0000-000000000000'
     union all select 1 from waypoint.transactions x where t.key = 'transactions' and x.id = m.value::uuid and x.household_id = '0000000a-0000-0000-0000-000000000000')),
  0,
  'every row of A carries the fresh uuid the map gives its document id'
);

select results_eq(
  $$ select a.name, f.name from waypoint.accounts a left join waypoint.accounts f on f.id = a.funded_from_account_id
     where a.household_id = '0000000a-0000-0000-0000-000000000000' order by 1 $$,
  $$ values ('Card', 'Current'), ('Current', null), ('Savings', 'Current') $$,
  'funded_from_account_id names the new id of the funder, even one listed after the card'
);

select results_eq(
  $$ select p.name, fa.name, ta.name, c.name from waypoint.plan_items p
     left join waypoint.accounts fa on fa.id = p.from_account_id left join waypoint.accounts ta on ta.id = p.to_account_id
     left join waypoint.categories c on c.id = p.category_id
     where p.household_id = '0000000a-0000-0000-0000-000000000000' order by 1 $$,
  $$ values ('Card payment', null, 'Card', null), ('Groceries', 'Current', null, 'Food'), ('Laptop', 'Card', null, null),
    ('Rent', 'Current', null, null), ('Salary', null, 'Current', null) $$,
  'plan items name the new ids of their accounts and category'
);

select results_eq(
  $$ select m.key, a.name, c.name, p.name, t.period, t.external_id,
       (select x.key from jsonb_each_text(r.value #> '{ids,transfers}') x where x.value::uuid = t.transfer_id),
       (select x.key from jsonb_each_text(r.value #> '{ids,batches}') x where x.value::uuid = t.batch_id)
     from results r, jsonb_each_text(r.value #> '{ids,transactions}') m
     join waypoint.transactions t on t.id = m.value::uuid join waypoint.accounts a on a.id = t.account_id
     left join waypoint.categories c on c.id = t.category_id left join waypoint.plan_items p on p.id = t.plan_item_id
     where r.name = 'import a' order by m.key collate "C" $$,
  $$ values
    ('lunch', 'Current', 'Food', null, null::date, null, null, 'sep-1'),
    ('pay-in', 'Card', null, null, null, null, 'pay', 'sep-2'),
    ('pay-out', 'Current', null, 'Card payment', '2026-09-01', null, 'pay', 'sep-2'),
    ('rent-sep', 'Current', null, 'Rent', '2026-09-01', null, null, 'sep-1'),
    ('salary-sep', 'Current', null, 'Salary', '2026-09-01', null, null, null),
    ('save-in', 'Savings', null, null, null, null, 'save', null),
    ('save-out', 'Current', null, null, null, 'ref-1', 'save', null) $$,
  'transactions name the new ids of their account, category and plan item, and each transfer and batch shares one new uuid'
);

select results_eq(
  $$ select a.name, s.cut_date, s.due_date, s.previous_balance_minor, s.payments_and_credits_minor, s.charges_minor, s.installments_minor,
       s.interest_minor, s.fees_minor, s.total_due_minor, s.minimum_due_minor, s.available_credit_minor
     from waypoint.statements s join waypoint.accounts a on a.id = s.account_id where s.household_id = '0000000a-0000-0000-0000-000000000000' $$,
  $$ values ('Card', '2026-09-20'::date, '2026-10-10'::date, 40000::bigint, 20000::bigint, 5000::bigint, 8000::bigint, 0::bigint, 0::bigint, 33000::bigint, 3300::bigint, 467000::bigint) $$,
  'the statement lands on the new card id with its six parts'
);

select results_eq(
  $$ select 'payoff_order', payoff_order from waypoint.households where id = '0000000a-0000-0000-0000-000000000000'
     union all select 'Savings opening_balance_minor', opening_balance_minor::text from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Savings'
     union all select 'Card floor_windows', floor_windows::text from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Card'
     union all select 'Current sort_order', sort_order::text from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Current'
     union all select 'Rent every', every from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Rent'
     union all select 'Rent confidence', confidence from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Rent'
     union all select 'Rent skip_periods', skip_periods::text from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Rent'
     union all select 'Groceries roll', roll from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Groceries'
     union all select 'lunch description', description from waypoint.transactions where household_id = '0000000a-0000-0000-0000-000000000000' and amount_minor = -4500 $$,
  $$ values ('payoff_order', 'avalanche'), ('Savings opening_balance_minor', '0'), ('Card floor_windows', '[]'), ('Current sort_order', '0'),
    ('Rent every', 'month'), ('Rent confidence', 'committed'), ('Rent skip_periods', '{}'), ('Groceries roll', 'none'), ('lunch description', '') $$,
  'a key left out takes the column default, as in an SQL insert'
);

select results_eq(
  $$ select 'Current floor_windows', floor_windows::text from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Current'
     union all select 'Current fx_fee_pct', fx_fee_pct::text from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Current'
     union all select 'Current csv_mapping', csv_mapping::text from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Current'
     union all select 'Card terms', terms::text from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Card'
     union all select 'Savings archived_at', (archived_at = '2026-10-01T00:00:00+00:00')::text from waypoint.accounts where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Savings'
     union all select 'Home archived_at', (archived_at = '2026-09-15T12:00:00+00:00')::text from waypoint.categories where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Home'
     union all select 'Salary skip_periods', skip_periods::text from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Salary'
     union all select 'Salary confidence', confidence from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Salary'
     union all select 'Rent roll', roll from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Rent'
     union all select 'Laptop ends_on', ends_on::text from waypoint.plan_items where household_id = '0000000a-0000-0000-0000-000000000000' and name = 'Laptop' $$,
  $$ values
    ('Current floor_windows', '[{"from_month": "2026-10", "to_month": null, "amount_minor": 100000}]'::jsonb::text),
    ('Current fx_fee_pct', '0.00700'), ('Current csv_mapping', '{"date": "Booking date"}'), ('Card terms', '{"cut_day": 20}'),
    ('Savings archived_at', 'true'), ('Home archived_at', 'true'), ('Salary skip_periods', '{2026-12-01}'), ('Salary confidence', 'estimated'),
    ('Rent roll', 'following'), ('Laptop ends_on', '2027-05-01') $$,
  'json, numeric, array and timestamp values arrive unchanged'
);

-- export_household, as A

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000a-0000-0000-0000-000000000000", "role": "authenticated"}';

insert into results select 'export a', waypoint.export_household();

select results_eq(
  $$ select array(select k from jsonb_object_keys(r.value) k order by k collate "C"), r.value -> 'version' from results r where r.name = 'export a' $$,
  $$ values (array['accounts', 'categories', 'household', 'plan_items', 'statements', 'transactions', 'version'], '1'::jsonb) $$,
  'export_household returns version 1 with the household and the five tables'
);

select results_eq(
  $$ select distinct x.t, array(select k from jsonb_object_keys(x.r) k order by k collate "C")
     from results e, lateral (
       select 'household' as t, e.value -> 'household' as r
       union all select t.key, r from jsonb_each(e.value) t, jsonb_array_elements(t.value) r where jsonb_typeof(t.value) = 'array'
     ) x where e.name = 'export a' order by 1 $$,
  $$ values
    ('accounts', array['archived_at', 'csv_mapping', 'currency', 'floor_windows', 'funded_from_account_id', 'fx_fee_pct', 'id', 'kind', 'name',
      'opening_balance_minor', 'opening_date', 'sort_order', 'terms']),
    ('categories', array['archived_at', 'id', 'name']),
    ('household', array['base_currency', 'locale', 'payoff_order', 'timezone', 'track_from']),
    ('plan_items', array['amount_minor', 'category_id', 'confidence', 'ends_on', 'every', 'from_account_id', 'id', 'kind', 'name', 'roll', 'skip_periods',
      'starts_on', 'stops_with_income', 'to_account_id']),
    ('statements', array['account_id', 'available_credit_minor', 'charges_minor', 'cut_date', 'due_date', 'fees_minor', 'id', 'installments_minor',
      'interest_minor', 'minimum_due_minor', 'payments_and_credits_minor', 'previous_balance_minor', 'total_due_minor']),
    ('transactions', array['account_id', 'amount_minor', 'batch_id', 'category_id', 'description', 'external_id', 'id', 'kind', 'period', 'plan_item_id',
      'posted_on', 'transfer_id']) $$,
  'every exported row has exactly the keys import_household takes, with no household_id or created_at'
);

select results_eq(
  $$ select t.key, array(select r ->> 'id' from jsonb_array_elements(t.value) with ordinality x(r, ord) order by x.ord)
       = array(select r ->> 'id' from jsonb_array_elements(t.value) r order by (r ->> 'id')::uuid)
     from results e, jsonb_each(e.value) t where e.name = 'export a' and jsonb_typeof(t.value) = 'array' order by t.key collate "C" $$,
  $$ values ('accounts', true), ('categories', true), ('plan_items', true), ('statements', true), ('transactions', true) $$,
  'every exported table is sorted by id'
);

select results_eq(
  $$ select t.key, (r ->> 'id')::uuid from results e, jsonb_each(e.value) t, jsonb_array_elements(t.value) r
     where e.name = 'export a' and jsonb_typeof(t.value) = 'array' order by t.key collate "C", 2 $$,
  $$ select 'accounts', id from waypoint.accounts
     union all select 'categories', id from waypoint.categories
     union all select 'plan_items', id from waypoint.plan_items
     union all select 'statements', id from waypoint.statements
     union all select 'transactions', id from waypoint.transactions order by 1, 2 $$,
  'export_household holds every row of A with its real id'
);

select results_eq(
  $$ select r ->> 'name', r from results e, jsonb_array_elements(e.value -> 'accounts') r where e.name = 'export a' and r ->> 'name' in ('Current', 'Savings')
     union all select 'pay-out', r from results e, jsonb_array_elements(e.value -> 'transactions') r where e.name = 'export a' and r ->> 'amount_minor' = '-20000'
     order by 1 $$,
  $$ select 'Current', jsonb_build_object('id', i #>> '{accounts,main}', 'name', 'Current', 'kind', 'cash', 'currency', 'EUR', 'opening_balance_minor', 500000,
       'opening_date', '2026-08-01', 'terms', null, 'funded_from_account_id', null,
       'floor_windows', '[{"from_month": "2026-10", "to_month": null, "amount_minor": 100000}]'::jsonb, 'fx_fee_pct', 0.007,
       'csv_mapping', '{"date": "Booking date"}'::jsonb, 'sort_order', 0, 'archived_at', null)
     from (select value -> 'ids' as i from results where name = 'import a') x
     union all select 'Savings', jsonb_build_object('id', i #>> '{accounts,savings}', 'name', 'Savings', 'kind', 'cash', 'currency', 'EUR', 'opening_balance_minor', 0,
       'opening_date', '2026-08-01', 'terms', null, 'funded_from_account_id', i #>> '{accounts,main}', 'floor_windows', '[]'::jsonb, 'fx_fee_pct', null,
       'csv_mapping', null, 'sort_order', 1, 'archived_at', '2026-10-01T00:00:00+00:00')
     from (select value -> 'ids' as i from results where name = 'import a') x
     union all select 'pay-out', jsonb_build_object('id', i #>> '{transactions,pay-out}', 'account_id', i #>> '{accounts,main}', 'posted_on', '2026-09-10',
       'amount_minor', -20000, 'kind', 'transfer', 'category_id', null, 'description', '', 'transfer_id', i #>> '{transfers,pay}',
       'plan_item_id', i #>> '{plan_items,card-payment}', 'period', '2026-09-01', 'external_id', null, 'batch_id', i #>> '{batches,sep-2}')
     from (select value -> 'ids' as i from results where name = 'import a') x
     order by 1 $$,
  'exported rows carry the stored values: numbers, dates as YYYY-MM-DD, json as json and timestamps with their offset'
);

select throws_ok(
  $$ select waypoint.import_household(d.doc) from docs d where d.name = 'a' $$,
  'P0001', 'household_not_empty: this household already holds accounts or categories; import_household fills an empty household only',
  'a second import into a household with rows raises household_not_empty'
);

reset role;

select results_eq(
  $$ select * from pg_temp.counts('0000000a-0000-0000-0000-000000000000') $$,
  $$ values ('households', 1), ('accounts', 3), ('categories', 2), ('plan_items', 5), ('statements', 1), ('transactions', 7) $$,
  'the refused second import adds nothing to A'
);

-- Refused imports, as C

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000c-0000-0000-0000-000000000000", "role": "authenticated"}';

select is(
  pg_temp.error_detail($$ select waypoint.import_household('{"version": 2, "rates": [],
    "household": {"base_currency": "EUR", "timezone": "UTC", "locale": "en", "track_from": "2026-09-01", "id": "0000000a-0000-0000-0000-000000000000"},
    "accounts": [
      {"id": "main", "name": "Main", "kind": "cash", "currency": "EUR", "opening_date": "2026-09-01", "household_id": "0000000a-0000-0000-0000-000000000000"},
      {"id": "main", "name": "Twin", "kind": "cash", "currency": "EUR", "opening_date": "2026-09-01"},
      {"name": "No id", "kind": "cash", "currency": "EUR", "opening_date": "2026-09-01"}],
    "statements": {}}') $$),
  jsonb_build_object('error', 'bad_input', 'issues', jsonb_build_array(
    'Unknown key ''rates''; allowed keys: version, household, accounts, categories, plan_items, statements, transactions, meals',
    'version: must be 1',
    'household: Unknown key ''id''; allowed keys: base_currency, timezone, locale, payoff_order, track_from',
    'statements: must be an array',
    'accounts: duplicate id ''main''',
    'accounts[0]: Unknown key ''household_id''; allowed keys: id, name, kind, currency, opening_balance_minor, opening_date, terms, funded_from_account_id, floor_windows, fx_fee_pct, csv_mapping, sort_order, archived_at',
    'accounts[2].id: must be a non-empty id')),
  'bad_input lists every problem: version, unknown keys, a table that is not an array, duplicate and missing ids'
);

select is(
  pg_temp.error_detail($$ select waypoint.import_household('{"version": 1,
    "household": {"base_currency": "EUR", "timezone": "UTC", "locale": "en", "track_from": "2026-09-01"},
    "accounts": [{"id": "main", "name": "Main", "kind": "cash", "currency": "EUR", "opening_date": "2026-09-01"}],
    "categories": [{"id": "food", "name": "Food"}],
    "plan_items": [{"id": "gym", "kind": "bill", "name": "Gym", "from_account_id": "nope", "amount_minor": 3000, "starts_on": "2026-09-05"}],
    "transactions": [{"id": "t1", "account_id": "main", "posted_on": "2026-09-05", "amount_minor": -3000, "kind": "expense", "category_id": "Food",
      "plan_item_id": "gym", "period": "2026-09-01"}]}') $$),
  jsonb_build_object('error', 'bad_input', 'issues', jsonb_build_array(
    'plan_items[0].from_account_id: no account ''nope'' in the document',
    'transactions[0].category_id: no category ''Food'' in the document')),
  'a reference to an id the document does not hold raises bad_input'
);

reset role;

select results_eq(
  $$ select * from pg_temp.counts('0000000c-0000-0000-0000-000000000000') $$,
  $$ values ('households', 0), ('accounts', 0), ('categories', 0), ('plan_items', 0), ('statements', 0), ('transactions', 0) $$,
  'an import refused for bad input leaves C without a household or any row'
);

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000c-0000-0000-0000-000000000000", "role": "authenticated"}';

select throws_like(
  $$ select waypoint.import_household('{"version": 1,
       "household": {"base_currency": "EUR", "timezone": "UTC", "locale": "en", "track_from": "2026-09-01"},
       "accounts": [{"id": "main", "name": "Main", "kind": "cash", "currency": "EUR", "opening_date": "2026-09-01"},
         {"id": "savings", "name": "Savings", "kind": "cash", "currency": "EUR", "opening_date": "2026-09-01"}],
       "plan_items": [{"id": "rent", "kind": "bill", "name": "Rent", "from_account_id": "main", "amount_minor": 90000, "starts_on": "2026-09-01"}],
       "transactions": [{"id": "t1", "account_id": "savings", "posted_on": "2026-09-01", "amount_minor": -90000, "kind": "expense",
         "plan_item_id": "rent", "period": "2026-09-01"}]}');
     set constraints all immediate $$,
  'check_link: transaction %: the expense must leave the bill''s account %',
  'a link the database refuses fails the import at commit'
);

reset role;

select results_eq(
  $$ select * from pg_temp.counts('0000000c-0000-0000-0000-000000000000') $$,
  $$ values ('households', 0), ('accounts', 0), ('categories', 0), ('plan_items', 0), ('statements', 0), ('transactions', 0) $$,
  'a bad reference rolls the whole import back, the household included'
);

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000c-0000-0000-0000-000000000000", "role": "authenticated"}';

select is(waypoint.export_household(), null, 'export_household returns null for a user with no household');

-- B against A's ids

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000b-0000-0000-0000-000000000000", "role": "authenticated"}';

select throws_ok(
  format($$ select waypoint.import_household(%L) $$, format('{"version": 1,
    "household": {"base_currency": "USD", "timezone": "America/Chicago", "locale": "en-US", "track_from": "2026-09-01"},
    "accounts": [{"id": "b-main", "name": "Checking", "kind": "cash", "currency": "USD", "opening_date": "2026-09-01"}],
    "plan_items": [{"id": "gym", "kind": "bill", "name": "Gym", "from_account_id": "%s", "amount_minor": 3000, "starts_on": "2026-09-05"}],
    "transactions": [{"id": "t1", "account_id": "%s", "posted_on": "2026-09-05", "amount_minor": -3000, "kind": "expense"}]}',
    r.value #>> '{ids,accounts,card}', r.value #>> '{ids,accounts,main}')),
  'P0001',
  format('bad_input: plan_items[0].from_account_id: no account ''%s'' in the document; transactions[0].account_id: no account ''%s'' in the document',
    r.value #>> '{ids,accounts,card}', r.value #>> '{ids,accounts,main}'),
  'an import by B whose rows reference the account ids of A is refused'
)
from results r where r.name = 'import a';

reset role;

select results_eq(
  $$ select 'B', * from pg_temp.counts('0000000b-0000-0000-0000-000000000000')
     union all select 'A', * from pg_temp.counts('0000000a-0000-0000-0000-000000000000') $$,
  $$ values ('B', 'households', 0), ('B', 'accounts', 0), ('B', 'categories', 0), ('B', 'plan_items', 0), ('B', 'statements', 0), ('B', 'transactions', 0),
    ('A', 'households', 1), ('A', 'accounts', 3), ('A', 'categories', 2), ('A', 'plan_items', 5), ('A', 'statements', 1), ('A', 'transactions', 7) $$,
  'the refused import rolls back: B holds no row and A keeps every row'
);

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000b-0000-0000-0000-000000000000", "role": "authenticated"}';

select lives_ok(
  $$ insert into results select 'import b', waypoint.import_household(value) from results where name = 'export a';
     set constraints all immediate;
     set constraints all deferred $$,
  'B imports the export of A, whose document ids are the real ids of A'
);

insert into results select 'export b', waypoint.export_household();

select is(
  (select count(*)::int
   from (select '0000000a-0000-0000-0000-000000000000' as id union all
         select m.value from results r, jsonb_each(r.value -> 'ids') t, jsonb_each_text(t.value) m where r.name = 'import a') a
   where (select value::text from results where name = 'export b') like '%' || a.id || '%'),
  0,
  'the export_household() of B contains none of the ids of A'
);

select is(
  (select value from results where name = 'export b'),
  (select pg_temp.translated(a.value, b.value -> 'ids') from results a, results b where a.name = 'export a' and b.name = 'import b'),
  'the export of B is the export of A with every id swapped for the one B got'
);

-- delete_my_account

select lives_ok(
  $$ select waypoint.delete_my_account();
     set constraints all immediate;
     set constraints all deferred $$,
  'B calls delete_my_account and every deferred check passes'
);

reset role;

select results_eq(
  $$ select 'auth user', count(*)::int from auth.users where id = '0000000a-0000-0000-0000-000000000000'
     union all select * from pg_temp.counts('0000000a-0000-0000-0000-000000000000') $$,
  $$ values ('auth user', 1), ('households', 1), ('accounts', 3), ('categories', 2), ('plan_items', 5), ('statements', 1), ('transactions', 7) $$,
  'user B calling delete_my_account leaves the auth user of A and every row of A intact'
);

select results_eq(
  $$ select 'auth user', count(*)::int from auth.users where id = '0000000b-0000-0000-0000-000000000000'
     union all select * from pg_temp.counts('0000000b-0000-0000-0000-000000000000') $$,
  $$ values ('auth user', 0), ('households', 0), ('accounts', 0), ('categories', 0), ('plan_items', 0), ('statements', 0), ('transactions', 0) $$,
  'delete_my_account removes the auth user of B and every row of B'
);

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000a-0000-0000-0000-000000000000", "role": "authenticated"}';

select lives_ok(
  $$ select waypoint.delete_my_account();
     set constraints all immediate;
     set constraints all deferred $$,
  'A calls delete_my_account and every deferred check passes'
);

reset role;

select results_eq(
  $$ select 'auth user', count(*)::int from auth.users where id = '0000000a-0000-0000-0000-000000000000'
     union all select * from pg_temp.counts('0000000a-0000-0000-0000-000000000000') $$,
  $$ values ('auth user', 0), ('households', 0), ('accounts', 0), ('categories', 0), ('plan_items', 0), ('statements', 0), ('transactions', 0) $$,
  'A calling delete_my_account leaves no auth user and 0 rows of A in all six tables'
);

select results_eq(
  $$ select id from auth.users where id in ('0000000a-0000-0000-0000-000000000000', '0000000b-0000-0000-0000-000000000000', '0000000c-0000-0000-0000-000000000000') $$,
  $$ values ('0000000c-0000-0000-0000-000000000000'::uuid) $$,
  'only the two callers are gone from auth.users'
);

-- anon

set local role anon;
set local request.jwt.claims to '{"role": "anon"}';

select throws_ok($$ select waypoint.delete_my_account() $$, '42501', 'permission denied for function delete_my_account', 'anon cannot execute delete_my_account');
select throws_ok($$ select waypoint.export_household() $$, '42501', 'permission denied for function export_household', 'anon cannot execute export_household');
select throws_ok($$ select waypoint.import_household('{}') $$, '42501', 'permission denied for function import_household', 'anon cannot execute import_household');

reset role;

select * from finish();
rollback;
