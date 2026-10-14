-- 매치 유형 보정은 match_type='unknown' 행을 최신순으로 찾는다. 대상이 거의 없어
-- 기존 인덱스로는 134만 행 인덱스를 끝까지 훑다가 시간 초과된다(운영 실측 20초).
-- 대상 행만 담는 부분 인덱스로 바로 찾는다. 운영 쓰기를 막지 않도록 CONCURRENTLY 로 만든다.
create index concurrently if not exists pubg_player_matches_unknown_type_idx
  on public.pubg_player_matches (played_at desc)
  where match_type = 'unknown';
