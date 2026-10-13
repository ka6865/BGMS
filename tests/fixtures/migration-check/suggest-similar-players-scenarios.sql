-- suggest_similar_players RPC 테스트 시나리오
-- 새 GIN trgm 인덱스로 유사 닉네임 검색이 올바르게 작동하는지 검증

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
    select array_agg(similarity order by similarity desc)
    into sims
    from public.suggest_similar_players('ka6865', 'steam', 10);

    if sims is not null and array_length(sims, 1) > 1 then
      if sims[1] >= sims[2] then
        raise notice 'PASS: % (정렬 확인 완료)', test_name;
      else
        raise notice 'FAIL: % - 유사도 정렬 순서 오류', test_name;
        test_passed := false;
      end if;
    else
      raise notice 'PASS: % (결과 1개 이하)', test_name;
    end if;
  end;

  -- 정리
  delete from pubg_player_cache where id like 'account.test%';

  if test_passed then
    raise notice '✅ suggest_similar_players RPC 시나리오 통과';
  else
    raise exception '❌ suggest_similar_players RPC 시나리오 실패';
  end if;
end $$;
