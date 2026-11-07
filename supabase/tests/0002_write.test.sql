begin;
select plan(58);

insert into auth.users (id, aud, role, email) values
  ('0000000a-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test'),
  ('0000000b-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000a-0000-0000-0000-000000000000', 'EUR', 'Europe/Berlin', 'de-DE', '2026-09-01'),
  ('0000000b-0000-0000-0000-000000000000', 'USD', 'America/Chicago', 'en-US', '2026-09-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_balance_minor, opening_date, funded_from_account_id, terms) values
  ('0000000a-0001-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Current', 'cash', 'EUR', 500000, '2026-08-01', null, null),
  ('0000000a-0001-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'Savings', 'cash', 'EUR', 0, '2026-08-01', null, null),
  ('0000000a-0001-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', -40000, '2026-08-01', '0000000a-0001-0000-0000-000000000001', '{}'),
  ('0000000a-0001-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', 'Card2', 'credit_card', 'EUR', -40000, '2026-08-01', '0000000a-0001-0000-0000-000000000001', '{}'),
  ('0000000a-0001-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', 'Loan', 'loan', 'EUR', -1000000, '2026-08-01', '0000000a-0001-0000-0000-000000000001', '{}'),
  ('0000000b-0001-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', 'Checking', 'cash', 'USD', 0, '2026-08-01', null, null);

insert into waypoint.categories (id, household_id, name) values
  ('0000000a-0002-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Food');

insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on, ends_on, skip_periods) values
  ('0000000a-0003-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000a-0001-0000-0000-000000000001', 90000, '2026-09-01', null, '{}'),
  ('0000000a-0003-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', 3000, '2026-09-05', null, '{2026-12-01}'),
  ('0000000a-0003-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', 'installment', 'Laptop', '0000000a-0001-0000-0000-000000000003', 8000, '2026-06-01', '2027-05-01', '{}'),
  ('0000000b-0003-0000-0000-000000000001', '0000000b-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000b-0001-0000-0000-000000000001', 120000, '2026-09-01', null, '{}');

-- Card: statements cut 20 Aug (50,000) and 20 Sep (30,000), and 45,000 paid on 5 Sep, so 5,000 is left on the August one.
insert into waypoint.statements (id, household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values
  ('0000000a-0005-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000003', '2026-08-20', '2026-09-10', 50000, 5000),
  ('0000000a-0005-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000003', '2026-09-20', '2026-10-10', 30000, 3000);

insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values
  ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-09-01', -90000, 'expense', null, '0000000a-0003-0000-0000-000000000001', '2026-09-01'),
  ('0000000a-0004-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-09-29', -90000, 'expense', null, '0000000a-0003-0000-0000-000000000001', '2026-10-01'),
  ('0000000a-0004-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-09-05', -45000, 'transfer', '0000000a-0006-0000-0000-000000000001', null, null),
  ('0000000a-0004-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000003', '2026-09-05', 45000, 'transfer', '0000000a-0006-0000-0000-000000000001', null, null),
  ('0000000a-0004-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-05', -3000, 'expense', null, '0000000a-0003-0000-0000-000000000002', '2026-10-01'),
  ('0000000a-0004-0000-0000-000000000006', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-05', -3000, 'expense', null, '0000000a-0003-0000-0000-000000000002', '2026-11-01'),
  ('0000000a-0004-0000-0000-000000000007', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-05', -3000, 'expense', null, '0000000a-0003-0000-0000-000000000002', '2027-01-01');

set constraints all immediate;
set constraints all deferred;

create extension pgrowlocks with schema extensions;

-- The detail of the error a statement raises, which carries the figures as JSON.
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

-- Structure

select results_eq(
  $$ select proname::text collate "default", prosecdef, proowner::regrole::text collate "default", proconfig collate "default"
     from pg_proc where pronamespace = 'waypoint'::regnamespace and proname in ('post_batch', 'split_plan_item') order by 1 $$,
  $$ values ('post_batch', false, 'postgres', array['search_path=""']), ('split_plan_item', false, 'postgres', array['search_path=""']) $$,
  'post_batch and split_plan_item run as the caller with an empty search path'
);

select function_privs_are(
  'waypoint', f, a, r,
  case when r = 'authenticated' then array['EXECUTE'] else array[]::text[] end,
  format('%s %s %s', r, case when r = 'authenticated' then 'can execute' else 'cannot execute' end, f)
)
from (values ('post_batch', array['jsonb']), ('split_plan_item', array['uuid', 'date', 'jsonb'])) fn(f, a),
  unnest(array['anon', 'authenticated', 'service_role']) r;

-- post_batch, as A

set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000a-0000-0000-0000-000000000000", "role": "authenticated"}';

select is(
  waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000001",
    "expect_before": {"0000000a-0001-0000-0000-000000000001": 266000, "0000000a-0001-0000-0000-000000000002": 0, "0000000a-0001-0000-0000-000000000004": -40000},
    "expect_after": {"0000000a-0001-0000-0000-000000000001": 256000, "0000000a-0001-0000-0000-000000000002": 10000, "0000000a-0001-0000-0000-000000000004": -40000},
    "rows": [
      {"id": "0000000a-0004-0000-0000-000000000101", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-06", "amount_minor": -10000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000101"},
      {"id": "0000000a-0004-0000-0000-000000000102", "account_id": "0000000a-0001-0000-0000-000000000002", "posted_on": "2026-10-06", "amount_minor": 10000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000101"},
      {"id": "0000000a-0004-0000-0000-000000000103", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2099-12-31", "amount_minor": -1000, "kind": "expense", "description": "Paid ahead"}]}'),
  '{"status": "applied", "batch_id": "0000000a-0007-0000-0000-000000000001", "inserted": 3,
    "balances_before": {"0000000a-0001-0000-0000-000000000001": 266000, "0000000a-0001-0000-0000-000000000002": 0, "0000000a-0001-0000-0000-000000000004": -40000},
    "balances_after": {"0000000a-0001-0000-0000-000000000001": 256000, "0000000a-0001-0000-0000-000000000002": 10000, "0000000a-0001-0000-0000-000000000004": -40000}}'::jsonb,
  'a batch inserts its rows and returns balances up to today before and after'
);

reset role;
select results_eq(
  $$ select a.name::text, l.modes collate "default" from extensions.pgrowlocks('waypoint.accounts') l join waypoint.accounts a on a.ctid = l.locked_row
     where a.name in ('Current', 'Savings', 'Card2') order by 1 $$,
  $$ values ('Card2', array['For Update']), ('Current', array['For Update']), ('Savings', array['For Update']) $$,
  'post_batch locks the accounts it touches and expects for update'
);
set local role authenticated;
set local request.jwt.claims to '{"sub": "0000000a-0000-0000-0000-000000000000", "role": "authenticated"}';

select lives_ok($$ set constraints all immediate; set constraints all deferred $$, 'the posted batch passes the deferred checks');

select is(
  waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000001",
    "expect_before": {"0000000a-0001-0000-0000-000000000001": 266000, "0000000a-0001-0000-0000-000000000002": 0, "0000000a-0001-0000-0000-000000000004": -40000},
    "expect_after": {"0000000a-0001-0000-0000-000000000001": 256000, "0000000a-0001-0000-0000-000000000002": 10000, "0000000a-0001-0000-0000-000000000004": -40000},
    "rows": [
      {"id": "0000000a-0004-0000-0000-000000000101", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-06", "amount_minor": -10000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000101"},
      {"id": "0000000a-0004-0000-0000-000000000102", "account_id": "0000000a-0001-0000-0000-000000000002", "posted_on": "2026-10-06", "amount_minor": 10000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000101"},
      {"id": "0000000a-0004-0000-0000-000000000103", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2099-12-31", "amount_minor": -1000, "kind": "expense", "description": "Paid ahead"}]}') ->> 'status',
  'already_applied',
  'a replay answers already_applied before checking the stale expected balances'
);
select is(
  (select count(*)::int from waypoint.transactions where batch_id = '0000000a-0007-0000-0000-000000000001'),
  3,
  'a replay returns already_applied and inserts nothing'
);

select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000001", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000101", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-06", "amount_minor": -10001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000101"},
       {"id": "0000000a-0004-0000-0000-000000000102", "account_id": "0000000a-0001-0000-0000-000000000002", "posted_on": "2026-10-06", "amount_minor": 10000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000101"},
       {"id": "0000000a-0004-0000-0000-000000000103", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2099-12-31", "amount_minor": -1000, "kind": "expense", "description": "Paid ahead"}]}') $$,
  'P0001', 'id_conflict: row 0000000a-0004-0000-0000-000000000101 already exists with other amount_minor',
  'a changed amount raises id_conflict'
);
select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000001", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000101", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-06", "amount_minor": -10000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000101"},
       {"id": "0000000a-0004-0000-0000-000000000104", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-06", "amount_minor": -500, "kind": "expense"}]}') $$,
  'P0001', 'partial_replay: 1 of the 2 rows already exist; resend the whole batch unchanged or use new ids',
  'a batch whose ids only partly exist raises partial_replay'
);

select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000002", "expect_before": {"0000000a-0001-0000-0000-000000000001": 266000}, "rows": [
       {"id": "0000000a-0004-0000-0000-000000000111", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-07", "amount_minor": -5000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000111"},
       {"id": "0000000a-0004-0000-0000-000000000112", "account_id": "0000000a-0001-0000-0000-000000000002", "posted_on": "2026-10-07", "amount_minor": 5000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000111"}]}') $$,
  'P0001', 'balance_mismatch: before the batch, account 0000000a-0001-0000-0000-000000000001 is 256000, not the expected 266000',
  'a wrong expect_before rolls back everything and reports the actual'
);
select is(
  pg_temp.error_detail($$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000002", "expect_before": {"0000000a-0001-0000-0000-000000000001": 266000}, "rows": [
       {"id": "0000000a-0004-0000-0000-000000000111", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-07", "amount_minor": -5000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000111"},
       {"id": "0000000a-0004-0000-0000-000000000112", "account_id": "0000000a-0001-0000-0000-000000000002", "posted_on": "2026-10-07", "amount_minor": 5000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000111"}]}') $$),
  '{"error": "balance_mismatch", "when": "before", "accounts": [{"account_id": "0000000a-0001-0000-0000-000000000001", "expected_minor": 266000, "actual_minor": 256000}]}'::jsonb,
  'balance_mismatch lists the expected and actual balance per account in its detail'
);
select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000002",
       "expect_before": {"0000000a-0001-0000-0000-000000000001": 256000}, "expect_after": {"0000000a-0001-0000-0000-000000000001": 250000}, "rows": [
       {"id": "0000000a-0004-0000-0000-000000000111", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-07", "amount_minor": -5000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000111"},
       {"id": "0000000a-0004-0000-0000-000000000112", "account_id": "0000000a-0001-0000-0000-000000000002", "posted_on": "2026-10-07", "amount_minor": 5000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000111"}]}') $$,
  'P0001', 'balance_mismatch: after the batch, account 0000000a-0001-0000-0000-000000000001 is 251000, not the expected 250000',
  'a wrong expect_after raises balance_mismatch with the actual'
);
select is(
  (select count(*)::int from waypoint.transactions where batch_id = '0000000a-0007-0000-0000-000000000002'),
  0,
  'a wrong expect_after rolls back both legs'
);

-- Card payments against the remaining due

select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000003", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000121", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-09-19", "amount_minor": -30000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000121"},
       {"id": "0000000a-0004-0000-0000-000000000122", "account_id": "0000000a-0001-0000-0000-000000000003", "posted_on": "2026-09-19", "amount_minor": 30000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000121"}]}') $$,
  'P0001', 'over_remainder: row 0000000a-0004-0000-0000-000000000122 pays 30000 into card 0000000a-0001-0000-0000-000000000003, above the 5000 remaining due on the statement cut 2026-08-20; set allow_over to pay more',
  'a card leg posted the day before a cut nets against the old statement'
);
select lives_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000004", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000131", "account_id": "0000000a-0001-0000-0000-000000000003", "posted_on": "2026-09-22", "amount_minor": 5000, "kind": "refund", "category_id": "0000000a-0002-0000-0000-000000000001"},
       {"id": "0000000a-0004-0000-0000-000000000132", "account_id": "0000000a-0001-0000-0000-000000000003", "posted_on": "2026-09-20", "amount_minor": 2000, "kind": "refund"}]}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a refund after the cut and one on the cut day post'
);
select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000005", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000141", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-09-23", "amount_minor": -25001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000141"},
       {"id": "0000000a-0004-0000-0000-000000000142", "account_id": "0000000a-0001-0000-0000-000000000003", "posted_on": "2026-09-23", "amount_minor": 25001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000141"}]}') $$,
  'P0001', 'over_remainder: row 0000000a-0004-0000-0000-000000000142 pays 25001 into card 0000000a-0001-0000-0000-000000000003, above the 25000 remaining due on the statement cut 2026-09-20; set allow_over to pay more',
  'a refund on the card lowers remaining, and one on the cut day is already in the statement'
);
select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000006", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000151", "account_id": "0000000a-0001-0000-0000-000000000003", "posted_on": "2026-09-23", "amount_minor": 1000, "kind": "refund"},
       {"id": "0000000a-0004-0000-0000-000000000152", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-09-23", "amount_minor": -25000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000152"},
       {"id": "0000000a-0004-0000-0000-000000000153", "account_id": "0000000a-0001-0000-0000-000000000003", "posted_on": "2026-09-23", "amount_minor": 25000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000152"}]}') $$,
  'P0001', 'over_remainder: row 0000000a-0004-0000-0000-000000000153 pays 25000 into card 0000000a-0001-0000-0000-000000000003, above the 24000 remaining due on the statement cut 2026-09-20; set allow_over to pay more',
  'an earlier refund in the same batch lowers remaining'
);
select lives_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000007", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000161", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-09-20", "amount_minor": -25000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000161"},
       {"id": "0000000a-0004-0000-0000-000000000162", "account_id": "0000000a-0001-0000-0000-000000000003", "posted_on": "2026-09-21", "amount_minor": 25000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000161"}]}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a card leg posted the day after a cut nets against the new statement'
);

select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000008", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000171", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-01", "amount_minor": -40001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000171"},
       {"id": "0000000a-0004-0000-0000-000000000172", "account_id": "0000000a-0001-0000-0000-000000000004", "posted_on": "2026-10-01", "amount_minor": 40001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000171"}]}') $$,
  'P0001', 'over_remainder: row 0000000a-0004-0000-0000-000000000172 pays 40001 into card 0000000a-0001-0000-0000-000000000004, above the 40000 remaining due on the opening balance; set allow_over to pay more',
  'a card with no statement measures from its opening balance'
);
select is(
  pg_temp.error_detail($$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000008", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000171", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-01", "amount_minor": -40001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000171"},
       {"id": "0000000a-0004-0000-0000-000000000172", "account_id": "0000000a-0001-0000-0000-000000000004", "posted_on": "2026-10-01", "amount_minor": 40001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000171"}]}') $$),
  '{"error": "over_remainder", "id": "0000000a-0004-0000-0000-000000000172", "account_id": "0000000a-0001-0000-0000-000000000004", "amount_minor": 40001, "remaining_minor": 40000, "cut_date": null}'::jsonb,
  'over_remainder carries the remaining amount'
);
select lives_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000008", "allow_over": true, "rows": [
       {"id": "0000000a-0004-0000-0000-000000000171", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-01", "amount_minor": -40001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000171"},
       {"id": "0000000a-0004-0000-0000-000000000172", "account_id": "0000000a-0001-0000-0000-000000000004", "posted_on": "2026-10-01", "amount_minor": 40001, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000171"}]}');
     set constraints all immediate;
     set constraints all deferred $$,
  'over_remainder passes with allow_over'
);

-- The deferred checks run on what post_batch inserts

select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000009", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000181", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-02", "amount_minor": -1000, "kind": "transfer", "transfer_id": "0000000a-0006-0000-0000-000000000181"}]}');
     set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000181 has 1 leg; a transfer has exactly 2',
  'a batch with one transfer leg is refused at commit'
);
select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000010", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000191", "account_id": "0000000a-0001-0000-0000-000000000002", "posted_on": "2026-10-02", "amount_minor": -90000, "kind": "expense",
        "plan_item_id": "0000000a-0003-0000-0000-000000000001", "period": "2026-11-01"}]}');
     set constraints all immediate $$,
  '23514', 'check_link: transaction 0000000a-0004-0000-0000-000000000191: the expense must leave the bill''s account 0000000a-0001-0000-0000-000000000001',
  'a batch row linked from the wrong account is refused at commit'
);
select lives_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000010", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000191", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-02", "amount_minor": -90000, "kind": "expense",
        "plan_item_id": "0000000a-0003-0000-0000-000000000001", "period": "2026-11-01"}]}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a batch row linked from the bill''s account passes at commit'
);

