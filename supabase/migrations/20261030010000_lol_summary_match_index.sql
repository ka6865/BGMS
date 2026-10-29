begin;
set local lock_timeout = '2s';

-- 공개 경기 상세는 원문(7일)이 정리된 뒤에도 저장된 경기 요약에 있는 경기면 Riot에서 다시 받는다.
-- 요약 테이블은 계정 기준 색인만 있어 경기 ID로 찾을 수 있게 색인을 더한다.
create index if not exists lol_player_summaries_match on public.lol_player_match_summaries (match_id, platform_id);

commit;
