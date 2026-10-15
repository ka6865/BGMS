-- suggest_similar_players RPC 테스트 시나리오
-- 기존 nickname trgm 인덱스 조건으로 유사 닉네임 검색 결과·권한·설정을 검증

do $$
declare
  test_name text;
  result_count integer;
  expected_count integer;
  best_similarity real;
  test_passed boolean := true;
begin
  set local search_path = public;

  -- 테스트 데이터: 유사 닉네임들
  insert into pubg_player_cache(
    id, nickname, lower_nickname, platform, updated_at, search_count
  ) values
    ('account.test1', 'ka6865', 'ka6865', 'steam', now(), 0),
    ('account.test2', 'Ka6865_Player', 'ka6865_player', 'steam', now(), 0),
    ('account.test3', 'ka686500', 'ka686500', 'steam', now(), 0),
    ('account.test4', 'ka686599', 'ka686599', 'steam', now(), 0),
    ('account.test5', 'totally_different', 'totally_different', 'steam', now(), 0),
    ('account.test6', 'ka6865', 'ka6865', 'kakao', now(), 0)
  on conflict do nothing;

  -- 시나리오 1: 정확한 일치 → 유사도 높은 결과만
  test_name := '시나리오 1: 정확한 일치';
  select count(*), max(similarity) into result_count, best_similarity
  from public.suggest_similar_players('ka6865', 'steam', 3);
  -- steam 플랫폼에서 'ka6865' 완일치: account.test1만 (account.test2는 'ka6865_player'로 다름)
  if result_count >= 1 and best_similarity >= 0.9 then
    raise notice 'PASS: % (결과 %개, 최고 유사도 %.2f)', test_name, result_count, best_similarity;
  else
    raise notice 'FAIL: % - 예상 1개 이상, 실제 %개 (최고 유사도 %.2f)', test_name, result_count, coalesce(best_similarity, 0);
    test_passed := false;
  end if;

  -- 시나리오 2: 부분 일치 → 0.2 threshold 이상만
  test_name := '시나리오 2: 임계값 검사';
  select count(*) into result_count
  from public.suggest_similar_players('ka68', 'steam', 10);
  if result_count < 2 then
    raise notice 'FAIL: % - 최소 2개 예상, 실제 %개', test_name, result_count;
    test_passed := false;
  else
    raise notice 'PASS: % (결과 %개)', test_name, result_count;
  end if;

  -- 시나리오 3: 플랫폼 필터링
  test_name := '시나리오 3: 플랫폼 필터링';
  select count(*) into result_count
  from public.suggest_similar_players('ka6865', 'kakao', 3);
  expected_count := 1;
  if result_count != expected_count then
    raise notice 'FAIL: % - 예상 %개, 실제 %개 (kakao 플랫폼)', test_name, expected_count, result_count;
    test_passed := false;
  else
    raise notice 'PASS: %', test_name;
  end if;

  -- 시나리오 4: limit_val 존중
  test_name := '시나리오 4: limit_val 존중';
  select count(*) into result_count
  from public.suggest_similar_players('ka68', 'steam', 1);
  if result_count > 1 then
    raise notice 'FAIL: % - limit_val=1이지만 %개 반환', test_name, result_count;
    test_passed := false;
  else
    raise notice 'PASS: %', test_name;
  end if;

  -- 시나리오 5: 비유사 검색 → 빈 결과
  test_name := '시나리오 5: 비유사 검색';
  select count(*) into result_count
  from public.suggest_similar_players('xyz123', 'steam', 3);
  expected_count := 0;
  if result_count != expected_count then
    raise notice 'FAIL: % - 예상 %개, 실제 %개', test_name, expected_count, result_count;
    test_passed := false;
  else
    raise notice 'PASS: %', test_name;
  end if;

  -- 시나리오 6: 유사도 정렬 (가장 유사한 것이 먼저)
  test_name := '시나리오 6: 유사도 내림차순 정렬';
  declare
    sims real[];
  begin
    select array_agg(similarity order by ordinality)
    into sims
    from public.suggest_similar_players('ka6865', 'steam', 10) with ordinality;

    if coalesce(array_length(sims, 1), 0) < 2 then
      raise notice 'FAIL: % - 정렬 검증에 최소 2개 결과 필요', test_name;
      test_passed := false;
    elsif exists (
      select from generate_subscripts(sims, 1) as s(i)
      where sims[i] is null or (i > 1 and sims[i - 1] < sims[i])
    ) then
      raise notice 'FAIL: % - 유사도 정렬 순서 오류', test_name;
      test_passed := false;
    else
      raise notice 'PASS: % (모든 인접 결과 정렬 확인)', test_name;
    end if;
  end;

  -- 시나리오 7: 0.3 이상이 limit 개 미만이면 0.2 이상까지 넓혀 같은 결과를 낸다
  test_name := '시나리오 7: 0.2 임계값 대체 검색';
  insert into pubg_player_cache(id, nickname, lower_nickname, platform, updated_at, search_count)
  values ('account.test7', 'abcdefgh', 'abcdefgh', 'steam', now(), 0)
  on conflict do nothing;
  if public.similarity('abcdefgh', 'abcdxyzw') not between 0.2 and 0.3 then
    raise exception '시나리오 7 데이터의 유사도가 0.2~0.3 사이가 아니다: %', public.similarity('abcdefgh', 'abcdxyzw');
  end if;
  select count(*), max(similarity) into result_count, best_similarity
  from public.suggest_similar_players('abcdxyzw', 'steam', 3);
  if result_count = 1 and best_similarity = public.similarity('abcdefgh', 'abcdxyzw') then
    raise notice 'PASS: % (유사도 %)', test_name, best_similarity;
  else
    raise notice 'FAIL: % - 0.2~0.3 사이 1개 예상, 실제 %개', test_name, result_count;
    test_passed := false;
  end if;

  -- 정리
  delete from pubg_player_cache where id like 'account.test%';

  if test_passed then
    raise notice 'PASS: suggest_similar_players RPC 시나리오';
  else
    raise exception 'suggest_similar_players RPC 시나리오 실패';
  end if;
