-- Meals: a price list, recipes, a week of cooking, shopping trips and what was bought; read with export_meals, carried by import_household's 'meals' key.

create table waypoint.meal_settings (
  household_id uuid primary key references waypoint.households (id) on delete cascade,
  -- The allowance the shopping counts against; null until one is picked.
  category_id uuid,
  currency char(3) not null constraint meal_settings_currency_check check (currency ~ '^[A-Z]{3}$'),
  -- 0 Monday to 6 Sunday; a week of meals starts on it.
  shop_weekday smallint not null default 5 constraint meal_settings_shop_weekday_check check (shop_weekday between 0 and 6),
  people smallint not null default 2 constraint meal_settings_people_check check (people between 1 and 12),
  constraint meal_settings_category_fkey foreign key (household_id, category_id) references waypoint.categories (household_id, id)
);

create table waypoint.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  name text not null constraint items_name_check check (char_length(name) between 1 and 60),
  -- recipe: bought for the week's meals; stock: kept in and bought before it runs out.
  kind text not null constraint items_kind_check check (kind in ('recipe', 'stock')),
  unit text not null constraint items_unit_check check (unit in ('g', 'ml', 'unit')),
  pack_size numeric(10, 3) not null constraint items_pack_size_check check (pack_size > 0),
  -- Sold by weight: bought by the amount needed, priced per pack_size.
  loose boolean not null default false,
  price_minor bigint constraint items_price_minor_check check (price_minor > 0),
  price_checked_on date,
  price_source text constraint items_price_source_check check (price_source in ('typed', 'paid', 'mercadona')),
  mercadona_id text constraint items_mercadona_id_check check (mercadona_id ~ '^[0-9]{1,12}(\.[0-9]{1,4})?$'),
  aisle text constraint items_aisle_check check (char_length(aisle) between 1 and 40),
  -- null counts against the meals allowance.
  category_id uuid,
  lasts_days smallint constraint items_lasts_days_check check (lasts_days between 1 and 730),
  -- Put on the first trip from this day until it is bought.
  wanted_on date,
  archived_at timestamptz,
  constraint items_household_id_id_key unique (household_id, id),
  constraint items_price_check check (num_nulls(price_minor, price_checked_on, price_source) in (0, 3)),
  constraint items_category_fkey foreign key (household_id, category_id) references waypoint.categories (household_id, id)
);

create table waypoint.item_purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  item_id uuid not null,
  bought_on date not null,
  packs smallint not null default 1 constraint item_purchases_packs_check check (packs between 1 and 99),
  -- Paid per pack, when it was typed.
  price_minor bigint constraint item_purchases_price_minor_check check (price_minor > 0),
  constraint item_purchases_item_id_bought_on_key unique (item_id, bought_on),
  constraint item_purchases_item_fkey foreign key (household_id, item_id) references waypoint.items (household_id, id) on delete cascade
);

create table waypoint.recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  name text not null constraint recipes_name_check check (char_length(name) between 1 and 60),
  portions smallint not null constraint recipes_portions_check check (portions between 1 and 24),
  prep_minutes smallint not null constraint recipes_prep_minutes_check check (prep_minutes between 1 and 600),
  steps text not null default '' constraint recipes_steps_check check (char_length(steps) <= 4000),
  archived_at timestamptz,
  constraint recipes_household_id_id_key unique (household_id, id)
);

create table waypoint.recipe_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  recipe_id uuid not null,
  item_id uuid not null,
  -- In the item's unit, for the recipe's portions.
  quantity numeric(10, 3) not null constraint recipe_items_quantity_check check (quantity > 0),
  sort_order smallint not null default 0,
  constraint recipe_items_recipe_id_item_id_key unique (recipe_id, item_id),
  constraint recipe_items_recipe_fkey foreign key (household_id, recipe_id) references waypoint.recipes (household_id, id) on delete cascade,
  constraint recipe_items_item_fkey foreign key (household_id, item_id) references waypoint.items (household_id, id)
);

create table waypoint.meals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  day date not null,
  slot text not null constraint meals_slot_check check (slot in ('lunch', 'dinner')),
  recipe_id uuid not null,
  -- Lunch cooked for dinner too.
  leftovers boolean not null default false,
  constraint meals_household_id_day_slot_key unique (household_id, day, slot),
  constraint meals_leftovers_check check (not leftovers or slot = 'lunch'),
  constraint meals_recipe_fkey foreign key (household_id, recipe_id) references waypoint.recipes (household_id, id)
);

create table waypoint.trips (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references waypoint.households (id) on delete cascade,
  day date not null,
  constraint trips_household_id_day_key unique (household_id, day)
);

alter table waypoint.meal_settings enable row level security;
alter table waypoint.items enable row level security;
alter table waypoint.item_purchases enable row level security;
alter table waypoint.recipes enable row level security;
alter table waypoint.recipe_items enable row level security;
alter table waypoint.meals enable row level security;
alter table waypoint.trips enable row level security;