-- External ids

select lives_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000011", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000201", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-03", "amount_minor": -2500, "kind": "expense",
        "category_id": "0000000a-0002-0000-0000-000000000001", "external_id": "csv:0001"}]}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a row with a new external_id posts'
);
select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000012", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000202", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-03", "amount_minor": -2500, "kind": "expense",
        "category_id": "0000000a-0002-0000-0000-000000000001", "external_id": "csv:0001"}]}') $$,
  'P0001', 'already_recorded: external id ''csv:0001'' is already recorded on its account',
  'a repeated external_id raises already_recorded naming it'
);
select is(
  pg_temp.error_detail($$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000012", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000202", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-03", "amount_minor": -2500, "kind": "expense",
        "category_id": "0000000a-0002-0000-0000-000000000001", "external_id": "csv:0001"}]}') $$),
  '{"error": "already_recorded", "external_ids": ["csv:0001"], "ids": ["0000000a-0004-0000-0000-000000000202"]}'::jsonb,
  'already_recorded lists the external ids and their row ids in its detail'
);

select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000013", "dry_run": true, "rows": [
       {"id": "0000000a-0004-0000-0000-000000000211", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-03", "amount": -100, "kind": "expense"}]}') $$,
  'P0001', 'bad_input: Unknown key ''dry_run''; allowed keys: batch_id, allow_over, expect_before, expect_after, rows; '
    || 'rows[0]: Unknown key ''amount''; allowed keys: id, account_id, posted_on, amount_minor, kind, category_id, description, transfer_id, plan_item_id, period, external_id; '
    || 'rows[0].amount_minor: is required',
  'post_batch refuses unknown keys and names the allowed ones'
);

