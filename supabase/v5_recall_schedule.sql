-- Fuel by Buzah — v5 schedule (run after v5_recall_checks.sql). Safe to re-run.
-- pg_cron runs in UTC. 8pm Central is 01:00 UTC (daylight time) or 02:00 UTC
-- (standard time); fuel_private.recall_cron_request() only acts at 8pm local.
create extension if not exists pg_cron;

select cron.schedule('fuel-recall-request', '0 1,2 * * *', $$select fuel_private.recall_cron_request()$$);
-- Process downloaded feeds a few minutes later (cheap no-op when nothing is waiting).
select cron.schedule('fuel-recall-process', '*/5 * * * *', $$select fuel_private.process_recall_batches()$$);