end $$;

-- 권한과 함수 설정: 서버 전용, invoker, 임계값은 함수 설정으로만 적용
do $$
declare
  before_threshold text;
begin
  if has_function_privilege('anon','public.suggest_similar_players(text,text,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.suggest_similar_players(text,text,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.suggest_similar_players(text,text,integer)','EXECUTE') then
    raise exception 'suggest_similar_players must be executable by service_role only';
  end if;
  if exists(select from pg_proc where oid='public.suggest_similar_players(text,text,integer)'::regprocedure and prosecdef) then
    raise exception 'suggest_similar_players must be SECURITY INVOKER';
  end if;
  if not exists(
    select from pg_proc
    where oid='public.suggest_similar_players(text,text,integer)'::regprocedure
      and array_position(proconfig, 'search_path=public') is not null
      and array_position(proconfig, 'pg_trgm.similarity_threshold=0.3') is not null
  ) then
    raise exception 'suggest_similar_players must pin search_path and similarity threshold in its config';
  end if;

  -- 함수 호출 뒤 세션 임계값이 바뀌면 연결 풀의 다른 쿼리에 영향을 준다.
  -- 함수 설정(0.3)·대체 검색(0.2)과 다른 값으로 두어 어느 쪽이 새어도 드러나게 한다.
  perform set_config('pg_trgm.similarity_threshold', '0.5', false);
  before_threshold := current_setting('pg_trgm.similarity_threshold');
  perform count(*) from public.suggest_similar_players('ka6865','steam',3);
  perform count(*) from public.suggest_similar_players('abcdxyzw','steam',3);
  if current_setting('pg_trgm.similarity_threshold') <> before_threshold then
    raise exception 'suggest_similar_players must not change the session similarity threshold';
  end if;
  raise notice 'PASS: suggest_similar_players 권한·설정';
end;
$$;
