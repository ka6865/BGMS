-- 검색 캐시는 1MB까지, 경기 상세 캐시는 기존 256KB까지만 저장된다.
begin;
do $$
declare v_big jsonb := jsonb_build_object('blob', repeat('x', 600000));
begin
  insert into public.lol_api_cache (cache_key, kind, platform_id, regional_route, data_version, payload, expires_at)
  values ('cap:search', 'search', 'kr', 'asia', '16.21.1', v_big, now() + interval '1 minute');
  begin
    insert into public.lol_api_cache (cache_key, kind, platform_id, regional_route, data_version, payload, expires_at)
    values ('cap:match', 'match_details', 'kr', 'asia', '16.21.1', v_big, now() + interval '1 minute');
    raise exception '경기 상세 캐시가 256KB를 넘어 저장됨';
  exception when check_violation then null;
  end;
  begin
    insert into public.lol_api_cache (cache_key, kind, platform_id, regional_route, data_version, payload, expires_at)
    values ('cap:search-over', 'search', 'kr', 'asia', '16.21.1', jsonb_build_object('blob', repeat('x', 1100000)), now() + interval '1 minute');
    raise exception '검색 캐시가 1MB를 넘어 저장됨';
  exception when check_violation then null;
  end;
  if not exists (select 1 from pg_proc where oid = 'public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)'::regprocedure
    and pg_get_functiondef(oid) like '%> 1048576%' and not prosecdef) then
    raise exception '검색 스냅샷 상한이 1MB로 바뀌지 않음';
  end if;
  if has_function_privilege('anon', 'public.persist_lol_search_snapshot(text,uuid,text,jsonb,text,text,text,jsonb,jsonb,jsonb)', 'EXECUTE') then
    raise exception '공개 역할에 스냅샷 저장 권한이 있음';
  end if;
end $$;
rollback;
