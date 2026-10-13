-- suggest_similar_players RPC 성능 최적화: lower_nickname GIN trgm 인덱스 추가
--
-- 문제: 운영에서 suggest_similar_players() 콜드 캐시 시 5.3초로 timeout 발생
-- - 현재 쿼리: similarity(lower_nickname, lower(search_name))는 인덱스 미사용
-- - lower_nickname btree prefix 인덱스가 full scan (171k행 제거)
--
-- 해결:
-- 1. lower_nickname GIN trgm 인덱스 추가 → % 연산자로 인덱스 활용
-- 2. 함수 내 pg_trgm.similarity_threshold 명시 설정
-- 3. similarity() 함수 대신 % 연산자 사용 (인덱스 지원)
--
-- 기대 효과: 약 2-3초 단축 (운영 동시 생성 후 warm cache 1.0초대로 안정화)
--
-- 운영 DB에는 CONCURRENTLY로 별도 적용한다. 이 migration은 IF NOT EXISTS라
-- 이후 이력 반영 시 no-op이다.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- lower_nickname GIN trgm 인덱스: suggest_similar_players의 유사 검색 가속화
create index if not exists pubg_player_cache_lower_nickname_trgm_idx
  on public.pubg_player_cache using gin (lower_nickname public.gin_trgm_ops);

comment on index public.pubg_player_cache_lower_nickname_trgm_idx is
  '닉네임 유사도 검색(%) 가속화용 GIN trgm 인덱스';

-- suggest_similar_players 함수 개선:
-- - % 연산자로 인덱스 활용 + similarity() 함수로 정확한 정렬
-- - pg_trgm.similarity_threshold 명시 (threshold 0.2 유지)
-- - search_path 고정 (운영 Supabase 표준)
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
security definer
set search_path = public
as $$
begin
  set pg_trgm.similarity_threshold = 0.2;

  return query
  select
    c.nickname,
    c.platform,
    similarity(c.lower_nickname, lower(search_name))::real as sim
  from pubg_player_cache c
  where
    c.platform = search_platform
    and c.lower_nickname % lower(search_name)
  order by sim desc
  limit limit_val;
end;
$$;

-- 권한 유지: anon, authenticated, service_role 모두 실행 가능
grant execute on function public.suggest_similar_players(text, text, integer)
  to anon, authenticated, service_role;
