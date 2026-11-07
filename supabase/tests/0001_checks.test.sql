begin;
select plan(85);

insert into auth.users (id, aud, role, email) values
  ('0000000a-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test'),
  ('0000000c-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000a-0000-0000-0000-000000000000', 'EUR', 'Europe/Berlin', 'de-DE', '2026-09-01');

insert into waypoint.accounts (id, household_id, name, kind, currency, opening_date, funded_from_account_id, terms) values
  ('0000000a-0001-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Current', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000a-0001-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '{}'),
  ('0000000a-0001-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', 'Savings', 'cash', 'EUR', '2026-09-01', null, null),
  ('0000000a-0001-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', 'Loan', 'loan', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000003', '{}');

insert into waypoint.categories (id, household_id, name) values
  ('0000000a-0002-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'Food'),
  ('0000000a-0002-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'Travel');

insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on) values
  ('0000000a-0003-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', 'bill', 'Rent', '0000000a-0001-0000-0000-000000000001', 90000, '2026-09-01');

set constraints all immediate;
set constraints all deferred;

-- households

select throws_ok(
  $$ insert into waypoint.households (id, base_currency, timezone, locale, track_from) values ('0000000c-0000-0000-0000-000000000000', 'eur', 'UTC', 'en', '2026-09-01') $$,
  '23514', 'new row for relation "households" violates check constraint "households_base_currency_check"',
  'a household base currency is three capital letters'
);
select throws_ok(
  $$ insert into waypoint.households (id, base_currency, timezone, locale, payoff_order, track_from) values ('0000000c-0000-0000-0000-000000000000', 'EUR', 'UTC', 'en', 'snowball', '2026-09-01') $$,
  '23514', 'new row for relation "households" violates check constraint "households_payoff_order_check"',
  'payoff order is avalanche or list'
);
select throws_ok(
  $$ insert into waypoint.households (id, base_currency, timezone, locale, track_from) values ('0000000d-0000-0000-0000-000000000000', 'EUR', 'UTC', 'en', '2026-09-01') $$,
  '23503', 'insert or update on table "households" violates foreign key constraint "households_id_fkey"',
  'a household id is an auth user id'
);
select lives_ok(
  $$ insert into waypoint.households (id, base_currency, timezone, locale, track_from) values ('0000000c-0000-0000-0000-000000000000', 'EUR', 'UTC', 'en', '2026-09-01') $$,
  'a household for an auth user with a valid currency passes'
);
select is(
  (select payoff_order from waypoint.households where id = '0000000c-0000-0000-0000-000000000000'),
  'avalanche',
  'payoff order defaults to avalanche'
);

-- accounts

select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date) values ('0000000a-0000-0000-0000-000000000000', '', 'cash', 'EUR', '2026-09-01') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_name_check"',
  'an account name is not empty'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date) values ('0000000a-0000-0000-0000-000000000000', repeat('x', 41), 'cash', 'EUR', '2026-09-01') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_name_check"',
  'an account name is at most 40 characters'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, funded_from_account_id) values ('0000000a-0000-0000-0000-000000000000', 'Bank', 'bank', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_kind_check"',
  'an account kind is cash, credit_card or loan'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date) values ('0000000a-0000-0000-0000-000000000000', 'Bank', 'cash', 'eur', '2026-09-01') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_currency_check"',
  'an account currency is three capital letters'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date) values ('0000000a-0000-0000-0000-000000000000', 'Bank', 'cash', 'EU', '2026-09-01') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_currency_check"',
  'a two-letter currency is refused'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, fx_fee_pct) values ('0000000a-0000-0000-0000-000000000000', 'Bank', 'cash', 'EUR', '2026-09-01', 0.2) $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_fx_fee_pct_check"',
  'an fx fee is a fraction below 0.2'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, fx_fee_pct) values ('0000000a-0000-0000-0000-000000000000', 'Bank', 'cash', 'EUR', '2026-09-01', -0.001) $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_fx_fee_pct_check"',
  'an fx fee is not negative'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, terms) values ('0000000a-0000-0000-0000-000000000000', 'Bank', 'cash', 'EUR', '2026-09-01', '{}') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_terms_check"',
  'a cash account has no terms'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, funded_from_account_id) values ('0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_terms_check"',
  'a card needs terms'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, funded_from_account_id) values ('0000000a-0000-0000-0000-000000000000', 'Loan', 'loan', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_terms_check"',
  'a loan needs terms'
);
select throws_ok(
  $$ insert into waypoint.accounts (id, household_id, name, kind, currency, opening_date, funded_from_account_id) values ('0000000a-0001-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', 'Wallet', 'cash', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000009') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_funded_from_self_check"',
  'an account cannot fund itself'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, terms) values ('0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '{}') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_debt_funded_check"',
  'a debt needs the cash account that pays it'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, funded_from_account_id, terms, floor_windows) values ('0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '{}', '[{"from_month": "2026-10", "to_month": null, "amount_minor": 1000}]') $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_cash_only_check"',
  'floor windows are for cash accounts only'
);
select throws_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, funded_from_account_id, terms, fx_fee_pct) values ('0000000a-0000-0000-0000-000000000000', 'Card', 'credit_card', 'EUR', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '{}', 0.01) $$,
  '23514', 'new row for relation "accounts" violates check constraint "accounts_cash_only_check"',
  'an fx fee is for cash accounts only'
);
select lives_ok(
  $$ insert into waypoint.accounts (household_id, name, kind, currency, opening_date, funded_from_account_id, floor_windows, fx_fee_pct) values ('0000000a-0000-0000-0000-000000000000', 'Pesos', 'cash', 'PHP', '2026-09-01', '0000000a-0001-0000-0000-000000000001', '[{"from_month": "2026-10", "to_month": null, "amount_minor": 1000}]', 0.19999) $$,
  'a cash account funded from another, with a floor window and an fx fee just under 0.2, passes'
);
select results_eq(
  $$ select opening_balance_minor, floor_windows, sort_order from waypoint.accounts where id = '0000000a-0001-0000-0000-000000000001' $$,
  $$ values (0::bigint, '[]'::jsonb, 0) $$,
  'an account opens at 0 with no floor windows and sort order 0 by default'
);

