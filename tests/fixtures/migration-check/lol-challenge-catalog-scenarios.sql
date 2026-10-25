begin;
set local role service_role;
do $$
declare v_token uuid; v_payload jsonb := '[{"id":101,"name":"가상 도전과제","percentiles":{"GOLD":0.3}}]';
begin
  select lease_token into strict v_token from public.acquire_lol_collection_lease('challenge-catalog:kr:ko_KR:v1',60);
  perform public.put_lol_challenge_catalog_cache(v_payload,'challenge-catalog:kr:ko_KR:v1',v_token);
  if public.get_lol_challenge_catalog_cache() is distinct from v_payload then raise exception 'catalog read mismatch'; end if;
  if not exists(select 1 from public.lol_challenge_catalog_cache where expires_at=fetched_at+interval '1 day') then
    raise exception 'catalog TTL mismatch'; end if;
  begin
    perform public.put_lol_challenge_catalog_cache('[]','challenge-catalog:kr:ko_KR:v1',pg_catalog.gen_random_uuid());
    raise exception 'catalog lease not checked';
  exception when serialization_failure then null; end;
  begin
    perform public.put_lol_challenge_catalog_cache('{}','challenge-catalog:kr:ko_KR:v1',v_token);
    raise exception 'catalog array check missing';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.put_lol_challenge_catalog_cache(jsonb_build_array(repeat('x',1048576)),'challenge-catalog:kr:ko_KR:v1',v_token);
    raise exception 'catalog byte check missing';
  exception when invalid_parameter_value then null; end;
  update public.lol_challenge_catalog_cache set fetched_at=now()-interval '2 days',expires_at=now()-interval '1 day';
  if public.get_lol_challenge_catalog_cache() is not null then raise exception 'expired catalog exposed'; end if;
end $$;
reset role;
do $$
declare v_role text; v_function text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    if has_table_privilege(v_role,'public.lol_challenge_catalog_cache','select,insert,update,delete,truncate') then
      raise exception 'catalog table is public'; end if;
    foreach v_function in array array['get_lol_challenge_catalog_cache()','put_lol_challenge_catalog_cache(jsonb,text,uuid)'] loop
      if has_function_privilege(v_role,'public.'||v_function,'execute') then raise exception 'catalog RPC is public'; end if;
    end loop;
  end loop;
  if not (select relrowsecurity from pg_class where oid='public.lol_challenge_catalog_cache'::regclass) then
    raise exception 'catalog RLS missing'; end if;
  foreach v_function in array array['get_lol_challenge_catalog_cache()','put_lol_challenge_catalog_cache(jsonb,text,uuid)'] loop
    if (select prosecdef or not ('search_path=""'=any(proconfig)) from pg_proc where oid=('public.'||v_function)::regprocedure)
      or not has_function_privilege('service_role','public.'||v_function,'execute') then raise exception 'catalog RPC security changed'; end if;
  end loop;
end $$;
rollback;
\echo '✅ LoL 도전과제 캐시 읽기·TTL·lease·상한·만료·권한 8개 시나리오 통과'
