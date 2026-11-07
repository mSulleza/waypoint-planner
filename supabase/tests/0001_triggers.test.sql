begin;
select plan(61);

insert into auth.users (id, aud, role, email) values
  ('0000000a-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000a-0000-0000-0000-000000000000', 'EUR', 'Europe/Berlin', 'de-DE', '2026-09-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_date, funded_from_account_id, terms) values
  ('0000000a-0001-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Current', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000a-0001-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'Savings', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000a-0001-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', 'Dollars', 'cash', 'USD', '2026-09-01', null, null),
  ('0000000a-0001-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '{}'),
  ('0000000a-0001-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', 'Loan', 'loan', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '{}');

insert into waypoint.categories (id, household_id, name) values
  ('0000000a-0002-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Food');

insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, category_id, amount_minor, starts_on, ends_on) values
  ('0000000a-0003-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000a-0001-0000-0000-000000000001', null, null, 90000, '2026-09-01', null),
  ('0000000a-0003-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'income', 'Salary', null, '0000000a-0001-0000-0000-000000000001', null, 300000, '2026-09-28', null),
  ('0000000a-0003-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', 'allowance', 'Food', '0000000a-0001-0000-0000-000000000001', null, '0000000a-0002-0000-0000-000000000001', 40000, '2026-09-01', null),
  ('0000000a-0003-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', 'transfer', 'To savings', '0000000a-0001-0000-0000-000000000001', '0000000a-0001-0000-0000-000000000002', null, 50000, '2026-09-28', null),
  ('0000000a-0003-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', 'transfer', 'Card payment', null, '0000000a-0001-0000-0000-000000000004', null, 20000, '2026-09-10', null),
  ('0000000a-0003-0000-0000-000000000006', '0000000a-0000-0000-0000-000000000000', 'transfer', 'Extra for debts', '0000000a-0001-0000-0000-000000000001', null, null, 10000, '2026-09-28', null),
  ('0000000a-0003-0000-0000-000000000007', '0000000a-0000-0000-0000-000000000000', 'installment', 'Laptop', '0000000a-0001-0000-0000-000000000004', null, null, 8000, '2026-10-01', '2027-09-01'),
  ('0000000a-0003-0000-0000-000000000008', '0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', null, null, 3000, '2026-09-05', null);

set constraints all immediate;
set constraints all deferred;

-- Every case runs as A through the API role, which has no rights on the private schema.
set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000a-0000-0000-0000-000000000000", "role": "authenticated"}';

-- transfer_pair

select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000001');
     set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000001 has 1 leg; a transfer has exactly 2',
  'a lone transfer leg is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000001'),
       ('0000000a-0004-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-01', 5000, 'transfer', '0000000a-0006-0000-0000-000000000001');
     set constraints all immediate;
     set constraints all deferred $$,
  'two legs of one transfer pass at commit'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000001');
     set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000001 has 3 legs; a transfer has exactly 2',
  'a third leg is refused at commit'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000002'),
       ('0000000a-0004-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000002');
     set constraints all immediate $$,
  '23514', 'transfer_pair: the legs of transfer 0000000a-0006-0000-0000-000000000002 need opposite signs',
  'two outgoing legs are refused at commit'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000002'),
       ('0000000a-0004-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-01', 5000, 'transfer', '0000000a-0006-0000-0000-000000000002');
     set constraints all immediate;
     set constraints all deferred $$,
  'an outgoing and an incoming leg pass at commit'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000003'),
       ('0000000a-0004-0000-0000-000000000006', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', 5000, 'transfer', '0000000a-0006-0000-0000-000000000003');
     set constraints all immediate $$,
  '23514', 'transfer_pair: both legs of transfer 0000000a-0006-0000-0000-000000000003 are on account 0000000a-0001-0000-0000-000000000001',
  'a transfer to the same account is refused at commit'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000003'),
       ('0000000a-0004-0000-0000-000000000006', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-07', 5000, 'transfer', '0000000a-0006-0000-0000-000000000003');
     set constraints all immediate $$,
  '23514', 'transfer_pair: the incoming leg of transfer 0000000a-0006-0000-0000-000000000003 must post 0 to 5 days after the outgoing leg (2026-10-01)',
  'an incoming leg 6 days late is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -5000, 'transfer', '0000000a-0006-0000-0000-000000000003'),
       ('0000000a-0004-0000-0000-000000000006', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-06', 5000, 'transfer', '0000000a-0006-0000-0000-000000000003');
     set constraints all immediate;
     set constraints all deferred $$,
  'an incoming leg 5 days late passes at commit'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000007', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-10', -5000, 'transfer', '0000000a-0006-0000-0000-000000000004'),
       ('0000000a-0004-0000-0000-000000000008', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-12', 5000, 'transfer', '0000000a-0006-0000-0000-000000000004');
     set constraints all immediate;
     set constraints all deferred $$,
  'legs 2 days apart pass at commit'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-10', -5000, 'transfer', '0000000a-0006-0000-0000-000000000005'),
       ('0000000a-0004-0000-0000-000000000010', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-09', 5000, 'transfer', '0000000a-0006-0000-0000-000000000005');
     set constraints all immediate $$,
  '23514', 'transfer_pair: the incoming leg of transfer 0000000a-0006-0000-0000-000000000005 must post 0 to 5 days after the outgoing leg (2026-10-10)',
  'an incoming leg dated before the outgoing leg is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-10', -5000, 'transfer', '0000000a-0006-0000-0000-000000000005'),
       ('0000000a-0004-0000-0000-000000000010', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-10', 5000, 'transfer', '0000000a-0006-0000-0000-000000000005');
     set constraints all immediate;
     set constraints all deferred $$,
  'legs on the same day pass at commit'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000011', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-10', -5000, 'transfer', '0000000a-0006-0000-0000-000000000006'),
       ('0000000a-0004-0000-0000-000000000012', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-10', 4990, 'transfer', '0000000a-0006-0000-0000-000000000006');
     set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000006 moves 5000 out and 4990 in within EUR; a fee is its own row',
  'unequal legs in one currency are refused at commit'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000011', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-10', -5000, 'transfer', '0000000a-0006-0000-0000-000000000006'),
       ('0000000a-0004-0000-0000-000000000012', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000003', '2026-10-11', 5815, 'transfer', '0000000a-0006-0000-0000-000000000006');
     set constraints all immediate;
     set constraints all deferred $$,
  'unequal legs across two currencies pass at commit'
);
select throws_ok(
  $$ update waypoint.transactions set amount_minor = -6000 where id = '0000000a-0004-0000-0000-000000000001'; set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000001 moves 6000 out and 5000 in within EUR; a fee is its own row',
  'editing one leg of a transfer is refused at commit'
);
select lives_ok(
  $$ update waypoint.transactions set amount_minor = case when amount_minor < 0 then -6000 else 6000 end where transfer_id = '0000000a-0006-0000-0000-000000000001';
     set constraints all immediate;
     set constraints all deferred $$,
  'editing both legs of a transfer passes at commit'
);
select throws_ok(
  $$ update waypoint.transactions set transfer_id = '0000000a-0006-0000-0000-000000000099' where id = '0000000a-0004-0000-0000-000000000002'; set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000001 has 1 leg; a transfer has exactly 2',
  'moving one leg to another transfer is refused at commit'
);
select throws_ok(
  $$ delete from waypoint.transactions where id = '0000000a-0004-0000-0000-000000000001'; set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000001 has 1 leg; a transfer has exactly 2',
  'a REST delete of one transfer leg is refused at commit'
);
select lives_ok(
  $$ delete from waypoint.transactions where transfer_id = '0000000a-0006-0000-0000-000000000001';
     set constraints all immediate;
     set constraints all deferred $$,
  'a REST delete of both legs by transfer id passes at commit'
);
select is(
  (select count(*)::int from waypoint.transactions where transfer_id = '0000000a-0006-0000-0000-000000000001'),
  0,
  'the deleted transfer has no legs left'
);

-- check_link

select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000021', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-01', -90000, 'expense', '0000000a-0003-0000-0000-000000000001', '2026-10-01');
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000021: the expense must leave the bill''s account 0000000a-0001-0000-0000-000000000001',
  'an expense from the wrong account cannot settle a bill'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000021', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -90000, 'expense', '0000000a-0003-0000-0000-000000000001', '2026-10-01');
     set constraints all immediate;
     set constraints all deferred $$,
  'an expense from the bill account settles the bill'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000022', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-02', -2500, 'expense', '0000000a-0002-0000-0000-000000000001', '0000000a-0003-0000-0000-000000000003', '2026-10-01');
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000022: an allowance settles by spending and takes no links',
  'a link to an allowance is refused'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id) values
       ('0000000a-0004-0000-0000-000000000022', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-02', -2500, 'expense', '0000000a-0002-0000-0000-000000000001');
     set constraints all immediate;
     set constraints all deferred $$,
  'spending tagged with the allowance category, unlinked, passes'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000023', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000004', '2026-10-03', -8000, 'expense', '0000000a-0003-0000-0000-000000000007', '2026-10-01');
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000023: an installment settles through statements and takes no links',
  'a link to an installment is refused'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values
       ('0000000a-0004-0000-0000-000000000031', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000004', '2026-10-03', -8000, 'expense');
     set constraints all immediate;
     set constraints all deferred $$,
  'the same card charge, unlinked, passes'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000023', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-03', -10000, 'transfer', '0000000a-0006-0000-0000-000000000021', '0000000a-0003-0000-0000-000000000006', '2026-10-01'),
       ('0000000a-0004-0000-0000-000000000024', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000004', '2026-10-03', 10000, 'transfer', '0000000a-0006-0000-0000-000000000021', null, null);
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000023: extra for debts is sized by the engine and takes no links',
  'a link to extra for debts is refused'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values
       ('0000000a-0004-0000-0000-000000000032', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-03', -10000, 'transfer', '0000000a-0006-0000-0000-000000000031'),
       ('0000000a-0004-0000-0000-000000000033', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000004', '2026-10-03', 10000, 'transfer', '0000000a-0006-0000-0000-000000000031');
     set constraints all immediate;
     set constraints all deferred $$,
  'the same extra payment, unlinked, passes'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000023', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-03', 120, 'adjustment', '0000000a-0003-0000-0000-000000000002', '2026-10-01');
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000023: an adjustment never links',
  'an adjustment never links'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values
       ('0000000a-0004-0000-0000-000000000034', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-03', 120, 'adjustment');
     set constraints all immediate;
     set constraints all deferred $$,
  'the same adjustment, unlinked, passes'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000023', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-03', 300000, 'income', '0000000a-0003-0000-0000-000000000001', '2026-10-01');
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000023: income links only to an income item, not to a bill',
  'income cannot settle a bill'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000023', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-28', 300000, 'income', '0000000a-0003-0000-0000-000000000002', '2026-10-01');
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000023: the income must land in the item''s account 0000000a-0001-0000-0000-000000000001',
  'income landing in the wrong account cannot settle an income item'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000023', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-28', -300000, 'expense', '0000000a-0003-0000-0000-000000000002', '2026-10-01');
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000023: an expense links only to a bill, not to an income item',
  'an expense cannot settle an income item'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000023', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-28', 300000, 'income', '0000000a-0003-0000-0000-000000000002', '2026-10-01'),
       ('0000000a-0004-0000-0000-000000000024', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-29', 2500, 'refund', '0000000a-0003-0000-0000-000000000002', '2026-10-01');
     set constraints all immediate;
     set constraints all deferred $$,
  'income and a refund landing in the item account settle an income item'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000025', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -90000, 'transfer', '0000000a-0006-0000-0000-000000000022', '0000000a-0003-0000-0000-000000000001', '2026-11-01'),
       ('0000000a-0004-0000-0000-000000000026', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-01', 90000, 'transfer', '0000000a-0006-0000-0000-000000000022', null, null);
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000025: a transfer links only to a transfer item, not to a bill',
  'a transfer cannot settle a bill'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000025', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000003', '2026-10-28', -58000, 'transfer', '0000000a-0006-0000-0000-000000000022', '0000000a-0003-0000-0000-000000000004', '2026-10-01'),
       ('0000000a-0004-0000-0000-000000000026', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-28', 50000, 'transfer', '0000000a-0006-0000-0000-000000000022', null, null);
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000025: the outgoing leg must leave the item''s account 0000000a-0001-0000-0000-000000000001',
  'an outgoing leg from the wrong account cannot settle a transfer item'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000025', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-28', -50000, 'transfer', '0000000a-0006-0000-0000-000000000022', '0000000a-0003-0000-0000-000000000004', '2026-10-01'),
       ('0000000a-0004-0000-0000-000000000026', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000003', '2026-10-28', 58000, 'transfer', '0000000a-0006-0000-0000-000000000022', null, null);
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000025: the other leg must land in the item''s account 0000000a-0001-0000-0000-000000000002',
  'an incoming leg in the wrong account cannot settle a transfer item'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000025', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-28', -50000, 'transfer', '0000000a-0006-0000-0000-000000000022', '0000000a-0003-0000-0000-000000000004', '2026-10-01'),
       ('0000000a-0004-0000-0000-000000000026', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-28', 50000, 'transfer', '0000000a-0006-0000-0000-000000000022', null, null);
     set constraints all immediate;
     set constraints all deferred $$,
  'a transfer from the item account to the item account settles a transfer item'
);
select throws_ok(
  $$ update waypoint.transactions set account_id = '0000000a-0001-0000-0000-000000000003', amount_minor = 58000 where id = '0000000a-0004-0000-0000-000000000026'; set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000025: the other leg must land in the item''s account 0000000a-0001-0000-0000-000000000002',
  'moving the unlinked leg of a linked transfer to another account is refused at commit'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000027', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000005', '2026-10-10', -20000, 'transfer', '0000000a-0006-0000-0000-000000000023', '0000000a-0003-0000-0000-000000000005', '2026-10-01'),
       ('0000000a-0004-0000-0000-000000000028', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000004', '2026-10-11', 20000, 'transfer', '0000000a-0006-0000-0000-000000000023', null, null);
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000027: the outgoing leg of a payment into a debt must leave a cash account',
  'a payment into a debt from another debt cannot settle the payment item'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000027', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-10', -20000, 'transfer', '0000000a-0006-0000-0000-000000000023', '0000000a-0003-0000-0000-000000000005', '2026-10-01'),
       ('0000000a-0004-0000-0000-000000000028', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000004', '2026-10-11', 20000, 'transfer', '0000000a-0006-0000-0000-000000000023', null, null);
     set constraints all immediate;
     set constraints all deferred $$,
  'a payment from the card funding account into the card settles the payment item'
);
select lives_ok(
  $$ update waypoint.accounts set funded_from_account_id = '0000000a-0001-0000-0000-000000000002' where id = '0000000a-0001-0000-0000-000000000004';
     update waypoint.transactions set description = 'October card payment' where id = '0000000a-0004-0000-0000-000000000027';
     set constraints all immediate;
     set constraints all deferred $$,
  'after the card funding account changes, editing an old linked payment leg passes at commit'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
       ('0000000a-0004-0000-0000-000000000029', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-11-10', -20000, 'transfer', '0000000a-0006-0000-0000-000000000024', '0000000a-0003-0000-0000-000000000005', '2026-11-01'),
       ('0000000a-0004-0000-0000-000000000030', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000004', '2026-11-11', 20000, 'transfer', '0000000a-0006-0000-0000-000000000024', null, null);
     set constraints all immediate;
     set constraints all deferred $$,
  'a payment from the new funding account settles the next period'
);
select is(
  (select description from waypoint.transactions where id = '0000000a-0004-0000-0000-000000000027'),
  'October card payment',
  'the old linked leg kept its edit'
);

-- check_plan_item

select throws_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000011', '0000000a-0000-0000-0000-000000000000', 'transfer', 'Card extra', '0000000a-0001-0000-0000-000000000001', '0000000a-0001-0000-0000-000000000004', 5000, '2026-10-15');
     set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000a-0003-0000-0000-000000000011: a transfer with both accounts moves cash to cash; one into a debt has no from account and leaves the debt''s funded-from account',
  'a transfer item into a card with a from account is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000011', '0000000a-0000-0000-0000-000000000000', 'transfer', 'Card extra', null, '0000000a-0001-0000-0000-000000000004', 5000, '2026-10-15');
     set constraints all immediate;
     set constraints all deferred $$,
  'a transfer item into a card with no from account passes at commit'
);
select throws_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000012', '0000000a-0000-0000-0000-000000000000', 'transfer', 'From the card', '0000000a-0001-0000-0000-000000000004', null, 5000, '2026-10-15');
     set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000a-0003-0000-0000-000000000012: extra for debts leaves a cash account',
  'extra for debts from a card is refused at commit'
);
select throws_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000012', '0000000a-0000-0000-0000-000000000000', 'transfer', 'From the card', '0000000a-0001-0000-0000-000000000004', '0000000a-0001-0000-0000-000000000001', 5000, '2026-10-15');
     set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000a-0003-0000-0000-000000000012: a transfer with both accounts moves cash to cash; one into a debt has no from account and leaves the debt''s funded-from account',
  'a transfer item from a card into cash is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000012', '0000000a-0000-0000-0000-000000000000', 'transfer', 'More for debts', '0000000a-0001-0000-0000-000000000002', null, 5000, '2026-10-15');
     set constraints all immediate;
     set constraints all deferred $$,
  'extra for debts from a cash account passes at commit'
);
select throws_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000013', '0000000a-0000-0000-0000-000000000000', 'transfer', 'Into savings', null, '0000000a-0001-0000-0000-000000000002', 5000, '2026-10-15');
     set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000a-0003-0000-0000-000000000013: a transfer with no from account goes into a debt',
  'a transfer item with no from account into cash is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000013', '0000000a-0000-0000-0000-000000000000', 'transfer', 'Loan extra', null, '0000000a-0001-0000-0000-000000000005', 5000, '2026-10-15');
     set constraints all immediate;
     set constraints all deferred $$,
  'a transfer item with no from account into a loan passes at commit'
);
select throws_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000014', '0000000a-0000-0000-0000-000000000000', 'bill', 'Fee', '0000000a-0001-0000-0000-000000000005', 1500, '2026-10-15');
     set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000a-0003-0000-0000-000000000014: a bill leaves a cash account or a card, to no account',
  'a bill from a loan is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000014', '0000000a-0000-0000-0000-000000000000', 'bill', 'Streaming', '0000000a-0001-0000-0000-000000000004', 1500, '2026-10-15');
     set constraints all immediate;
     set constraints all deferred $$,
  'a bill charged to a card passes at commit'
);
select throws_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, category_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000015', '0000000a-0000-0000-0000-000000000000', 'allowance', 'Food on credit', '0000000a-0001-0000-0000-000000000005', '0000000a-0002-0000-0000-000000000001', 10000, '2026-10-01');
     set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000a-0003-0000-0000-000000000015: an allowance leaves a cash account or a card, to no account',
  'an allowance from a loan is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, category_id, amount_minor, starts_on) values
       ('0000000a-0003-0000-0000-000000000015', '0000000a-0000-0000-0000-000000000000', 'allowance', 'Food on credit', '0000000a-0001-0000-0000-000000000004', '0000000a-0002-0000-0000-000000000001', 10000, '2026-10-01');
     set constraints all immediate;
     set constraints all deferred $$,
  'an allowance spent on a card passes at commit'
);
select throws_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on, ends_on) values
       ('0000000a-0003-0000-0000-000000000016', '0000000a-0000-0000-0000-000000000000', 'installment', 'Phone', '0000000a-0001-0000-0000-000000000001', 4000, '2026-10-01', '2027-03-01');
     set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000a-0003-0000-0000-000000000016: an installment sits on a card, to no account',
  'an installment on a cash account is refused at commit'
);
select lives_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on, ends_on) values
       ('0000000a-0003-0000-0000-000000000016', '0000000a-0000-0000-0000-000000000000', 'installment', 'Phone', '0000000a-0001-0000-0000-000000000004', 4000, '2026-10-01', '2027-03-01');
     set constraints all immediate;
     set constraints all deferred $$,
  'an installment on a card passes at commit'
);
select lives_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, to_account_id, amount_minor, every, starts_on) values
       ('0000000a-0003-0000-0000-000000000017', '0000000a-0000-0000-0000-000000000000', 'income', 'Loan paid to the card', '0000000a-0001-0000-0000-000000000004', 150000, 'once', '2026-10-18');
     set constraints all immediate;
     set constraints all deferred $$,
  'income onto a debt, a planned draw, passes at commit'
);
select throws_ok(
  $$ update waypoint.plan_items set from_account_id = '0000000a-0001-0000-0000-000000000005' where id = '0000000a-0003-0000-0000-000000000008'; set constraints all immediate $$,
  '23514', 'check_plan_item: plan item 0000000a-0003-0000-0000-000000000008: a bill leaves a cash account or a card, to no account',
  'moving a bill onto a loan is refused at commit'
);
select lives_ok(
  $$ update waypoint.plan_items set from_account_id = '0000000a-0001-0000-0000-000000000004' where id = '0000000a-0003-0000-0000-000000000008';
     set constraints all immediate;
     set constraints all deferred $$,
  'moving a bill onto a card passes at commit'
);

-- linked plan items

select throws_ok(
  $$ delete from waypoint.plan_items where id = '0000000a-0003-0000-0000-000000000001' $$,
  '23503', 'update or delete on table "plan_items" violates foreign key constraint "transactions_plan_item_fkey" on table "transactions"',
  'a linked plan item cannot be deleted'
);
select lives_ok(
  $$ update waypoint.plan_items set ends_on = '2026-10-31' where id = '0000000a-0003-0000-0000-000000000001';
     delete from waypoint.plan_items where id = '0000000a-0003-0000-0000-000000000008';
     set constraints all immediate;
     set constraints all deferred $$,
  'a linked plan item can be ended, and an unlinked one deleted'
);

reset role;

select * from finish();
rollback;
