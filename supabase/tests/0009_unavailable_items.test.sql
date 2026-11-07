begin;
select plan(3);

insert into auth.users (id, aud, role, email) values
  ('00000012-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'i@example.test'),
  ('00000013-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'j@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('00000012-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'en-PH', '2026-10-01'),
  ('00000013-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'en-PH', '2026-10-01');

insert into waypoint.items (household_id, name, kind, unit, pack_size, unavailable_on) values
  ('00000012-0000-0000-0000-000000000000', 'Pork belly', 'recipe', 'g', 500, '2026-10-24');

set local role authenticated;
set local request.jwt.claims to '{"sub": "00000012-0000-0000-0000-000000000000", "role": "authenticated"}';

select is(waypoint.export_meals() #>> '{items,0,unavailable_on}', '2026-10-24', 'export_meals carries the day an item was not in stock');

set local request.jwt.claims to '{"sub": "00000013-0000-0000-0000-000000000000", "role": "authenticated"}';

select lives_ok(
  $$ select waypoint.import_meals('{"items": [{"id": "pb", "name": "Pork belly", "kind": "recipe", "unit": "g", "pack_size": 500, "unavailable_on": "2026-10-24"}]}') $$,
  'import_meals takes the day an item was not in stock'
);
select is((select unavailable_on from waypoint.items), '2026-10-24'::date, 'and stores it');

select * from finish();
rollback;
