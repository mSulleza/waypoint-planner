-- import_household moves a household in, export_household is the one read every client uses, and delete_my_account removes the caller.

create function waypoint.import_household(p_doc jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc_keys constant text[] := array['version', 'household', 'accounts', 'categories', 'plan_items', 'statements', 'transactions'];
  household_keys constant text[] := array['base_currency', 'timezone', 'locale', 'payoff_order', 'track_from'];
  tables constant text[] := array['accounts', 'categories', 'plan_items', 'statements', 'transactions'];
  v_household uuid := (select auth.uid());
  v_issues text[];
  v_ids jsonb;
begin
  if jsonb_typeof(p_doc) is distinct from 'object' then
    raise exception using message = 'bad_input: the document must be a JSON object with ' || array_to_string(doc_keys, ', '),
      detail = jsonb_build_object('error', 'bad_input', 'issues', jsonb_build_array('(root): must be a JSON object'))::text;
  end if;
  v_issues := array(
    select format('Unknown key%s %s; allowed keys: %s', case when count(*) > 1 then 's' else '' end, string_agg(format('''%s''', k), ', ' order by k), array_to_string(doc_keys, ', '))
    from jsonb_object_keys(p_doc) k where k <> all (doc_keys) having count(*) > 0
  );
  if p_doc -> 'version' is distinct from '1'::jsonb then
    v_issues := v_issues || 'version: must be 1'::text;
  end if;
  if jsonb_typeof(p_doc -> 'household') is distinct from 'object' then
    v_issues := v_issues || ('household: must be an object with ' || array_to_string(household_keys, ', '));
  else
    v_issues := v_issues || array(
      select format('household: Unknown key%s %s; allowed keys: %s', case when count(*) > 1 then 's' else '' end, string_agg(format('''%s''', k), ', ' order by k), array_to_string(household_keys, ', '))
      from jsonb_object_keys(p_doc -> 'household') k where k <> all (household_keys) having count(*) > 0
    );
  end if;
  v_issues := v_issues || array(
    select format('%s: must be an array', u.t) from unnest(tables) with ordinality u(t, pos)
    where coalesce(jsonb_typeof(p_doc -> u.t), 'array') <> 'array' order by u.pos
  );

  -- Each row keeps the keys of core's importDoc, a non-empty id unique in its table, and references that name a row of the document.
  v_issues := v_issues || array(
    with spec(t, pos, keys) as (values
      ('accounts', 1, array['id', 'name', 'kind', 'currency', 'opening_balance_minor', 'opening_date', 'terms', 'funded_from_account_id', 'floor_windows', 'fx_fee_pct', 'csv_mapping', 'sort_order', 'archived_at']),
      ('categories', 2, array['id', 'name', 'archived_at']),
      ('plan_items', 3, array['id', 'kind', 'name', 'from_account_id', 'to_account_id', 'category_id', 'amount_minor', 'every', 'starts_on', 'ends_on', 'roll', 'confidence', 'skip_periods']),
      ('statements', 4, array['id', 'account_id', 'cut_date', 'due_date', 'previous_balance_minor', 'payments_and_credits_minor', 'charges_minor', 'installments_minor', 'interest_minor', 'fees_minor', 'total_due_minor', 'minimum_due_minor', 'available_credit_minor']),
      ('transactions', 5, array['id', 'account_id', 'posted_on', 'amount_minor', 'kind', 'category_id', 'description', 'transfer_id', 'plan_item_id', 'period', 'external_id', 'batch_id'])
    ),
    refs(t, col, target, noun) as (values
      ('accounts', 'funded_from_account_id', 'accounts', 'account'),
      ('plan_items', 'from_account_id', 'accounts', 'account'),
      ('plan_items', 'to_account_id', 'accounts', 'account'),
      ('plan_items', 'category_id', 'categories', 'category'),
      ('statements', 'account_id', 'accounts', 'account'),
      ('transactions', 'account_id', 'accounts', 'account'),
      ('transactions', 'category_id', 'categories', 'category'),
      ('transactions', 'plan_item_id', 'plan_items', 'plan item')
    ),
    r as (
      select s.t, s.pos, s.keys, e.ord, e.j, jsonb_typeof(e.j) = 'object' as is_object
      from spec s
      cross join lateral jsonb_array_elements(case when jsonb_typeof(p_doc -> s.t) = 'array' then p_doc -> s.t else '[]' end) with ordinality e(j, ord)
    ),
    ids as (select r.t, r.j ->> 'id' as id from r where r.is_object and jsonb_typeof(r.j -> 'id') = 'string' and r.j ->> 'id' <> '')
    select x.issue from (
      select r.pos, r.ord, 0 as step, format('%s[%s]: must be a JSON object', r.t, r.ord - 1) as issue from r where not r.is_object
      union all
      select r.pos, r.ord, 1, format('%s[%s]: Unknown key%s %s; allowed keys: %s', r.t, r.ord - 1, case when count(*) > 1 then 's' else '' end,
          string_agg(format('''%s''', k), ', ' order by k), array_to_string(r.keys, ', '))
        from r cross join lateral jsonb_object_keys(case when r.is_object then r.j else '{}' end) k
        where k <> all (r.keys) group by r.t, r.pos, r.ord, r.keys
      union all
      select r.pos, r.ord, 2, format('%s[%s].id: must be a non-empty id', r.t, r.ord - 1) from r
        where r.is_object and (jsonb_typeof(r.j -> 'id') is distinct from 'string' or r.j ->> 'id' = '')
      union all
      select s.pos, 0, 3, format('%s: duplicate id ''%s''', ids.t, ids.id) from ids join spec s on s.t = ids.t group by s.pos, ids.t, ids.id having count(*) > 1
      union all
      select r.pos, r.ord, 4, format('%s[%s].%s: no %s ''%s'' in the document', r.t, r.ord - 1, f.col, f.noun, r.j ->> f.col)
        from r join refs f on f.t = r.t
        where r.is_object and r.j ->> f.col is not null and not exists (select 1 from ids where ids.t = f.target and ids.id = r.j ->> f.col)
    ) x order by x.pos, x.ord, x.step, x.issue
  );
  if cardinality(v_issues) > 0 then
    raise exception using message = 'bad_input: ' || array_to_string(v_issues, '; '),
      detail = jsonb_build_object('error', 'bad_input', 'issues', to_jsonb(v_issues))::text;
  end if;

  -- The household row first: a concurrent import of the same user waits on it, then sees this one's rows and stops below.
  insert into waypoint.households (id, base_currency, timezone, locale, payoff_order, track_from)
  select v_household, h.base_currency, h.timezone, h.locale, h.payoff_order, h.track_from
  from jsonb_populate_record(null::waypoint.households, '{"payoff_order": "avalanche"}' || (p_doc -> 'household')) h
  on conflict (id) do update set base_currency = excluded.base_currency, timezone = excluded.timezone, locale = excluded.locale,
    payoff_order = excluded.payoff_order, track_from = excluded.track_from;
  if exists (select 1 from waypoint.accounts a where a.household_id = v_household)
    or exists (select 1 from waypoint.categories c where c.household_id = v_household) then
    raise exception using message = 'household_not_empty: this household already holds accounts or categories; import_household fills an empty household only',
      detail = jsonb_build_object('error', 'household_not_empty')::text;
  end if;

  -- A fresh uuid for every document id, per table, and for each transfer and batch the rows share.
  select jsonb_object_agg(m.t, m.ids) into v_ids
  from (
    select u.t, coalesce(jsonb_object_agg(e.j ->> 'id', gen_random_uuid()) filter (where e.j is not null), '{}') as ids
    from unnest(tables) u(t)
    left join lateral jsonb_array_elements(coalesce(p_doc -> u.t, '[]')) e(j) on true
    group by u.t
    union all
    select x.t, coalesce(jsonb_object_agg(d.id, gen_random_uuid()) filter (where d.id is not null), '{}')
    from (values ('transfers', 'transfer_id'), ('batches', 'batch_id')) x(t, col)
    left join lateral (select distinct e.j ->> x.col as id from jsonb_array_elements(coalesce(p_doc -> 'transactions', '[]')) e(j)) d on true
    group by x.t
  ) m;

  insert into waypoint.categories (id, household_id, name, archived_at)
  select (v_ids #>> array['categories', e.j ->> 'id'])::uuid, v_household, c.name, c.archived_at
  from jsonb_array_elements(coalesce(p_doc -> 'categories', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.categories, e.j - 'id') c;

  -- One statement, so an account may name a funder listed after it: the foreign key is checked at the statement's end.
  insert into waypoint.accounts (id, household_id, name, kind, currency, opening_balance_minor, opening_date, terms, funded_from_account_id, floor_windows, fx_fee_pct, csv_mapping, sort_order, archived_at)
  select (v_ids #>> array['accounts', e.j ->> 'id'])::uuid, v_household, a.name, a.kind, a.currency, a.opening_balance_minor, a.opening_date, a.terms,
    (v_ids #>> array['accounts', e.j ->> 'funded_from_account_id'])::uuid, a.floor_windows, a.fx_fee_pct, a.csv_mapping, a.sort_order, a.archived_at
  from jsonb_array_elements(coalesce(p_doc -> 'accounts', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.accounts,
    '{"opening_balance_minor": 0, "floor_windows": [], "sort_order": 0}' || (e.j - array['id', 'funded_from_account_id'])) a;

  insert into waypoint.plan_items (id, household_id, kind, name, from_account_id, to_account_id, category_id, amount_minor, every, starts_on, ends_on, roll, confidence, skip_periods)
  select (v_ids #>> array['plan_items', e.j ->> 'id'])::uuid, v_household, p.kind, p.name,
    (v_ids #>> array['accounts', e.j ->> 'from_account_id'])::uuid, (v_ids #>> array['accounts', e.j ->> 'to_account_id'])::uuid,
    (v_ids #>> array['categories', e.j ->> 'category_id'])::uuid, p.amount_minor, p.every, p.starts_on, p.ends_on, p.roll, p.confidence, p.skip_periods
  from jsonb_array_elements(coalesce(p_doc -> 'plan_items', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.plan_items,
    '{"every": "month", "roll": "none", "confidence": "committed", "skip_periods": []}' || (e.j - array['id', 'from_account_id', 'to_account_id', 'category_id'])) p;

  insert into waypoint.statements (id, household_id, account_id, cut_date, due_date, previous_balance_minor, payments_and_credits_minor, charges_minor,
    installments_minor, interest_minor, fees_minor, total_due_minor, minimum_due_minor, available_credit_minor)
  select (v_ids #>> array['statements', e.j ->> 'id'])::uuid, v_household, (v_ids #>> array['accounts', e.j ->> 'account_id'])::uuid,
    s.cut_date, s.due_date, s.previous_balance_minor, s.payments_and_credits_minor, s.charges_minor, s.installments_minor, s.interest_minor, s.fees_minor,
    s.total_due_minor, s.minimum_due_minor, s.available_credit_minor
  from jsonb_array_elements(coalesce(p_doc -> 'statements', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.statements, e.j - array['id', 'account_id']) s;

  insert into waypoint.transactions (id, household_id, account_id, posted_on, amount_minor, kind, category_id, description, transfer_id, plan_item_id, period, external_id, batch_id)
  select (v_ids #>> array['transactions', e.j ->> 'id'])::uuid, v_household, (v_ids #>> array['accounts', e.j ->> 'account_id'])::uuid,
    t.posted_on, t.amount_minor, t.kind, (v_ids #>> array['categories', e.j ->> 'category_id'])::uuid, t.description,
    (v_ids #>> array['transfers', e.j ->> 'transfer_id'])::uuid, (v_ids #>> array['plan_items', e.j ->> 'plan_item_id'])::uuid, t.period, t.external_id,
    (v_ids #>> array['batches', e.j ->> 'batch_id'])::uuid
  from jsonb_array_elements(coalesce(p_doc -> 'transactions', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.transactions,
    '{"description": ""}' || (e.j - array['id', 'account_id', 'category_id', 'transfer_id', 'plan_item_id', 'batch_id'])) t;

  return jsonb_build_object('household_id', v_household, 'ids', v_ids);
end;
$$;

-- The import format with real ids, every table sorted by id; null when the caller has no household yet.
create function waypoint.export_household() returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'household', jsonb_build_object('base_currency', h.base_currency, 'timezone', h.timezone, 'locale', h.locale, 'payoff_order', h.payoff_order, 'track_from', h.track_from),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'kind', a.kind, 'currency', a.currency, 'opening_balance_minor', a.opening_balance_minor, 'opening_date', a.opening_date,
        'terms', a.terms, 'funded_from_account_id', a.funded_from_account_id, 'floor_windows', a.floor_windows, 'fx_fee_pct', a.fx_fee_pct,
        'csv_mapping', a.csv_mapping, 'sort_order', a.sort_order, 'archived_at', a.archived_at
      ) order by a.id)
      from waypoint.accounts a where a.household_id = h.id), '[]'),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'archived_at', c.archived_at) order by c.id)
      from waypoint.categories c where c.household_id = h.id), '[]'),
    'plan_items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'kind', p.kind, 'name', p.name, 'from_account_id', p.from_account_id, 'to_account_id', p.to_account_id, 'category_id', p.category_id,
        'amount_minor', p.amount_minor, 'every', p.every, 'starts_on', p.starts_on, 'ends_on', p.ends_on, 'roll', p.roll, 'confidence', p.confidence,
        'skip_periods', p.skip_periods
      ) order by p.id)
      from waypoint.plan_items p where p.household_id = h.id), '[]'),
    'statements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'account_id', s.account_id, 'cut_date', s.cut_date, 'due_date', s.due_date, 'previous_balance_minor', s.previous_balance_minor,
        'payments_and_credits_minor', s.payments_and_credits_minor, 'charges_minor', s.charges_minor, 'installments_minor', s.installments_minor,
        'interest_minor', s.interest_minor, 'fees_minor', s.fees_minor, 'total_due_minor', s.total_due_minor, 'minimum_due_minor', s.minimum_due_minor,
        'available_credit_minor', s.available_credit_minor
      ) order by s.id)
      from waypoint.statements s where s.household_id = h.id), '[]'),
    'transactions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'account_id', t.account_id, 'posted_on', t.posted_on, 'amount_minor', t.amount_minor, 'kind', t.kind, 'category_id', t.category_id,
        'description', t.description, 'transfer_id', t.transfer_id, 'plan_item_id', t.plan_item_id, 'period', t.period, 'external_id', t.external_id,
        'batch_id', t.batch_id
      ) order by t.id)
      from waypoint.transactions t where t.household_id = h.id), '[]')
  )
  from waypoint.households h
  where h.id = (select auth.uid())
$$;

-- Owner's rights, as the caller has none on auth.users; it takes no input and reaches only the caller, whose rows go by cascade.
create function waypoint.delete_my_account() returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = (select auth.uid());
$$;

alter function waypoint.delete_my_account() owner to postgres;

revoke execute on function waypoint.import_household(jsonb), waypoint.export_household(), waypoint.delete_my_account() from public, anon, service_role;
grant execute on function waypoint.import_household(jsonb), waypoint.export_household(), waypoint.delete_my_account() to authenticated;