-- categories

select throws_ok(
  $$ insert into waypoint.categories (household_id, name) values ('0000000a-0000-0000-0000-000000000000', '') $$,
  '23514', 'new row for relation "categories" violates check constraint "categories_name_check"',
  'a category name is not empty'
);
select throws_ok(
  $$ insert into waypoint.categories (household_id, name) values ('0000000a-0000-0000-0000-000000000000', repeat('x', 41)) $$,
  '23514', 'new row for relation "categories" violates check constraint "categories_name_check"',
  'a category name is at most 40 characters'
);
select throws_ok(
  $$ insert into waypoint.categories (household_id, name) values ('0000000a-0000-0000-0000-000000000000', 'FOOD') $$,
  '23505', 'duplicate key value violates unique constraint "categories_household_id_name_key"',
  'category names are unique in a household, ignoring case'
);
select lives_ok(
  $$ insert into waypoint.categories (household_id, name) values ('0000000c-0000-0000-0000-000000000000', 'Food') $$,
  'another household may use the same category name'
);

-- plan_items

select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'loan', 'Gym', '0000000a-0001-0000-0000-000000000001', 3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_kind_check"',
  'a plan item kind is income, bill, allowance, transfer or installment'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', '', '0000000a-0001-0000-0000-000000000001', 3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_name_check"',
  'a plan item name is not empty'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', repeat('x', 61), '0000000a-0001-0000-0000-000000000001', 3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_name_check"',
  'a plan item name is at most 60 characters'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, every, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', 3000, 'day', '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_every_check"',
  'every is once, week, 2weeks, month, quarter or year'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, roll, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', 3000, 'nearest', '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_roll_check"',
  'roll is none, following or preceding'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, confidence, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', 3000, 'certain', '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_confidence_check"',
  'confidence is committed, estimated or upside'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'transfer', 'Loop', '0000000a-0001-0000-0000-000000000001', '0000000a-0001-0000-0000-000000000001', 3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_accounts_differ_check"',
  'a plan item does not move money to the account it leaves'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'transfer', 'Nowhere', 3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_transfer_route_check"',
  'a transfer item needs a from account, a to account or both'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'income', 'Salary', '0000000a-0001-0000-0000-000000000002', '0000000a-0001-0000-0000-000000000001', 300000, '2026-10-28') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_income_route_check"',
  'an income with a from account is refused'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'income', 'Salary', 300000, '2026-10-28') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_income_route_check"',
  'an income needs the account it lands in'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, to_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', '0000000a-0001-0000-0000-000000000002', 3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_outgoing_route_check"',
  'a bill with a to account is refused'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', 3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_outgoing_route_check"',
  'a bill needs the account it leaves'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'allowance', 'Food', '0000000a-0001-0000-0000-000000000001', 40000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_category_check"',
  'an allowance needs its category'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, category_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', '0000000a-0002-0000-0000-000000000001', 3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_category_check"',
  'only an allowance takes a category'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', 0, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_amount_check"',
  'a bill amount is above 0'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', -3000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_amount_check"',
  'a bill amount is not negative'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, category_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'allowance', 'Food', '0000000a-0001-0000-0000-000000000001', '0000000a-0002-0000-0000-000000000001', 0, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_amount_check"',
  'an allowance amount is not 0'
);
select lives_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, category_id, amount_minor, every, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'allowance', 'Food credit', '0000000a-0001-0000-0000-000000000001', '0000000a-0002-0000-0000-000000000001', -5000, 'once', '2026-10-01') $$,
  'a negative allowance, a one-month budget credit, passes'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, every, starts_on, ends_on) values ('0000000a-0000-0000-0000-000000000000', 'installment', 'Laptop', '0000000a-0001-0000-0000-000000000002', 8000, 'year', '2026-10-01', '2027-09-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_installment_every_check"',
  'an installment bills every month'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on, ends_on) values ('0000000a-0000-0000-0000-000000000000', 'bill', 'Gym', '0000000a-0001-0000-0000-000000000001', 3000, '2026-10-01', '2026-09-30') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_ends_on_check"',
  'a plan item does not end before it starts'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on, ends_on) values ('0000000a-0000-0000-0000-000000000000', 'installment', 'Laptop', '0000000a-0001-0000-0000-000000000002', 8000, '2026-10-15', '2027-09-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_installment_months_check"',
  'an installment starts on the first of its first billed month'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on, ends_on) values ('0000000a-0000-0000-0000-000000000000', 'installment', 'Laptop', '0000000a-0001-0000-0000-000000000002', 8000, '2026-10-01', '2027-09-15') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_installment_months_check"',
  'an installment ends on the first of its last billed month'
);
select throws_ok(
  $$ insert into waypoint.plan_items (household_id, kind, name, from_account_id, amount_minor, starts_on) values ('0000000a-0000-0000-0000-000000000000', 'installment', 'Laptop', '0000000a-0001-0000-0000-000000000002', 8000, '2026-10-01') $$,
  '23514', 'new row for relation "plan_items" violates check constraint "plan_items_installment_months_check"',
  'an installment needs its last billed month'
);
select lives_ok(
  $$ insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, amount_minor, starts_on, ends_on) values ('0000000a-0003-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', 'installment', 'Laptop', '0000000a-0001-0000-0000-000000000002', 8000, '2026-10-01', '2027-09-01') $$,
  'an installment on a card from its first to its last billed month passes'
);
select results_eq(
  $$ select every, roll, confidence, skip_periods from waypoint.plan_items where id = '0000000a-0003-0000-0000-000000000002' $$,
  $$ values ('month', 'none', 'committed', '{}'::date[]) $$,
  'a plan item defaults to monthly, no roll, committed and no skipped periods'
);

