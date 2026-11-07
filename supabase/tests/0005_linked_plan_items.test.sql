begin;
select plan(9);

insert into auth.users (id, aud, role, email) values
  ('0000000d-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'd@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000d-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'es-ES', '2026-09-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_date, funded_from_account_id, terms) values
  ('0000000d-0001-0000-0000-000000000001', '0000000d-0000-0000-0000-000000000000', 'Current', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000d-0001-0000-0000-000000000002', '0000000d-0000-0000-0000-000000000000', 'Savings', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000d-0001-0000-0000-000000000003', '0000000d-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '0000000d-0001-0000-0000-000000000001', '{}');

insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
  ('0000000d-0003-0000-0000-000000000001', '0000000d-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000d-0001-0000-0000-000000000001', null, 90000, '2026-09-01'),
  ('0000000d-0003-0000-0000-000000000002', '0000000d-0000-0000-0000-000000000000', 'income', 'Salary', null, '0000000d-0001-0000-0000-000000000001', 300000, '2026-09-28'),
  ('0000000d-0003-0000-0000-000000000003', '0000000d-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000d-0001-0000-0000-000000000001', null, 3000, '2026-09-05');

insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
  ('0000000d-0004-0000-0000-000000000001', '0000000d-0000-0000-0000-000000000000', '0000000d-0001-0000-0000-000000000001', '2026-09-01', -90000, 'expense', '0000000d-0003-0000-0000-000000000001', '2026-09-01'),
  ('0000000d-0004-0000-0000-000000000002', '0000000d-0000-0000-0000-000000000000', '0000000d-0001-0000-0000-000000000001', '2026-09-28', 300000, 'income', '0000000d-0003-0000-0000-000000000002', '2026-09-01');

set constraints all immediate;
set constraints all deferred;

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000d-0000-0000-0000-000000000000", "role": "authenticated"}';

-- A linked item keeps its kind and accounts

select throws_ok(
  $$ update waypoint.plan_items set kind = 'transfer' where id = '0000000d-0003-0000-0000-000000000001'; set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000d-0003-0000-0000-000000000001: its linked transactions fix its kind and accounts; split_plan_item changes the accounts from a later period',
  'turning a linked bill into extra for debts is refused at commit'
);
select throws_ok(
  $$ update waypoint.plan_items set from_account_id = '0000000d-0001-0000-0000-000000000003' where id = '0000000d-0003-0000-0000-000000000001'; set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000d-0003-0000-0000-000000000001: its linked transactions fix its kind and accounts; split_plan_item changes the accounts from a later period',
  'moving a linked bill onto a card is refused at commit'
);
select throws_ok(
  $$ update waypoint.plan_items set to_account_id = '0000000d-0001-0000-0000-000000000002' where id = '0000000d-0003-0000-0000-000000000002'; set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000d-0003-0000-0000-000000000002: its linked transactions fix its kind and accounts; split_plan_item changes the accounts from a later period',
  'moving a linked income item to another account is refused at commit'
);

-- Amount, day and end stay editable

select lives_ok(
  $$ update waypoint.plan_items
       set kind = 'bill', from_account_id = '0000000d-0001-0000-0000-000000000001', to_account_id = null,
         amount_minor = 95000, starts_on = '2026-09-03', ends_on = '2027-08-31'
       where id = '0000000d-0003-0000-0000-000000000001';
     set constraints all immediate;
     set constraints all deferred $$,
  'a linked bill takes a new amount, day and end, restating its kind and account, at commit'
);
select results_eq(
  $$ select kind, from_account_id, amount_minor, starts_on, ends_on from waypoint.plan_items where id = '0000000d-0003-0000-0000-000000000001' $$,
  $$ values ('bill'::text, '0000000d-0001-0000-0000-000000000001'::uuid, 95000::bigint, '2026-09-03'::date, '2027-08-31'::date) $$,
  'the linked bill keeps its kind and account with the new amount, day and end'
);

-- An unlinked item can move

select lives_ok(
  $$ update waypoint.plan_items set from_account_id = '0000000d-0001-0000-0000-000000000003' where id = '0000000d-0003-0000-0000-000000000003';
     set constraints all immediate;
     set constraints all deferred $$,
  'moving an unlinked bill onto a card passes at commit'
);
select results_eq(
  $$ select from_account_id from waypoint.plan_items where id = '0000000d-0003-0000-0000-000000000003' $$,
  $$ values ('0000000d-0001-0000-0000-000000000003'::uuid) $$,
  'the unlinked bill now leaves the card'
);

-- split_plan_item moves a linked item's accounts from a later period

select lives_ok(
  $$ select waypoint.split_plan_item('0000000d-0003-0000-0000-000000000001', '2026-10-01', '{"from_account_id": "0000000d-0001-0000-0000-000000000003"}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a split moves a linked bill onto a card from October at commit'
);
select results_eq(
  $$ select p.starts_on, p.ends_on, p.from_account_id, count(t.id)::int from waypoint.plan_items p left join waypoint.transactions t on t.plan_item_id = p.id
     where p.name = 'Rent' group by p.id order by p.starts_on $$,
  $$ values ('2026-09-03'::date, '2026-09-30'::date, '0000000d-0001-0000-0000-000000000001'::uuid, 1),
            ('2026-10-03', '2027-08-31', '0000000d-0001-0000-0000-000000000003', 0) $$,
  'the September link stays on the old row with the cash account; the card row starts 3 October'
);

reset role;

select * from finish();
rollback;
