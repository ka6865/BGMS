-- 마지막 검색 결과는 저장된 계정에만 7일 보관하고, 2분 검색 캐시·권한·정리 계약을 그대로 둔다.
begin;
set local role service_role;
do $$
declare
  v_key text := 'search-snapshot:v11:kr:asia:16.21.1:snapshot:kr1';
  v_payload jsonb := jsonb_build_object('lastUpdatedAt', '2026-10-29T00:00:00Z', 'matches', '[]'::jsonb);
  v_row public.lol_api_cache%rowtype;
  v_deleted jsonb;
begin
  if public.put_lol_search_snapshot(v_key,'kr','asia','16.21.1','snapshot-puuid',v_payload) then
    raise exception '저장되지 않은 계정의 검색 결과를 보관함';
  end if;
  insert into public.lol_accounts (puuid,game_name,tag_line,platform_id,regional_route)
  values ('snapshot-puuid','Snapshot','KR1','kr','asia');
  if not public.put_lol_search_snapshot(v_key,'kr','asia','16.21.1','snapshot-puuid',v_payload) then
    raise exception '저장된 계정의 검색 결과를 보관하지 못함';
  end if;
  select * into v_row from public.lol_api_cache where cache_key = v_key;
  if v_row.kind <> 'search_snapshot' or v_row.expires_at < v_row.fetched_at + interval '7 days' - interval '1 second'
    or v_row.expires_at > v_row.fetched_at + interval '7 days' then
    raise exception '검색 결과 보관 종류나 7일 만료가 다름';
  end if;
  if public.get_lol_api_cache(v_key,'search_snapshot','kr','asia','16.21.1') <> v_payload then
    raise exception '보관한 검색 결과를 조회하지 못함';
  end if;
  -- 2분 검색 캐시 조회는 보관본을 돌려주지 않는다.
  if public.get_lol_api_cache(v_key,'search','kr','asia','16.21.1') is not null then
    raise exception '2분 검색 캐시 조회가 보관본을 반환함';
  end if;
  if not public.put_lol_search_snapshot(v_key,'kr','asia','16.21.1','snapshot-puuid', jsonb_build_object('blob', repeat('x', 900000))) then
    raise exception '1MB 이하 검색 결과를 덮어쓰지 못함';
  end if;
  begin
    perform public.put_lol_search_snapshot(v_key,'kr','asia','16.21.1','snapshot-puuid', jsonb_build_object('blob', repeat('x', 1100000)));
    raise exception '1MB를 넘는 검색 결과를 보관함';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.put_lol_search_snapshot('search:v11:kr:asia:16.21.1:snapshot:kr1','kr','asia','16.21.1','snapshot-puuid',v_payload);
    raise exception '보관용이 아닌 키로 검색 캐시를 덮어씀';
  exception when sqlstate '22023' then null;
  end;
  -- 다른 종류 행은 같은 키여도 보관본으로 바꾸지 않는다.
  insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,expires_at)
  values ('search-snapshot:collision','match_details','kr','asia','16.21.1','{}'::jsonb, now() + interval '1 day');
  if public.put_lol_search_snapshot('search-snapshot:collision','kr','asia','16.21.1','snapshot-puuid',v_payload) then
    raise exception '다른 종류 캐시 행을 보관본으로 덮어씀';
  end if;
  begin
    insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
    values ('search-snapshot:too-long','search_snapshot','kr','asia','16.21.1','{}'::jsonb, now(), now() + interval '8 days');
    raise exception '7일을 넘는 보관을 허용함';
  exception when check_violation then null;
  end;
  begin
    insert into public.lol_api_cache (cache_key,kind,platform_id,regional_route,data_version,payload,fetched_at,expires_at)
    values ('search:too-long','search','kr','asia','16.21.1','{}'::jsonb, now(), now() + interval '3 minutes');
    raise exception '2분 검색 캐시 상한이 바뀜';
  exception when check_violation then null;
  end;
  -- 계정 데이터 삭제는 보관한 검색 결과도 지운다.
  v_deleted := public.delete_lol_account_data('snapshot-puuid');
  if exists (select 1 from public.lol_api_cache where cache_key = v_key) then
    raise exception '계정 삭제 뒤 검색 결과 보관본이 남음';
  end if;
end $$;
reset role;
do $$
begin
  if has_function_privilege('anon', 'public.put_lol_search_snapshot(text,text,text,text,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.put_lol_search_snapshot(text,text,text,text,text,jsonb)', 'EXECUTE') then
    raise exception '공개 역할에 검색 결과 보관 권한이 있음';
  end if;
  if exists (select 1 from pg_proc where proname = 'put_lol_search_snapshot' and prosecdef) then
    raise exception '검색 결과 보관 함수가 security definer임';
  end if;
end $$;
rollback;
