-- Waypoint v1 schema: six tables, row-level security, grants and the three deferred checks (schema.dbml).

-- Its own schema, so it can share a project whose public schema has other tables (spec §14).
create schema waypoint;
grant usage on schema waypoint to anon, authenticated, service_role;

create table waypoint.households (
  id uuid primary key references auth.users (id) on delete cascade,
  base_currency char(3) not null constraint households_base_currency_check check (base_currency ~ '^[A-Z]{3}$'),
  timezone text not null,
  locale text not null,
  payoff_order text not null default 'avalanche' constraint households_payoff_order_check check (payoff_order in ('avalanche', 'list')),
  track_from date not null
);

create table waypoint.accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  name text not null constraint accounts_name_check check (char_length(name) between 1 and 40),
  kind text not null constraint accounts_kind_check check (kind in ('cash', 'credit_card', 'loan')),
  currency char(3) not null constraint accounts_currency_check check (currency ~ '^[A-Z]{3}$'),
  opening_balance_minor bigint not null default 0,
  opening_date date not null,
  terms jsonb,
  funded_from_account_id uuid,
  floor_windows jsonb not null default '[]',
  fx_fee_pct numeric(6, 5) constraint accounts_fx_fee_pct_check check (fx_fee_pct >= 0 and fx_fee_pct < 0.2),
  csv_mapping jsonb,
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint accounts_household_id_id_key unique (household_id, id),
  constraint accounts_terms_check check ((terms is not null) = (kind in ('credit_card', 'loan'))),
  constraint accounts_funded_from_self_check check (funded_from_account_id <> id),
  constraint accounts_debt_funded_check check (kind = 'cash' or funded_from_account_id is not null),
  constraint accounts_cash_only_check check (kind = 'cash' or (floor_windows = '[]' and fx_fee_pct is null)),
  constraint accounts_funded_from_fkey foreign key (household_id, funded_from_account_id) references waypoint.accounts (household_id, id)
);

create table waypoint.categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  name text not null constraint categories_name_check check (char_length(name) between 1 and 40),
  archived_at timestamptz,
  constraint categories_household_id_id_key unique (household_id, id)
);

create unique index categories_household_id_name_key on waypoint.categories (household_id, lower(name));

create table waypoint.plan_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  kind text not null constraint plan_items_kind_check check (kind in ('income', 'bill', 'allowance', 'transfer', 'installment')),
  name text not null constraint plan_items_name_check check (char_length(name) between 1 and 60),
  from_account_id uuid,
  to_account_id uuid,
  category_id uuid,
  amount_minor bigint not null,
  every text not null default 'month' constraint plan_items_every_check check (every in ('once', 'week', '2weeks', 'month', 'year')),
  starts_on date not null,
  ends_on date,
  roll text not null default 'none' constraint plan_items_roll_check check (roll in ('none', 'following', 'preceding')),
  confidence text not null default 'committed' constraint plan_items_confidence_check check (confidence in ('committed', 'estimated', 'upside')),
  skip_periods date[] not null default '{}',
  constraint plan_items_household_id_id_key unique (household_id, id),
  constraint plan_items_accounts_differ_check check (to_account_id <> from_account_id),
  constraint plan_items_transfer_route_check check (kind <> 'transfer' or from_account_id is not null or to_account_id is not null),
  constraint plan_items_income_route_check check (kind <> 'income' or (from_account_id is null and to_account_id is not null)),
  constraint plan_items_outgoing_route_check check (kind not in ('bill', 'allowance', 'installment') or (from_account_id is not null and to_account_id is null)),
  constraint plan_items_category_check check ((kind = 'allowance') = (category_id is not null)),
  constraint plan_items_amount_check check (amount_minor > 0 or (kind = 'allowance' and amount_minor <> 0)),
  constraint plan_items_installment_every_check check (kind <> 'installment' or every = 'month'),
  constraint plan_items_ends_on_check check (ends_on >= starts_on),
  constraint plan_items_installment_months_check check (
    kind <> 'installment'
    or (ends_on is not null and date_trunc('month', starts_on::timestamp) = starts_on and date_trunc('month', ends_on::timestamp) = ends_on)
  ),
  constraint plan_items_from_account_fkey foreign key (household_id, from_account_id) references waypoint.accounts (household_id, id),
  constraint plan_items_to_account_fkey foreign key (household_id, to_account_id) references waypoint.accounts (household_id, id),
  constraint plan_items_category_fkey foreign key (household_id, category_id) references waypoint.categories (household_id, id)
);

