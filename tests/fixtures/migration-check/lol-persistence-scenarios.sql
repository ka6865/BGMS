-- Reuse the dedicated LoL contract fixture; extend it with full table ACL and
-- global permit boundary checks for the common migration verifier.
\i tests/fixtures/lol-persistence-verification.sql

do $$
declare
  v_table text;
  v_role text;
  v_privilege text;
begin
  foreach v_table in array array[
    'lol_accounts','lol_ranked_entries','lol_matches','lol_match_participants',
    'lol_api_cache','lol_rate_limit_state','lol_collection_leases'
  ] loop
    if not (select relrowsecurity from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.'||v_table)) then
      raise exception 'RLS is disabled on %',v_table;
    end if;
    foreach v_role in array array['anon','authenticated'] loop
      foreach v_privilege in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if pg_catalog.has_table_privilege(v_role,'public.'||v_table,v_privilege) then
          raise exception '% has % on public.%',v_role,v_privilege,v_table;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

set role service_role;
do $$
declare v_first record; v_second record; v_third record; v_budget record; v_bg record; v_fg record; v_full record;
begin
  update public.lol_rate_limit_state
  set next_permit_at=pg_catalog.clock_timestamp(),min_interval_ms=1500,last_started_at=null,app_rate_limit='20:1,100:120',
      max_concurrency=2,blocked_until='-infinity',budget_day=(pg_catalog.timezone('UTC',pg_catalog.clock_timestamp()))::date,used_count=0
  where host in ('global','asia','kr');
  delete from public.lol_riot_request_log;
  delete from public.lol_collection_leases where lease_type='request';
  -- 한도 안에서는 간격 없이 바로 시작하고, 호스트별 동시 요청 수만 제한한다.
  select * into v_first from public.reserve_lol_riot_request('asia');
  select * into v_second from public.reserve_lol_riot_request('asia');
  select * into v_third from public.reserve_lol_riot_request('asia');
  if not v_first.granted or not v_second.granted or not v_first.started or not v_second.started then
    raise exception 'first two permits were not granted immediately'; end if;
  if v_third.granted or v_third.reason<>'concurrency' then raise exception 'third permit exceeded concurrency limit'; end if;
  if v_second.permit_at-v_first.permit_at >= interval '1 second' then raise exception 'fixed spacing is still applied'; end if;
  if not (select granted from public.reserve_lol_riot_request('kr')) then raise exception 'kr shares asia concurrency'; end if;
  -- 1초 20회 한도에서 사용자 검색은 18회, 백그라운드 수집은 10회까지 바로 쓴다.
  delete from public.lol_collection_leases where lease_type='request';
  update public.lol_rate_limit_state set max_concurrency=8 where host='asia';
  delete from public.lol_riot_request_log;
  insert into public.lol_riot_request_log(host,priority,started_at) select 'asia','interactive',pg_catalog.clock_timestamp() from generate_series(1,10);
  select * into v_bg from public.reserve_lol_riot_request('asia','background');
  select * into v_fg from public.reserve_lol_riot_request('asia','interactive');
  if not v_bg.granted or v_bg.started or v_bg.permit_at < pg_catalog.clock_timestamp() + interval '500 milliseconds' then
    raise exception 'background request did not yield at half of the window'; end if;
  if not v_fg.granted then raise exception 'interactive request was not granted'; end if;
  insert into public.lol_riot_request_log(host,priority,started_at) select 'asia','interactive',pg_catalog.clock_timestamp() from generate_series(1,10);
  delete from public.lol_collection_leases where lease_type='request';
  select * into v_full from public.reserve_lol_riot_request('asia');
  if not v_full.granted or v_full.started or v_full.permit_at < pg_catalog.clock_timestamp() + interval '500 milliseconds' then
    raise exception 'full window was not deferred'; end if;
  -- 예약 시각이 아직 오지 않은 허가는 시작할 수 없다.
  if (select allowed from public.start_lol_riot_request(v_full.lease_token)) then raise exception 'future permit started early'; end if;
  delete from public.lol_collection_leases where lease_type='request';
  delete from public.lol_riot_request_log;
  update public.lol_rate_limit_state set used_count=40 where host in ('global','asia','kr');
  select * into v_budget from public.reserve_lol_riot_request('asia');
  if v_budget.reason='daily_budget' then raise exception 'removed daily budget is still enforced'; end if;
  -- 한도를 다 쓴 헤더는 해당 호스트만 잠시 멈추고, 여유 있는 헤더는 막지 않는다.
  update public.lol_rate_limit_state set blocked_until='-infinity';
  if not public.finish_lol_riot_request(v_budget.lease_token,'asia','20:1,100:120','15:1,80:120','2000:10','5:10') then
    raise exception 'valid headers rejected'; end if;
  if exists(select 1 from public.lol_rate_limit_state where blocked_until > pg_catalog.clock_timestamp()) then raise exception '80 percent usage blocked requests'; end if;
  if exists(select 1 from public.lol_collection_leases where lease_token=v_budget.lease_token) then raise exception 'finish did not release permit'; end if;
  perform public.record_lol_riot_rate_headers('asia','20:1,100:120','20:1,90:120','2000:10','5:10');
  if (select blocked_until from public.lol_rate_limit_state where host='asia') <= pg_catalog.clock_timestamp()
    or (select blocked_until from public.lol_rate_limit_state where host='asia') > pg_catalog.clock_timestamp() + interval '2 seconds'
    or (select blocked_until from public.lol_rate_limit_state where host='kr') > pg_catalog.clock_timestamp() then
    raise exception 'exhausted window must block only asia for that window'; end if;
  update public.lol_rate_limit_state set blocked_until='-infinity', max_concurrency=8, app_rate_limit=null, used_count=0;
  delete from public.lol_collection_leases where lease_type='request';
  delete from public.lol_riot_request_log;
end $$;
reset role;
