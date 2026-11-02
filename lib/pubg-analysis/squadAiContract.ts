// 스쿼드 AI 코칭의 서버·클라이언트 공용 계약 상수. 서버 전용 로직은 넣지 않는다.

// AI 해석을 만들 최소 경기 수(분석에 쓰이는 matchCount 기준). 미만이면 모델을 호출하지 않는다.
export const SQUAD_AI_MIN_MATCH_COUNT = 3;

// 경기 수 부족으로 AI 해석을 만들지 않은 응답의 errorCode(HTTP 409, 재시도 불가).
export const SQUAD_AI_TOO_FEW_MATCHES_ERROR_CODE = "PUBG_SQUAD_TOO_FEW_MATCHES";

// AI 해석 없이 계산된 팀 지표만 돌려준 응답의 errorCode(HTTP 200, mode "facts_only").
export const SQUAD_AI_FACTS_ONLY_ERROR_CODE = "PUBG_AI_SQUAD_FACTS_ONLY";
