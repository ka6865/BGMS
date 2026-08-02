-- /api/pubg/suggest 의 2글자 prefix 검색을 위한 B-tree pattern index.
--
-- 기존 nickname gin_trgm_ops는 3글자 미만 prefix에서 선택도가 낮고,
-- lower_nickname 일반 B-tree는 locale 때문에 LIKE 'q%' 범위 조건으로
-- 사용되지 않았다. text_pattern_ops와 covering column으로 정렬 없는
-- index-only prefix 조회를 가능하게 해 전체/대량 index scan을 막는다.
--
-- 운영 DB에는 write 차단을 피하기 위해 같은 정의를 CONCURRENTLY로 먼저
-- 확장 적용한다. 이 migration은 IF NOT EXISTS라 이후 이력 반영 시 no-op이다.

set lock_timeout = '5s';
set statement_timeout = '2min';

create index if not exists pubg_player_cache_lower_prefix_idx
  on public.pubg_player_cache (lower_nickname text_pattern_ops)
  include (nickname, platform, updated_at);

comment on index public.pubg_player_cache_lower_prefix_idx is
  '2글자 이상 lower_nickname prefix 자동완성용 covering index';
