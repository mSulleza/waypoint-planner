begin;
select plan(17);

insert into auth.users (id, aud, role, email) values
  ('0000000f-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f@example.test'),
  ('00000010-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g@example.test'),
  ('00000011-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('0000000f-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'en-PH', '2026-10-01'),
  ('00000010-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'es-ES', '2026-10-01');

insert into waypoint.categories (id, household_id, name) values
  ('0000000f-0002-0000-0000-000000000001', '0000000f-0000-0000-0000-000000000000', 'Groceries'),
  ('0000000f-0002-0000-0000-000000000002', '0000000f-0000-0000-0000-000000000000', 'Cleaning');

select results_eq(
  $$ select proname::text collate "default", prosecdef, proconfig collate "default" from pg_proc
     where pronamespace = 'waypoint'::regnamespace and proname in ('export_meals', 'import_meals') order by 1 $$,
  $$ values ('export_meals', false, array['search_path=""']), ('import_meals', false, array['search_path=""']) $$,
  'export_meals and import_meals run as the caller with an empty search path'
);

set local role authenticated;
set local request.jwt.claims to '{"sub": "00000011-0000-0000-0000-000000000000", "role": "authenticated"}';

select is(waypoint.export_meals(), null, 'export_meals is null for an account with no household');
select throws_ok($$ select waypoint.import_meals('{}') $$, 'P0001', 'no_household: import_meals fills the meals of an existing household', 'import_meals needs a household');

set local request.jwt.claims to '{"sub": "0000000f-0000-0000-0000-000000000000", "role": "authenticated"}';

select is(
  waypoint.export_meals(),
  '{"settings": null, "items": [], "purchases": [], "recipes": [], "recipe_items": [], "meals": [], "trips": []}'::jsonb,
  'export_meals of a household with no meals is empty lists and no settings'
);

select throws_ok($$ select waypoint.import_meals('[]') $$, 'P0001', 'bad_input: meals must be a JSON object with settings, items, purchases, recipes, recipe_items, meals, trips', 'import_meals refuses a document that is not an object');
select throws_ok(
  $$ select waypoint.import_meals('{"items": [], "pantry": []}') $$, 'P0001',
  'bad_input: meals: Unknown keys ''pantry''; allowed keys: settings, items, purchases, recipes, recipe_items, meals, trips',
  'import_meals names an unknown key'
);

-- Document ids, with categories named by the ids the household already has.
select lives_ok(
  $$ select waypoint.import_meals($j${
    "settings": {"category_id": "0000000f-0002-0000-0000-000000000001", "currency": "EUR", "shop_weekday": 5, "people": 2},
    "items": [
      {"id": "rice", "name": "Rice", "kind": "stock", "unit": "g", "pack_size": 1000, "price_minor": 129, "price_checked_on": "2026-10-23", "price_source": "mercadona", "mercadona_id": "5004", "aisle": "Arroz", "lasts_days": 21},
      {"id": "thighs", "name": "Chicken thighs", "kind": "recipe", "unit": "g", "pack_size": 600, "price_minor": 389, "price_checked_on": "2026-10-23", "price_source": "typed"},
      {"id": "soap", "name": "Dish soap", "kind": "stock", "unit": "ml", "pack_size": 750, "category_id": "0000000f-0002-0000-0000-000000000002", "lasts_days": 40}
    ],
    "purchases": [{"id": "p1", "item_id": "rice", "bought_on": "2026-10-03", "packs": 2, "price_minor": 129}],
    "recipes": [{"id": "adobo", "name": "Chicken adobo", "portions": 4, "prep_minutes": 15, "steps": "Brown, then simmer."}],
    "recipe_items": [{"id": "l1", "recipe_id": "adobo", "item_id": "thighs", "quantity": 600}, {"id": "l2", "recipe_id": "adobo", "item_id": "rice", "quantity": 300, "sort_order": 1}],
    "meals": [{"id": "m1", "day": "2026-10-24", "slot": "lunch", "recipe_id": "adobo", "leftovers": true}],
    "trips": [{"id": "t1", "day": "2026-10-24"}]
  }$j$) $$,
  'import_meals fills an empty household from document ids'
);

select results_eq(
  $$ select (select count(*)::int from waypoint.items), (select count(*)::int from waypoint.item_purchases), (select count(*)::int from waypoint.recipes),
       (select count(*)::int from waypoint.recipe_items), (select count(*)::int from waypoint.meals), (select count(*)::int from waypoint.trips),
       (select count(*)::int from waypoint.meal_settings) $$,
  $$ values (3, 1, 1, 2, 1, 1, 1) $$,
  'import_meals stores every row'
);

select results_eq(
  $$ select i.name, l.quantity, r.name, m.leftovers from waypoint.recipe_items l
     join waypoint.items i on i.id = l.item_id join waypoint.recipes r on r.id = l.recipe_id join waypoint.meals m on m.recipe_id = r.id
     order by l.sort_order $$,
  $$ values ('Chicken thighs'::text, 600.000::numeric(10, 3), 'Chicken adobo'::text, true), ('Rice', 300.000, 'Chicken adobo', true) $$,
  'import_meals links lines, meals and purchases to the fresh ids'
);

select is(
  (select category_id from waypoint.items where name = 'Dish soap'),
  '0000000f-0002-0000-0000-000000000002'::uuid,
  'an item keeps a category the household already has'
);

select throws_ok($$ select waypoint.import_meals('{}') $$, 'P0001', 'meals_not_empty: this household already holds meals data; import_meals fills empty meals only', 'import_meals fills empty meals only');

select is(
  jsonb_array_length(waypoint.export_meals() -> 'items') + jsonb_array_length(waypoint.export_meals() -> 'recipe_items'),
  5,
  'export_meals reads the rows back'
);

-- One cook per day and slot; leftovers are a lunch's; a price comes with its day and source.
select throws_ok(
  $$ insert into waypoint.meals (household_id, day, slot, recipe_id) select '0000000f-0000-0000-0000-000000000000', '2026-10-24', 'lunch', id from waypoint.recipes $$,
  '23505', null, 'a day holds one lunch'
);
select throws_ok(
  $$ insert into waypoint.meals (household_id, day, slot, recipe_id, leftovers) select '0000000f-0000-0000-0000-000000000000', '2026-10-25', 'dinner', id, true from waypoint.recipes $$,
  '23514', null, 'only a lunch is cooked for dinner too'
);
select throws_ok(
  $$ insert into waypoint.items (household_id, name, kind, unit, pack_size, price_minor) values ('0000000f-0000-0000-0000-000000000000', 'Tofu', 'recipe', 'g', 400, 150) $$,
  '23514', null, 'a price without its day and source is refused'
);

-- Another household cannot point at these rows.
do $$ begin perform set_config('test.recipe', (select id::text from waypoint.recipes limit 1), true); end $$;
set local request.jwt.claims to '{"sub": "00000010-0000-0000-0000-000000000000", "role": "authenticated"}';

select throws_ok(
  $$ insert into waypoint.meals (household_id, day, slot, recipe_id) values ('00000010-0000-0000-0000-000000000000', '2026-10-24', 'lunch', current_setting('test.recipe')::uuid) $$,
  '23503', null, 'a meal cannot name another household''s recipe'
);

reset role;
select results_eq(
  $$ select r.household_id from waypoint.recipes r $$,
  $$ values ('0000000f-0000-0000-0000-000000000000'::uuid) $$,
  'the other household added no recipe'
);

select * from finish();
rollback;
