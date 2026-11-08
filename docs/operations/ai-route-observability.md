# AI 요약 관측성·생성 차단 스위치 운영 메모

이 문서는 최근 전적 AI 요약(`/api/pubg/ai-summary`)과 단일 경기 코칭(`/api/pubg/ai-analyze`)의 계측 로그, 생성 차단 스위치, 검증 사유 id를 설명한다. 계약의 원문은 `lib/pubg-analysis/aiRouteTiming.ts`와 `lib/pubg-analysis/aiGenerationSwitch.ts` 상단 주석이다.

## 1. 단계별 계측 로그 (`kind: "ai-route-timing"`)

요약 요청이 결과를 기록할 때 `console.info`로 JSON 한 줄을 남긴다. 사용자 식별자, 닉네임, 프롬프트, 모델 원문은 넣지 않고 `requestId`만 쓴다.

| 필드 | 의미 |
| --- | --- |
| `route` | 이번 변경은 `summary`만 기록한다. 스쿼드 라우트의 같은 키 이름 계측은 별도 작업이다. |
| `outcome` | 최종 결과 코드. 아래 표 참고 |
| `stages.auth`, `privateGuard`, `processedLookup`, `benchmark`, `promptBuild`, `geminiFirstPart`, `geminiTotal`, `total` | 단계 소요 시간(ms) |
| `stages.canonicalFallback` | `{ ms, calls, ok }`. canonical 보충 호출 수, 성공 수, 총 시간 |
| `stages.cacheLookup` | `{ ms, result }`. `result`는 `hit`, `miss`, `skipped`(force) |
| `stages.persist` | `{ ms, status }`. `status`는 `ok`, `failed`, `skipped`(부분 완료) |
| `attempts` | 모델 시도 목록. `{ model, outcome, ms }` |
| `reasons` | 검증 사유 id 목록(쉼표 구분, 500자 상한) |
| `actionDrops` | 탈락한 행동 제안의 사유 id |

단계 키가 없으면 그 단계에 도달하지 않은 것이다. 예를 들어 캐시 적중이면 `geminiFirstPart`와 `persist`가 없다.

`attempts[].outcome` 값:

- `ok`: 첫 파트를 받았다. 스트림 중 실패하면 나중에 아래 값으로 바뀐다.
- `first_part_timeout`: 응답 시작 전 시간 초과(모델별 8초, 생성 예산 18초)
- `rate_limited`: 제공자 429
- `provider_error`: 그 밖의 제공자 오류
- `stream_deadline`: 첫 파트 뒤 스트림 도중 데드라인
- `truncated`: 요약에서 Gemini가 `finishReason=other`로 응답을 중간에 멈췄다. 다음 후보 모델로 한 번만 다시 생성한다.

`outcome` 값:

- `success`, `partial`(검증 일부 탈락), `cache_hit`, `cancelled`(클라이언트 취소)
- `generation_disabled`(차단 스위치), `validation`(검증 전체 실패)
- `first_part_timeout`: 첫 파트 전 실패. 모든 모델이 첫 파트 전에 끝났다.
- `stream_deadline`: 스트림 도중 데드라인(라우트 50초 또는 생성 예산 18초)
- `PUBG_AI_*` 코드: 그 밖의 실패. `PUBG_AI_ROUTE_TIMEOUT`은 생성 이전 단계(canonical 보충 등)의 라우트 데드라인일 수 있다.

### 조회 방법

Vercel 대시보드의 로그 화면에서 검색어 `ai-route-timing`으로 시작한다. 원인별로 좁히려면 `first_part_timeout`(첫 파트 전 실패), `stream_deadline`(스트림 도중 데드라인), `"status":"failed"`(캐시 저장 실패)를 함께 넣는다. 검색 문법은 화면 기능에 따르며, 이 문서는 특정 CLI 명령을 전제하지 않는다.

`error_message`에서도 두 경로를 구분할 수 있다. 첫 파트 전 실패는 `first_part: <모델>=<결과>,...`, 스트림 도중 데드라인은 `stream_deadline: <모델>`로 남는다. `error_code`는 기존과 같이 `PUBG_AI_ROUTE_TIMEOUT`이다.

요약 재생성은 결과 한 줄로 남는다. 성공하면 `model_name`은 다시 생성한 모델이고 `error_message`는 `retried_after_truncation: <끊긴 모델>`이며, 토큰은 두 모델의 합이다(비용은 다시 생성한 모델 단가로 추정). 재생성도 실패하면 오류 문구 끝에 `retriedFrom=<끊긴 모델>`이 붙는다.

매치 분석(`ai-analyze`)도 모든 모델의 첫 응답 시간 초과, 라우트 데드라인, 스트림 도중 실패를 `ai_usage_logs`에 남긴다. 클라이언트가 먼저 끊은 요청은 남기지 않는다.

## 2. Gemini 생성 차단 스위치

환경 변수 `PUBG_AI_GENERATION_DISABLED=true`이면 새 Gemini 생성을 하지 않는다. 캐시 적중은 기존처럼 돌려준다.

- `ai-summary`(`summaryContractVersion: 2`): 사실 카드로 응답한다. 기록은 `visuals`, `cards`, `error`, `done`이며 `errorCode`는 `PUBG_AI_GENERATION_DISABLED`, `retryable`은 `false`다. 캐시에는 쓰지 않는다. 구형 계약(버전 없음)은 사실 카드가 없으므로 503 JSON을 반환한다.
- `ai-analyze`: 503과 `{ error, errorCode: "PUBG_AI_GENERATION_DISABLED", retryable: false }`를 반환한다.
- 요약 화면은 재시도 버튼 없이 "AI 해석은 잠시 중지되어 있어요." 안내를 보여 준다.

