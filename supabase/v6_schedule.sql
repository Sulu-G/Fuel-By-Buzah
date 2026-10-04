-- Fuel by Buzah — v6 schedule (run after v6_customer_features.sql). Safe to re-run.
-- Mondays at 6 AM Central (11:00 or 12:00 UTC depending on daylight saving time),
-- create the week's weekly-plan orders as pending.
create extension if not exists pg_cron;
select cron.schedule('fuel-plan-orders', '0 11,12 * * 1', $$select fuel_private.generate_plan_orders()$$);