-- Another household's ids

select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000014", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000221", "account_id": "0000000b-0001-0000-0000-000000000001", "posted_on": "2026-10-03", "amount_minor": -100, "kind": "expense"}]}') $$,
  'P0001', 'unknown_account: no account 0000000b-0001-0000-0000-000000000001 in this household',
  'post_batch refuses another household''s account'
);
select throws_ok(
  $$ select waypoint.post_batch('{"batch_id": "0000000a-0007-0000-0000-000000000015", "rows": [
       {"id": "0000000a-0004-0000-0000-000000000231", "account_id": "0000000a-0001-0000-0000-000000000001", "posted_on": "2026-10-03", "amount_minor": -3000, "kind": "expense",
        "plan_item_id": "0000000b-0003-0000-0000-000000000001", "period": "2026-10-01"}]}') $$,
  '23503', 'insert or update on table "transactions" violates foreign key constraint "transactions_plan_item_fkey"',
  'post_batch refuses a link to another household''s plan item'
);

-- Deletes are REST requests naming both legs or a batch

select throws_ok(
  $$ delete from waypoint.transactions where id = '0000000a-0004-0000-0000-000000000162'; set constraints all immediate $$,
  '23514', 'transfer_pair: transfer 0000000a-0006-0000-0000-000000000161 has 1 leg; a transfer has exactly 2',
  'deleting one leg of a posted transfer is refused at commit'
);
select lives_ok(
  $$ delete from waypoint.transactions where transfer_id in ('0000000a-0006-0000-0000-000000000161');
     set constraints all immediate;
     set constraints all deferred $$,
  'deleting a posted transfer by transfer_id passes at commit'
);
select is(
  (select count(*)::int from waypoint.transactions where transfer_id = '0000000a-0006-0000-0000-000000000161'),
  0,
  'delete by transfer_id removes both legs'
);
select results_eq(
  $$ with gone as (delete from waypoint.transactions where batch_id = '0000000a-0007-0000-0000-000000000001' returning id) select id from gone order by id $$,
  $$ values ('0000000a-0004-0000-0000-000000000101'::uuid), ('0000000a-0004-0000-0000-000000000102'), ('0000000a-0004-0000-0000-000000000103') $$,
  'delete by batch_id removes exactly that batch'
);
select lives_ok($$ set constraints all immediate; set constraints all deferred $$, 'deleting a whole batch passes at commit');

