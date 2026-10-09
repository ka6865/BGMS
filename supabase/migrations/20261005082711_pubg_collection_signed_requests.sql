-- Managed pg_net objects are owned by supabase_admin and cannot be hardened by
-- postgres REVOKE requests. Send only a 120-second request signature, never the
-- permanent dedicated secret. Net remains outside the exposed Data API schemas.
create or replace function bgms_private.dispatch_pubg_collection_tick()
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  base_url text; signing_key text; request_id bigint; request_time text; signature text;
begin
  if not exists(select 1 from cron.job where jobname='bgms-pubg-collection' and active) then return null; end if;
  select decrypted_secret into strict base_url from vault.decrypted_secrets where name='bgms_pubg_collection_base_url';
  select decrypted_secret into strict signing_key from vault.decrypted_secrets where name='bgms_pubg_collection_bearer';
  if base_url is distinct from 'https://bgms.kr' or length(signing_key) not between 32 and 1024 then
    raise exception 'collection-cron-invalid-configuration';
  end if;
  perform bgms_private.cleanup_pubg_collection_clock_logs();
  if not exists(select 1 from public.pubg_player_match_discovery
    where (state in ('pending','retry') and next_attempt_at <= now())
       or (state='running' and lease_expires_at <= now())) then return null; end if;
  request_time := floor(extract(epoch from now()))::bigint::text;
  signature := encode(extensions.hmac(request_time || E'\nPOST\n/api/internal/pubg/collect',signing_key,'sha256'),'hex');
  select net.http_post(
    url := base_url || '/api/internal/pubg/collect',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || signature,'X-BGMS-Collection-Time',request_time),
    body := '{}'::jsonb, timeout_milliseconds := 55000
  ) into request_id;
  insert into bgms_private.pubg_collection_requests values(request_id,now());
  return request_id;
end $$;
revoke all on function bgms_private.dispatch_pubg_collection_tick() from public,anon,authenticated,service_role;
