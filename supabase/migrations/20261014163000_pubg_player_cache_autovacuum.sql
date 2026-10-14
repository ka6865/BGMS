-- pubg_player_cache 는 2026-08-30 이후 자동 VACUUM 이 돌지 않았다(죽은 행 3.9만 < 기본 기준 6.9만).
-- 가시성 지도가 낡아 인덱스만으로 답할 쿼리도 본문을 다시 읽어 정리 RPC 가 8초 제한을 넘긴다.
-- 기준을 행의 5%로 낮춰 자동 VACUUM 이 제때 돌게 한다. 설정 변경은 읽기·쓰기를 막지 않는다.
alter table public.pubg_player_cache set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