-- split_plan_item, as A

select throws_ok(
  $$ select waypoint.split_plan_item('0000000a-0003-0000-0000-000000000001', '2026-10-01', '{"amount": 95000}') $$,
  'P0001', 'bad_patch: Unknown key ''amount''; allowed keys: amount_minor, name, from_account_id, to_account_id, category_id, every, roll, confidence, stops_with_income, ends_on, day',
  'split_plan_item refuses unknown keys and names the allowed ones'
);
select throws_ok(
  $$ select waypoint.split_plan_item('0000000a-0003-0000-0000-000000000001', '2026-09-01', '{"amount_minor": 95000}') $$,
  'P0001', 'bad_split: split from a day after the first occurrence 2026-09-01; to change every occurrence, update the item',
  'split_plan_item refuses a split on the first occurrence'
);
select lives_ok(
  $$ select waypoint.split_plan_item('0000000a-0003-0000-0000-000000000001', '2026-10-01', '{"amount_minor": 95000}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a split of a linked bill passes at commit'
);
select results_eq(
  $$ select starts_on, ends_on, amount_minor from waypoint.plan_items where name = 'Rent' order by starts_on $$,
  $$ values ('2026-09-01'::date, '2026-09-30'::date, 90000::bigint), ('2026-10-01', null, 95000) $$,
  'the old row ends the day before the split and the copy starts on it with the new amount'
);
select results_eq(
  $$ select t.id, t.period, p.starts_on from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id where p.name = 'Rent' order by t.id $$,
  $$ values ('0000000a-0004-0000-0000-000000000001'::uuid, '2026-09-01'::date, '2026-09-01'::date),
            ('0000000a-0004-0000-0000-000000000002', '2026-10-01', '2026-10-01'),
            ('0000000a-0004-0000-0000-000000000191', '2026-11-01', '2026-10-01') $$,
  'split moves later links only'
);

select lives_ok(
  $$ select waypoint.split_plan_item('0000000a-0003-0000-0000-000000000002', '2026-11-01', '{"day": 15}');
     set constraints all immediate;
     set constraints all deferred $$,
  'moving a monthly bill to a new day from a month passes at commit'
);
select results_eq(
  $$ select starts_on, ends_on, skip_periods from waypoint.plan_items where name = 'Gym' order by starts_on $$,
  $$ values ('2026-09-05'::date, '2026-10-31'::date, '{}'::date[]), ('2026-11-15', null, '{2026-12-01}') $$,
  'a new day starts the copy on that day in the split month and moves later skips to it with their period'
);
select results_eq(
  $$ select t.period, p.starts_on from waypoint.transactions t join waypoint.plan_items p on p.id = t.plan_item_id where p.name = 'Gym' order by t.period $$,
  $$ values ('2026-10-01'::date, '2026-09-05'::date), ('2026-11-01', '2026-11-15'), ('2027-01-01', '2026-11-15') $$,
  'a new day moves each later link to the copy and keeps its first-of-month period'
);
select throws_ok(
  $$ select waypoint.split_plan_item((select id from waypoint.plan_items where name = 'Gym' and starts_on = '2026-11-15'), '2026-11-16', '{"every": "week"}') $$,
  'P0001', 'bad_split: the occurrence 2026-12-01 is linked or skipped, and the new row has no occurrence to take it; unlink or unskip it first',
  'a split that would leave a link with no occurrence is refused'
);

select lives_ok(
  $$ select waypoint.split_plan_item('0000000a-0003-0000-0000-000000000003', '2026-10-01', '{"amount_minor": 7900}');
     set constraints all immediate;
     set constraints all deferred $$,
  'an installment split passes at commit'
);
select results_eq(
  $$ select starts_on, ends_on, amount_minor from waypoint.plan_items where name = 'Laptop' order by starts_on $$,
  $$ values ('2026-06-01'::date, '2026-09-01'::date, 8000::bigint), ('2026-10-01', '2027-05-01', 7900) $$,
  'an installment split keeps first-of-month dates on both rows'
);
select is(
  (select sum((select count(*) from generate_series(p.starts_on, p.ends_on, interval '1 month')))::int from waypoint.plan_items p where p.name = 'Laptop'),
  12,
  'splitting a 12-month installment from its 5th billed month keeps 12 occurrences across the two rows'
);

select throws_like(
  $$ select waypoint.split_plan_item((select id from waypoint.plan_items where name = 'Rent' and starts_on = '2026-10-01'), '2026-12-01',
       '{"from_account_id": "0000000a-0001-0000-0000-000000000005"}');
     set constraints all immediate $$,
  'check_plan_item: plan item %: a bill leaves a cash account or a card, to no account',
  'a split that moves a bill onto a loan is refused at commit'
);
select lives_ok(
  $$ select waypoint.split_plan_item((select id from waypoint.plan_items where name = 'Rent' and starts_on = '2026-10-01'), '2026-12-01', '{"amount_minor": 97000}');
     set constraints all immediate;
     set constraints all deferred $$,
  'a split that keeps the routing passes at commit'
);

select throws_ok(
  $$ select waypoint.split_plan_item('0000000b-0003-0000-0000-000000000001', '2026-10-01', '{"amount_minor": 125000}') $$,
  'P0001', 'unknown_plan_item: no plan item 0000000b-0003-0000-0000-000000000001 in this household',
  'split_plan_item refuses another household''s plan item'
);
select throws_ok(
  $$ select waypoint.split_plan_item((select id from waypoint.plan_items where name = 'Gym' and starts_on = '2026-11-15'), '2026-12-01',
       '{"from_account_id": "0000000b-0001-0000-0000-000000000001"}') $$,
  '23503', 'insert or update on table "plan_items" violates foreign key constraint "plan_items_from_account_fkey"',
  'split_plan_item refuses another household''s account'
);

-- anon

reset role;
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';

select throws_ok($$ select waypoint.post_batch('{}') $$, '42501', 'permission denied for function post_batch', 'anon cannot execute post_batch');
select throws_ok(
  $$ select waypoint.split_plan_item('0000000a-0003-0000-0000-000000000001', '2026-10-01', '{}') $$,
  '42501', 'permission denied for function split_plan_item', 'anon cannot execute split_plan_item'
);

reset role;

select * from finish();
rollback;
