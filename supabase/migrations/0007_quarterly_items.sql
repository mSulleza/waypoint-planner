-- Income, a bill or a transfer may repeat every 3 months from starts_on ('quarter'); split_plan_item steps such an item 3 months at a time.

alter table waypoint.plan_items
  drop constraint plan_items_every_check,
  add constraint plan_items_every_check check (every in ('once', 'week', '2weeks', 'month', 'quarter', 'year')),
  add constraint plan_items_quarter_check check (every <> 'quarter' or kind in ('income', 'bill', 'transfer'));

create or replace function waypoint.split_plan_item(p_id uuid, p_from date, p_patch jsonb) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  patch_keys constant text[] := array['amount_minor', 'name', 'from_account_id', 'to_account_id', 'category_id', 'every', 'roll', 'confidence', 'ends_on', 'day'];
  v_patch jsonb := coalesce(p_patch, '{}');
  v_unknown text[];
  v_old waypoint.plan_items;
  v_from date;
  v_every text;
  v_months int;
  v_days int;
  v_steps int;
  v_anchor date;
  v_cut date;
  v_start date;
  v_end date;
  v_orphan date;
  v_new uuid := gen_random_uuid();
begin
  if jsonb_typeof(v_patch) <> 'object' then
    raise exception 'bad_patch: the patch must be a JSON object with any of %', array_to_string(patch_keys, ', ');
  end if;
  select array_agg(format('''%s''', k) order by k) into v_unknown from jsonb_object_keys(v_patch) k where k <> all (patch_keys);
  if v_unknown is not null then
    raise exception 'bad_patch: Unknown key% %; allowed keys: %', case when cardinality(v_unknown) > 1 then 's' else '' end,
      array_to_string(v_unknown, ', '), array_to_string(patch_keys, ', ');
  end if;
  if v_patch ? 'day' and not (jsonb_typeof(v_patch -> 'day') = 'number' and (v_patch ->> 'day') ~ '^([1-9]|[12][0-9]|3[01])$') then
    raise exception 'bad_patch: day must be a day of the month, 1 to 31';
  end if;

  select p.* into v_old from waypoint.plan_items p where p.id = p_id for update;
  if not found then
    raise exception 'unknown_plan_item: no plan item % in this household', p_id;
  end if;
  if p_from is null then
    raise exception 'bad_split: p_from is the first day the change applies and is required';
  end if;
  if v_old.every = 'once' then
    raise exception 'bad_split: plan item % happens once; update it instead', p_id;
  end if;
  v_from := case when v_old.kind = 'installment' then date_trunc('month', p_from)::date else p_from end;
  if v_from <= v_old.starts_on then
    raise exception 'bad_split: split from a day after the first occurrence %; to change every occurrence, update the item', v_old.starts_on;
  end if;
  if v_from > v_old.ends_on then
    raise exception 'bad_split: plan item % ends %, before %', p_id, v_old.ends_on, v_from;
  end if;
  v_every := coalesce(v_patch ->> 'every', v_old.every);
  if v_patch ? 'day' and (v_old.kind = 'installment' or v_every not in ('month', 'quarter', 'year')) then
    raise exception 'bad_split: day moves an item that repeats monthly, every 3 months or yearly; an installment bills at the cut and a weekly item keeps its weekday';
  end if;

  -- The new row starts at the old row's first occurrence on or after v_from, so the cadence carries on.
  v_months := case v_old.every when 'month' then 1 when 'quarter' then 3 when 'year' then 12 end;
  v_days := case v_old.every when 'week' then 7 when '2weeks' then 14 end;
  if v_months is not null then
    v_steps := ((extract(year from v_from) - extract(year from v_old.starts_on)) * 12 + extract(month from v_from) - extract(month from v_old.starts_on))::int / v_months;
    v_anchor := v_old.starts_on + make_interval(months => v_months * v_steps);
    if v_anchor < v_from then
      v_anchor := v_old.starts_on + make_interval(months => v_months * (v_steps + 1));
    end if;
  else
    v_anchor := v_old.starts_on + v_days * ((v_from - v_old.starts_on + v_days - 1) / v_days);
  end if;
  -- Links and skips from the anchor's period on move to the new row; a mid-month v_from can fall after that period.
  v_cut := case when v_months is null then v_anchor else date_trunc('month', v_anchor)::date end;
  v_start := case when v_patch ? 'day'
    then make_date(extract(year from v_anchor)::int, extract(month from v_anchor)::int,
      least((v_patch ->> 'day')::int, extract(day from date_trunc('month', v_anchor) + interval '1 month - 1 day')::int))
    else v_anchor end;
  v_end := case when v_patch ? 'ends_on' then (v_patch ->> 'ends_on')::date else v_old.ends_on end;
  if v_start > v_end then
    raise exception 'bad_split: the new row would start % but end %', v_start, v_end;
  end if;

  -- A moved period keeps its value, so it must be the period of a new-row occurrence between v_start and v_end.
  select p.period into v_orphan
    from (
      select t.period from waypoint.transactions t where t.plan_item_id = p_id and t.period >= v_cut
      union select s.period from unnest(v_old.skip_periods) s(period) where s.period >= v_cut
    ) p
    cross join lateral (select ((extract(year from p.period) - extract(year from v_start)) * 12 + extract(month from p.period) - extract(month from v_start))::int as months) d
    cross join lateral (select case
      when v_every = 'once' then v_start
      when v_every = 'month' or (v_every = 'quarter' and d.months % 3 = 0) or (v_every = 'year' and d.months % 12 = 0) then (v_start + make_interval(months => d.months))::date
      when (v_every = 'week' and (p.period - v_start) % 7 = 0) or (v_every = '2weeks' and (p.period - v_start) % 14 = 0) then p.period
    end as day) o
    where o.day is null or o.day < v_start or (v_end is not null and o.day > v_end)
      or p.period <> case when v_every in ('week', '2weeks') then o.day else date_trunc('month', o.day)::date end
    order by p.period limit 1;
  if v_orphan is not null then
    raise exception 'bad_split: the occurrence % is linked or skipped, and the new row has no occurrence to take it; unlink or unskip it first', v_orphan;
  end if;

  update waypoint.plan_items p
    set ends_on = case when v_old.kind = 'installment' then (v_from - interval '1 month')::date else v_from - 1 end,
      skip_periods = array(select s from unnest(v_old.skip_periods) s where s < v_cut order by s)
    where p.id = p_id;
  insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, category_id, amount_minor, every, starts_on, ends_on, roll, confidence, skip_periods)
  values (
    v_new, v_old.household_id, v_old.kind,
    case when v_patch ? 'name' then v_patch ->> 'name' else v_old.name end,
    case when v_patch ? 'from_account_id' then (v_patch ->> 'from_account_id')::uuid else v_old.from_account_id end,
    case when v_patch ? 'to_account_id' then (v_patch ->> 'to_account_id')::uuid else v_old.to_account_id end,
    case when v_patch ? 'category_id' then (v_patch ->> 'category_id')::uuid else v_old.category_id end,
    case when v_patch ? 'amount_minor' then (v_patch ->> 'amount_minor')::bigint else v_old.amount_minor end,
    v_every, v_start, v_end,
    case when v_patch ? 'roll' then v_patch ->> 'roll' else v_old.roll end,
    case when v_patch ? 'confidence' then v_patch ->> 'confidence' else v_old.confidence end,
    array(select s from unnest(v_old.skip_periods) s where s >= v_cut order by s)
  );
  update waypoint.transactions t set plan_item_id = v_new where t.plan_item_id = p_id and t.period >= v_cut;
  return v_new;
end;
$$;
