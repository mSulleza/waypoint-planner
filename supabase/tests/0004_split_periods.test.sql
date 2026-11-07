begin;
select plan(13);

insert into auth.users (id, aud, role, email) values
  ('0000000c-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000c-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'es-ES', '2025-01-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_balance_minor, opening_date) values
  ('0000000c-0001-0000-0000-000000000001', '0000000c-0000-0000-0000-000000000000', 'Current', 'cash', 'EUR', 500000, '2025-01-01');

insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, every, starts_on, ends_on, skip_periods) values
  ('0000000c-0003-0000-0000-000000000001', '0000000c-0000-0000-0000-000000000000', 'bill', 'Phone', '0000000c-0001-0000-0000-000000000001', 4000, 'month', '2026-01-20', null, '{2026-09-01}'),
  ('0000000c-0003-0000-0000-000000000002', '0000000c-0000-0000-0000-000000000000', 'bill', 'Insurance', '0000000c-0001-0000-0000-000000000001', 6000, 'month', '2026-01-25', null, '{}'),
  ('0000000c-0003-0000-0000-000000000003', '0000000c-0000-0000-0000-000000000000', 'bill', 'Licence', '0000000c-0001-0000-0000-000000000001', 15000, 'year', '2025-03-15', null, '{}'),
  ('0000000c-0003-0000-0000-000000000004', '0000000c-0000-0000-0000-000000000000', 'bill', 'Cleaner', '0000000c-0001-0000-0000-000000000001', 3000, 'week', '2026-09-03', null, '{}');

insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
  ('0000000c-0004-0000-0000-000000000001', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-06-20', -4000, 'expense', '0000000c-0003-0000-0000-000000000001', '2026-06-01'),
  ('0000000c-0004-0000-0000-000000000002', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-07-20', -4000, 'expense', '0000000c-0003-0000-0000-000000000001', '2026-07-01'),
  ('0000000c-0004-0000-0000-000000000003', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-08-20', -4000, 'expense', '0000000c-0003-0000-0000-000000000001', '2026-08-01'),
  ('0000000c-0004-0000-0000-000000000004', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-06-25', -6000, 'expense', '0000000c-0003-0000-0000-000000000002', '2026-06-01'),
  ('0000000c-0004-0000-0000-000000000005', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-07-24', -6000, 'expense', '0000000c-0003-0000-0000-000000000002', '2026-07-01'),
  ('0000000c-0004-0000-0000-000000000006', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-03-15', -15000, 'expense', '0000000c-0003-0000-0000-000000000003', '2026-03-01'),
  ('0000000c-0004-0000-0000-000000000007', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-09-30', -15000, 'expense', '0000000c-0003-0000-0000-000000000003', '2027-03-01'),
  ('0000000c-0004-0000-0000-000000000008', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-09-10', -3000, 'expense', '0000000c-0003-0000-0000-000000000004', '2026-09-10'),
  ('0000000c-0004-0000-0000-000000000009', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-09-17', -3000, 'expense', '0000000c-0003-0000-0000-000000000004', '2026-09-17'),
  ('0000000c-0004-0000-0000-000000000010', '0000000c-0000-0000-0000-000000000000', '0000000c-0001-0000-0000-000000000001', '2026-10-01', -3000, 'expense', '0000000c-0003-0000-0000-000000000004', '2026-10-01');

set constraints all immediate;
set constraints all deferred;

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000c-0000-0000-0000-000000000000", "role": "authenticated"}';

-- Monthly, split in July

select lives_ok(
  $$ select waypoint.split_plan_item('0000000c-0003-0000-0000-000000000001', '2026-07-01', '{"amount_minor": 4500}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a mid-year split of a linked monthly bill passes at commit'
);
select results_eq(
  $$ select starts_on, ends_on, amount_minor, skip_periods from waypoint.plan_items where name = 'Phone' order by starts_on $$,
  $$ values ('2026-01-20'::date, '2026-06-30'::date, 4000::bigint, '{}'::date[]), ('2026-07-20', null, 4500, '{2026-09-01}') $$,
  'the copy starts on 20 July and takes the September skip with its first-of-month period'
);
select results_eq(
  $$ select t.id, t.period, p.starts_on from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id where p.name = 'Phone' order by t.id $$,
  $$ values ('0000000c-0004-0000-0000-000000000001'::uuid, '2026-06-01'::date, '2026-01-20'::date),
            ('0000000c-0004-0000-0000-000000000002', '2026-07-01', '2026-07-20'),
            ('0000000c-0004-0000-0000-000000000003', '2026-08-01', '2026-07-20') $$,
  'links from July move to the copy and keep their first-of-month period'
);
select throws_ok(
  $$ select waypoint.split_plan_item((select id from waypoint.plan_items where name = 'Phone' and starts_on = '2026-07-20'), '2026-08-15', '{"ends_on": "2026-08-31"}') $$,
  'P0001', 'bad_split: the occurrence 2026-09-01 is linked or skipped, and the new row has no occurrence to take it; unlink or unskip it first',
  'a first-of-month period before the copy''s start day is its occurrence; only the period past its end is refused'
);

-- Monthly, split mid-month before the month's occurrence

select lives_ok(
  $$ select waypoint.split_plan_item('0000000c-0003-0000-0000-000000000002', '2026-06-10', '{"amount_minor": 6500}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a mid-month split of a linked monthly bill passes at commit'
);
select results_eq(
  $$ select starts_on, ends_on, amount_minor from waypoint.plan_items where name = 'Insurance' order by starts_on $$,
  $$ values ('2026-01-25'::date, '2026-06-09'::date, 6000::bigint), ('2026-06-25', null, 6500) $$,
  'the old row ends the day before the split and the copy takes June''s occurrence on the 25th'
);
select results_eq(
  $$ select t.period, p.starts_on from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id where p.name = 'Insurance' order by t.period $$,
  $$ values ('2026-06-01'::date, '2026-06-25'::date), ('2026-07-01', '2026-06-25') $$,
  'the June link moves with its occurrence and keeps its first-of-month period'
);

-- Yearly

select lives_ok(
  $$ select waypoint.split_plan_item('0000000c-0003-0000-0000-000000000003', '2026-07-01', '{"amount_minor": 16000}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a split of a linked yearly bill passes at commit'
);
select results_eq(
  $$ select t.period, p.starts_on, p.ends_on from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id where p.name = 'Licence' order by t.period $$,
  $$ values ('2026-03-01'::date, '2025-03-15'::date, '2026-06-30'::date), ('2027-03-01', '2027-03-15', null) $$,
  'a yearly link keeps the first of its month on whichever row takes its year'
);

-- Weekly

select lives_ok(
  $$ select waypoint.split_plan_item('0000000c-0003-0000-0000-000000000004', '2026-09-15', '{"amount_minor": 3500}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a split of a linked weekly bill passes at commit'
);
select results_eq(
  $$ select starts_on, ends_on, amount_minor from waypoint.plan_items where name = 'Cleaner' order by starts_on $$,
  $$ values ('2026-09-03'::date, '2026-09-14'::date, 3000::bigint), ('2026-09-17', null, 3500) $$,
  'the weekly copy starts on the next weekday occurrence'
);
select results_eq(
  $$ select t.period, p.starts_on from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id where p.name = 'Cleaner' order by t.period $$,
  $$ values ('2026-09-10'::date, '2026-09-03'::date), ('2026-09-17', '2026-09-17'), ('2026-10-01', '2026-09-17') $$,
  'weekly links keep their dated period'
);

select is(
  (select count(*)::int from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id
    where p.every not in ('week', '2weeks') and t.period <> date_trunc('month', t.period)::date),
  0,
  'after the splits every link to a monthly or yearly item is on the first of its month'
);

reset role;

select * from finish();
rollback;
