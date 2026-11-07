begin;
select plan(3);

insert into auth.users (id, aud, role, email) values
  ('00000014-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'k@example.test'),
  ('00000015-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'l@example.test');

insert into waypoint.households (id, base_currency, timezone, locale, track_from) values
  ('00000014-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'en-PH', '2026-10-01'),
  ('00000015-0000-0000-0000-000000000000', 'EUR', 'Europe/Madrid', 'en-PH', '2026-10-01');

insert into waypoint.items (household_id, name, kind, unit, pack_size, at_home_on) values
  ('00000014-0000-0000-0000-000000000000', 'Spring onions', 'recipe', 'unit', 1, '2026-10-31');

set local role authenticated;
set local request.jwt.claims to '{"sub": "00000014-0000-0000-0000-000000000000", "role": "authenticated"}';

select is(waypoint.export_meals() #>> '{items,0,at_home_on}', '2026-10-31', 'export_meals carries the trip an item was still at home for');

set local request.jwt.claims to '{"sub": "00000015-0000-0000-0000-000000000000", "role": "authenticated"}';

select lives_ok(
  $$ select waypoint.import_meals('{"items": [{"id": "so", "name": "Spring onions", "kind": "recipe", "unit": "unit", "pack_size": 1, "at_home_on": "2026-10-31"}]}') $$,
  'import_meals takes the trip an item was still at home for'
);
select is((select at_home_on from waypoint.items), '2026-10-31'::date, 'and stores it');

select * from finish();
rollback;
