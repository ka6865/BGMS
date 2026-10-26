begin;
set local role service_role;
do $$
declare
  v_before timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
begin
  update public.lol_rate_limit_state set blocked_until='-infinity';
  if public.record_lol_riot_rate_headers('asia','bad','0:1','20:1','0:1') then
    raise exception '형식 오류 헤더를 허용함';
  end if;
  if exists (select 1 from public.lol_rate_limit_state where host in ('global','asia')
    and (blocked_until < v_before + interval '10 minutes' or blocked_until > v_before + interval '10 minutes 5 seconds')) then
    raise exception '형식 오류 차단이 10분 범위를 벗어남';
  end if;
  perform * from public.acquire_lol_collection_lease('collect:identity-backfill-own',180);
  perform * from public.acquire_lol_collection_lease('search:v10:' ||
    (select lower(game_name || '#' || tag_line) from public.lol_accounts where puuid='identity-backfill-own'),180);
  perform * from public.acquire_lol_collection_lease('search:v11:' ||
    (select lower(game_name || '#' || tag_line) from public.lol_accounts where puuid='identity-backfill-own'),180);
  -- 이름 뒤에 다른 문자가 붙은 검색 lease는 다른 계정이므로 남아야 한다.
  perform * from public.acquire_lol_collection_lease('search:v11:' ||
    (select lower(game_name || '#' || tag_line) from public.lol_accounts where puuid='identity-backfill-own') || 'x',180);
  perform * from public.acquire_lol_collection_lease('match:KR_889998',180);
  perform * from public.acquire_lol_collection_lease('collect:unrelated-fixture',180);
  perform * from public.acquire_lol_collection_lease('ops:expired-cleanup',120);
  v_result := public.delete_lol_account_data('identity-backfill-own');
  if (v_result->>'lease_rows')::integer <> 4 then raise exception '대상 lease를 모두 지우지 않음'; end if;
  if (select count(*) from public.lol_collection_leases where lease_key in ('collect:unrelated-fixture','ops:expired-cleanup')
    or lease_key like 'search:v11:%x') <> 3 then
    raise exception '무관한 계정 또는 정리 lease를 삭제함';
  end if;
  -- 저장 계정이 없는 동료도 PUUID 수집 lease만 삭제한다.
  perform * from public.acquire_lol_collection_lease('collect:unsearched-fixture',180);
  v_result := public.delete_lol_account_data('unsearched-fixture');
  if (v_result->>'lease_rows')::integer <> 1 then raise exception '미검색 계정 lease가 남음'; end if;
end $$;
reset role;
do $$
declare v_function regprocedure; v_role text;
begin
  foreach v_function in array array['public.record_lol_riot_rate_headers(text,text,text,text,text)'::regprocedure,
    'public.delete_lol_account_data(text)'::regprocedure] loop
    if exists (select 1 from pg_proc where oid=v_function and (prosecdef or not ('search_path=""'=any(proconfig)))) then
      raise exception '함수 권한 또는 search_path가 변경됨';
    end if;
    foreach v_role in array array['anon','authenticated'] loop
      if has_function_privilege(v_role,v_function,'EXECUTE') then raise exception '공개 역할에 RPC 실행 권한이 있음'; end if;
    end loop;
  end loop;
end $$;
rollback;
