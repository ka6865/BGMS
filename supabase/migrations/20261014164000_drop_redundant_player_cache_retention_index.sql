-- pubg_player_cache_compaction_candidates_idx 가 같은 조건(search_count=0, season_stats_data null)과
-- 같은 선두 열(updated_at)에 id·last_seen_at 까지 담아 기존 인덱스를 대체한다.
-- 기존 인덱스가 남아 있으면 플래너가 본문을 읽는 계획을 골라 정리 대상 수 계산이 3초 넘게 걸렸다.
drop index concurrently if exists public.pubg_player_cache_retention_idx;
