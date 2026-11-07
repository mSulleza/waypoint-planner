-- post_batch and split_plan_item run as the caller, so RLS applies; each error is P0001, named by its message prefix, with a JSON detail.

create function waypoint.post_batch(p_batch jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  batch_keys constant text[] := array['batch_id', 'allow_over', 'expect_before', 'expect_after', 'rows'];
  row_keys constant text[] := array['id', 'account_id', 'posted_on', 'amount_minor', 'kind', 'category_id', 'description', 'transfer_id', 'plan_item_id', 'period', 'external_id'];
  required_keys constant text[] := array['id', 'account_id', 'posted_on', 'amount_minor', 'kind'];
  v_household uuid := (select auth.uid());
  v_issues text[];
  v_batch_id uuid;
  v_allow_over boolean;
  v_expect_before jsonb;
  v_expect_after jsonb;
  v_rows waypoint.transactions[];
  v_timezone text;
  v_today date;
  v_account_ids uuid[];
  v_missing text;
  v_existing int;
  v_changed text;
  v_changed_ids jsonb;
  v_before jsonb;
  v_after jsonb;
  v_problem text;
  v_detail jsonb;
  v_leg record;
  v_cut date;
  v_total bigint;
  v_remaining bigint;
  v_recorded text[];
  v_recorded_ids uuid[];
  v_inserted int;
begin
  if jsonb_typeof(p_batch) is distinct from 'object' then
    raise exception 'bad_input: the batch must be a JSON object with %', array_to_string(batch_keys, ', ');
  end if;
  v_issues := array(
    select format('Unknown key%s %s; allowed keys: %s', case when count(*) > 1 then 's' else '' end, string_agg(format('''%s''', k), ', ' order by k), array_to_string(batch_keys, ', '))
    from jsonb_object_keys(p_batch) k where k <> all (batch_keys) having count(*) > 0
  );
  if coalesce(jsonb_typeof(p_batch -> 'batch_id'), 'null') <> 'string' then
    v_issues := v_issues || 'batch_id: must be a uuid'::text;
  end if;
  if jsonb_typeof(p_batch -> 'rows') is distinct from 'array' or jsonb_array_length(p_batch -> 'rows') = 0 then
    v_issues := v_issues || 'rows: must hold at least one row'::text;
  elsif exists (select 1 from jsonb_array_elements(p_batch -> 'rows') e(j) where jsonb_typeof(e.j) <> 'object') then
    v_issues := v_issues || 'rows: every row must be a JSON object'::text;
  else
    v_issues := v_issues || array(
      select format('rows[%s]: Unknown key%s %s; allowed keys: %s', e.ord - 1, case when count(*) > 1 then 's' else '' end, string_agg(format('''%s''', k), ', ' order by k), array_to_string(row_keys, ', '))
      from jsonb_array_elements(p_batch -> 'rows') with ordinality e(j, ord), jsonb_object_keys(e.j) k
      where k <> all (row_keys) group by e.ord order by e.ord
    ) || array(
      select format('rows[%s].%s: is required', e.ord - 1, k)
      from jsonb_array_elements(p_batch -> 'rows') with ordinality e(j, ord), unnest(required_keys) with ordinality r(k, pos)
      where coalesce(jsonb_typeof(e.j -> k), 'null') = 'null' order by e.ord, r.pos
    ) || array(
      select format('rows: duplicate id ''%s''', e.j ->> 'id')
      from jsonb_array_elements(p_batch -> 'rows') e(j) where e.j ? 'id' group by e.j ->> 'id' having count(*) > 1 order by 1
    );
  end if;
  if coalesce(jsonb_typeof(p_batch -> 'allow_over'), 'boolean') not in ('boolean', 'null') then
    v_issues := v_issues || 'allow_over: must be true or false'::text;
  end if;
  if coalesce(jsonb_typeof(p_batch -> 'expect_before'), 'object') not in ('object', 'null') then
    v_issues := v_issues || 'expect_before: must map account ids to balances in minor units'::text;
  end if;
  if coalesce(jsonb_typeof(p_batch -> 'expect_after'), 'object') not in ('object', 'null') then
    v_issues := v_issues || 'expect_after: must map account ids to balances in minor units'::text;
  end if;
  if cardinality(v_issues) > 0 then
    raise exception using message = 'bad_input: ' || array_to_string(v_issues, '; '),
      detail = jsonb_build_object('error', 'bad_input', 'issues', to_jsonb(v_issues))::text;
  end if;

  v_batch_id := (p_batch ->> 'batch_id')::uuid;
  v_allow_over := coalesce((p_batch ->> 'allow_over')::boolean, false);
  v_expect_before := coalesce(nullif(p_batch -> 'expect_before', 'null'), '{}');
  v_expect_after := coalesce(nullif(p_batch -> 'expect_after', 'null'), '{}');
  -- The batch stamps household_id and batch_id; a missing description gets the column default.
  select array_agg(jsonb_populate_record(null::waypoint.transactions,
      e.j || jsonb_build_object('household_id', v_household, 'batch_id', v_batch_id, 'description', coalesce(e.j ->> 'description', ''))) order by e.ord)
    into v_rows
    from jsonb_array_elements(p_batch -> 'rows') with ordinality e(j, ord);

  select h.timezone into v_timezone from waypoint.households h where h.id = v_household;
  if not found then
    raise exception using message = 'no_household: the signed-in user has no household',
      detail = jsonb_build_object('error', 'no_household')::text;
  end if;
  v_today := (now() at time zone v_timezone)::date;
  v_account_ids := array(
    select r.account_id from unnest(v_rows) r
    union select k::uuid from jsonb_object_keys(v_expect_before) k
    union select k::uuid from jsonb_object_keys(v_expect_after) k
    order by 1
  );
  -- Id order, so two batches on the same accounts queue instead of deadlocking.
  perform 1 from waypoint.accounts a where a.id = any (v_account_ids) order by a.id for update;
  select string_agg(x::text, ', ' order by x) into v_missing
    from unnest(v_account_ids) x where not exists (select 1 from waypoint.accounts a where a.id = x);
  if v_missing is not null then
    raise exception using message = format('unknown_account: no account %s in this household', v_missing),
      detail = jsonb_build_object('error', 'unknown_account', 'account_ids', string_to_array(v_missing, ', '))::text;
  end if;

  -- An expected balance is the bank's figure: opening plus every row up to today.
  select coalesce(jsonb_object_agg(a.id, a.opening_balance_minor + coalesce(s.total, 0)), '{}') into v_before
    from waypoint.accounts a
    left join lateral (select sum(t.amount_minor) as total from waypoint.transactions t where t.account_id = a.id and t.posted_on <= v_today) s on true
    where a.id = any (v_account_ids);

  -- A retried save changes nothing; reused ids with other content, or a half-saved batch, are refused.
  select count(t.id)::int,
      string_agg(format('row %s already exists with other %s', b.id, d.fields), '; ' order by b.ordinality) filter (where t.id is not null and d.fields <> ''),
      jsonb_agg(b.id order by b.ordinality) filter (where t.id is not null and d.fields <> '')
    into v_existing, v_changed, v_changed_ids
    from unnest(v_rows) with ordinality b
    left join waypoint.transactions t on t.id = b.id
    cross join lateral (select array_to_string(array[
      case when t.account_id is distinct from b.account_id then 'account_id' end,
      case when t.posted_on is distinct from b.posted_on then 'posted_on' end,
      case when t.amount_minor is distinct from b.amount_minor then 'amount_minor' end,
      case when t.kind is distinct from b.kind then 'kind' end,
      case when t.category_id is distinct from b.category_id then 'category_id' end,
      case when t.description is distinct from b.description then 'description' end,
      case when t.transfer_id is distinct from b.transfer_id then 'transfer_id' end,
      case when t.plan_item_id is distinct from b.plan_item_id then 'plan_item_id' end,
      case when t.period is distinct from b.period then 'period' end,
      case when t.external_id is distinct from b.external_id then 'external_id' end,
      case when t.batch_id is distinct from b.batch_id then 'batch_id' end
    ], ', ') as fields) d;
  if v_changed is not null then
    raise exception using message = 'id_conflict: ' || v_changed,
      detail = jsonb_build_object('error', 'id_conflict', 'ids', v_changed_ids)::text;
  end if;
  if v_existing = cardinality(v_rows) then
    return jsonb_build_object('status', 'already_applied', 'batch_id', v_batch_id, 'inserted', 0, 'balances_before', v_before, 'balances_after', v_before);
  end if;
  if v_existing > 0 then
    raise exception using message = format('partial_replay: %s of the %s rows already exist; resend the whole batch unchanged or use new ids', v_existing, cardinality(v_rows)),
      detail = jsonb_build_object('error', 'partial_replay', 'ids',
        (select jsonb_agg(b.id order by b.ordinality) from unnest(v_rows) with ordinality b where exists (select 1 from waypoint.transactions t where t.id = b.id)))::text;
  end if;

  select string_agg(format('account %s is %s, not the expected %s', e.key, v_before -> (e.key::uuid::text), e.value), '; ' order by e.key),
      jsonb_agg(jsonb_build_object('account_id', e.key::uuid, 'expected_minor', e.value, 'actual_minor', v_before -> (e.key::uuid::text)) order by e.key)
    into v_problem, v_detail
    from jsonb_each(v_expect_before) e where v_before -> (e.key::uuid::text) is distinct from e.value;
  if v_problem is not null then
    raise exception using message = 'balance_mismatch: before the batch, ' || v_problem,
      detail = jsonb_build_object('error', 'balance_mismatch', 'when', 'before', 'accounts', v_detail)::text;
  end if;

  -- A card payment may not exceed the remaining due on the latest statement cut on or before it; the opening balance stands in for none.
  if not v_allow_over then
    for v_leg in
      select b.id, b.account_id, b.posted_on, b.amount_minor, b.ordinality, a.opening_balance_minor
      from unnest(v_rows) with ordinality b join waypoint.accounts a on a.id = b.account_id
      where b.kind = 'transfer' and b.amount_minor > 0 and a.kind = 'credit_card'
      order by b.ordinality
    loop
      select s.cut_date, s.total_due_minor into v_cut, v_total
        from waypoint.statements s where s.account_id = v_leg.account_id and s.cut_date <= v_leg.posted_on
        order by s.cut_date desc limit 1;
      if not found then
        v_total := -v_leg.opening_balance_minor;
      end if;
      v_remaining := v_total
        - coalesce((select sum(t.amount_minor) from waypoint.transactions t
            where t.account_id = v_leg.account_id and t.amount_minor > 0 and (v_cut is null or t.posted_on > v_cut)), 0)
        - coalesce((select sum(b.amount_minor) from unnest(v_rows) with ordinality b
            where b.ordinality < v_leg.ordinality and b.account_id = v_leg.account_id and b.amount_minor > 0 and (v_cut is null or b.posted_on > v_cut)), 0);
      if v_leg.amount_minor > v_remaining then
        raise exception using
          message = format('over_remainder: row %s pays %s into card %s, above the %s remaining due on %s; set allow_over to pay more',
            v_leg.id, v_leg.amount_minor, v_leg.account_id, v_remaining, coalesce('the statement cut ' || v_cut, 'the opening balance')),
          detail = jsonb_build_object('error', 'over_remainder', 'id', v_leg.id, 'account_id', v_leg.account_id, 'amount_minor', v_leg.amount_minor,
            'remaining_minor', v_remaining, 'cut_date', v_cut)::text;
      end if;
    end loop;
  end if;

  -- Checked first to name the external ids; the unique index stays the final guard.
  select array_agg(b.external_id order by b.ordinality), array_agg(b.id order by b.ordinality) into v_recorded, v_recorded_ids
    from unnest(v_rows) with ordinality b
    where b.external_id is not null and exists (select 1 from waypoint.transactions t where t.account_id = b.account_id and t.external_id = b.external_id);
  if v_recorded is not null then
    raise exception using
      message = format('already_recorded: external id%s %s %s already recorded on %s account', case when cardinality(v_recorded) > 1 then 's' else '' end,
        (select string_agg(format('''%s''', x), ', ') from unnest(v_recorded) x), case when cardinality(v_recorded) > 1 then 'are' else 'is' end,
        case when cardinality(v_recorded) > 1 then 'their' else 'its' end),
      detail = jsonb_build_object('error', 'already_recorded', 'external_ids', to_jsonb(v_recorded), 'ids', to_jsonb(v_recorded_ids))::text;
  end if;

  insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id, description, transfer_id, plan_item_id, period, external_id, batch_id)
  select b.id, b.household_id, b.account_id, b.posted_on, b.amount_minor, b.kind, b.category_id, b.description, b.transfer_id, b.plan_item_id, b.period, b.external_id, b.batch_id
  from unnest(v_rows) b;
  get diagnostics v_inserted = row_count;

  select coalesce(jsonb_object_agg(a.id, a.opening_balance_minor + coalesce(s.total, 0)), '{}') into v_after
    from waypoint.accounts a
    left join lateral (select sum(t.amount_minor) as total from waypoint.transactions t where t.account_id = a.id and t.posted_on <= v_today) s on true
    where a.id = any (v_account_ids);
  select string_agg(format('account %s is %s, not the expected %s', e.key, v_after -> (e.key::uuid::text), e.value), '; ' order by e.key),
      jsonb_agg(jsonb_build_object('account_id', e.key::uuid, 'expected_minor', e.value, 'actual_minor', v_after -> (e.key::uuid::text)) order by e.key)
    into v_problem, v_detail
    from jsonb_each(v_expect_after) e where v_after -> (e.key::uuid::text) is distinct from e.value;
  if v_problem is not null then
    raise exception using message = 'balance_mismatch: after the batch, ' || v_problem,
      detail = jsonb_build_object('error', 'balance_mismatch', 'when', 'after', 'accounts', v_detail)::text;
  end if;

  return jsonb_build_object('status', 'applied', 'batch_id', v_batch_id, 'inserted', v_inserted, 'balances_before', v_before, 'balances_after', v_after);
