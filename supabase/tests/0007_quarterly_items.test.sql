begin;
select plan(14);

insert into auth.users (id, aud, role, email) values
  ('0000000e-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000e-0000-0000-0000-000000000000', 'PHP', 'Asia/Manila', 'en-PH', '2026-01-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_balance_minor, opening_date, funded_from_account_id, terms) values
  ('0000000e-0001-0000-0000-000000000001', '0000000e-0000-0000-0000-000000000000', 'Bank', 'cash', 'PHP', 5000000, '2026-01-01', null, null),
  ('0000000e-0001-0000-0000-000000000002', '0000000e-0000-0000-0000-000000000000', 'Savings', 'cash', 'PHP', 0, '2026-01-01', null, null),
  ('0000000e-0001-0000-0000-000000000003', '0000000e-0000-0000-0000-000000000000', 'Card', 'credit_card', 'PHP', 0, '2026-01-01', '0000000e-0001-0000-0000-000000000001', '{}');

insert into waypoint.categories (id, household_id, name) values
  ('0000000e-0002-0000-0000-000000000001', '0000000e-0000-0000-0000-000000000000', 'Food');

-- A quarterly fee from 15 Jan: linked in January, April and July, October skipped; and a monthly food budget.
insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, category_id, amount_minor, every, starts_on, skip_periods) values
  ('0000000e-0003-0000-0000-000000000001', '0000000e-0000-0000-0000-000000000000', 'bill', 'Accountant', '0000000e-0001-0000-0000-000000000001', null, 450000, 'quarter', '2026-01-15', '{2026-10-01}'),
  ('0000000e-0003-0000-0000-000000000002', '0000000e-0000-0000-0000-000000000000', 'allowance', 'Groceries', '0000000e-0001-0000-0000-000000000001', '0000000e-0002-0000-0000-000000000001', 30000, 'month', '2026-01-01', '{}');

insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
  ('0000000e-0004-0000-0000-000000000001', '0000000e-0000-0000-0000-000000000000', '0000000e-0001-0000-0000-000000000001', '2026-01-15', -450000, 'expense', '0000000e-0003-0000-0000-000000000001', '2026-01-01'),
  ('0000000e-0004-0000-0000-000000000002', '0000000e-0000-0000-0000-000000000000', '0000000e-0001-0000-0000-000000000001', '2026-04-15', -450000, 'expense', '0000000e-0003-0000-0000-000000000001', '2026-04-01'),
  ('0000000e-0004-0000-0000-000000000003', '0000000e-0000-0000-0000-000000000000', '0000000e-0001-0000-0000-000000000001', '2026-07-15', -450000, 'expense', '0000000e-0003-0000-0000-000000000001', '2026-07-01');

set constraints all immediate;
set constraints all deferred;

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000e-0000-0000-0000-000000000000", "role": "authenticated"}';

-- Which kinds repeat every 3 months

select lives_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, to_account_id, amount_minor, every, starts_on) values ('0000000e-0000-0000-0000-000000000000', 'income', 'Dividends', '0000000e-0001-0000-0000-000000000001', 100000, 'quarter', '2026-03-31');
     insert into waypoint.plan_items (household_id, kind, name, from_account_id, to_account_id, amount_minor, every, starts_on) values ('0000000e-0000-0000-0000-000000000000', 'transfer', 'To savings', '0000000e-0001-0000-0000-000000000001', '0000000e-0001-0000-0000-000000000002', 200000, 'quarter', '2026-02-01');
     insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, every, starts_on) values ('0000000e-0000-0000-0000-000000000000', 'bill', 'Card fee', '0000000e-0001-0000-0000-000000000003', 50000, 'quarter', '2026-02-10');
     set constraints all immediate;
     set constraints all deferred $$,
  'income, a transfer and a bill on a card repeat every 3 months and pass at commit'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, category_id, amount_minor, every, starts_on) values ('0000000e-0000-0000-0000-000000000000', 'allowance', 'Food', '0000000e-0001-0000-0000-000000000001', '0000000e-0002-0000-0000-000000000001', 30000, 'quarter', '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_quarter_check"',
  'an allowance is a monthly budget and never repeats every 3 months'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, every, starts_on, ends_on) values ('0000000e-0000-0000-0000-000000000000', 'installment', 'Laptop', '0000000e-0001-0000-0000-000000000003', 8000, 'quarter', '2026-10-01', '2027-09-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_installment_every_check"',
  'an installment bills every month, never every 3 months'
);
select throws_ok(
  $$ update waypoint.plan_items set kind = 'allowance', category_id = '0000000e-0002-0000-0000-000000000001' where name = 'Card fee' $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_quarter_check"',
  'a quarterly bill cannot become an allowance'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, every, starts_on) values ('0000000e-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000e-0001-0000-0000-000000000001', 3000, 'quarterly', '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_every_check"',
  'every takes quarter, not quarterly'
);

