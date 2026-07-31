-- Overwolf GEP 세션 요약 마이그레이션 동작 시나리오
--
-- 일회용 PostgreSQL 인스턴스에서 실행합니다. 운영 DB 를 대상으로 실행하지 않습니다.
-- 실행: scripts/verify_overwolf_migration.sh

\echo '--- 시나리오 1: 테이블/인덱스 존재 ---'
do $$
declare missing integer;
begin
  select count(*) into missing
  from (values ('overwolf_session_events'), ('overwolf_session_quota')) as t(name)
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.name and c.relkind = 'r'
  );
  if missing > 0 then raise exception 'FAIL: 신규 테이블 % 건 누락', missing; end if;

  select count(*) into missing
  from (values
    ('overwolf_session_events_created_at_idx'),
    ('overwolf_session_events_match_id_idx'),
    ('overwolf_session_events_player_idx')
  ) as t(name)
  where not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = t.name
  );
  if missing > 0 then raise exception 'FAIL: 인덱스 % 건 누락', missing; end if;
  raise notice 'PASS: 테이블과 인덱스 생성 확인';
end $$;

\echo '--- 시나리오 2: RLS 및 권한 격리 ---'
do $$
declare unprotected integer; leaked integer;
begin
  select count(*) into unprotected
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('overwolf_session_events', 'overwolf_session_quota')
    and c.relrowsecurity = false;
  if unprotected > 0 then raise exception 'FAIL: RLS 미적용 테이블 % 건', unprotected; end if;

  select count(*) into leaked
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('overwolf_session_events', 'overwolf_session_quota')
    and grantee in ('anon', 'authenticated');
  if leaked > 0 then raise exception 'FAIL: anon/authenticated 권한 % 건 잔존', leaked; end if;
  raise notice 'PASS: RLS 적용 및 anon/authenticated 권한 격리';
end $$;

\echo '--- 시나리오 3: 세션 적재와 중복 matchEnd idempotency ---'
do $$
declare first_insert boolean; second_insert boolean; row_count integer; stored_kills integer;
begin
  set local role service_role;

  select public.record_overwolf_session_event(
    'verify-session-1', 'match-1', 'pseudo-1', 'mynick', 'steam',
    '{"kills": 3, "source": "overwolf_gep"}'::jsonb,
    '{"app": "BGMS Companion"}'::jsonb, 'bgms.kr', false
  ) into first_insert;

  -- 사망 시점과 로비 복귀 시점에 각각 발생하는 중복 matchEnd 를 흉내낸다.
  select public.record_overwolf_session_event(
    'verify-session-1', 'match-1', 'pseudo-1', 'mynick', 'steam',
    '{"kills": 99, "source": "overwolf_gep"}'::jsonb,
    '{"app": "BGMS Companion"}'::jsonb, 'bgms.kr', false
  ) into second_insert;

  if first_insert is not true then raise exception 'FAIL: 첫 적재가 false 반환'; end if;
  if second_insert is not false then raise exception 'FAIL: 중복 적재가 true 반환'; end if;

  select count(*) into row_count
  from public.overwolf_session_events where session_id = 'verify-session-1';
  if row_count <> 1 then raise exception 'FAIL: 중복 수신으로 % 행 생성', row_count; end if;

  select (gep_summary->>'kills')::integer into stored_kills
  from public.overwolf_session_events where session_id = 'verify-session-1';
  if stored_kills <> 3 then raise exception 'FAIL: 중복 수신이 기존 값을 덮어씀 (kills=%)', stored_kills; end if;

  raise notice 'PASS: session_id 기준 idempotent 적재';
end $$;

\echo '--- 시나리오 4: 빈 문자열 정규화와 잘못된 session_id 거부 ---'
do $$
declare accepted boolean; null_count integer;
begin
  set local role service_role;

  select public.record_overwolf_session_event(
    'verify-session-2', '', '', '', '',
    null, null, '', false
  ) into accepted;
  if accepted is not true then raise exception 'FAIL: 정상 세션이 거부됨'; end if;

  select count(*) into null_count
  from public.overwolf_session_events
  where session_id = 'verify-session-2'
    and match_id is null and pseudo_match_id is null
    and player_id is null and platform is null and source_host is null
    and gep_summary = '{}'::jsonb and client_environment = '{}'::jsonb;
  if null_count <> 1 then raise exception 'FAIL: 빈 문자열이 NULL 로 정규화되지 않음'; end if;

  select public.record_overwolf_session_event(
    '', null, null, null, null, null, null, null, null
  ) into accepted;
  if accepted is not false then raise exception 'FAIL: 빈 session_id 가 수락됨'; end if;

  select public.record_overwolf_session_event(
    repeat('x', 201), null, null, null, null, null, null, null, null
  ) into accepted;
  if accepted is not false then raise exception 'FAIL: 과도한 길이 session_id 가 수락됨'; end if;

  raise notice 'PASS: 빈 값 정규화와 잘못된 session_id 거부';
