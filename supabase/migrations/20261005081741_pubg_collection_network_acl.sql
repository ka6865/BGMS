-- Recorded restriction attempt. Hosted objects belong to supabase_admin;
-- postgres emits notices and cannot revoke their grants. Live ACL checks
-- confirmed the hosted grants stayed unchanged. Do not treat this migration
-- as proof of a hosted ACL restriction; net is not exposed through the Data API.
-- The next migration replaces permanent bearer headers with expiring HMACs.
revoke all on schema net,cron from public,anon,authenticated,service_role;
revoke all on all tables in schema net,cron from public,anon,authenticated,service_role;
revoke all on all sequences in schema net,cron from public,anon,authenticated,service_role;
revoke all on all functions in schema net,cron from public,anon,authenticated,service_role;