create table waypoint.statements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  account_id uuid not null,
  cut_date date not null,
  due_date date not null,
  previous_balance_minor bigint,
  payments_and_credits_minor bigint constraint statements_payments_and_credits_minor_check check (payments_and_credits_minor >= 0),
  charges_minor bigint constraint statements_charges_minor_check check (charges_minor >= 0),
  installments_minor bigint constraint statements_installments_minor_check check (installments_minor >= 0),
  interest_minor bigint constraint statements_interest_minor_check check (interest_minor >= 0),
  fees_minor bigint constraint statements_fees_minor_check check (fees_minor >= 0),
  total_due_minor bigint not null,
  minimum_due_minor bigint not null constraint statements_minimum_due_minor_check check (minimum_due_minor >= 0 and minimum_due_minor <= greatest(total_due_minor, 0)),
  available_credit_minor bigint,
  constraint statements_due_date_check check (due_date >= cut_date),
  constraint statements_parts_check check (
    num_nulls(previous_balance_minor, payments_and_credits_minor, charges_minor, installments_minor, interest_minor, fees_minor) in (0, 6)
  ),
  constraint statements_balance_check check (
    previous_balance_minor - payments_and_credits_minor + charges_minor + installments_minor + interest_minor + fees_minor = total_due_minor
  ),
  constraint statements_account_id_cut_date_key unique (account_id, cut_date),
  constraint statements_account_fkey foreign key (household_id, account_id) references waypoint.accounts (household_id, id) on delete cascade
);

create table waypoint.transactions (
  id uuid primary key,
  household_id uuid not null references waypoint.households (id) on delete cascade,
  account_id uuid not null,
  posted_on date not null,
  amount_minor bigint not null constraint transactions_amount_minor_check check (amount_minor <> 0),
  kind text not null constraint transactions_kind_check check (kind in ('income', 'expense', 'refund', 'transfer', 'drawdown', 'adjustment')),
  category_id uuid,
  description text not null default '' constraint transactions_description_check check (char_length(description) <= 140),
  transfer_id uuid,
  plan_item_id uuid,
  period date,
  external_id text,
  batch_id uuid,
  created_at timestamptz not null default now(),
  constraint transactions_money_in_check check (kind not in ('income', 'refund', 'drawdown') or amount_minor > 0),
  constraint transactions_expense_check check (kind <> 'expense' or amount_minor < 0),
  constraint transactions_category_check check (category_id is null or kind in ('expense', 'refund')),
  constraint transactions_transfer_id_check check ((kind = 'transfer') = (transfer_id is not null)),
  constraint transactions_link_check check ((plan_item_id is null) = (period is null)),
  constraint transactions_transfer_link_check check (plan_item_id is null or kind <> 'transfer' or amount_minor < 0),
  constraint transactions_account_id_external_id_key unique (account_id, external_id),
  constraint transactions_account_fkey foreign key (household_id, account_id) references waypoint.accounts (household_id, id) on delete cascade,
  constraint transactions_category_fkey foreign key (household_id, category_id) references waypoint.categories (household_id, id),
  constraint transactions_plan_item_fkey foreign key (household_id, plan_item_id) references waypoint.plan_items (household_id, id)
);

create index transactions_account_id_posted_on_idx on waypoint.transactions (account_id, posted_on);
create index transactions_household_id_posted_on_idx on waypoint.transactions (household_id, posted_on);
create index transactions_transfer_id_idx on waypoint.transactions (transfer_id) where transfer_id is not null;
create index transactions_batch_id_idx on waypoint.transactions (batch_id) where batch_id is not null;
create index transactions_plan_item_id_period_idx on waypoint.transactions (plan_item_id, period) where plan_item_id is not null;

alter table waypoint.households enable row level security;
alter table waypoint.accounts enable row level security;
alter table waypoint.categories enable row level security;
alter table waypoint.plan_items enable row level security;
alter table waypoint.statements enable row level security;
alter table waypoint.transactions enable row level security;

create policy households_own on waypoint.households for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy accounts_own on waypoint.accounts for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy categories_own on waypoint.categories for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy plan_items_own on waypoint.plan_items for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy statements_own on waypoint.statements for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy transactions_own on waypoint.transactions for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));

