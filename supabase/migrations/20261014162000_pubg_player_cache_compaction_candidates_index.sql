-- compact_pubg_player_cache 의 정리 대상 수 계산이 19만 행의 테이블 본문을 읽었다(운영 실측 4.2초).
-- 조건에 쓰는 열을 모두 인덱스에 담아 본문을 읽지 않고 셀 수 있게 한다.
create index concurrently if not exists pubg_player_cache_compaction_candidates_idx
  on public.pubg_player_cache (updated_at, id) include (last_seen_at)
  where search_count = 0 and season_stats_data is null;
