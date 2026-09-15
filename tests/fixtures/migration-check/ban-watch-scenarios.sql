-- 제재 추적 migration 동작 시나리오.
\set ON_ERROR_STOP on

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222')
on conflict (id) do nothing;

\echo '--- 제재 추적 1: 직접 공개 접근 차단 ---'
do $$
begin
  begin
    set local role anon;
    perform 1 from public.pubg_ban_status;
    reset role;
    raise exception 'FAIL: anon이 상태 테이블을 읽을 수 있음';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS: anon 직접 접근 차단';
  end;
end $$;

\echo '--- 제재 추적 2: 원자적 상태 예약 및 활성 watch만 claim ---'
select public.schedule_pubg_ban_status('steam', 'account.target-1', now());
select public.schedule_pubg_ban_status('kakao', 'account.target-2', now());
do $$ begin
  update public.pubg_ban_status set next_check_at=now()+interval '1 day' where platform='steam' and account_id='account.target-1';
  perform public.schedule_pubg_ban_status('steam','account.target-1',now());
  if (select next_check_at>now()+interval '1 minute' from public.pubg_ban_status where platform='steam' and account_id='account.target-1') then
    raise exception 'FAIL: explicit refresh did not move the check earlier';
  end if;
end $$;
select public.create_pubg_ban_watch_item(
  '11111111-1111-1111-1111-111111111111', 'steam', 'account.subject-1', 'account.target-1',
  'match-1', now(), 'killer', 'Target One'
);
do $$
declare claimed integer;
begin
  select count(*) into claimed
  from public.claim_pubg_ban_status_batch(
    10, '33333333-3333-3333-3333-333333333333', now() + interval '15 minutes'
  );
  if claimed <> 1 then raise exception 'FAIL: 활성 대상 claim 수가 1이 아님 (%)', claimed; end if;
  raise notice 'PASS: 활성 watch 대상만 claim';
end $$;

\echo '--- 제재 추적 3: 대상당 경기 10개 상한과 멱등 중복 ---'
do $$
declare result jsonb; i integer;
begin
  for i in 2..10 loop
    result := public.create_pubg_ban_watch_item(
      '11111111-1111-1111-1111-111111111111', 'steam', 'account.subject-1', 'account.target-1',
      'match-' || i, now() + (i || ' minutes')::interval, 'killer', 'Target One'
    );
    if result->>'code' <> 'created' then raise exception 'FAIL: %번째 생성 실패: %', i, result; end if;
  end loop;
  result := public.create_pubg_ban_watch_item(
    '11111111-1111-1111-1111-111111111111', 'steam', 'account.subject-1', 'account.target-1',
    'match-1', (select event_at from public.pubg_ban_watch_items where match_id = 'match-1' limit 1), 'killer', 'Target One'
  );
  if result->>'code' <> 'duplicate' then raise exception 'FAIL: 중복 생성이 멱등하지 않음: %', result; end if;
  result := public.create_pubg_ban_watch_item(
    '11111111-1111-1111-1111-111111111111', 'steam', 'account.subject-1', 'account.target-1',
    'match-11', now() + interval '11 minutes', 'killer', 'Target One'
  );
  if result->>'code' <> 'target_match_limit' then raise exception 'FAIL: 대상 경기 10개 상한이 동작하지 않음: %', result; end if;
  raise notice 'PASS: 대상 경기 상한 + 중복 멱등';
end $$;

\echo '--- 제재 추적 4: 오래된 관찰은 최신 상태를 덮지 않음 ---'
do $$
declare first jsonb; stale jsonb; repeat jsonb; event_count integer;
begin
  first := public.record_pubg_ban_observation(
    'steam', 'account.target-1', 'PermanentBan', 'permanent',
    '2026-09-12T00:00:00Z', '2026-09-19T00:00:00Z',
    '44444444-4444-4444-4444-444444444444', null
  );
  if first->>'code' <> 'recorded' then raise exception 'FAIL: 최초 관찰 저장 실패: %', first; end if;
  stale := public.record_pubg_ban_observation(
    'steam', 'account.target-1', 'Innocent', 'none',
    '2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z',
    '55555555-5555-5555-5555-555555555555', null
  );
  if stale->>'code' <> 'stale' then raise exception 'FAIL: stale 관찰이 거부되지 않음: %', stale; end if;
  repeat := public.record_pubg_ban_observation(
    'steam', 'account.target-1', 'PermanentBan', 'permanent',
    '2026-09-12T00:00:00Z', '2026-09-19T00:00:00Z',
    '44444444-4444-4444-4444-444444444444', null
  );
  if repeat->>'code' <> 'recorded' then raise exception 'FAIL: 동일 observation 재처리 실패: %', repeat; end if;
  select count(*) into event_count
  from public.pubg_ban_status_events
  where platform = 'steam' and account_id = 'account.target-1';
  if event_count <> 1 then raise exception 'FAIL: observation_id 중복 이벤트 발생 (%)', event_count; end if;
  if (select normalized_status from public.pubg_ban_status where platform = 'steam' and account_id = 'account.target-1') <> 'permanent' then
    raise exception 'FAIL: stale 관찰이 상태를 덮음';
  end if;
  raise notice 'PASS: stale CAS + observation_id 멱등';
end $$;

\echo '--- 제재 추적 시나리오 종료 ---'
