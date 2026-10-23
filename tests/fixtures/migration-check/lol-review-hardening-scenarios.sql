begin;
set local lock_timeout = '2s';

do $$
declare v_role text; v_table text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    if pg_catalog.has_function_privilege(v_role, 'public.consume_lol_public_rate_limit(text,integer,integer)', 'execute') then
      raise exception '공개 역할에 RPC 실행 권한이 있습니다';
    end if;
    foreach v_table in array array['lol_public_rate_limits','lol_data_dragon_versions'] loop
      if pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'select,insert,update,delete') then
        raise exception '공개 역할에 테이블 권한이 있습니다';
      end if;
      if not (select relrowsecurity from pg_catalog.pg_class where oid = ('public.' || v_table)::regclass) then
        raise exception 'RLS가 비활성입니다';
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc where oid = 'public.consume_lol_public_rate_limit(text,integer,integer)'::regprocedure
    and (prosecdef or not ('search_path=""' = any(proconfig)))) then
    raise exception '함수 보안 설정이 잘못되었습니다';
  end if;
end $$;

set local role anon;
do $$ begin
  begin
    perform public.consume_lol_public_rate_limit('search:' || repeat('a',64),10,60);
    raise exception '비공개 RPC 호출을 허용했습니다';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.lol_public_rate_limits;
    raise exception '비공개 테이블 읽기를 허용했습니다';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin
    insert into public.lol_data_dragon_versions(version) values ('16.22.1');
    raise exception '비공개 버전 캐시 쓰기를 허용했습니다';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set local role service_role;
do $$
declare v_result jsonb; v_preview jsonb; v_batch jsonb;
begin
  v_result := public.consume_lol_public_rate_limit('search:' || repeat('a',64),1,60);
  if v_result <> '{"allowed":true,"retry_after":0}'::jsonb then raise exception '첫 요청이 거부되었습니다'; end if;
  v_result := public.consume_lol_public_rate_limit('search:' || repeat('a',64),1,60);
  if (v_result->>'allowed')::boolean or (v_result->>'retry_after')::integer not between 1 and 60 then
    raise exception '제한 또는 재시도 초가 잘못되었습니다';
  end if;
  update public.lol_public_rate_limits set window_start = now() - interval '2 minutes', expires_at = now() - interval '1 minute';
  if not (public.consume_lol_public_rate_limit('search:' || repeat('a',64),1,60)->>'allowed')::boolean then
    raise exception '만료 윈도우가 초기화되지 않았습니다';
  end if;
  if (select count from public.lol_public_rate_limits where bucket_key='search:' || repeat('a',64)) <> 1 then
    raise exception '만료 카운터가 초기화되지 않았습니다';
  end if;
  begin
    perform public.consume_lol_public_rate_limit('192.0.2.1',10,60);
    raise exception '원본 IP 저장을 허용했습니다';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.consume_lol_public_rate_limit('search:' || repeat('a',64),0,60);
    raise exception '잘못된 제한값을 허용했습니다';
  exception when sqlstate '22023' then null;
  end;
  insert into public.lol_data_dragon_versions(version, fetched_at) values ('16.22.1', now() - interval '10 days');
  insert into public.lol_public_rate_limits values
    ('read:' || repeat('b',64), now() - interval '2 minutes', now() - interval '1 minute', 1),
    ('read:' || repeat('c',64), now() - interval '2 minutes', now() - interval '1 minute', 1);
  v_preview := public.preview_lol_expired_data();
  if (v_preview->>'public_rate_limit_rows')::integer <> 2 then raise exception '만료 카운터가 미리보기에 없습니다'; end if;
  v_batch := public.cleanup_lol_expired_batch(1);
  if (v_batch->'deleted'->>'public_rate_limit_rows')::integer <> 1
    or (v_batch->'remaining'->>'public_rate_limit_rows')::integer <> 1 then
    raise exception '공개 카운터 정리 배치 상한이 잘못되었습니다';
  end if;
  perform public.cleanup_lol_expired_batch(100);
  if not exists (select 1 from public.lol_public_rate_limits where bucket_key='search:' || repeat('a',64))
    or not exists (select 1 from public.lol_data_dragon_versions) then
    raise exception '유효 카운터 또는 마지막 성공 버전이 삭제되었습니다';
  end if;
  if (select count(*) from public.lol_ops_daily where metric in ('cleanup_deleted','cleanup_remaining','cleanup_duration_ms')) <> 3 then
    raise exception '정리 메트릭 기록이 없습니다';
  end if;
end $$;
reset role;

do $$ begin
  if exists (
    select 1 from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where c.contype = 'f' and n.nspname = 'public'
      and (t.relname like 'lol_augment%' or t.relname in ('lol_public_rate_limits','lol_data_dragon_versions'))
      and not exists (select 1 from pg_catalog.pg_index i
        where i.indrelid = c.conrelid and i.indisvalid and i.indpred is null and i.indexprs is null
          and i.indnkeyatts >= pg_catalog.cardinality(c.conkey)
          and (i.indkey::smallint[])[0:pg_catalog.cardinality(c.conkey)-1] @> c.conkey)
  ) then raise exception '인덱스가 없는 외래 키가 남았습니다'; end if;
  if not exists (select 1 from pg_catalog.pg_index where indexrelid = 'public.lol_public_rate_limits_expiry_idx'::regclass and indisvalid) then
    raise exception '만료 정리 인덱스가 없습니다';
  end if;
end $$;
rollback;