create policy meal_settings_own on waypoint.meal_settings for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy items_own on waypoint.items for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy item_purchases_own on waypoint.item_purchases for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy recipes_own on waypoint.recipes for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy recipe_items_own on waypoint.recipe_items for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy meals_own on waypoint.meals for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));
create policy trips_own on waypoint.trips for all to authenticated
  using (household_id = (select auth.uid())) with check (household_id = (select auth.uid()));

revoke all on table waypoint.meal_settings, waypoint.items, waypoint.item_purchases, waypoint.recipes, waypoint.recipe_items, waypoint.meals, waypoint.trips
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table waypoint.meal_settings, waypoint.items, waypoint.item_purchases, waypoint.recipes, waypoint.recipe_items, waypoint.meals, waypoint.trips
  to authenticated;

-- Every meals row of the caller, ids as stored and each table sorted by id; null when the caller has no household yet.
create function waypoint.export_meals() returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'settings', (
      select jsonb_build_object('category_id', s.category_id, 'currency', s.currency, 'shop_weekday', s.shop_weekday, 'people', s.people)
      from waypoint.meal_settings s where s.household_id = h.id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name, 'kind', i.kind, 'unit', i.unit, 'pack_size', i.pack_size, 'loose', i.loose, 'price_minor', i.price_minor,
        'price_checked_on', i.price_checked_on, 'price_source', i.price_source, 'mercadona_id', i.mercadona_id, 'aisle', i.aisle,
        'category_id', i.category_id, 'lasts_days', i.lasts_days, 'wanted_on', i.wanted_on, 'archived_at', i.archived_at
      ) order by i.id)
      from waypoint.items i where i.household_id = h.id), '[]'),
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'item_id', p.item_id, 'bought_on', p.bought_on, 'packs', p.packs, 'price_minor', p.price_minor) order by p.id)
      from waypoint.item_purchases p where p.household_id = h.id), '[]'),
    'recipes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'portions', r.portions, 'prep_minutes', r.prep_minutes, 'steps', r.steps, 'archived_at', r.archived_at
      ) order by r.id)
      from waypoint.recipes r where r.household_id = h.id), '[]'),
    'recipe_items', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'recipe_id', l.recipe_id, 'item_id', l.item_id, 'quantity', l.quantity, 'sort_order', l.sort_order) order by l.id)
      from waypoint.recipe_items l where l.household_id = h.id), '[]'),
    'meals', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'day', m.day, 'slot', m.slot, 'recipe_id', m.recipe_id, 'leftovers', m.leftovers) order by m.id)
      from waypoint.meals m where m.household_id = h.id), '[]'),
    'trips', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'day', t.day) order by t.id)
      from waypoint.trips t where t.household_id = h.id), '[]')
  )
  from waypoint.households h
  where h.id = (select auth.uid())
$$;

-- Fills the caller's empty meals tables from export_meals' shape with fresh ids; p_categories maps the document's category ids to stored ones, and an id it lacks is taken as stored.
create function waypoint.import_meals(p_meals jsonb, p_categories jsonb default '{}') returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  meal_keys constant text[] := array['settings', 'items', 'purchases', 'recipes', 'recipe_items', 'meals', 'trips'];
  v_household uuid := (select auth.uid());
  v_items jsonb;
  v_recipes jsonb;
  v_unknown text;
