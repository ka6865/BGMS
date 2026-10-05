begin;
delete from public.pubg_player_match_discovery;

do $$ begin
  if has_function_privilege('anon','public.configure_pubg_collection_cron(boolean,text,text)','execute')
    or has_function_privilege('authenticated','public.pubg_collection_cron_status()','execute')
    or has_schema_privilege('service_role','bgms_private','usage')
    or has_function_privilege('service_role','bgms_private.dispatch_pubg_collection_tick()','execute') then
    raise exception 'FAIL: collection cron privileges exposed';
  end if;
  if not has_function_privilege('service_role','public.configure_pubg_collection_cron(boolean,text,text)','execute') then
    raise exception 'FAIL: collection config RPC inaccessible to service role';
  end if;
  if (public.pubg_collection_cron_status()->>'enabled')::boolean or exists(select 1 from vault.secrets) then
    raise exception 'FAIL: migration enabled collection or created a secret';
  end if;
end $$;

set local role anon;
do $$ begin
  begin
    perform public.configure_pubg_collection_cron(true,'https://bgms.kr',repeat('a',64));
    raise exception 'FAIL: anon configured collection';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role service_role;
do $$ begin
  begin
    perform public.configure_pubg_collection_cron(true,'https://evil.example',repeat('a',64));
    raise exception 'FAIL: arbitrary outbound host accepted';
  exception when raise_exception then
    if sqlerrm <> 'collection-cron-invalid-configuration' then raise; end if;
  end;
  begin
    perform public.configure_pubg_collection_cron(true,'https://bgms.kr','short');
    raise exception 'FAIL: weak bearer accepted';
  exception when raise_exception then
    if sqlerrm <> 'collection-cron-invalid-configuration' then raise; end if;
  end;
  perform public.configure_pubg_collection_cron(true,'https://bgms.kr',repeat('a',64));
  if not (public.pubg_collection_cron_status()->>'enabled')::boolean then raise exception 'FAIL: enabled clock invisible'; end if;
end $$;
reset role;

do $$ begin
  if (select count(*) from cron.job where jobname='bgms-pubg-collection') <> 1
    or (select schedule from cron.job where jobname='bgms-pubg-collection') <> '*/5 * * * *'
    or exists(select 1 from cron.job where command like '%' || repeat('a',64) || '%') then
    raise exception 'FAIL: clock schedule or secret confinement';
  end if;
  if bgms_private.dispatch_pubg_collection_tick() is not null or exists(select 1 from net.test_requests) then
    raise exception 'FAIL: idle clock invoked application';
  end if;
end $$;

-- Expired pg_net response data is unknown, not a failed/still-running request.
insert into bgms_private.pubg_collection_requests values(999999,now()-interval '7 hours');
do $$ declare status jsonb; begin
  status := public.pubg_collection_cron_status();
  if status->'requests'->0->>'responseState' <> 'unavailable'
    or status->'requests'->0->>'completed' is not null
    or status->'requests'->0->>'healthy' is not null then
    raise exception 'FAIL: expired response misreported';
  end if;
end $$;
delete from bgms_private.pubg_collection_requests where request_id=999999;

insert into public.pubg_player_match_discovery(platform,account_id,match_id,nickname_at_discovery)
values('steam','account.cron','cron-fixture-match','CronFixture');
do $$ declare rid bigint; status jsonb; begin
  rid := bgms_private.dispatch_pubg_collection_tick();
  if rid is null or not exists(select 1 from net.test_requests where id=rid
    and url='https://bgms.kr/api/internal/pubg/collect' and body='{}'::jsonb
    and headers->>'Authorization'='Bearer ' || encode(extensions.hmac(
      (headers->>'X-BGMS-Collection-Time') || E'\nPOST\n/api/internal/pubg/collect',repeat('a',64),'sha256'),'hex')
    and headers->>'Authorization' not like '%' || repeat('a',64) || '%'
    and timeout_milliseconds=55000) then
    raise exception 'FAIL: bounded authenticated clock dispatch';
  end if;
  status := public.pubg_collection_cron_status();
  if (status->'requests'->0->>'completed')::boolean then raise exception 'FAIL: HTTP enqueue treated as completed'; end if;
  insert into net._http_response values(rid,200,false,null,'{"ok":true,"claimed":3,"saved":2,"alreadyStored":1}');
  status := public.pubg_collection_cron_status();
  if not (status->'requests'->0->>'healthy')::boolean then raise exception 'FAIL: delivered collection not healthy'; end if;
  update net._http_response set status_code=503,content='upstream details' where id=rid;
  status := public.pubg_collection_cron_status();
  if (status->'requests'->0->>'healthy')::boolean or status->'requests'->0->>'summary' is not null then
    raise exception 'FAIL: failed HTTP masked or leaked';
  end if;
end $$;

-- Waiting retries stay idle; expired worker leases are eligible again.
update public.pubg_player_match_discovery set state='retry',next_attempt_at=now()+interval '6 hours';
do $$ begin
  if bgms_private.dispatch_pubg_collection_tick() is not null then raise exception 'FAIL: future retry prematurely dispatched'; end if;
end $$;

update public.pubg_player_match_discovery set state='running',lease_expires_at=now()-interval '1 second';
do $$ begin
  if bgms_private.dispatch_pubg_collection_tick() is null then raise exception 'FAIL: expired lease not dispatched'; end if;
end $$;

set local role service_role;
select public.configure_pubg_collection_cron(false,null,null);
reset role;
do $$ begin
  if (public.pubg_collection_cron_status()->>'enabled')::boolean
    or bgms_private.dispatch_pubg_collection_tick() is not null then
    raise exception 'FAIL: disabled clock still dispatched';
  end if;
end $$;

insert into bgms_private.pubg_collection_requests values(999998,now()-interval '8 days');
insert into cron.job_run_details select jobid,now()-interval '8 days' from cron.job;
do $$ begin
  if not exists(select 1 from cron.job where jobname='bgms-pubg-collection-log-cleanup' and active) then
    raise exception 'FAIL: disabling collection stopped log cleanup';
  end if;
  perform bgms_private.cleanup_pubg_collection_clock_logs();
  if exists(select 1 from bgms_private.pubg_collection_requests where dispatched_at < now()-interval '7 days')
    or exists(select 1 from cron.job_run_details where end_time < now()-interval '7 days') then
    raise exception 'FAIL: disabled collection logs exceed retention';
  end if;
end $$;

set local role service_role;
select public.configure_pubg_collection_cron(true,'https://bgms.kr',repeat('b',64));
reset role;
do $$ begin
  if (select count(*) from cron.job where jobname='bgms-pubg-collection') <> 1 or (select count(*) from vault.secrets) <> 2
    or (select decrypted_secret from vault.decrypted_secrets where name='bgms_pubg_collection_bearer') <> repeat('b',64) then
    raise exception 'FAIL: re-enable did not safely rotate secret in place';
  end if;
  raise notice 'Collection cron: ACL, idle, delivery, retries, disable and re-enable scenarios passed';
end $$;
rollback;
