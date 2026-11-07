-- Card terms gain interest.payment_effective_lag_days, which core reads as 0 when missing; stored cards get the 0 so a guarded edit's loaded terms equal the row.

update waypoint.accounts
   set terms = jsonb_set(terms, '{interest,payment_effective_lag_days}', '0'::jsonb)
 where kind = 'credit_card'
   and jsonb_typeof(terms -> 'interest') = 'object'
   and not (terms -> 'interest') ? 'payment_effective_lag_days';
