-- 신규 migration의 RPC 동작 검증 시나리오.
-- 일회용 DB에서만 실행한다.
\set ON_ERROR_STOP on

insert into public.weapons (id, name, type, damage, bullet_speed, availability)
values ('ar_m416', 'M416', 'AR', 41, 880, '월드 스폰')
on conflict (id) do nothing;

insert into public.vehicles (id, name, trunk_capacity) values ('veh_dacia', 'Dacia', 200)
on conflict (id) do nothing;

insert into public.posts (id, title) values (1, '업데이트 42.1 패치노트')
on conflict (id) do nothing;

-- 1. 제안 생성
insert into public.weapon_patch_proposals (id, source_post_id, source_url, source_text_hash, patch_label)
values ('11111111-1111-1111-1111-111111111111', 1, 'https://pubg.com/ko/news/1', 'hash-a', '업데이트 42.1');

\echo '--- 시나리오 1: 승인된 정상 항목이 적용된다 ---'
insert into public.weapon_patch_proposal_changes
  (id, proposal_id, target_table, target_id, column_name, old_value, new_value,
   evidence_quote, evidence_found, validation_state, decision)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'weapons', 'ar_m416', 'damage', '41'::jsonb, '43'::jsonb,
   'M416의 기본 데미지가 41에서 43으로 상향되었습니다.', true, 'ok', 'accepted');

select * from public.apply_weapon_patch_proposal('11111111-1111-1111-1111-111111111111', null);

do $$
declare v integer;
begin
  select damage into v from public.weapons where id = 'ar_m416';
  if v <> 43 then raise exception 'FAIL: damage 가 43 이 아님 (실제 %)', v; end if;
  if not exists (select 1 from public.weapon_patch_apply_log where change_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'FAIL: 적용 로그가 없음';
  end if;
  if (select status from public.weapon_patch_proposals where id = '11111111-1111-1111-1111-111111111111') <> 'applied' then
    raise exception 'FAIL: 제안 상태가 applied 가 아님';
  end if;
  raise notice 'PASS: 적용 + 로그 + 상태 전이';
end $$;

\echo '--- 시나리오 2: 되돌리기가 원래 값으로 복구한다 ---'
do $$
declare log_id uuid; v integer;
begin
  select id into log_id from public.weapon_patch_apply_log where change_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform public.revert_weapon_patch_apply(log_id, null);
  select damage into v from public.weapons where id = 'ar_m416';
  if v <> 41 then raise exception 'FAIL: 되돌리기 후 damage 가 41 이 아님 (실제 %)', v; end if;
  if (select reverted_at from public.weapon_patch_apply_log where id = log_id) is null then
    raise exception 'FAIL: reverted_at 이 기록되지 않음';
  end if;
  raise notice 'PASS: 되돌리기';
end $$;

\echo '--- 시나리오 3: old_value 불일치(stale)면 적용을 건너뛴다 ---'
insert into public.weapon_patch_proposals (id, source_url, source_text_hash)
values ('22222222-2222-2222-2222-222222222222', 'https://pubg.com/ko/news/2', 'hash-b');

insert into public.weapon_patch_proposal_changes
  (id, proposal_id, target_table, target_id, column_name, old_value, new_value,
   evidence_quote, evidence_found, validation_state, decision)
values
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'weapons', 'ar_m416', 'bullet_speed', '700'::jsonb, '730'::jsonb,
   'Beryl M762의 탄속이 715m/s에서 730m/s로 증가했습니다.', true, 'ok', 'accepted');

do $$
declare r record; v integer;
begin
  select * into r from public.apply_weapon_patch_proposal('22222222-2222-2222-2222-222222222222', null);
  if r.result <> 'skipped_stale' then raise exception 'FAIL: skipped_stale 이 아님 (실제 %)', r.result; end if;
  select bullet_speed into v from public.weapons where id = 'ar_m416';
  if v <> 880 then raise exception 'FAIL: stale 인데 값이 변경됨 (실제 %)', v; end if;
  if (select validation_state from public.weapon_patch_proposal_changes where id = 'bbbbbbbb-0000-0000-0000-000000000001') <> 'stale' then
    raise exception 'FAIL: validation_state 가 stale 로 갱신되지 않음';
  end if;
  raise notice 'PASS: stale 스킵';
end $$;

\echo '--- 시나리오 4: 검증 미통과 항목은 승인 상태가 될 수 없다 ---'
do $$
begin
  begin
    insert into public.weapon_patch_proposal_changes
      (proposal_id, target_table, target_id, column_name, new_value,
       evidence_quote, evidence_found, validation_state, decision)
    values
      ('22222222-2222-2222-2222-222222222222', 'weapons', 'ar_m416', 'damage', '99'::jsonb,
       '근거 없음', false, 'invalid', 'accepted');
    raise exception 'FAIL: invalid + accepted 삽입이 허용됨';
  exception when check_violation then
    raise notice 'PASS: invalid 항목 승인 차단';
  end;
end $$;

\echo '--- 시나리오 5: 화이트리스트 밖 컬럼은 적용 RPC 가 거부한다 ---'
-- CHECK 제약을 우회해 직접 삽입한 뒤 RPC 단계 방어를 확인한다.
insert into public.weapon_patch_proposals (id, source_url, source_text_hash)
values ('33333333-3333-3333-3333-333333333333', 'https://pubg.com/ko/news/3', 'hash-c');

alter table public.weapon_patch_proposal_changes drop constraint weapon_patch_proposal_changes_accept_requires_ok;
insert into public.weapon_patch_proposal_changes
  (proposal_id, target_table, target_id, column_name, old_value, new_value,
   evidence_quote, evidence_found, validation_state, decision)
values
  ('33333333-3333-3333-3333-333333333333', 'weapons', 'ar_m416', 'name', '"M416"'::jsonb, '"HACKED"'::jsonb,
   '위조된 근거', true, 'ok', 'accepted');
alter table public.weapon_patch_proposal_changes
  add constraint weapon_patch_proposal_changes_accept_requires_ok
  check (decision <> 'accepted' or validation_state = 'ok');

do $$
declare n text;
begin
  begin
    perform public.apply_weapon_patch_proposal('33333333-3333-3333-3333-333333333333', null);
    raise exception 'FAIL: 화이트리스트 밖 컬럼 적용이 통과됨';
  exception when others then
    if position('column not editable' in SQLERRM) = 0 then
      raise exception 'FAIL: 예상과 다른 오류: %', SQLERRM;
    end if;
    raise notice 'PASS: 화이트리스트 밖 컬럼 거부 (%)', SQLERRM;
  end;
  select name into n from public.weapons where id = 'ar_m416';
  if n <> 'M416' then raise exception 'FAIL: name 이 변경됨 (실제 %)', n; end if;
