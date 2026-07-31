-- 닉네임 자동완성 쿼리의 전체 테스트 스캔 제거
--
-- 배경: /api/pubg/suggest 가 nickname ILIKE 'q%' 로 전방 일치 검색을 하지만
-- 해당 컬럼에 인덱스가 없어 42만 행을 순차 스캔했다. 운영 실측에서
-- Parallel Seq Scan 으로 2,179ms 가 소요되어 간헐적으로 500 이 반환되었다.
-- 매칭 행이 많은 접두사(kang 은 150건)에서 정렬 비용까지 더해져 재현된다.
--
-- lower_nickname 에는 복합 인덱스가 있으나 (lower_nickname, platform) 순서이고
-- 라우트는 nickname 을 ILIKE 로 조회하므로 사용되지 않는다.
--
-- 대응: pg_trgm 이 이미 설치되어 있으므로 GIN 인덱스로 ILIKE 전방 일치를 지원한다.
-- 정렬 키인 updated_at 에도 인덱스를 두어 top-N 정렬 비용을 낮춘다.

-- ILIKE 전방 일치를 인덱스로 처리한다. 대소문자 무관 검색이므로 trgm 을 사용한다.
CREATE INDEX IF NOT EXISTS pubg_player_cache_nickname_trgm_idx
  ON public.pubg_player_cache USING gin (nickname gin_trgm_ops);

-- 자동완성은 최근 갱신 순으로 정렬하므로 정렬 전용 인덱스를 함께 둔다.
CREATE INDEX IF NOT EXISTS pubg_player_cache_updated_at_idx
  ON public.pubg_player_cache (updated_at DESC);
