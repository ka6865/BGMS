-- 20261029030000: 보내기 전에 취소한 예약은 한도를 돌려주고, 보관본은 저장 계정이 지금도 그 Riot ID의 유일한 계정일 때만 돌려준다.
begin;
set local role service_role;
do $$
declare
  v_permit record; v_count integer; v_token uuid; v_waiting uuid; v_payload jsonb := '{"lastUpdatedAt":"2026-10-29T00:00:00Z"}'::jsonb;
  v_key text := 'search-snapshot:v11:kr:asia:16.21.1:owner:kr1';
begin
  update public.lol_rate_limit_state set blocked_until='-infinity', app_rate_limit='5:1', max_concurrency=32 where host in ('global','asia','kr');
  delete from public.lol_collection_leases where lease_type='request';
  delete from public.lol_riot_request_log;

  -- 1초 5회 한도의 90%(4회)를 채운다.
  for i in 1..4 loop
    select * into v_permit from public.reserve_lol_riot_request('asia','interactive',4000);
    if not v_permit.granted or not v_permit.started then raise exception '한도 안 예약이 바로 시작되지 않음'; end if;
    if i = 1 then v_token := v_permit.lease_token; end if;
  end loop;
  -- 최대 대기 0ms로는 기다려야 하는 예약을 받지 않고, 기록도 남기지 않는다.
  for i in 1..20 loop
    select * into v_permit from public.reserve_lol_riot_request('asia','interactive',0);
    if v_permit.granted or v_permit.reason <> 'window' or v_permit.retry_after_seconds < 1 then
      raise exception '대기 초과 예약을 window로 거절하지 않음';
    end if;
  end loop;
  select count(*) into v_count from public.lol_riot_request_log where host='asia';
  if v_count <> 4 then raise exception '거절한 예약이 기록에 남음: %', v_count; end if;

  -- 최대 대기 안이면 미래 허가를 받고, 보내기 전에 취소하면 기록이 사라진다.
  select * into v_permit from public.reserve_lol_riot_request('asia','interactive',4000);
  if not v_permit.granted or v_permit.started or v_permit.permit_at <= clock_timestamp() then raise exception '미래 허가가 아님'; end if;
  v_waiting := v_permit.lease_token;
  if not public.cancel_lol_riot_request(v_waiting) then raise exception '예약 취소 실패'; end if;
  if exists (select 1 from public.lol_riot_request_log where lease_token = v_waiting)
    or exists (select 1 from public.lol_collection_leases where lease_token = v_waiting) then
    raise exception '취소한 예약의 기록이나 허가가 남음';
  end if;

  -- 시작을 거절한 예약도 기록을 지운다.
  select * into v_permit from public.reserve_lol_riot_request('asia','interactive',4000);
  v_waiting := v_permit.lease_token;
  update public.lol_rate_limit_state set blocked_until = clock_timestamp() + interval '1 minute' where host='global';
  perform * from public.start_lol_riot_request(v_waiting);
  if exists (select 1 from public.lol_riot_request_log where lease_token = v_waiting) then raise exception '시작 거절 뒤 기록이 남음'; end if;
  update public.lol_rate_limit_state set blocked_until='-infinity' where host='global';

  -- 보낸 요청은 finish로 허가만 풀고 기록은 한도 계산에 남긴다.
  perform public.finish_lol_riot_request(v_token,'asia','5:1','1:1','100:10','1:10');
  if not exists (select 1 from public.lol_riot_request_log where lease_token = v_token) then raise exception '보낸 요청 기록이 사라짐'; end if;
  if exists (select 1 from public.lol_collection_leases where lease_token = v_token) then raise exception 'finish 뒤 허가가 남음'; end if;

  -- 이전 서명(최대 대기 없음) 호출도 기본값으로 동작한다.
  delete from public.lol_riot_request_log;
  delete from public.lol_collection_leases where lease_type='request';
  select * into v_permit from public.reserve_lol_riot_request('kr');
  if not v_permit.granted then raise exception '기본 인자 예약 실패'; end if;

  -- 보관본: 저장 계정이 그 이름의 유일한 계정일 때만 돌려준다.
  insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route) values ('owner-a','Owner','KR1','kr','asia');
  if not public.put_lol_search_snapshot(v_key,'kr','asia','16.21.1','owner-a',v_payload) then raise exception '보관본 저장 실패'; end if;
  if (select owner_puuid from public.lol_api_cache where cache_key = v_key) <> 'owner-a' then raise exception '보관본 주인이 기록되지 않음'; end if;
  if public.get_lol_search_snapshot(v_key,'kr','asia','16.21.1','owner','KR1') is distinct from v_payload then
    raise exception '주인이 맞는 보관본을 돌려주지 않음';
  end if;
  -- 같은 이름의 저장 계정이 둘이면 돌려주지 않는다.
  insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route) values ('owner-b','OWNER','kr1','kr','asia');
  if public.get_lol_search_snapshot(v_key,'kr','asia','16.21.1','Owner','KR1') is not null then raise exception '이름이 겹치는데 보관본을 돌려줌'; end if;
  delete from public.lol_accounts where puuid='owner-b';
  -- 저장 계정의 이름이 바뀐 것이 기록되면 옛 이름 보관본을 돌려주지 않는다.
  update public.lol_accounts set game_name='Renamed' where puuid='owner-a';
  if public.get_lol_search_snapshot(v_key,'kr','asia','16.21.1','Owner','KR1') is not null then raise exception '이름 변경 뒤 옛 보관본을 돌려줌'; end if;
  -- 다른 계정이 그 이름을 가져가도 옛 주인의 보관본은 돌려주지 않는다.
  insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route) values ('owner-c','Owner','KR1','kr','asia');
  if public.get_lol_search_snapshot(v_key,'kr','asia','16.21.1','Owner','KR1') is not null then raise exception '새 주인에게 옛 보관본을 돌려줌'; end if;
  -- 주인 기록이 없는 이전 행은 돌려주지 않는다.
  update public.lol_api_cache set owner_puuid = null where cache_key = v_key;
  update public.lol_accounts set game_name='Owner' where puuid='owner-a';
  delete from public.lol_accounts where puuid='owner-c';
  if public.get_lol_search_snapshot(v_key,'kr','asia','16.21.1','Owner','KR1') is not null then raise exception '주인 없는 행을 돌려줌'; end if;

  -- 한 Riot ID의 2분 캐시와 보관본을 모든 버전에서 지우고, 다른 이름(접두사가 같은 이름 포함)은 남긴다.
  insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,expires_at) values
    ('search:v11:kr:asia:16.20.1:owner:kr1','search','kr','asia','16.20.1','{}', now() + interval '1 minute'),
    ('search:v11:kr:asia:16.21.1:xowner:kr1','search','kr','asia','16.21.1','{}', now() + interval '1 minute'),
    ('search:v11:kr:asia:16.21.1:owner:kr12','search','kr','asia','16.21.1','{}', now() + interval '1 minute');
  if public.delete_lol_search_cache_for_name('kr','asia',':owner:kr1') <> 2 then raise exception '이름 캐시를 정확히 지우지 않음'; end if;
  if (select count(*) from public.lol_api_cache where cache_key in ('search:v11:kr:asia:16.21.1:xowner:kr1','search:v11:kr:asia:16.21.1:owner:kr12')) <> 2 then
    raise exception '다른 이름의 캐시를 지움';
  end if;
  begin
    perform public.delete_lol_search_cache_for_name('kr','asia','owner');
    raise exception '잘못된 이름 형식을 받음';
  exception when sqlstate '22023' then null;
  end;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'put_lol_search_snapshot' and pg_get_functiondef(oid) like '%for key share%') then
    raise exception '보관본 저장이 계정 행을 잠그지 않음';
  end if;
  if has_function_privilege('anon', 'public.cancel_lol_riot_request(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.get_lol_search_snapshot(text,text,text,text,text,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.delete_lol_search_cache_for_name(text,text,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.reserve_lol_riot_request(text,text,integer)', 'EXECUTE') then
    raise exception '공개 역할에 새 함수 권한이 있음';
  end if;
  if exists (select 1 from pg_proc where proname in ('cancel_lol_riot_request','get_lol_search_snapshot','delete_lol_search_cache_for_name','reserve_lol_riot_request') and prosecdef) then
    raise exception 'security definer 함수가 있음';
  end if;
end $$;
rollback;