revoke all on table waypoint.households, waypoint.accounts, waypoint.categories, waypoint.plan_items, waypoint.statements, waypoint.transactions
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table waypoint.households, waypoint.accounts, waypoint.categories, waypoint.plan_items, waypoint.statements, waypoint.transactions
  to authenticated;

create schema private;
revoke all on schema private from public, anon, authenticated;

-- Owner's rights: Supabase Auth deletes a user as supabase_auth_admin, which has no rights on these tables.
create function private.transfer_pair() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  groups uuid[][];
  g uuid[];
  legs int;
  out_leg record;
  in_leg record;
begin
  groups := case tg_op
    when 'INSERT' then array[[new.household_id, new.transfer_id]]
    when 'DELETE' then array[[old.household_id, old.transfer_id]]
    else array[[old.household_id, old.transfer_id], [new.household_id, new.transfer_id]]
  end;
  foreach g slice 1 in array groups loop
    continue when g[2] is null;
    select count(*) into legs from waypoint.transactions t where t.household_id = g[1] and t.transfer_id = g[2];
    continue when legs = 0;
    if legs <> 2 then
      raise exception using errcode = 'check_violation', constraint = 'transfer_pair',
        message = format('transfer_pair: transfer %s has %s leg%s; a transfer has exactly 2', g[2], legs, case when legs = 1 then '' else 's' end);
    end if;
    select t.account_id, t.amount_minor, t.posted_on, a.currency into out_leg
      from waypoint.transactions t join waypoint.accounts a on a.household_id = t.household_id and a.id = t.account_id
      where t.household_id = g[1] and t.transfer_id = g[2] order by t.amount_minor, t.id limit 1;
    select t.account_id, t.amount_minor, t.posted_on, a.currency into in_leg
      from waypoint.transactions t join waypoint.accounts a on a.household_id = t.household_id and a.id = t.account_id
      where t.household_id = g[1] and t.transfer_id = g[2] order by t.amount_minor desc, t.id desc limit 1;
    if out_leg.account_id = in_leg.account_id then
      raise exception using errcode = 'check_violation', constraint = 'transfer_pair',
        message = format('transfer_pair: both legs of transfer %s are on account %s', g[2], out_leg.account_id);
    end if;
    if out_leg.amount_minor > 0 or in_leg.amount_minor < 0 then
      raise exception using errcode = 'check_violation', constraint = 'transfer_pair',
        message = format('transfer_pair: the legs of transfer %s need opposite signs', g[2]);
    end if;
    if in_leg.posted_on < out_leg.posted_on or in_leg.posted_on > out_leg.posted_on + 5 then
      raise exception using errcode = 'check_violation', constraint = 'transfer_pair',
        message = format('transfer_pair: the incoming leg of transfer %s must post 0 to 5 days after the outgoing leg (%s)', g[2], out_leg.posted_on);
    end if;
    if out_leg.currency = in_leg.currency and -out_leg.amount_minor <> in_leg.amount_minor then
      raise exception using errcode = 'check_violation', constraint = 'transfer_pair',
        message = format('transfer_pair: transfer %s moves %s out and %s in within %s; a fee is its own row', g[2], -out_leg.amount_minor, in_leg.amount_minor, out_leg.currency);
    end if;
  end loop;
  return null;
end;
$$;

create function private.check_link() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tx record;
  item record;
  partner record;
  leg_kind text;
  item_name text;
  problem text;
