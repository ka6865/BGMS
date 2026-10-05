set lock_timeout = '3s';
set statement_timeout = '30s';

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create schema if not exists bgms_private;
revoke all on schema bgms_private from public, anon, authenticated, service_role;

-- Only request IDs and times, never credentials, accounts, or match payloads.
create table bgms_private.pubg_collection_requests (
  request_id bigint primary key,
  dispatched_at timestamptz not null default now()
);
alter table bgms_private.pubg_collection_requests enable row level security;
revoke all on bgms_private.pubg_collection_requests from public, anon, authenticated, service_role;

create function bgms_private.cleanup_pubg_collection_clock_logs()
returns void language sql security invoker set search_path = '' as $$
  delete from bgms_private.pubg_collection_requests where dispatched_at < now() - interval '7 days';
  delete from cron.job_run_details where jobid in (
    select jobid from cron.job where jobname in ('bgms-pubg-collection','bgms-pubg-collection-log-cleanup')
  ) and end_time < now() - interval '7 days';
$$;
revoke all on function bgms_private.cleanup_pubg_collection_clock_logs() from public,anon,authenticated,service_role;

create function bgms_private.dispatch_pubg_collection_tick()
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  base_url text; bearer text; request_id bigint;
begin
  if not exists(select 1 from cron.job where jobname='bgms-pubg-collection' and active) then return null; end if;
  -- Job command contains no secret; the token is read from Vault at dispatch.
  select decrypted_secret into strict base_url from vault.decrypted_secrets where name='bgms_pubg_collection_base_url';
  select decrypted_secret into strict bearer from vault.decrypted_secrets where name='bgms_pubg_collection_bearer';
  if base_url is distinct from 'https://bgms.kr' or length(bearer) not between 32 and 1024 then
    raise exception 'collection-cron-invalid-configuration';
  end if;
  perform bgms_private.cleanup_pubg_collection_clock_logs();
  -- Idle periods cost no application invocation. Expired leases remain recoverable.
  if not exists(select 1 from public.pubg_player_match_discovery
    where (state in ('pending','retry') and next_attempt_at <= now())
       or (state='running' and lease_expires_at <= now())) then return null; end if;
  select net.http_post(
    url := base_url || '/api/internal/pubg/collect',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || bearer),
    body := '{}'::jsonb, timeout_milliseconds := 55000
  ) into request_id;
  insert into bgms_private.pubg_collection_requests values(request_id,now());
  return request_id;
end $$;
revoke all on function bgms_private.dispatch_pubg_collection_tick() from public, anon, authenticated, service_role;

-- SECURITY DEFINER is limited to this configuration operation: service_role
-- cannot administer Cron/Vault directly. No user role can execute either RPC.
create function public.configure_pubg_collection_cron(p_enabled boolean,p_base_url text,p_secret text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare secret_id uuid;
begin
  perform pg_advisory_xact_lock(784218591);
  if p_enabled is null then raise exception 'collection-cron-invalid-enabled'; end if;
  if not p_enabled then
    update cron.job set active=false where jobname='bgms-pubg-collection';
    return;
  end if;
  if p_base_url is distinct from 'https://bgms.kr' or p_secret is null or length(p_secret) not between 32 and 1024 then
    raise exception 'collection-cron-invalid-configuration';
  end if;
  if (select count(*) from vault.secrets where name='bgms_pubg_collection_bearer') > 1
    or (select count(*) from vault.secrets where name='bgms_pubg_collection_base_url') > 1 then
    raise exception 'collection-cron-ambiguous-secrets';
  end if;
  select id into secret_id from vault.secrets where name='bgms_pubg_collection_bearer';
  if secret_id is null then perform vault.create_secret(p_secret,'bgms_pubg_collection_bearer');
  else perform vault.update_secret(secret_id,p_secret); end if;
  select id into secret_id from vault.secrets where name='bgms_pubg_collection_base_url';
  if secret_id is null then perform vault.create_secret(p_base_url,'bgms_pubg_collection_base_url');
  else perform vault.update_secret(secret_id,p_base_url); end if;
  perform cron.schedule('bgms-pubg-collection','*/5 * * * *','select bgms_private.dispatch_pubg_collection_tick();');
  -- Only this clock's own logs; remains active when collection is disabled.
  perform cron.schedule('bgms-pubg-collection-log-cleanup','17 4 * * *','select bgms_private.cleanup_pubg_collection_clock_logs();');
end $$;
revoke all on function public.configure_pubg_collection_cron(boolean,text,text) from public,anon,authenticated;
grant execute on function public.configure_pubg_collection_cron(boolean,text,text) to service_role;

create function public.pubg_collection_cron_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled',coalesce((select active from cron.job where jobname='bgms-pubg-collection'),false),
    'schedule',(select schedule from cron.job where jobname='bgms-pubg-collection'),
    'measuredAt',now(),
    'requests',coalesce((select jsonb_agg(x order by x."dispatchedAt" desc) from (
      select q.dispatched_at as "dispatchedAt",r.status_code as "httpStatus",
        coalesce(r.timed_out,false) as "timedOut",
        case when r.id is not null then true when q.dispatched_at < now()-interval '6 hours' then null else false end as completed,
        case when r.id is not null then r.status_code=200 and not coalesce(r.timed_out,false) and r.error_msg is null else null end as healthy,
        case when r.id is not null then 'available' when q.dispatched_at < now()-interval '6 hours' then 'unavailable' else 'pending' end as "responseState",
        case when r.status_code=200 then r.content else null end as summary
      from (select * from bgms_private.pubg_collection_requests order by dispatched_at desc limit 10) q
      left join net._http_response r on r.id=q.request_id
    ) x),'[]'::jsonb)
  );
$$;
revoke all on function public.pubg_collection_cron_status() from public,anon,authenticated;
grant execute on function public.pubg_collection_cron_status() to service_role;

-- Installation does not start collection or create a token. Enable only after
-- the production route and dedicated random secret have been verified.
reset lock_timeout;
reset statement_timeout;