end $$;

\echo '--- 시나리오 6: 동일 본문 해시 중복 제안 차단 ---'
do $$
begin
  begin
    insert into public.weapon_patch_proposals (source_url, source_text_hash)
    values ('https://pubg.com/ko/news/9', 'hash-a');
    raise exception 'FAIL: 중복 해시 삽입이 허용됨';
  exception when unique_violation then
    raise notice 'PASS: 중복 해시 차단';
  end;
end $$;

\echo '--- 시나리오 7: numeric/integer 캐스팅 (vehicles.trunk_capacity) ---'
insert into public.weapon_patch_proposals (id, source_url, source_text_hash)
values ('44444444-4444-4444-4444-444444444444', 'https://pubg.com/ko/news/4', 'hash-d');
insert into public.weapon_patch_proposal_changes
  (proposal_id, target_table, target_id, column_name, old_value, new_value,
   evidence_quote, evidence_found, validation_state, decision)
values
  ('44444444-4444-4444-4444-444444444444', 'vehicles', 'veh_dacia', 'trunk_capacity',
   '200'::jsonb, '250'::jsonb, '다시아 트렁크 용량이 250으로 증가했습니다.', true, 'ok', 'accepted');

do $$
declare v integer;
begin
  perform public.apply_weapon_patch_proposal('44444444-4444-4444-4444-444444444444', null);
  select trunk_capacity into v from public.vehicles where id = 'veh_dacia';
  if v <> 250 then raise exception 'FAIL: trunk_capacity 가 250 이 아님 (실제 %)', v; end if;
  raise notice 'PASS: integer 캐스팅';
end $$;

\echo '--- 시나리오 8: Discord 방 쿼터 (사용자당 3회) ---'
insert into auth.users (id) values ('55555555-5555-5555-5555-555555555555');
do $$
declare ok1 boolean; ok2 boolean; ok3 boolean; ok4 boolean;
begin
  ok1 := public.consume_discord_room_quota('55555555-5555-5555-5555-555555555555');
  ok2 := public.consume_discord_room_quota('55555555-5555-5555-5555-555555555555');
  ok3 := public.consume_discord_room_quota('55555555-5555-5555-5555-555555555555');
  ok4 := public.consume_discord_room_quota('55555555-5555-5555-5555-555555555555');
  if not (ok1 and ok2 and ok3) then raise exception 'FAIL: 3회 이내가 거부됨 (% % %)', ok1, ok2, ok3; end if;
  if ok4 then raise exception 'FAIL: 4번째 호출이 허용됨'; end if;
  if public.consume_discord_room_quota(null) then raise exception 'FAIL: null user 허용됨'; end if;
  raise notice 'PASS: Discord 방 쿼터';
end $$;

\echo '--- 시나리오 9: PUBG 응답 캐시 read/write/TTL ---'
do $$
declare payload jsonb;
begin
  perform public.write_pubg_response_cache('player:steam:test:current', '{"name":"test"}'::jsonb, 180);
  select public.read_pubg_response_cache('player:steam:test:current') into payload;
  if payload is null or payload->>'name' <> 'test' then raise exception 'FAIL: 캐시 조회 실패 (%)', payload; end if;

  -- 즉시 만료되는 TTL(1초)로 덮어쓰고 만료 확인
  perform public.write_pubg_response_cache('player:steam:expired:current', '{"a":1}'::jsonb, 1);
  update public.pubg_response_cache set expires_at = now() - interval '1 second'
    where cache_key = 'player:steam:expired:current';
  if public.read_pubg_response_cache('player:steam:expired:current') is not null then
    raise exception 'FAIL: 만료된 캐시가 반환됨';
  end if;

  -- 과도한 TTL 은 상한 처리
  perform public.write_pubg_response_cache('player:steam:ttl:current', '{"a":1}'::jsonb, 999999);
  if (select expires_at from public.pubg_response_cache where cache_key = 'player:steam:ttl:current')
     > now() + interval '1 day' + interval '1 minute' then
    raise exception 'FAIL: TTL 상한이 적용되지 않음';
  end if;
  raise notice 'PASS: 캐시 read/write/TTL 상한';
end $$;

\echo '--- 시나리오 10: 강제 갱신 쿨다운 클레임 ---'
do $$
declare first_claim boolean; second_claim boolean; third_claim boolean;
begin
  first_claim := public.claim_pubg_force_refresh('player:steam:lock:current', 60);
  second_claim := public.claim_pubg_force_refresh('player:steam:lock:current', 60);
  if not first_claim then raise exception 'FAIL: 최초 클레임 실패'; end if;
  if second_claim then raise exception 'FAIL: 쿨다운 중 클레임이 허용됨'; end if;

  update public.pubg_refresh_locks set claimed_at = now() - interval '2 minutes'
    where lock_key = 'player:steam:lock:current';
  third_claim := public.claim_pubg_force_refresh('player:steam:lock:current', 60);
  if not third_claim then raise exception 'FAIL: 쿨다운 경과 후 클레임 실패'; end if;
  raise notice 'PASS: 강제 갱신 쿨다운';
end $$;

\echo '--- 시나리오 11: 쓰기 정책 강화 결과 확인 ---'
do $$
declare bad_policies integer; write_grants integer;
begin
  select count(*) into bad_policies
  from pg_policies
  where schemaname = 'public'
    and tablename in ('pubg_player_cache', 'processed_match_telemetry', 'match_stats_raw')
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and (coalesce(qual, '') like '%authenticated%'
         or coalesce(with_check, '') like '%authenticated%'
         or coalesce(qual, '') = 'true');
  if bad_policies > 0 then raise exception 'FAIL: 느슨한 쓰기 정책 % 건 잔존', bad_policies; end if;

  select count(*) into write_grants
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('pubg_player_cache', 'processed_match_telemetry', 'match_stats_raw')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if write_grants > 0 then raise exception 'FAIL: anon/authenticated 쓰기 권한 % 건 잔존', write_grants; end if;

  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'pubg_player_cache'
      and grantee = 'anon' and privilege_type = 'SELECT'
  ) then raise exception 'FAIL: anon 읽기 권한이 사라짐'; end if;
  raise notice 'PASS: 쓰기 정책·권한 강화 확인';
end $$;

