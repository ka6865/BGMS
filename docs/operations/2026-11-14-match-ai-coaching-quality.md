# 단일 경기 AI 코칭 품질 개선 — 2026-11-14

## 목적

단일 경기 AI 코칭(`/api/pubg/ai-analyze`)이 화면에 있는 숫자를 문장으로 다시 읽는 데 그쳤다. 장면 시점과 이유, 다음 판에 바로 쓸 행동 하나, BGMS 기록 백분위를 근거 정책 안에서 말하게 한다.

## 바뀐 점

- 프롬프트에 `[경기 흐름]`을 넣는다(`buildMatchAiFlowLines`). 분석 결과의 `matchReport`에서 착지, 교전(먼저 쏜 쪽·결과·준/받은 피해·쓰러진 수)과 그 시간대의 장면 ID, 사망 유형·팀원 거리, 2페이즈부터의 원 밖 거리를 측정값 그대로 적는다. 상대 닉네임은 넣지 않는다. 장면 ID 규칙(`TYPE-ts`)은 그대로라 화면·앱의 장면 찾기와 리플레이 이동은 바뀌지 않는다.
- `briefFeedback`은 '근거(장면 또는 수치) → 이번 경기에서의 이유'로 쓰고, 흐름 기록이 있으면 최소 2개가 교전·사망을 경과 시각과 함께 가리킨다. `actionItems`는 정확히 1개이며 `desc`는 '어떤 상황이 오면 → 무엇을 한다'.
- 매운맛은 반말·게임 밈 말투로 바꿨다(실제 경기 4개로 직설 존댓말안과 비교 후 사용자 선택). 서버가 붙이는 단일 경기 한마디(`spicyPunchlines.ts`의 `MATCH_JABS`·`MATCH_HYPES`)도 반말로 맞췄다. 최근 요약 한마디는 존댓말 그대로다.
- 프롬프트의 `Elite Avg` 표기를 `비슷한 성적 경기 평균`으로 바꿨다. 단일 경기 비교는 순위 퍼센트로 고른 점수 구간(`benchmark.tier`) 행의 평균이라 엘리트 평균이 아니다. 조회 로직은 바꾸지 않았다.

## BGMS 기록 백분위

- RPC `get_pubg_benchmark_percentiles(match_id, platform, player_id)`(migration `20261114120000`)가 이 경기의 `global_benchmarks` 행이 있을 때만 같은 `game_mode`·`match_type`, 최근 90일, `filter_version 8`·`population_evidence_version 1`·계산 버전이 있는 행과 비교한다. 행이 없으면(생존 5분 미만·봇·사용자 정의 등) 빈 결과다.
- 저장된 `tier`는 그 경기 점수 구간이라 쓰지 않는다. 같은 구간 안의 순위는 점수와 순환한다(점검 시 딜량 669가 스쿼드 일반전 전체 상위 12%, A 구간 안 상위 36%).
- 지표는 공식 피해량(`damage`, 유효 딜량과 다름)·킬·생존 시간만 쓴다. 판마다 표본이 몇 건인 비율 지표는 동점이 많아 쓰지 않는다.
- 서버(`toMatchAiPercentiles`)는 동점을 포함한 `at_or_above`/`at_or_below`로 상위·하위를 올림 계산하고, 표본 200경기 미만이거나 어느 쪽도 50% 이내가 아니면 뺀다.
- 응답 JSON에 서버 값 `benchmarkPercentiles`(`metric`, `label`, `direction`, `percent`, `sampleCount`, `scope`)를 넣는다. 문장의 '상위/하위 N%'가 이 값과 다르면 그 문장을 지운다(`applyMatchAiPercentiles`). 캐시 응답은 저장된 필드로 다시 검증한다.
- 조회 실패는 경고만 남기고 백분위 없이 코칭을 만든다.

## 근거 정책 추가

- `applyMatchAiClockPolicy`: 응답의 `m:ss` 시각이 장면 목록·경기 흐름에 없으면 조사까지 지운다. 문장에 섞인 장면 ID도 지운다.
- 적용 순서: 근거 정책 → 백분위 → 시각 → 장면 ID 검증 → 매운맛 한마디. 정책이 바꾼 문장의 장면 ID는 기존처럼 버린다.

## 계약과 캐시

- 앱이 그리는 `coach`, `signature`, `signatureSub`, `briefFeedback`, `finalVerdict`, `actionItems(icon,title,desc)`는 그대로다. 추가 필드는 `benchmarkPercentiles`뿐이며 `actionItems`는 항상 1개다.
- `AI_MATCH_PROMPT_VERSION`: `${AI_CACHE_VERSION}.scene-refs-v1` → `${AI_CACHE_VERSION}.scene-flow-pct-v2`. 기존 캐시는 다음 조회 때 새로 생성된다. 모델 순서는 그대로다.

## 운영 적용

migration `20261114120000_pubg_benchmark_percentiles.sql`을 배포 전에 운영에 적용한다. 미적용 상태로 배포하면 RPC 오류로 백분위만 빠지고 코칭은 계속 생성된다.

## 남은 한계

- 할 일에 '엄폐물로 이동' 같은 일반 조언이 섞일 수 있다. 일반 조언으로 허용하기로 했고(프롬프트로 막아도 flash-lite가 4경기 중 2경기에서 썼다), 장면 설명에서 엄폐를 단정하는 것만 금지한다.
- 근거 정책이 바꿔 넣는 문장은 존댓말이라 매운맛 반말 응답에 섞인다. 다음 작업으로 미뤘다.
- 최근 경기 요약·스쿼드는 이번 변경에 포함하지 않았다.