-- statements

select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-09-19', 30000, 3000) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_due_date_check"',
  'a statement is not due before its cut'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 30000, -1) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_minimum_due_minor_check"',
  'a minimum due is not negative'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 30000, 30001) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_minimum_due_minor_check"',
  'a minimum due does not exceed the total due'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', -500, 1) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_minimum_due_minor_check"',
  'nothing is due when the total is negative'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, previous_balance_minor, payments_and_credits_minor, charges_minor, installments_minor, interest_minor, fees_minor, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 10000, -1000, 0, 0, 0, 0, 11000, 1000) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_payments_and_credits_minor_check"',
  'printed payments and credits are not negative'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, previous_balance_minor, payments_and_credits_minor, charges_minor, installments_minor, interest_minor, fees_minor, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 10000, 0, -1000, 0, 0, 0, 9000, 900) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_charges_minor_check"',
  'printed charges are not negative'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, previous_balance_minor, payments_and_credits_minor, charges_minor, installments_minor, interest_minor, fees_minor, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 10000, 0, 0, -1000, 0, 0, 9000, 900) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_installments_minor_check"',
  'printed installments are not negative'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, previous_balance_minor, payments_and_credits_minor, charges_minor, installments_minor, interest_minor, fees_minor, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 10000, 0, 0, 0, -1000, 0, 9000, 900) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_interest_minor_check"',
  'printed interest is not negative'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, previous_balance_minor, payments_and_credits_minor, charges_minor, installments_minor, interest_minor, fees_minor, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 10000, 0, 0, 0, 0, -1000, 9000, 900) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_fees_minor_check"',
  'printed fees are not negative'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, previous_balance_minor, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 10000, 10000, 1000) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_parts_check"',
  'a statement with only some of its six parts is refused'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, previous_balance_minor, payments_and_credits_minor, charges_minor, installments_minor, interest_minor, fees_minor, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 10000, 10000, 25000, 8000, 300, 0, 33301, 3000) $$,
  '23514', 'new row for relation "statements" violates check constraint "statements_balance_check"',
  'a statement whose parts do not add up to its total is refused'
);
select lives_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, previous_balance_minor, payments_and_credits_minor, charges_minor, installments_minor, interest_minor, fees_minor, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-10', 10000, 10000, 25000, 8000, 300, 0, 33300, 3000) $$,
  'a statement whose six parts add up to its total passes'
);
select throws_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-09-20', '2026-10-12', 33300, 3000) $$,
  '23505', 'duplicate key value violates unique constraint "statements_account_id_cut_date_key"',
  'a card has one statement per cut date'
);
select lives_ok(
  $$ insert into waypoint.statements (household_id, account_id, cut_date, due_date, total_due_minor, minimum_due_minor) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-20', '2026-11-10', -500, 0) $$,
  'a total-only statement with a negative total and nothing due passes'
);