\echo '--- 시나리오 13: linked player sync 후보 dedupe·lease·completion ---'
insert into public.profiles (id, pubg_nickname, pubg_platform, last_active_at, updated_at)
values
  ('66666666-6666-4666-8666-666666666661', 'Shared_Player', 'steam', now() - interval '1 day', now()),
  ('66666666-6666-4666-8666-666666666662', 'shared_player', 'steam', now() - interval '2 days', now()),
  ('66666666-6666-4666-8666-666666666663', 'Inactive_Player', 'kakao', now() - interval '31 days', now()),
  ('66666666-6666-4666-8666-666666666664', null, 'steam', now() - interval '1 day', now())
on conflict (id) do nothing;

do $$
declare candidate_count integer; claim_ok boolean; stale_ok boolean; complete_ok boolean;
begin
  select count(*) into candidate_count
  from public.list_pubg_linked_sync_candidates(15, now() - interval '30 days');
  if candidate_count <> 1 then
    raise exception 'FAIL: linked 후보 dedupe/활동 필터 오류 (실제 %)', candidate_count;
  end if;

  claim_ok := public.claim_pubg_linked_sync(
    'steam', 'shared_player', 'Shared_Player',
    '77777777-7777-4777-8777-777777777777', now() + interval '10 minutes'
  );
  if not claim_ok then raise exception 'FAIL: linked claim 실패'; end if;

  if exists (
    select 1 from public.list_pubg_linked_sync_candidates(15, now() - interval '30 days')
    where normalized_nickname = 'shared_player'
  ) then raise exception 'FAIL: running lease 후보가 다시 노출됨'; end if;

  if public.claim_pubg_linked_sync(
    'steam', 'shared_player', 'Shared_Player',
    '88888888-8888-4888-8888-888888888888', now() + interval '10 minutes'
  ) then raise exception 'FAIL: 유효한 lease 중복 claim 허용'; end if;

  stale_ok := public.complete_pubg_linked_sync(
    'steam', 'shared_player', '00000000-0000-4000-8000-000000000000',
    'success', now(), now() + interval '1 day', 0, null
  );
  if stale_ok then raise exception 'FAIL: stale lease completion 허용'; end if;

  complete_ok := public.complete_pubg_linked_sync(
    'steam', 'shared_player', '77777777-7777-4777-8777-777777777777',
    'success', now(), now() + interval '1 day', 0, null
  );
  if not complete_ok then raise exception 'FAIL: current lease completion 실패'; end if;
  raise notice 'PASS: linked 후보 dedupe·활동 필터·lease 비교·completion';
end $$;

\echo '--- 시나리오 14: linked sync ACL·canonical CHECK·실제 역할 경계 ---'
do $$
declare
  state_rows integer;
  bad_definers integer;
  bad_indexes integer;
  bad_checks integer;
  service_grants integer;
  public_grants integer;
begin
  select count(*) into bad_indexes
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('pubg_linked_profiles_active_idx', 'pubg_linked_profiles_identity_idx');
  if bad_indexes <> 2 then raise exception 'FAIL: linked profiles partial index % 건', bad_indexes; end if;

  select count(*) into bad_checks
  from pg_constraint
  where conrelid = 'public.pubg_linked_player_sync_state'::regclass
    and pg_get_constraintdef(oid) like '%normalized_nickname = lower(btrim(normalized_nickname))%';
  if bad_checks <> 1 then raise exception 'FAIL: canonical normalized_nickname CHECK 누락'; end if;

  select count(*) into bad_definers
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('list_pubg_linked_sync_candidates', 'claim_pubg_linked_sync', 'complete_pubg_linked_sync')
    and p.prosecdef;
  if bad_definers <> 0 then raise exception 'FAIL: linked RPC SECURITY DEFINER 잔존 % 건', bad_definers; end if;

  if not has_table_privilege('service_role', 'public.pubg_linked_player_sync_state', 'SELECT') then
    raise exception 'FAIL: service_role table SELECT 권한 없음';
  end if;
  if has_table_privilege('anon', 'public.pubg_linked_player_sync_state', 'SELECT')
     or has_table_privilege('authenticated', 'public.pubg_linked_player_sync_state', 'SELECT') then
    raise exception 'FAIL: anon/authenticated table SELECT 권한 잔존';
  end if;

  select count(*) into service_grants
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'pubg_linked_player_sync_state'
    and grantee = 'service_role';
  if service_grants = 0 then raise exception 'FAIL: service_role table ACL 누락'; end if;

  select count(*) into public_grants
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'pubg_linked_player_sync_state'
    and grantee in ('public', 'anon', 'authenticated');
  if public_grants <> 0 then raise exception 'FAIL: 공개 table ACL % 건 잔존', public_grants; end if;

  if not (
    has_function_privilege('service_role', 'public.list_pubg_linked_sync_candidates(integer,timestamptz)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_pubg_linked_sync(text,text,text,uuid,timestamptz)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_pubg_linked_sync(text,text,uuid,text,timestamptz,timestamptz,integer,text)', 'EXECUTE')
  ) then raise exception 'FAIL: service_role linked RPC ACL 누락'; end if;

  if has_function_privilege('anon', 'public.list_pubg_linked_sync_candidates(integer,timestamptz)', 'EXECUTE')
     or has_function_privilege('anon', 'public.claim_pubg_linked_sync(text,text,text,uuid,timestamptz)', 'EXECUTE')
     or has_function_privilege('anon', 'public.complete_pubg_linked_sync(text,text,uuid,text,timestamptz,timestamptz,integer,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.list_pubg_linked_sync_candidates(integer,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_pubg_linked_sync(text,text,text,uuid,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.complete_pubg_linked_sync(text,text,uuid,text,timestamptz,timestamptz,integer,text)', 'EXECUTE') then
    raise exception 'FAIL: anon/authenticated linked RPC ACL 잔존';
  end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'FAIL: SET ROLE service_role 실패'; end if;
  select count(*) into state_rows from public.pubg_linked_player_sync_state;
  perform public.list_pubg_linked_sync_candidates(15, now() - interval '30 days');
  if state_rows < 1 then raise exception 'FAIL: service_role state table 조회 실패'; end if;
  raise notice 'PASS: service_role SET ROLE positive + ACL + SECURITY INVOKER + indexes + canonical CHECK';
end $$;

do $$
begin
  set local role anon;
  begin
    perform (select count(*) from public.pubg_linked_player_sync_state);
    raise exception 'FAIL: anon table SELECT 권한이 남아 있음';
  exception when insufficient_privilege then
    raise notice 'PASS: anon linked state table 권한 회수';
  end;
  begin
    perform public.list_pubg_linked_sync_candidates(15, now() - interval '30 days');
    raise exception 'FAIL: anon RPC 실행 권한이 남아 있음';
  exception when insufficient_privilege then
    raise notice 'PASS: anon linked RPC 권한 회수';
  end;
