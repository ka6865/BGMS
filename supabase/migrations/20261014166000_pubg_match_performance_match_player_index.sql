-- recover_retention_legacy_team 은 6개 테이블을 잠근 뒤 1초 안에 확인을 끝내야 한다.
-- pubg_match_performance 를 match_id·platform·player_id 로 찾는 확인에 맞는 인덱스가 없어
-- 기본키(platform 선두)로 해당 플랫폼 전체를 훑었다(운영 실측 0.61초). 잠금 예산 초과의 주원인이다.
create index concurrently if not exists pubg_match_performance_match_player_idx
  on public.pubg_match_performance (match_id, platform, player_id);
