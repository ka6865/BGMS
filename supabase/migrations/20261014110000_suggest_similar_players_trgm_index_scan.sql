-- 닉네임 유사 추천(suggest_similar_players)이 trgm 인덱스를 사용하게 하고 서버 전용으로 닫는다.
--
-- 기존 함수는 similarity(lower_nickname, …) > 0.2 를 WHERE 에 써서 인덱스를 쓰지 못했다.
-- 운영 EXPLAIN 기준 pubg_player_cache 34만 행을 훑어 콜드 캐시에서 5.3초가 걸렸고,
-- anon 역할 statement_timeout(약 3초)에 걸려 PostgREST 500 이 발생했다.
--
-- - 기존 GIN 인덱스 pubg_player_cache_nickname_trgm_idx 를 쓰도록 nickname % search_name 으로 후보를 고른다.
--   pg_trgm 은 trigram 을 소문자로 만들므로 lower_nickname 과 결과가 같다. 새 인덱스는 만들지 않는다.
-- - 임계값 0.2 는 함수 설정(proconfig)으로 둔다. 본문에서 SET 하면 연결 풀의 다른 쿼리까지 바뀐다.
-- - 호출부(app/api/pubg/player)가 service role 로 바뀌므로 SECURITY INVOKER 로 바꾸고
--   anon·authenticated 실행 권한을 회수한다. 반환 컬럼 이름과 타입은 유지한다.
--
-- 배포 순서: 앱 배포 후 적용한다. 먼저 적용하면 이전 앱의 추천 호출은 빈 목록으로 처리된다.
-- 재실행해도 결과가 같다.

set lock_timeout = '3s';
set statement_timeout = '30s';

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
language sql
stable
security invoker
set search_path = public
set pg_trgm.similarity_threshold = '0.2'
as $$
  select
    c.nickname,
    c.platform,
    public.similarity(c.nickname, search_name)::real as sim
  from public.pubg_player_cache c
  where c.platform = search_platform
    and c.nickname operator(public.%) search_name
  order by sim desc
  limit greatest(least(coalesce(limit_val, 3), 10), 1);
$$;

revoke execute on function public.suggest_similar_players(text, text, integer) from public, anon, authenticated;
grant execute on function public.suggest_similar_players(text, text, integer) to service_role;

reset lock_timeout;
reset statement_timeout;