end $$;

do $$
begin
  set local role authenticated;
  begin
    perform (select count(*) from public.pubg_linked_player_sync_state);
    raise exception 'FAIL: authenticated table SELECT 권한이 남아 있음';
  exception when insufficient_privilege then
    raise notice 'PASS: authenticated linked state table 권한 회수';
  end;
  begin
    perform public.list_pubg_linked_sync_candidates(15, now() - interval '30 days');
    raise exception 'FAIL: authenticated RPC 실행 권한이 남아 있음';
  exception when insufficient_privilege then
    raise notice 'PASS: authenticated linked RPC 권한 회수';
  end;
end $$;

\echo '--- 시나리오 12: 제안 테이블 RLS 및 권한 ---'
do $$
declare unprotected integer; leaked integer;
begin
  select count(*) into unprotected
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('weapon_patch_proposals','weapon_patch_proposal_changes','weapon_patch_apply_log',
                      'discord_room_rate_limits','pubg_response_cache','pubg_refresh_locks')
    and c.relrowsecurity = false;
  if unprotected > 0 then raise exception 'FAIL: RLS 미적용 테이블 % 건', unprotected; end if;

  select count(*) into leaked
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('weapon_patch_proposals','weapon_patch_proposal_changes','weapon_patch_apply_log',
                       'discord_room_rate_limits','pubg_response_cache','pubg_refresh_locks')
    and grantee in ('anon', 'authenticated');
  if leaked > 0 then raise exception 'FAIL: anon/authenticated 권한 % 건 잔존', leaked; end if;
  raise notice 'PASS: 신규 테이블 RLS + 권한 격리';
end $$;

-- 202609 population provenance boundary. Every row below uses a distinct
-- weapon name/match id so the RPC assertions can identify exactly what was
-- admitted or rejected by the current markers and match-type allowlist.
delete from public.global_benchmarks where id between 9001 and 9004;
insert into public.global_benchmarks (
  id, match_id, player_id, platform, tier, game_mode, match_type,
  filter_version, population_evidence_version, damage, kills, survival_time
)
values
  (9001, 'prov-legacy', 'prov-player', 'steam', 'A', 'squad-fpp', 'official', 8, null, 900, 1, 100),
  (9002, 'prov-trusted-minus-one', 'prov-player', 'steam', 'A', 'squad-fpp', 'official', 8, 1, -1, 2, 100),
  (9003, 'prov-trusted', 'prov-player', 'steam', 'A', 'squad-fpp', 'official', 8, 1, 100, 3, 100),
  (9004, 'prov-invalid-mode', 'prov-player', 'steam', 'A', 'arcade', 'official', 8, 1, 900, 4, 100);

\echo '--- legacy/unmarked benchmark rows are excluded ---'
do $$
declare
  v_match_count bigint;
  v_avg_damage double precision;
  v_avg_damage_count bigint;
begin
  select match_count, avg_damage, avg_damage_count
    into v_match_count, v_avg_damage, v_avg_damage_count
  from public.benchmark_stats_by_tier
  where tier = 'A' and game_mode = 'squad-fpp' and match_type = 'official';

  if v_match_count <> 2 then
    raise exception 'FAIL: legacy/unmarked benchmark rows were included (match_count=%)', v_match_count;
  end if;
  raise notice 'PASS: legacy/unmarked benchmark rows are excluded';

  if v_avg_damage <> 100 then
    raise exception 'FAIL: trusted canonical rows were not included (avg_damage=%)', v_avg_damage;
  end if;
  raise notice 'PASS: trusted canonical benchmark rows are included';

  if v_avg_damage <> 100 or v_avg_damage_count <> 1 then
    raise exception 'FAIL: metric -1 was not omitted (avg_damage=% count=%)', v_avg_damage, v_avg_damage_count;
  end if;
  raise notice 'PASS: metric -1 is omitted';

  if exists (
    select 1
    from public.benchmark_stats_by_tier
    where game_mode = 'arcade'
  ) then
    raise exception 'FAIL: invalid game mode was included';
  end if;
  raise notice 'PASS: invalid game mode is excluded';
end $$;

delete from public.weapon_meta_match_samples where match_id like 'prov-%';
insert into public.weapon_meta_match_samples (
  match_id, platform, player_id, played_at, patch_version,
  weapon_category, weapon_name, active_pick, total_kills, total_dbnos,
  total_damage, first_sec_hits, sustained_hits, sustained_burst_count,
  match_type, filter_version, population_evidence_version
)
values
  ('prov-weapon-legacy-pre', 'steam', 'prov-player', now() - interval '2 days', 'pre_42.1',
   'AR', 'LegacyPre', true, 1, 0, 10, 1, 2, 1, 'official', 8, null),
  ('prov-weapon-trusted-pre', 'steam', 'prov-player', now() - interval '2 days', 'pre_42.1',
   'AR', 'TrustedPre', true, 2, 1, 20, 2, 3, 1, 'official', 8, 1),
  ('prov-weapon-legacy-filter-pre', 'steam', 'prov-player', now() - interval '2 days', 'pre_42.1',
   'AR', 'LegacyFilter', true, 3, 1, 30, 3, 4, 1, 'official', null, null),
  ('prov-weapon-trusted-post', 'steam', 'prov-player', now() - interval '30 minutes', '42.1',
   'AR', 'TrustedPost', true, 4, 1, 40, 4, 5, 1, 'competitive', 8, 1),
  ('prov-weapon-legacy-post', 'steam', 'prov-player', now() - interval '20 minutes', '42.1',
   'AR', 'LegacyPost', true, 5, 1, 50, 5, 6, 1, 'competitive', 8, null),
  ('prov-weapon-invalid-type-post', 'steam', 'prov-player', now() - interval '10 minutes', '42.1',
   'AR', 'InvalidType', true, 6, 1, 60, 6, 7, 1, 'scrim', 8, 1);

create temporary table migration_provenance_weapon_results as
select *
from public.get_weapon_meta_comparison('42.1', now() - interval '1 hour', 14, 'all');

