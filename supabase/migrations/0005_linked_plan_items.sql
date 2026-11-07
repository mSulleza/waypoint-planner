-- check_plan_item also refuses a change of kind or accounts on a plan item that has linked transactions.

create or replace function private.check_plan_item() returns trigger
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
  if tg_op = 'UPDATE'
    and (old.kind, old.from_account_id, old.to_account_id) is distinct from (new.kind, new.from_account_id, new.to_account_id)
    and exists (select 1 from waypoint.transactions t where t.household_id = new.household_id and t.plan_item_id = new.id) then
    problem := 'its linked transactions fix its kind and accounts; split_plan_item changes the accounts from a later period';
  elsif item.kind in ('bill', 'allowance') and from_kind not in ('cash', 'credit_card') then
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