-- transactions

select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', 0, 'adjustment') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_amount_minor_check"',
  'a transaction amount is not 0'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -1000, 'fee') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_kind_check"',
  'a transaction kind is income, expense, refund, transfer, drawdown or adjustment'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -1000, 'income') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_money_in_check"',
  'income is positive'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -1000, 'refund') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_money_in_check"',
  'a refund is positive'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-01', -1000, 'drawdown') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_money_in_check"',
  'a drawdown is positive'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values ('0000000a-0004-0000-0000-000000000001', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', 1000, 'expense') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_expense_check"',
  'an expense is negative'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values
       ('0000000a-0004-0000-0000-000000000002', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', 1000, 'income'),
       ('0000000a-0004-0000-0000-000000000003', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', 1000, 'refund'),
       ('0000000a-0004-0000-0000-000000000004', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-01', 1000, 'drawdown'),
       ('0000000a-0004-0000-0000-000000000005', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -1000, 'expense'),
       ('0000000a-0004-0000-0000-000000000006', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -1, 'adjustment'),
       ('0000000a-0004-0000-0000-000000000007', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', 1, 'adjustment') $$,
  'money in is positive, an expense negative and an adjustment either sign'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id) values ('0000000a-0004-0000-0000-000000000008', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', 1000, 'income', '0000000a-0002-0000-0000-000000000001') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_category_check"',
  'only an expense or a refund takes a category'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id) values ('0000000a-0004-0000-0000-000000000008', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', 500, 'refund', '0000000a-0002-0000-0000-000000000002') $$,
  'a refund with a category passes'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind) values ('0000000a-0004-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -1000, 'transfer') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_transfer_id_check"',
  'a transfer needs its transfer id'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id) values ('0000000a-0004-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -1000, 'expense', '0000000a-0006-0000-0000-000000000001') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_transfer_id_check"',
  'only a transfer has a transfer id'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, plan_item_id) values ('0000000a-0004-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -90000, 'expense', '0000000a-0003-0000-0000-000000000001') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_link_check"',
  'a link names its period'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, period) values ('0000000a-0004-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -90000, 'expense', '2026-10-01') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_link_check"',
  'a period comes only with a plan item'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, transfer_id, plan_item_id, period) values ('0000000a-0004-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-01', 20000, 'transfer', '0000000a-0006-0000-0000-000000000001', '0000000a-0003-0000-0000-000000000001', '2026-10-01') $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_transfer_link_check"',
  'a transfer links only by its outgoing leg'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, description) values ('0000000a-0004-0000-0000-000000000009', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-01', -1000, 'expense', repeat('x', 141)) $$,
  '23514', 'new row for relation "transactions" violates check constraint "transactions_description_check"',
  'a description is at most 140 characters'
);
select lives_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, external_id) values
       ('0000000a-0004-0000-0000-000000000010', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-02', -1200, 'expense', 'bank-ref-1'),
       ('0000000a-0004-0000-0000-000000000011', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000002', '2026-10-02', -1200, 'expense', 'bank-ref-1') $$,
  'one external id may appear once on each account'
);
select throws_ok(
  $$ insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, external_id) values ('0000000a-0004-0000-0000-000000000012', '0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-02', -1200, 'expense', 'bank-ref-1') $$,
  '23505', 'duplicate key value violates unique constraint "transactions_account_id_external_id_key"',
  'a second import of the same bank row is refused'
);
select throws_ok(
  $$ insert into waypoint.transactions (household_id, account_id, posted_on, amount_minor, kind) values ('0000000a-0000-0000-0000-000000000000', '0000000a-0001-0000-0000-000000000001', '2026-10-02', -1200, 'expense') $$,
  '23502', 'null value in column "id" of relation "transactions" violates not-null constraint',
  'a transaction id is made by the client, never defaulted'
);
select results_eq(
  $$ select description, category_id, transfer_id, batch_id from waypoint.transactions where id = '0000000a-0004-0000-0000-000000000005' $$,
  $$ values ('', null::uuid, null::uuid, null::uuid) $$,
  'a transaction defaults to an empty description and no category, transfer or batch'
);

-- deletes

select throws_ok(
  $$ delete from waypoint.categories where id = '0000000a-0002-0000-0000-000000000002' $$,
  '23503', 'update or delete on table "categories" violates foreign key constraint "transactions_category_fkey" on table "transactions"',
  'a category in use cannot be deleted'
);
select throws_ok(
  $$ delete from waypoint.accounts where id = '0000000a-0001-0000-0000-000000000003' $$,
  '23503', 'update or delete on table "accounts" violates foreign key constraint "accounts_funded_from_fkey" on table "accounts"',
  'an account that funds another cannot be deleted'
);

select * from finish();
rollback;
