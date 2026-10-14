-- compact_pubg_player_cache 는 최근 15만 행의 경계를 updated_at desc nulls last, id desc 순서로 찾는다.
-- 맞는 인덱스가 없어 34만 행 전체를 디스크 정렬했다(운영 실측 3.6초). 같은 순서의 인덱스로 바로 찾는다.
create index concurrently if not exists pubg_player_cache_keep_recent_idx
  on public.pubg_player_cache (updated_at desc nulls last, id desc);