적용 절차: 값은 요청마다 `process.env`에서 읽는다. Vercel에서는 환경 변수를 바꾼 뒤 새 배포가 떠야 반영된다. 배포는 운영 승인을 받은 뒤 진행한다. 해제하려면 값을 `false`로 바꾸거나 비운다. `.env.example`에 키가 있다.

## 3. 검증 사유 id (`rejectReasons`)

카드 검증 결과의 `rejectReasons`는 기존 코드(`topic:prose`, `topic:conclusion`, `topic:mode`, `topic:evidence`, `top_level_*`, `all_neutral`, `all_unavailable` 등)를 그대로 유지한다. 상세 사유는 기존 코드 뒤에 덧붙는다. 예: `firepower:prose`와 `firepower:prose:spicy:empty`가 함께 들어간다. 수용과 거부 판정은 바뀌지 않는다.

상세 사유의 규칙 id:

- 추론 규칙(`inference:<id>`, `aiSummaryJudgment.ts`의 `UNSUPPORTED_INFERENCES` 순서): `damage_distribution_stable`, `focus_maintained`, `consistent_damage`, `firepower_support_efficiency`, `dealing_ability`, `steady_dealing_record`, `damage_accumulation`, `effective_damage_contribution`, `steady_engagement_record`, `calm_response`, `smoke_grenade_purpose`, `damage_distribution_prediction`, `damage_distribution_ability`, `damage_record_distribution`, `survival_team_contribution`, `stable_survival_operation`, `reaction_speed`, `calm_handling`, `engagement_participation`, `evenly_used`, `steady_dealing_proof`, `steady_combat_contribution`, `rescue_smoke_frequency`, `isolation_standard`, `stock_comparison`, `movement_focus_adjective`, `movement_focus_evaluation`, `mobility_style`, `initiative_control`, `initiative_angle`, `unmeasured_focus_improvement`, `unmeasured_shooting`
- 제안 규칙(`advice:<id>`, `ADVICE_RULES`): `solo_engagement`, `engagement_frequency`, `rescue_smoke_frequency`, `smoke_rescue_link`, `survival_contribution`, `shooting_opportunity`, `crossfire_expansion`, `throw_usage`
- 결론 규칙(`conclusion:<id>`): `population_mismatch`(다른 판 수 인용), `isolation_contradiction`(고립 지수 높고 낮음이 실제 값과 반대), `isolation_unmeasured`(비교 없는 고립 지수 단정), `rescue_opportunity_missing`(구출 연막 근거 없음), `utility_usage_claim`(투척 목적·빈도 단정)
- 해석 필드 코드: `kind`(kindOpinion), `spicy`(spicyOpinion), `reason`, `evaluation`. 예: `positioning:conclusion:reason:conclusion:isolation_unmeasured`
- 행동 제안(`action_items:<사유>`): `shape`(형식 오류), `neutral`(중립 문장), `mode`(다른 모드 언급), `title_number`(제목에 숫자), `check_text`(점검 문장 없음), `weakness_premise`(보완점 없는 카드의 약점 전제), 그리고 정제 뒤 빈 문장일 때의 `inference:<id>`·`advice:<id>`·`empty`

`actionDrops`는 행동 제안이 빠진 이유만 기록하며, 결과 수용 여부에는 영향을 주지 않는다.

사유 문자열은 규칙 id만 담는다. 서버 로그에 문장 발췌는 넣지 않았다. `ai_usage_logs.error_message`는 `trackAiUsage`에서 240자로 잘리므로, 사유가 많으면 뒷부분이 잘릴 수 있다.

## 4. 역할 칭호의 선제 타격 보류

`lib/pubg-analysis/roleReference.ts`의 기준 분포는 계산 2·3에서 산출했다. 계산 5는 선제 타격 성공률의 의미를 바꿨고, 계산 5 사용자의 중앙값(75%)이 기준 중앙값(50%)과 크게 어긋났다. 그래서 칭호 판정 경기(최근 유효 경기 중 상위 5경기)에 계산 5가 하나라도 있으면 `initiative`를 `pendingReferenceMetrics`로 넘긴다.

- 반응 시간(`reactionSec`)은 기존처럼 항상 보류한다. 그래서 선봉 칭호는 선제 지표만으로 판정되지 않는다.
- 바뀌는 것은 관측 성향(`observations`)과 근거 줄에서 선제 타격 항목이 빠지는 것, 그리고 보류 수다. 칭호는 같다.
- 계산 5 표본이 500명 이상 쌓이면 계산 5 기준으로 분포를 다시 산출하고 `ROLE_REFERENCE_VERSION`을 올린 뒤 보류를 푼다.

요약 캐시 hash에는 `precomputedVisuals.roleInfo`(`verdict`와 `evidenceAmount` 제외)가 들어간다. 그래서 보류로 칭호 입력이 바뀌면 hash가 달라지고 기존 캐시는 자동으로 빗나간다. `AI_SUMMARY_CACHE_VERSION`은 올리지 않았다.

## 5. 검증

- 자동 테스트: `tests/ai-route-timing.test.ts`, `tests/ai-summary-reject-reasons.test.ts`, `tests/role-classifier-rules.test.ts`(`verify:analysis` 목록), `tests/ai-cache-routes.test.ts`의 "AI 생성 차단 스위치·계측 로그·선제 지표 보류" 블록
- 첫 파트 전 실패와 스트림 도중 데드라인의 `error_message` 접두는 라우트 수준 자동 테스트가 없다. 함수 수준 계측은 `describeAttempts`와 `settleLastAttempt` 단위 테스트로 확인한다.
