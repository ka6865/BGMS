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

\echo '=== 전체 시나리오 통과 ==='