begin
  if new.plan_item_id is null and new.transfer_id is null then
    return null;
  end if;
  -- Also the linked leg of this row's transfer, since moving the unlinked leg can break the link.
  for tx in
    select t.* from waypoint.transactions t
    where t.household_id = new.household_id and t.plan_item_id is not null
      and (t.id = new.id or t.transfer_id = new.transfer_id)
  loop
    select p.kind, p.from_account_id, p.to_account_id into item
      from waypoint.plan_items p where p.household_id = tx.household_id and p.id = tx.plan_item_id;
    item_name := case item.kind
      when 'income' then 'an income item' when 'bill' then 'a bill' when 'allowance' then 'an allowance'
      when 'transfer' then 'a transfer item' else 'an installment' end;
    problem := null;
    if item.kind = 'allowance' then
      problem := 'an allowance settles by spending and takes no links';
    elsif item.kind = 'installment' then
      problem := 'an installment settles through statements and takes no links';
    elsif item.kind = 'transfer' and item.to_account_id is null then
      problem := 'extra for debts is sized by the engine and takes no links';
    elsif tx.kind = 'adjustment' then
      problem := 'an adjustment never links';
    elsif tx.kind = 'expense' then
      if item.kind <> 'bill' then
        problem := format('an expense links only to a bill, not to %s', item_name);
      elsif tx.account_id is distinct from item.from_account_id then
        problem := format('the expense must leave the bill''s account %s', item.from_account_id);
      end if;
    elsif tx.kind in ('income', 'refund', 'drawdown') then
      if item.kind <> 'income' then
        problem := format('%s links only to an income item, not to %s', case tx.kind when 'income' then 'income' else 'a ' || tx.kind end, item_name);
      elsif tx.account_id is distinct from item.to_account_id then
        problem := format('the %s must land in the item''s account %s', tx.kind, item.to_account_id);
      end if;
    elsif item.kind <> 'transfer' then
      problem := format('a transfer links only to a transfer item, not to %s', item_name);
    elsif item.from_account_id is not null and tx.account_id <> item.from_account_id then
      problem := format('the outgoing leg must leave the item''s account %s', item.from_account_id);
    else
      select a.kind into leg_kind from waypoint.accounts a where a.household_id = tx.household_id and a.id = tx.account_id;
      if item.from_account_id is null and leg_kind <> 'cash' then
        problem := 'the outgoing leg of a payment into a debt must leave a cash account';
      else
        select t.account_id into partner from waypoint.transactions t
          where t.household_id = tx.household_id and t.transfer_id = tx.transfer_id and t.id <> tx.id limit 1;
        if not found then
          problem := 'the transfer needs its other leg';
        elsif partner.account_id <> item.to_account_id then
          problem := format('the other leg must land in the item''s account %s', item.to_account_id);
        end if;
      end if;
    end if;
    if problem is not null then
      raise exception using errcode = 'check_violation', constraint = 'check_link',
        message = format('check_link: transaction %s: %s', tx.id, problem);
    end if;
  end loop;
  return null;
end;
$$;

create function private.check_plan_item() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  item record;
  from_kind text;
  to_kind text;
  problem text;
begin
  select p.kind, p.from_account_id, p.to_account_id into item
    from waypoint.plan_items p where p.household_id = new.household_id and p.id = new.id;
  if not found then
    return null;
  end if;
  select a.kind into from_kind from waypoint.accounts a where a.household_id = new.household_id and a.id = item.from_account_id;
  select a.kind into to_kind from waypoint.accounts a where a.household_id = new.household_id and a.id = item.to_account_id;
  if item.kind in ('bill', 'allowance') and from_kind not in ('cash', 'credit_card') then
    problem := format('%s leaves a cash account or a card, to no account', case item.kind when 'bill' then 'a bill' else 'an allowance' end);
  elsif item.kind = 'installment' and from_kind <> 'credit_card' then
    problem := 'an installment sits on a card, to no account';
  elsif item.kind = 'transfer' and from_kind is not null and to_kind is not null and (from_kind <> 'cash' or to_kind <> 'cash') then
    problem := 'a transfer with both accounts moves cash to cash; one into a debt has no from account and leaves the debt''s funded-from account';
  elsif item.kind = 'transfer' and from_kind is null and to_kind = 'cash' then
    problem := 'a transfer with no from account goes into a debt';
  elsif item.kind = 'transfer' and to_kind is null and from_kind <> 'cash' then
    problem := 'extra for debts leaves a cash account';
  end if;
  if problem is not null then
    raise exception using errcode = 'check_violation', constraint = 'check_plan_item',
      message = format('check_plan_item: plan item %s: %s', new.id, problem);
  end if;
  return null;
end;
$$;

alter function private.transfer_pair() owner to postgres;
alter function private.check_link() owner to postgres;
alter function private.check_plan_item() owner to postgres;
revoke all on function private.transfer_pair(), private.check_link(), private.check_plan_item() from public, anon, authenticated;

create constraint trigger transfer_pair after insert or update or delete on waypoint.transactions
  deferrable initially deferred for each row execute function private.transfer_pair();
create constraint trigger check_link after insert or update on waypoint.transactions
  deferrable initially deferred for each row execute function private.check_link();
create constraint trigger check_plan_item after insert or update on waypoint.plan_items
  deferrable initially deferred for each row execute function private.check_plan_item();