\echo '--- weapon RPC returns only current markers ---'
do $$
begin
  if not exists (
    select 1 from migration_provenance_weapon_results
    where weapon_name = 'TrustedPre' and period = 'pre'
  ) then
    raise exception 'FAIL: trusted pre weapon row was excluded';
  end if;
  if not exists (
    select 1 from migration_provenance_weapon_results
    where weapon_name = 'TrustedPost' and period = 'post'
  ) then
    raise exception 'FAIL: trusted post weapon row was excluded';
  end if;

  if exists (
    select 1 from migration_provenance_weapon_results
    where weapon_name in ('LegacyPre', 'LegacyFilter', 'LegacyPost', 'InvalidType')
  ) then
    raise exception 'FAIL: weapon RPC returned an untrusted or invalid row';
  end if;
  if exists (
    select 1 from migration_provenance_weapon_results
    where filter_version <> 8 or population_evidence_version <> 1
  ) then
    raise exception 'FAIL: weapon RPC returned non-current markers';
  end if;
  raise notice 'PASS: weapon RPC returns only current markers';
end $$;

\echo '--- 시나리오 15: recovery claim은 기존 lease를 보존한다 ---'
do $$
declare first_claim boolean; duplicate_claim boolean;
begin
  set local role service_role;
  first_claim := public.claim_telemetry_cache_recovery_write(
    'recovery-match', 'steam', 'recovery-player', 'lite', 61,
    'telemetry-map/v61/steam/recovery-match/recovery-player.json',
    now() + interval '10 minutes',
    '99999999-9999-4999-8999-999999999999', now()
  );
  duplicate_claim := public.claim_telemetry_cache_recovery_write(
    'recovery-match', 'steam', 'recovery-player', 'lite', 61,
    'telemetry-map/v61/steam/recovery-match/recovery-player-new.json',
    now() + interval '10 minutes',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now()
  );
  if not first_claim then raise exception 'FAIL: 최초 recovery claim 실패'; end if;
  if duplicate_claim then raise exception 'FAIL: 기존 recovery lease가 덮어써짐'; end if;
  if (select storage_path from public.telemetry_map_cache_entries
      where match_id = 'recovery-match' and platform = 'steam'
        and player_id = 'recovery-player' and mode = 'lite' and telemetry_version = 61)
      <> 'telemetry-map/v61/steam/recovery-match/recovery-player.json' then
    raise exception 'FAIL: 기존 recovery lease 본문이 변경됨';
  end if;
  raise notice 'PASS: recovery claim duplicate 보존';
end $$;

\echo '--- 시나리오 16: atomic recovery finalization success/idempotency ---'
delete from public.telemetry_map_cache_entries where match_id like 'atomic-recovery-%';
delete from public.processed_match_telemetry where match_id like 'atomic-recovery-%';
delete from public.global_benchmarks where match_id like 'atomic-recovery-%';
delete from public.match_master_telemetry where match_id like 'atomic-recovery-%';

do $$
declare
  lease_token uuid := '11111111-1111-4111-8111-111111111111';
  first_result jsonb;
  retry_result jsonb;
  first_claim boolean;
  processed_data jsonb := jsonb_build_object(
    'fullResult', jsonb_build_object(
      'v', 72,
      'matchId', 'atomic-recovery-success',
      'player_id', 'atomic-player',
      'platform', 'steam',
      'stats', jsonb_build_object('name', 'AtomicPlayer', 'playerId', 'atomic-account')
    )
  );
  final_processed_data jsonb := jsonb_build_object(
    'fullResult', jsonb_build_object(
      'v', 73,
      'matchId', 'atomic-recovery-success',
      'player_id', 'atomic-player',
      'platform', 'steam',
      'populationEvidenceVersion', 1,
      'stats', jsonb_build_object('name', 'AtomicPlayer', 'playerId', 'atomic-account')
    )
  );
  rows_payload jsonb;
begin
  set local role service_role;
  insert into public.processed_match_telemetry (match_id, platform, player_id, data)
  values ('atomic-recovery-success', 'steam', 'atomic-player', processed_data);
  insert into public.global_benchmarks (
    id, match_id, platform, player_id, game_mode, match_type, tier,
    filter_version, population_evidence_version, damage, kills
  ) values (
    9201, 'atomic-recovery-success', 'steam', 'atomic-player',
    'squad-fpp', 'official', 'B', null, null, 321, 3
  );
  first_claim := public.claim_telemetry_cache_recovery_write(
    'atomic-recovery-success', 'steam', 'atomic-account', 'lite', 61,
    'telemetry-map/v61/steam/atomic-recovery-success/atomic-account.json',
    now() + interval '10 minutes', lease_token, now()
  );
  if not first_claim then raise exception 'FAIL: atomic recovery claim 실패'; end if;

  rows_payload := jsonb_build_object(
    'master', jsonb_build_object(
      'match_id', 'atomic-recovery-success', 'map_name', 'Baltic_Main',
      'game_mode', 'squad-fpp', 'telemetry_version', 61,
      'storage_path', 'telemetry-map/v61/steam/atomic-recovery-success/atomic-account.json'
    ),
    'processed', jsonb_build_object(
      'match_id', 'atomic-recovery-success', 'platform', 'steam',
      'player_id', 'atomic-player', 'data', jsonb_set(final_processed_data, '{fullResult,stats,playerId}', '"atomic-account"'::jsonb),
      'updated_at', now()
    ),
    'benchmark', jsonb_build_object(
      'match_id', 'atomic-recovery-success', 'platform', 'steam', 'player_id', 'atomic-player',
      'game_mode', 'squad-fpp', 'match_type', 'official', 'tier', 'B',
      'filter_version', 8, 'population_evidence_version', 1, 'source', 'user',
      'damage', 321, 'kills', 3, 'win_place', 4, 'map_name', 'Baltic_Main'
    )
  );

  first_result := public.finalize_telemetry_cache_recovery(
    'atomic-recovery-success', 'steam', 'atomic-account', 'lite', 61,
    'telemetry-map/v61/steam/atomic-recovery-success/atomic-account.json', lease_token,
    jsonb_build_object(
      'matchId', 'atomic-recovery-success', 'playerId', 'atomic-player',
      'platform', 'steam', 'resultVersion', 72, 'accountId', 'atomic-account'
    ),
    jsonb_build_object(
      'id', 9201, 'matchId', 'atomic-recovery-success', 'playerId', 'atomic-player',
      'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official',
      'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null
    ),
    rows_payload
  );
  if first_result->>'code' <> 'finalized' then
    raise exception 'FAIL: atomic recovery finalization 실패 (%)', first_result;
  end if;
  if (select data #>> '{fullResult,v}' from public.processed_match_telemetry
      where match_id = 'atomic-recovery-success' and platform = 'steam' and player_id = 'atomic-player') <> '73'
     or not exists (select 1 from public.match_master_telemetry where match_id = 'atomic-recovery-success')
     or (select population_evidence_version from public.global_benchmarks where id = 9201) <> 1
     or (select status from public.telemetry_map_cache_entries where match_id = 'atomic-recovery-success') <> 'ready'
     or (select cache.lease_token
           from public.telemetry_map_cache_entries as cache
          where cache.match_id = 'atomic-recovery-success') is not null then
    raise exception 'FAIL: atomic finalization 중 일부 row가 갱신되지 않음';
  end if;

  retry_result := public.finalize_telemetry_cache_recovery(
    'atomic-recovery-success', 'steam', 'atomic-account', 'lite', 61,
    'telemetry-map/v61/steam/atomic-recovery-success/atomic-account.json', lease_token,
    jsonb_build_object(
      'matchId', 'atomic-recovery-success', 'playerId', 'atomic-player',
      'platform', 'steam', 'resultVersion', 72, 'accountId', 'atomic-account'
    ),
    jsonb_build_object(
      'id', 9201, 'matchId', 'atomic-recovery-success', 'playerId', 'atomic-player',
      'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official',
      'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null
    ),
    rows_payload
  );
  if retry_result->>'code' <> 'already_finalized' then
    raise exception 'FAIL: 동일 finalization 재시도가 already_finalized가 아님 (%)', retry_result;
  end if;
  raise notice 'PASS: atomic recovery success + all-row transition + idempotent retry';