end;
$$;

create function waypoint.split_plan_item(p_id uuid, p_from date, p_patch jsonb) returns uuid
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
  v_start date;
  v_end date;
  v_map jsonb;
  v_orphan text;
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
  if v_patch ? 'day' and (v_old.kind = 'installment' or v_every not in ('month', 'year')) then
    raise exception 'bad_split: day moves an item that repeats monthly or yearly; an installment bills at the cut and a weekly item keeps its weekday';
  end if;

  -- The new row starts at the old row's first occurrence on or after v_from, so the cadence carries on.
  v_months := case v_old.every when 'month' then 1 when 'year' then 12 end;
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
  v_start := case when v_patch ? 'day'
    then make_date(extract(year from v_anchor)::int, extract(month from v_anchor)::int,
      least((v_patch ->> 'day')::int, extract(day from date_trunc('month', v_anchor) + interval '1 month - 1 day')::int))
    else v_anchor end;
  v_end := case when v_patch ? 'ends_on' then (v_patch ->> 'ends_on')::date else v_old.ends_on end;
  if v_start > v_end then
    raise exception 'bad_split: the new row would start % but end %', v_start, v_end;
  end if;

  -- Links and skips from v_from move to the new row's occurrence in the same month, or year for a yearly item.
  select coalesce(jsonb_object_agg(p.period, case
      when v_every <> v_old.every then p.period
      when v_every = 'month' then (v_start + make_interval(months => (
        (extract(year from p.period) - extract(year from v_start)) * 12 + extract(month from p.period) - extract(month from v_start))::int))::date
      when v_every = 'year' then (v_start + make_interval(years => (extract(year from p.period) - extract(year from v_start))::int))::date
      else p.period end), '{}')
    into v_map
    from (
      select t.period from waypoint.transactions t where t.plan_item_id = p_id and t.period >= v_from
      union select s.period from unnest(v_old.skip_periods) s(period) where s.period >= v_from
    ) p;
  select m.key into v_orphan
    from jsonb_each_text(v_map) m cross join lateral (select m.value::date as d) x
    where not (x.d >= v_start and (v_end is null or x.d <= v_end) and case v_every
      when 'month' then x.d = (v_start + make_interval(months => (
        (extract(year from x.d) - extract(year from v_start)) * 12 + extract(month from x.d) - extract(month from v_start))::int))::date
      when 'year' then x.d = (v_start + make_interval(years => (extract(year from x.d) - extract(year from v_start))::int))::date
      when 'week' then (x.d - v_start) % 7 = 0
      when '2weeks' then (x.d - v_start) % 14 = 0
      else x.d = v_start end)
    order by m.key limit 1;
  if v_orphan is not null then
    raise exception 'bad_split: the occurrence % is linked or skipped, and the new row has no occurrence to take it; unlink or unskip it first', v_orphan;
  end if;

  update waypoint.plan_items p
    set ends_on = case when v_old.kind = 'installment' then (v_from - interval '1 month')::date else v_from - 1 end,
      skip_periods = array(select s from unnest(v_old.skip_periods) s where s < v_from order by s)
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
    array(select (v_map ->> s::text)::date from unnest(v_old.skip_periods) s where s >= v_from order by 1)
  );
  update waypoint.transactions t set plan_item_id = v_new, period = (v_map ->> t.period::text)::date
    where t.plan_item_id = p_id and t.period >= v_from;
  return v_new;
end;
$$;

revoke execute on function waypoint.post_batch(jsonb), waypoint.split_plan_item(uuid, date, jsonb) from public, anon, service_role;
grant execute on function waypoint.post_batch(jsonb), waypoint.split_plan_item(uuid, date, jsonb) to authenticated;
