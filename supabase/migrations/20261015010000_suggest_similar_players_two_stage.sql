-- 닉네임 유사 추천(suggest_similar_players)의 콜드 캐시 지연을 줄인다.
--
-- 운영 EXPLAIN(2026-10-15): 임계값 0.2 에서 GIN 후보가 1,040개, 본 테이블 블록 976개를 디스크에서 읽어
-- 1.1초가 걸렸다. 대부분이 후보 행 재확인을 위한 본 테이블 읽기였다.
-- 같은 검색어에서 임계값 0.3 의 후보는 314개, 읽은 블록은 306개였다(pubgking77 은 560 → 275).
--
-- - 먼저 임계값 0.3 으로 찾고, 결과가 limit 개 미만일 때만 0.2 로 다시 찾는다.
--   유사도 0.3 이상인 행은 항상 0.3 미만인 행보다 앞서므로, 1단계에서 limit 개를 채우면
--   임계값 0.2 로 찾은 상위 limit 개와 같은 결과다(같은 유사도끼리의 순서는 기존처럼 정하지 않는다).
-- - GiST 거리순(KNN) 검색도 시험했지만 인덱스 대부분을 읽어(약 2,500페이지) 콜드 캐시에서 이득이 없었다.
-- - 함수 설정의 임계값은 0.3 이다. 2단계의 set_config(..., true) 는 함수 SET 범위 안에서만 적용되고
--   함수가 끝나면 이전 값으로 돌아오므로 연결 풀의 다른 쿼리에 영향을 주지 않는다.
-- - 반환 컬럼, SECURITY INVOKER, service role 전용 실행 권한은 유지한다.
--
-- 운영 migration 역할은 슈퍼유저가 아니므로 pg_trgm 라이브러리를 먼저 로드한다(20261014130000 참고).
-- 앱 변경 없이 적용할 수 있다. 재실행해도 결과가 같다.

set lock_timeout = '3s';
set statement_timeout = '30s';

select public.similarity('', '');

create or replace function public.suggest_similar_players(
  search_name text,
  search_platform text,
  limit_val integer default 3
)
returns table (
  nickname text,
  platform text,
  similarity real
)
language plpgsql
stable
security invoker
set search_path = public
set pg_trgm.similarity_threshold = '0.3'
as $$
#variable_conflict use_column
declare
  result_limit integer := greatest(least(coalesce(limit_val, 3), 10), 1);
  first_names text[];
  first_platforms text[];
  first_sims real[];
begin
  select
    array_agg(r.nickname order by r.sim desc),
    array_agg(r.platform order by r.sim desc),
    array_agg(r.sim order by r.sim desc)
  into first_names, first_platforms, first_sims
  from (
    select c.nickname, c.platform, public.similarity(c.nickname, search_name)::real as sim
    from public.pubg_player_cache c
    where c.platform = search_platform
      and c.nickname operator(public.%) search_name
    order by sim desc
    limit result_limit
  ) r;

  if coalesce(cardinality(first_sims), 0) >= result_limit then
    return query
      select u.nickname, u.platform, u.sim
      from unnest(first_names, first_platforms, first_sims) with ordinality as u(nickname, platform, sim, ord)
      order by u.ord;
    return;
  end if;

  perform set_config('pg_trgm.similarity_threshold', '0.2', true);

  return query
    select c.nickname, c.platform, public.similarity(c.nickname, search_name)::real as sim
    from public.pubg_player_cache c
    where c.platform = search_platform
      and c.nickname operator(public.%) search_name
    order by sim desc
    limit result_limit;
end;
$$;

revoke execute on function public.suggest_similar_players(text, text, integer) from public, anon, authenticated;
grant execute on function public.suggest_similar_players(text, text, integer) to service_role;

reset lock_timeout;
reset statement_timeout;