-- split_plan_item on a quarterly item

select throws_ok(
  $$ select waypoint.split_plan_item('0000000e-0003-0000-0000-000000000002', '2026-11-01', '{"every": "quarter"}') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_quarter_check"',
  'a split cannot start a quarterly allowance'
);
select lives_ok(
  $$ select waypoint.split_plan_item('0000000e-0003-0000-0000-000000000001', '2026-05-01', '{"amount_minor": 500000}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a split inside a quarter of a linked quarterly bill passes at commit'
);
select results_eq(
  $$ select starts_on, ends_on, amount_minor, skip_periods from waypoint.plan_items where name = 'Accountant' order by starts_on $$,
  $$ values ('2026-01-15'::date, '2026-04-30'::date, 450000::bigint, '{}'::date[]), ('2026-07-15', null, 500000, '{2026-10-01}') $$,
  'the copy starts at the next quarterly occurrence, 15 July, and takes the October skip'
);
select results_eq(
  $$ select t.period, p.starts_on from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id where p.name = 'Accountant' order by t.period $$,
  $$ values ('2026-01-01'::date, '2026-01-15'::date), ('2026-04-01', '2026-01-15'), ('2026-07-01', '2026-07-15') $$,
  'the July link moves to the copy and keeps its first-of-month period; January and April stay'
);
select lives_ok(
  $$ select waypoint.split_plan_item((select id from waypoint.plan_items where name = 'Accountant' and starts_on = '2026-07-15'), '2026-12-01', '{"day": 31}');
     set constraints all immediate;
     set constraints all deferred $$,
  'day moves a quarterly item from a month on, as it moves a monthly one'
);
select results_eq(
  $$ select starts_on, ends_on, skip_periods from waypoint.plan_items where name = 'Accountant' order by starts_on $$,
  $$ values ('2026-01-15'::date, '2026-04-30'::date, '{}'::date[]), ('2026-07-15', '2026-11-30', '{2026-10-01}'), ('2027-01-31', null, '{}') $$,
  'across the year end the copy starts on 31 January, the next quarter, with the day moved'
);
select throws_ok(
  $$ select waypoint.split_plan_item((select id from waypoint.plan_items where name = 'Card fee'), '2026-03-01', '{"every": "week", "day": 15}') $$,
  'P0001', 'bad_split: day moves an item that repeats monthly, every 3 months or yearly; an installment bills at the cut and a weekly item keeps its weekday',
  'day moves an item that repeats monthly, every 3 months or yearly, and nothing weekly'
);
select throws_ok(
  $$ update waypoint.plan_items set skip_periods = '{2026-06-01}' where name = 'To savings';
     select waypoint.split_plan_item((select id from waypoint.plan_items where name = 'To savings'), '2026-04-01', '{"amount_minor": 250000}') $$,
  'P0001', 'bad_split: the occurrence 2026-06-01 is linked or skipped, and the new row has no occurrence to take it; unlink or unskip it first',
  'a period between two quarterly occurrences has no occurrence on the copy, so it is refused'
);

select is(
  (select count(*)::int from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id
    where p.every = 'quarter' and t.period <> date_trunc('month', t.period)::date),
  0,
  'after the splits every link to a quarterly item is on the first of its month'
);

reset role;

select * from finish();
rollback;
