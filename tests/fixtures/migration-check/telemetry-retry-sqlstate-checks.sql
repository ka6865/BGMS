-- 20261013185213 적용 후 두 텔레메트리 finalize 함수가 PostgREST 재시도용 40001 을 던지지 않는지 확인한다.
do $$
declare
  write_def text := pg_get_functiondef('public.finalize_telemetry_cache_write(text,text,text,numeric,text,text,text,text,numeric,timestamptz,uuid,text,text,jsonb,timestamptz)'::regprocedure);
  recovery_def text := pg_get_functiondef('public.finalize_telemetry_cache_recovery(text,text,text,text,numeric,text,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  marker_p0001 constant text := 'using errcode = ''P0001''';
begin
  if strpos(write_def, 'using errcode = ''40001''') > 0 or strpos(recovery_def, 'using errcode = ''40001''') > 0 then
    raise exception 'FAIL: intentional 40001 remains in telemetry finalize functions';
  end if;
  if (length(write_def) - length(replace(write_def, marker_p0001, ''))) / length(marker_p0001) <> 2
     or (length(recovery_def) - length(replace(recovery_def, marker_p0001, ''))) / length(marker_p0001) <> 3 then
    raise exception 'FAIL: telemetry finalize lease errors were not converted to P0001';
  end if;
  -- 정의 치환이 보안 모드와 search_path 고정을 바꾸지 않았는지 확인한다(원래 SECURITY INVOKER).
  if exists (
    select 1 from pg_proc
    where oid in (
      'public.finalize_telemetry_cache_recovery(text,text,text,text,numeric,text,uuid,jsonb,jsonb,jsonb)'::regprocedure,
      'public.finalize_telemetry_cache_write(text,text,text,numeric,text,text,text,text,numeric,timestamptz,uuid,text,text,jsonb,timestamptz)'::regprocedure
    )
      and (prosecdef or coalesce(proconfig, '{}') <> array['search_path=""'])
  ) then
    raise exception 'FAIL: telemetry finalize functions changed security mode or search_path';
  end if;
  if has_function_privilege('anon', 'public.finalize_telemetry_cache_recovery(text,text,text,text,numeric,text,uuid,jsonb,jsonb,jsonb)'::regprocedure, 'execute')
     or has_function_privilege('anon', 'public.finalize_telemetry_cache_write(text,text,text,numeric,text,text,text,text,numeric,timestamptz,uuid,text,text,jsonb,timestamptz)'::regprocedure, 'execute') then
    raise exception 'FAIL: telemetry finalize functions became executable by anon';
  end if;
  raise notice 'PASS: telemetry finalize lease errors use P0001 without PostgREST retry';
end;
$$;
