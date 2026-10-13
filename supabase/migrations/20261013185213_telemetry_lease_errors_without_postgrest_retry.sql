BEGIN;
-- PostgREST 14 는 RPC 함수가 직접 던진 SQLSTATE 40001(serialization_failure)을 일시적 오류로 보고
-- 같은 요청의 트랜잭션을 계속 다시 실행한다(PostgREST 16 에서 수정). 운영은 PostgREST 14 이다.
-- 2026-08-02 긴급 조치로 이 표식을 P0001 로 바꿨지만, 20260904130000 이 두 함수를 다시 정의하며
-- lease 유실·조건 실패에 40001 을 다시 넣었다. 다시 실행해도 결과가 같은 오류이므로 일반 예외 코드
-- P0001 로 던져 한 번에 실패하게 한다. 함수의 나머지 정의, 소유자, 권한은 그대로 둔다.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function pg_temp.replace_intentional_retry_sqlstate(
  p_function regprocedure,
  p_expected_count integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(p_function);
  v_old_marker constant text := 'using errcode = ''40001''';
  v_new_marker constant text := 'using errcode = ''P0001''';
  v_old_count integer;
begin
  v_old_count := (pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_marker, '')))
    / pg_catalog.length(v_old_marker);

  -- 이미 바뀐 정의에는 다시 손대지 않는다.
  if v_old_count = 0 then
    return;
  end if;
  -- 예상과 다른 정의를 문자열 치환으로 바꾸지 않는다. 정의가 달라졌다면 사람이 다시 확인해야 한다.
  if v_old_count <> p_expected_count then
    raise exception 'telemetry-retry-sqlstate-unexpected-count: % has % (expected %)',
      p_function, v_old_count, p_expected_count;
  end if;

  execute pg_catalog.replace(v_definition, v_old_marker, v_new_marker);
end;
$$;

select pg_temp.replace_intentional_retry_sqlstate(
  'public.finalize_telemetry_cache_write(text,text,text,numeric,text,text,text,text,numeric,timestamptz,uuid,text,text,jsonb,timestamptz)'::regprocedure,
  2
);
select pg_temp.replace_intentional_retry_sqlstate(
  'public.finalize_telemetry_cache_recovery(text,text,text,text,numeric,text,uuid,jsonb,jsonb,jsonb)'::regprocedure,
  3
);

-- 두 함수에 의도적 40001 이 남아 있으면 적용을 실패시킨다.
do $$
begin
  if pg_catalog.strpos(
       pg_catalog.pg_get_functiondef('public.finalize_telemetry_cache_write(text,text,text,numeric,text,text,text,text,numeric,timestamptz,uuid,text,text,jsonb,timestamptz)'::regprocedure),
       'using errcode = ''40001''') > 0
     or pg_catalog.strpos(
       pg_catalog.pg_get_functiondef('public.finalize_telemetry_cache_recovery(text,text,text,text,numeric,text,uuid,jsonb,jsonb,jsonb)'::regprocedure),
       'using errcode = ''40001''') > 0 then
    raise exception 'telemetry-retry-sqlstate-still-present';
  end if;
end;
$$;

COMMIT;
