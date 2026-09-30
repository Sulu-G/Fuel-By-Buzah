-- Fuel by Buzah — v4: remember where each customer is on the map.
-- The route planner looks up an address once (OpenStreetMap) and caches the
-- coordinates here as {"q": "<normalized address>", "lat": .., "lng": ..}.
-- If the address changes, "q" no longer matches and the app looks it up again.
-- Safe to re-run. Covered by the existing owner-only Row Level Security.
alter table public.customers add column if not exists geo jsonb;
