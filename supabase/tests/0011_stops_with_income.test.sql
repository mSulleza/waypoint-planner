begin;
select plan(8);

insert into auth.users (id, aud, role, email) values
  ('00000011-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stops@example.test'),
  ('00000011-0000-0000-0000-0000000000ff', 'authenticated', 'authenticated', 'import@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('00000011-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'en-GB', '2026-01-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_balance_minor, opening_date) values
  ('00000011-0001-0000-0000-000000000001', '00000011-0000-0000-0000-000000000000', 'Bank', 'cash', 'EUR', 500000, '2026-01-01');

-- A quarterly tax bill that stops with income, and rent that does not.
insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, every, starts_on, stops_with_income) values
  ('00000011-0003-0000-0000-000000000001', '00000011-0000-0000-0000-000000000000', 'bill', 'Income tax', '00000011-0001-0000-0000-000000000001', 329500, 'quarter', '2026-01-20', true),
  ('00000011-0003-0000-0000-000000000002', '00000011-0000-0000-0000-000000000000', 'bill', 'Rent', '00000011-0001-0000-0000-000000000001', 95000, 'month', '2026-01-01', false);

set local role authenticated;
set local request.jwt.claims to '{"sub": "00000011-0000-0000-0000-000000000000", "role": "authenticated"}';

select is(
  (select stops_with_income from waypoint.plan_items where name = 'Rent'),
  false,
  'a plan item keeps going while income is stopped unless it says otherwise'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, to_account_id, amount_minor, starts_on, stops_with_income) values ('00000011-0000-0000-0000-000000000000', 'income', 'Salary', '00000011-0001-0000-0000-000000000001', 600000, '2026-01-30', true) $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_stops_with_income_check"',
  'income always stops with income, so it never takes the flag'
);
select lives_ok(
  $$ update waypoint.plan_items set stops_with_income = true where name = 'Rent' $$,
  'a bill can be set to stop with income'
);

-- split_plan_item carries the flag into the new row, or changes it from that month.
do $$ begin
  perform waypoint.split_plan_item('00000011-0003-0000-0000-000000000001', '2026-07-01', '{"amount_minor": 350000}');
  perform waypoint.split_plan_item('00000011-0003-0000-0000-000000000002', '2026-07-01', '{"stops_with_income": false}');
end $$;
select is(
  (select stops_with_income from waypoint.plan_items where name = 'Income tax' and starts_on >= '2026-07-01'),
  true,
  'a split copies stops_with_income into the row it starts'
);
select is(
  (select array_agg(stops_with_income order by starts_on) from waypoint.plan_items where name = 'Rent'),
  array[true, false],
  'a split can change stops_with_income from a month on'
);

-- export_household writes the flag and import_household reads it, false when a document leaves it out.
select ok(
  (select bool_and(p ? 'stops_with_income') from jsonb_array_elements(waypoint.export_household() -> 'plan_items') p),
  'export_household writes stops_with_income on every plan item'
);
set local request.jwt.claims to '{"sub": "00000011-0000-0000-0000-0000000000ff", "role": "authenticated"}';
select lives_ok(
  $$ select waypoint.import_household(jsonb_build_object(
       'version', 1,
       'household', jsonb_build_object('base_currency', 'EUR', 'timezone', 'Europe/Madrid', 'locale', 'en-GB', 'track_from', '2026-01-01'),
       'accounts', jsonb_build_array(jsonb_build_object('id', 'bank', 'name', 'Bank', 'kind', 'cash', 'currency', 'EUR', 'opening_date', '2026-01-01')),
       'plan_items', jsonb_build_array(
         jsonb_build_object('id', 'tax', 'kind', 'bill', 'name', 'Tax', 'from_account_id', 'bank', 'amount_minor', 1000, 'starts_on', '2026-02-20', 'stops_with_income', true),
         jsonb_build_object('id', 'rent', 'kind', 'bill', 'name', 'Rent', 'from_account_id', 'bank', 'amount_minor', 1000, 'starts_on', '2026-02-01')))) $$,
  'import_household takes stops_with_income on a plan item'
);
select is(
  (select array_agg(p.stops_with_income order by p.name) from waypoint.plan_items p where p.household_id = '00000011-0000-0000-0000-0000000000ff'),
  array[false, true],
  'import_household reads stops_with_income and leaves it false when the document has none'
);

select * from finish();
rollback;