begin
  if jsonb_typeof(p_meals) is distinct from 'object' then
    raise exception using message = 'bad_input: meals must be a JSON object with ' || array_to_string(meal_keys, ', '),
      detail = jsonb_build_object('error', 'bad_input', 'issues', jsonb_build_array('meals: must be a JSON object'))::text;
  end if;
  select string_agg(format('''%s''', k), ', ' order by k) into v_unknown from jsonb_object_keys(p_meals) k where k <> all (meal_keys);
  if v_unknown is not null then
    raise exception using message = format('bad_input: meals: Unknown keys %s; allowed keys: %s', v_unknown, array_to_string(meal_keys, ', ')),
      detail = jsonb_build_object('error', 'bad_input', 'issues', jsonb_build_array(format('meals: Unknown keys %s', v_unknown)))::text;
  end if;
  if not exists (select 1 from waypoint.households h where h.id = v_household) then
    raise exception using message = 'no_household: import_meals fills the meals of an existing household',
      detail = jsonb_build_object('error', 'no_household')::text;
  end if;
  if exists (select 1 from waypoint.items i where i.household_id = v_household)
    or exists (select 1 from waypoint.recipes r where r.household_id = v_household)
    or exists (select 1 from waypoint.meal_settings s where s.household_id = v_household) then
    raise exception using message = 'meals_not_empty: this household already holds meals data; import_meals fills empty meals only',
      detail = jsonb_build_object('error', 'meals_not_empty')::text;
  end if;

  select coalesce(jsonb_object_agg(e.j ->> 'id', gen_random_uuid()), '{}') into v_items from jsonb_array_elements(coalesce(p_meals -> 'items', '[]')) e(j);
  select coalesce(jsonb_object_agg(e.j ->> 'id', gen_random_uuid()), '{}') into v_recipes from jsonb_array_elements(coalesce(p_meals -> 'recipes', '[]')) e(j);

  if jsonb_typeof(p_meals -> 'settings') = 'object' then
    insert into waypoint.meal_settings (household_id, category_id, currency, shop_weekday, people)
    select v_household, coalesce(p_categories ->> (p_meals #>> '{settings,category_id}'), p_meals #>> '{settings,category_id}')::uuid, s.currency, s.shop_weekday, s.people
    from jsonb_populate_record(null::waypoint.meal_settings, '{"shop_weekday": 5, "people": 2}' || ((p_meals -> 'settings') - 'category_id')) s;
  end if;

  insert into waypoint.items (id, household_id, name, kind, unit, pack_size, loose, price_minor, price_checked_on, price_source, mercadona_id, aisle, category_id, lasts_days, wanted_on, archived_at)
  select (v_items ->> (e.j ->> 'id'))::uuid, v_household, i.name, i.kind, i.unit, i.pack_size, i.loose, i.price_minor, i.price_checked_on, i.price_source, i.mercadona_id, i.aisle,
    coalesce(p_categories ->> (e.j ->> 'category_id'), e.j ->> 'category_id')::uuid, i.lasts_days, i.wanted_on, i.archived_at
  from jsonb_array_elements(coalesce(p_meals -> 'items', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.items, '{"loose": false}' || (e.j - array['id', 'category_id'])) i;

  insert into waypoint.item_purchases (id, household_id, item_id, bought_on, packs, price_minor)
  select gen_random_uuid(), v_household, (v_items ->> (e.j ->> 'item_id'))::uuid, p.bought_on, p.packs, p.price_minor
  from jsonb_array_elements(coalesce(p_meals -> 'purchases', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.item_purchases, '{"packs": 1}' || (e.j - array['id', 'item_id'])) p;

  insert into waypoint.recipes (id, household_id, name, portions, prep_minutes, steps, archived_at)
  select (v_recipes ->> (e.j ->> 'id'))::uuid, v_household, r.name, r.portions, r.prep_minutes, r.steps, r.archived_at
  from jsonb_array_elements(coalesce(p_meals -> 'recipes', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.recipes, '{"steps": ""}' || (e.j - 'id')) r;

  insert into waypoint.recipe_items (id, household_id, recipe_id, item_id, quantity, sort_order)
  select gen_random_uuid(), v_household, (v_recipes ->> (e.j ->> 'recipe_id'))::uuid, (v_items ->> (e.j ->> 'item_id'))::uuid, l.quantity, l.sort_order
  from jsonb_array_elements(coalesce(p_meals -> 'recipe_items', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.recipe_items, '{"sort_order": 0}' || (e.j - array['id', 'recipe_id', 'item_id'])) l;

  insert into waypoint.meals (id, household_id, day, slot, recipe_id, leftovers)
  select gen_random_uuid(), v_household, m.day, m.slot, (v_recipes ->> (e.j ->> 'recipe_id'))::uuid, m.leftovers
  from jsonb_array_elements(coalesce(p_meals -> 'meals', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.meals, '{"leftovers": false}' || (e.j - array['id', 'recipe_id'])) m;

  insert into waypoint.trips (id, household_id, day)
  select gen_random_uuid(), v_household, t.day
  from jsonb_array_elements(coalesce(p_meals -> 'trips', '[]')) e(j)
  cross join lateral jsonb_populate_record(null::waypoint.trips, e.j - 'id') t;

  return jsonb_build_object('items', v_items, 'recipes', v_recipes);
end;
$$;

revoke execute on function waypoint.export_meals(), waypoint.import_meals(jsonb, jsonb) from public, anon, service_role;
grant execute on function waypoint.export_meals(), waypoint.import_meals(jsonb, jsonb) to authenticated;

-- import_household takes the meals too, so a re-import keeps them: the same function as 0003 with 'meals' allowed and filled last.
create or replace function waypoint.import_household(p_doc jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc_keys constant text[] := array['version', 'household', 'accounts', 'categories', 'plan_items', 'statements', 'transactions', 'meals'];
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
  if p_doc ? 'meals' and jsonb_typeof(p_doc -> 'meals') <> 'object' then
    v_issues := v_issues || 'meals: must be an object'::text;
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

  if p_doc ? 'meals' then
    perform waypoint.import_meals(p_doc -> 'meals', v_ids -> 'categories');
  end if;

  return jsonb_build_object('household_id', v_household, 'ids', v_ids);
end;
$$;