end $$;

\echo '--- 시나리오 16b: already_finalized requires the exact requested payload ---'
do $$
declare
  result jsonb;
  variant jsonb;
  variants jsonb[];
  rows_payload jsonb;
  final_updated_at timestamptz;
  final_data jsonb;
  base_guard jsonb := jsonb_build_object(
    'matchId', 'atomic-recovery-success', 'playerId', 'atomic-player',
    'platform', 'steam', 'resultVersion', 72, 'accountId', 'atomic-account'
  );
begin
  set local role service_role;
  select data, updated_at into final_data, final_updated_at
    from public.processed_match_telemetry
   where match_id = 'atomic-recovery-success' and platform = 'steam' and player_id = 'atomic-player';
  rows_payload := jsonb_build_object(
    'master', jsonb_build_object(
      'match_id', 'atomic-recovery-success', 'map_name', 'Baltic_Main', 'game_mode', 'squad-fpp',
      'telemetry_version', 61, 'storage_path', 'telemetry-map/v61/steam/atomic-recovery-success/atomic-account.json'
    ),
    'processed', jsonb_build_object(
      'match_id', 'atomic-recovery-success', 'platform', 'steam', 'player_id', 'atomic-player',
      'data', final_data, 'updated_at', final_updated_at
    ),
    'benchmark', jsonb_build_object(
      'match_id', 'atomic-recovery-success', 'platform', 'steam', 'player_id', 'atomic-player',
      'damage', 321, 'kills', 3, 'win_place', 4, 'game_mode', 'squad-fpp', 'map_name', 'Baltic_Main',
      'match_type', 'official', 'tier', 'B', 'filter_version', 8,
      'population_evidence_version', 1, 'source', 'user'
    )
  );
  variants := array[
    jsonb_set(rows_payload, '{benchmark,damage}', '322'::jsonb),
    jsonb_set(rows_payload, '{benchmark,tier}', '"A"'::jsonb),
    jsonb_set(rows_payload, '{benchmark,game_mode}', '"solo-fpp"'::jsonb),
    jsonb_set(rows_payload, '{benchmark,match_type}', '"competitive"'::jsonb),
    jsonb_set(rows_payload, '{master,map_name}', '"Erangel_Main"'::jsonb),
    jsonb_set(rows_payload, '{processed,data,fullResult,reconciliationProbe}', 'true'::jsonb),
    jsonb_set(rows_payload, '{processed,updated_at}', to_jsonb(final_updated_at + interval '1 second'))
  ];
  for variant in select unnest(variants) loop
    begin
      result := public.finalize_telemetry_cache_recovery(
        'atomic-recovery-success', 'steam', 'atomic-account', 'lite', 61,
        'telemetry-map/v61/steam/atomic-recovery-success/atomic-account.json',
        '11111111-1111-4111-8111-111111111111', base_guard,
        jsonb_build_object(
          'id', 9201, 'matchId', 'atomic-recovery-success', 'playerId', 'atomic-player',
          'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official', 'tier', 'B',
          'filterVersion', null, 'populationEvidenceVersion', null
        ), variant
      );
      if result->>'code' = 'already_finalized' then
        raise exception 'FAIL: payload mismatch returned already_finalized (%)', variant;
      end if;
    exception when sqlstate '22023' then
      null;
    end;
  end loop;
  raise notice 'PASS: already_finalized exact master/processed/benchmark/timestamp reconciliation';
end $$;

\echo '--- 시나리오 17: stale benchmark/processed guards mutate no rows ---'
delete from public.telemetry_map_cache_entries where match_id like 'atomic-recovery-stale-%';
delete from public.processed_match_telemetry where match_id like 'atomic-recovery-stale-%';
delete from public.global_benchmarks where match_id like 'atomic-recovery-stale-%';
delete from public.match_master_telemetry where match_id like 'atomic-recovery-stale-%';

do $$
declare
  benchmark_result jsonb;
  processed_result jsonb;
  processed_data jsonb := jsonb_build_object(
    'fullResult', jsonb_build_object(
      'v', 72, 'matchId', 'atomic-recovery-stale-benchmark',
      'player_id', 'atomic-player', 'platform', 'steam',
      'stats', jsonb_build_object('name', 'AtomicPlayer', 'playerId', 'atomic-account')
    )
  );
  rows_payload jsonb;
  base_guard jsonb := jsonb_build_object(
    'matchId', 'atomic-recovery-stale-benchmark', 'playerId', 'atomic-player',
    'platform', 'steam', 'resultVersion', 72, 'accountId', 'atomic-account'
  );
