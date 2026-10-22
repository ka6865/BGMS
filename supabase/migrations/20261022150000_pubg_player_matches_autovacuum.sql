-- pubg_player_matches(170만 행)는 자동 VACUUM 이 한 번도 돌지 않았다(2026-10-22 측정: autovacuum_count 0,
-- 페이지의 35.6% 가 all-visible 이 아니고 죽은 행 3.5만). 기본 기준(행의 20%, 약 34만 행)에 닿기 전에는 돌지 않는다.
-- 가시성 지도가 낡으면 인덱스만으로 답할 쿼리도 본문을 다시 읽어, 보존 후보 조회(list_retention_archive_candidates)가
-- 캐시가 식은 첫 호출에서 8초 제한을 넘는다. 수동 VACUUM 후 같은 쿼리가 10.3초에서 1.0초로 줄었다(heap fetch 25,482 에서 0).
-- 기준을 낮춰 가시성 지도가 계속 최신으로 유지되게 한다. 설정 변경은 읽기·쓰기를 막지 않는다.
alter table public.pubg_player_matches set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01
);