end $$;

\echo '--- 시나리오 5: 세션 전송 쿼터 ---'
do $$
declare accepted boolean; iteration integer;
begin
  set local role service_role;

  -- 허용량 3회 안에서는 통과해야 한다.
  for iteration in 1..3 loop
    select public.consume_overwolf_session_quota('verify-quota', 3, 600) into accepted;
    if accepted is not true then raise exception 'FAIL: % 번째 요청이 거부됨', iteration; end if;
  end loop;

  -- 4번째부터는 막혀야 한다.
  select public.consume_overwolf_session_quota('verify-quota', 3, 600) into accepted;
  if accepted is not false then raise exception 'FAIL: 허용량 초과 요청이 통과됨'; end if;

  -- 윈도가 지나면 카운터가 초기화된다.
  update public.overwolf_session_quota
  set window_started_at = now() - interval '2 hours'
  where quota_key = 'verify-quota';

  select public.consume_overwolf_session_quota('verify-quota', 3, 600) into accepted;
  if accepted is not true then raise exception 'FAIL: 윈도 경과 후에도 차단됨'; end if;

  select public.consume_overwolf_session_quota('', 3, 600) into accepted;
  if accepted is not false then raise exception 'FAIL: 빈 quota_key 가 수락됨'; end if;

  raise notice 'PASS: 쿼터 소비와 윈도 초기화';
end $$;

\echo '--- 시나리오 6: 보존 기간 정리 ---'
do $$
declare deleted integer; remaining integer; quota_remaining integer;
begin
  set local role service_role;

  perform public.record_overwolf_session_event(
    'verify-old-session', 'match-old', null, null, null, null, null, null, false
  );
  update public.overwolf_session_events
  set created_at = now() - interval '200 days'
  where session_id = 'verify-old-session';

  insert into public.overwolf_session_quota (quota_key, event_count, window_started_at)
  values ('verify-old-quota', 5, now() - interval '10 days');

  select public.cleanup_overwolf_session_events(90) into deleted;
  if deleted < 1 then raise exception 'FAIL: 만료 세션이 삭제되지 않음 (deleted=%)', deleted; end if;

  select count(*) into remaining
  from public.overwolf_session_events where session_id = 'verify-old-session';
  if remaining <> 0 then raise exception 'FAIL: 만료 세션 % 행 잔존', remaining; end if;

  select count(*) into remaining
  from public.overwolf_session_events where session_id = 'verify-session-1';
  if remaining <> 1 then raise exception 'FAIL: 보존 기간 내 세션이 삭제됨'; end if;

  select count(*) into quota_remaining
  from public.overwolf_session_quota where quota_key = 'verify-old-quota';
  if quota_remaining <> 0 then raise exception 'FAIL: 오래된 쿼터 행 잔존'; end if;

  raise notice 'PASS: 90일 보존 정리와 쿼터 정리';
end $$;

\echo '--- 시나리오 7: 운영 분석 테이블 미참조 ---'
do $$
declare referenced integer;
begin
  select count(*) into referenced
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'record_overwolf_session_event',
      'consume_overwolf_session_quota',
      'cleanup_overwolf_session_events'
    )
    and (
      p.prosrc like '%processed_match_telemetry%'
      or p.prosrc like '%match_stats_raw%'
      or p.prosrc like '%global_benchmarks%'
    );
  if referenced > 0 then raise exception 'FAIL: 함수 % 건이 운영 분석 테이블을 참조', referenced; end if;
  raise notice 'PASS: 운영 분석 테이블과 완전 분리';
end $$;

\echo '--- 시나리오 8: anon 직접 접근 차단 ---'
do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform 1 from public.overwolf_session_events limit 1;
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: anon 이 세션 테이블을 조회함'; end if;

  blocked := false;
  begin
    set local role anon;
    perform public.record_overwolf_session_event(
      'verify-anon', null, null, null, null, null, null, null, null
    );
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: anon 이 적재 함수를 실행함'; end if;

  raise notice 'PASS: anon 직접 접근 및 RPC 실행 차단';
end $$;

\echo '=== 전체 시나리오 통과 ==='