begin
  set local role service_role;
  insert into public.processed_match_telemetry (match_id, platform, player_id, data)
  values ('atomic-recovery-stale-benchmark', 'steam', 'atomic-player', processed_data);
  insert into public.global_benchmarks (
    id, match_id, platform, player_id, game_mode, match_type, tier,
    filter_version, population_evidence_version
  ) values (
    9202, 'atomic-recovery-stale-benchmark', 'steam', 'atomic-player',
    'squad-fpp', 'official', 'B', null, null
  );
  perform public.claim_telemetry_cache_recovery_write(
    'atomic-recovery-stale-benchmark', 'steam', 'atomic-account', 'lite', 61,
    'telemetry-map/v61/steam/atomic-recovery-stale-benchmark/atomic-account.json',
    now() + interval '10 minutes', '22222222-2222-4222-8222-222222222222', now()
  );
  -- A concurrent writer advances only the legacy marker after the claim.
  update public.global_benchmarks set filter_version = 8 where id = 9202;
  rows_payload := jsonb_build_object(
    'master', jsonb_build_object(
      'match_id', 'atomic-recovery-stale-benchmark', 'map_name', 'Baltic_Main',
      'game_mode', 'squad-fpp', 'telemetry_version', 61,
      'storage_path', 'telemetry-map/v61/steam/atomic-recovery-stale-benchmark/atomic-account.json'
    ),
    'processed', jsonb_build_object(
      'match_id', 'atomic-recovery-stale-benchmark', 'platform', 'steam',
      'player_id', 'atomic-player', 'data', jsonb_set(jsonb_set(processed_data, '{fullResult,populationEvidenceVersion}', '1'::jsonb), '{fullResult,v}', '73'::jsonb), 'updated_at', now()
    ),
    'benchmark', jsonb_build_object(
      'match_id', 'atomic-recovery-stale-benchmark', 'platform', 'steam', 'player_id', 'atomic-player',
      'game_mode', 'squad-fpp', 'map_name', 'Baltic_Main', 'match_type', 'official', 'tier', 'B',
      'filter_version', 8, 'population_evidence_version', 1, 'source', 'user'
    )
  );
  benchmark_result := public.finalize_telemetry_cache_recovery(
    'atomic-recovery-stale-benchmark', 'steam', 'atomic-account', 'lite', 61,
    'telemetry-map/v61/steam/atomic-recovery-stale-benchmark/atomic-account.json',
    '22222222-2222-4222-8222-222222222222', base_guard,
    jsonb_build_object(
      'id', 9202, 'matchId', 'atomic-recovery-stale-benchmark', 'playerId', 'atomic-player',
      'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official',
      'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null
    ), rows_payload
  );
  if benchmark_result->>'code' <> 'benchmark_guard_mismatch'
     or (select data #>> '{fullResult,v}' from public.processed_match_telemetry where match_id = 'atomic-recovery-stale-benchmark') <> '72'
     or exists (select 1 from public.match_master_telemetry where match_id = 'atomic-recovery-stale-benchmark')
     or (select status from public.telemetry_map_cache_entries where match_id = 'atomic-recovery-stale-benchmark') <> 'pending' then
    raise exception 'FAIL: stale benchmark worker가 row를 변경함 (%)', benchmark_result;
  end if;

  insert into public.processed_match_telemetry (match_id, platform, player_id, data)
  values ('atomic-recovery-stale-processed', 'steam', 'atomic-player', jsonb_set(processed_data, '{fullResult,matchId}', '"atomic-recovery-stale-processed"'::jsonb));
  insert into public.global_benchmarks (
    id, match_id, platform, player_id, game_mode, match_type, tier,
    filter_version, population_evidence_version
  ) values (
    9203, 'atomic-recovery-stale-processed', 'steam', 'atomic-player',
    'squad-fpp', 'official', 'B', null, null
  );
  perform public.claim_telemetry_cache_recovery_write(
    'atomic-recovery-stale-processed', 'steam', 'atomic-account', 'lite', 61,
    'telemetry-map/v61/steam/atomic-recovery-stale-processed/atomic-account.json',
    now() + interval '10 minutes', '33333333-3333-4333-8333-333333333333', now()
  );
  update public.processed_match_telemetry
    set data = jsonb_set(data, '{fullResult,v}', '73'::jsonb)
    where match_id = 'atomic-recovery-stale-processed';
  processed_result := public.finalize_telemetry_cache_recovery(
    'atomic-recovery-stale-processed', 'steam', 'atomic-account', 'lite', 61,
    'telemetry-map/v61/steam/atomic-recovery-stale-processed/atomic-account.json',
    '33333333-3333-4333-8333-333333333333',
    jsonb_build_object(
      'matchId', 'atomic-recovery-stale-processed', 'playerId', 'atomic-player',
      'platform', 'steam', 'resultVersion', 72, 'accountId', 'atomic-account'
    ),
    jsonb_build_object(
      'id', 9203, 'matchId', 'atomic-recovery-stale-processed', 'playerId', 'atomic-player',
      'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official',
      'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null
    ),
    jsonb_build_object(
      'master', jsonb_build_object(
        'match_id', 'atomic-recovery-stale-processed', 'map_name', 'Baltic_Main',
        'game_mode', 'squad-fpp', 'telemetry_version', 61,
        'storage_path', 'telemetry-map/v61/steam/atomic-recovery-stale-processed/atomic-account.json'
      ),
      'processed', jsonb_build_object(
        'match_id', 'atomic-recovery-stale-processed', 'platform', 'steam',
        'player_id', 'atomic-player', 'data', jsonb_set(jsonb_set(jsonb_set(processed_data, '{fullResult,matchId}', '"atomic-recovery-stale-processed"'::jsonb), '{fullResult,populationEvidenceVersion}', '1'::jsonb), '{fullResult,v}', '73'::jsonb), 'updated_at', now()
      ),
      'benchmark', jsonb_build_object(
        'match_id', 'atomic-recovery-stale-processed', 'platform', 'steam', 'player_id', 'atomic-player',
        'game_mode', 'squad-fpp', 'map_name', 'Baltic_Main', 'match_type', 'official', 'tier', 'B',
        'filter_version', 8, 'population_evidence_version', 1, 'source', 'user'
      )
    )
  );
  if processed_result->>'code' <> 'processed_guard_mismatch'
     or (select population_evidence_version from public.global_benchmarks where id = 9203) is not null
     or exists (select 1 from public.match_master_telemetry where match_id = 'atomic-recovery-stale-processed')
     or (select status from public.telemetry_map_cache_entries where match_id = 'atomic-recovery-stale-processed') <> 'pending' then
    raise exception 'FAIL: stale processed worker가 row를 변경함 (%)', processed_result;
  end if;
  raise notice 'PASS: stale benchmark/processed guard zero-mutation';
end $$;

\echo '--- 시나리오 17b: NULL/unknown payloads are rejected without mutation ---'
do $$
declare
  result jsonb;
  base_rows jsonb := jsonb_build_object(
    'master', jsonb_build_object(
      'match_id', 'atomic-recovery-null', 'map_name', 'Baltic_Main', 'game_mode', 'squad-fpp',
      'telemetry_version', 61, 'storage_path', 'telemetry-map/v61/steam/atomic-recovery-null/account.json'
    ),
    'processed', jsonb_build_object(
      'match_id', 'atomic-recovery-null', 'platform', 'steam', 'player_id', 'atomic-player',
      'data', jsonb_build_object('fullResult', jsonb_build_object(
        'v', 73, 'matchId', 'atomic-recovery-null', 'player_id', 'atomic-player', 'platform', 'steam',
        'populationEvidenceVersion', 1, 'stats', jsonb_build_object('playerId', 'atomic-account')
      )), 'updated_at', now()
    ),
    'benchmark', jsonb_build_object(
      'match_id', 'atomic-recovery-null', 'platform', 'steam', 'player_id', 'atomic-player',
      'game_mode', 'squad-fpp', 'match_type', 'official', 'tier', 'B', 'filter_version', 8,
      'population_evidence_version', 1, 'source', 'user'
    )
  );
  base_guard jsonb := jsonb_build_object(
    'matchId', 'atomic-recovery-null', 'playerId', 'atomic-player', 'platform', 'steam',
    'resultVersion', 72, 'accountId', 'atomic-account'
  );
begin
  set local role service_role;
  insert into public.processed_match_telemetry(match_id, platform, player_id, data)
  values ('atomic-recovery-null', 'steam', 'atomic-player', jsonb_build_object('fullResult', jsonb_build_object(
    'v', 72, 'matchId', 'atomic-recovery-null', 'player_id', 'atomic-player', 'platform', 'steam',
    'stats', jsonb_build_object('playerId', 'atomic-account')
  )));
  insert into public.global_benchmarks(id, match_id, platform, player_id, game_mode, match_type, tier, filter_version, population_evidence_version)
  values (9291, 'atomic-recovery-null', 'steam', 'atomic-player', 'squad-fpp', 'official', 'B', null, null);
  perform public.claim_telemetry_cache_recovery_write(
    'atomic-recovery-null', 'steam', 'atomic-account', 'lite', 61,
    'telemetry-map/v61/steam/atomic-recovery-null/account.json', now() + interval '10 minutes',
    '99999999-9999-4999-8999-999999999991', now()
  );
  begin
    result := public.finalize_telemetry_cache_recovery(
      'atomic-recovery-null', 'steam', 'atomic-account', 'lite', 61,
      'telemetry-map/v61/steam/atomic-recovery-null/account.json', '99999999-9999-4999-8999-999999999991',
      jsonb_set(base_guard, '{accountId}', 'null'::jsonb),
      jsonb_build_object('id', 9291, 'matchId', 'atomic-recovery-null', 'playerId', 'atomic-player', 'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official', 'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null),
      base_rows
    );
    raise exception 'FAIL: NULL processed guard accepted (%)', result;
  exception when sqlstate '22023' then null;
  end;
  if (select data #>> '{fullResult,v}' from public.processed_match_telemetry where match_id = 'atomic-recovery-null') <> '72'
     or (select status from public.telemetry_map_cache_entries where match_id = 'atomic-recovery-null') <> 'pending'
     or exists(select 1 from public.match_master_telemetry where match_id = 'atomic-recovery-null') then
    raise exception 'FAIL: NULL guard mutated rows';
  end if;
  begin
    result := public.finalize_telemetry_cache_recovery(
      'atomic-recovery-null', 'steam', 'atomic-account', 'lite', 61,
      'telemetry-map/v61/steam/atomic-recovery-null/account.json', '99999999-9999-4999-8999-999999999991',
      base_guard,
      jsonb_build_object('id', 9291, 'matchId', 'atomic-recovery-null', 'playerId', 'atomic-player', 'platform', 'steam', 'gameMode', null, 'matchType', 'official', 'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null),
      base_rows
    );
    raise exception 'FAIL: NULL benchmark bucket accepted (%)', result;
  exception when sqlstate '22023' then null;
  end;
  begin
    result := public.finalize_telemetry_cache_recovery(
      'atomic-recovery-null', 'steam', 'atomic-account', 'lite', 61,
      'telemetry-map/v61/steam/atomic-recovery-null/account.json', '99999999-9999-4999-8999-999999999991',
      base_guard,
      jsonb_build_object('id', 9291, 'matchId', 'atomic-recovery-null', 'playerId', 'atomic-player', 'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official', 'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null),
      jsonb_set(base_rows, '{master,map_name}', 'null'::jsonb)
    );
    raise exception 'FAIL: NULL master field accepted (%)', result;
  exception when sqlstate '22023' then null;
  end;
  begin
    result := public.finalize_telemetry_cache_recovery(
      'atomic-recovery-null', 'steam', 'atomic-account', 'lite', 61,
      'telemetry-map/v61/steam/atomic-recovery-null/account.json', '99999999-9999-4999-8999-999999999991',
      base_guard,
      jsonb_build_object('id', 9291, 'matchId', 'atomic-recovery-null', 'playerId', 'atomic-player', 'platform', 'steam', 'gameMode', 'squad-fpp', 'matchType', 'official', 'tier', 'B', 'filterVersion', null, 'populationEvidenceVersion', null),
      jsonb_set(base_rows, '{benchmark,unexpected}', 'true'::jsonb)
    );
    raise exception 'FAIL: unknown nested key accepted (%)', result;
  exception when sqlstate '22023' then null;
  end;
  raise notice 'PASS: NULL and unknown nested payloads rejected without mutation';
end $$;

\echo '--- 시나리오 18: recovery finalizer ACL·SECURITY INVOKER ---'
do $$
declare
  signature constant text := 'public.finalize_telemetry_cache_recovery(text,text,text,text,numeric,text,uuid,jsonb,jsonb,jsonb)';
  public_exec boolean;
begin
  if not has_function_privilege('service_role', signature, 'EXECUTE') then
    raise exception 'FAIL: service_role finalizer EXECUTE 권한 누락';
  end if;
  if has_function_privilege('anon', signature, 'EXECUTE') then
    raise exception 'FAIL: anon finalizer EXECUTE 권한 잔존';
  end if;
  if has_function_privilege('authenticated', signature, 'EXECUTE') then
    raise exception 'FAIL: authenticated finalizer EXECUTE 권한 잔존';
  end if;
  select exists (
    select 1
    from aclexplode(p.proacl) acl
    where p.oid = signature::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ) into public_exec
  from pg_proc p
  where p.oid = signature::regprocedure;
  if coalesce(public_exec, false) then
    raise exception 'FAIL: PUBLIC finalizer EXECUTE 권한 잔존';
  end if;
  if exists (
    select 1 from pg_proc p
    where p.oid = signature::regprocedure and p.prosecdef
  ) then
    raise exception 'FAIL: finalizer가 SECURITY DEFINER임';
  end if;
  raise notice 'PASS: finalizer ACL 4-way + SECURITY INVOKER';
end $$;

\echo '=== 전체 시나리오 통과 ==='
