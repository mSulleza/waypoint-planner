-- An item marked not in stock on a trip: the day of that trip, so the meals it would have bought for can be swapped. Export and import carry it.

alter table waypoint.items add column unavailable_on date;

create or replace function waypoint.export_meals() returns jsonb
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
        'category_id', i.category_id, 'lasts_days', i.lasts_days, 'wanted_on', i.wanted_on, 'unavailable_on', i.unavailable_on, 'archived_at', i.archived_at
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


create or replace function waypoint.import_meals(p_meals jsonb, p_categories jsonb default '{}') returns jsonb
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

  insert into waypoint.items (id, household_id, name, kind, unit, pack_size, loose, price_minor, price_checked_on, price_source, mercadona_id, aisle, category_id, lasts_days, wanted_on, unavailable_on, archived_at)
  select (v_items ->> (e.j ->> 'id'))::uuid, v_household, i.name, i.kind, i.unit, i.pack_size, i.loose, i.price_minor, i.price_checked_on, i.price_source, i.mercadona_id, i.aisle,
    coalesce(p_categories ->> (e.j ->> 'category_id'), e.j ->> 'category_id')::uuid, i.lasts_days, i.wanted_on, i.unavailable_on, i.archived_at
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

