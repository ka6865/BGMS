# 전적 지표·칭호 1차 수정 설계

작성일: 2026-10-28. 상태: 1차 제품 구현·로컬 통합 브라우저·독립 검토 완료. 운영 적용은 별도 작업이다.

## 목적과 범위

사용자가 전적 지표를 먼저 발사한 비율이나 사람의 반사신경으로 오해하지 않게 하고, 칭호의 필수 근거와 캐시 기준을 일치시킨다.

- 명칭: **선제 타격 성공률**, **반격 소요 시간**.
- 실제 선제 발사 비율은 개발하지 않는다.
- 1차는 기존 PR #378을 보완한다. 새 점수 산식, 역할 분포(CDF) 재학습, 운영 DB 재분석·배포는 포함하지 않는다.
- 기준: 하위 워크트리 `fix-first-reply-evidence`, 커밋 `efd82fbf`. #377과 #378은 현재 미병합이다. #377을 선행 병합했다고 가정하지 않는다.
- 이번 설계의 파일 배치·기존 PR 재사용은 작업자의 제안이다.

## 접근 방식

1. **단계적으로 수정(추천)**: 기존 보호 기능을 유지하면서 표현·남은 raw reader·캐시 연결을 보완한다. 선봉은 검증된 새 분포가 마련될 때까지 보류한다. 빠르게 오해를 줄일 수 있지만 전체 칭호 분포 문제는 2차로 남는다.
2. 전체 역할 기준을 한 번에 교체: 모든 분포를 다시 산출하고 같은 배포에서 반영한다. 일관성은 좋지만 현재 확보한 원본에 보관 편향이 있고 최근 경기 수가 부족해 1차 범위를 크게 넘는다.

대화에서 정한 1차/2차 순서를 따른다.

## 측정·표현 계약

- 선제 타격 성공률 = 먼저 피해를 준 교전 중 승리·아군 마무리 지원 등 기존 성공 조건을 충족한 비율. 전체 교전의 선제 발사 비율이 아니다. 분자·분모·점수는 바꾸지 않는다.
- 반격 소요 시간 = 상대에게 먼저 피해를 받은 뒤 해당 상대에게 처음 피해를 주기까지의 시간. 기존 `firstReplyLatencyMs(result)`의 적격 관측만 표시한다.
- 툴팁: “상대에게 피해를 받은 뒤, 해당 상대에게 처음 피해를 주기까지 걸린 시간입니다. 피격 전 연속 발사가 관측됐거나 발사 기록이 불확실한 교전은 제외합니다. 조준·탄속 등의 영향도 포함되며 반사신경을 직접 측정한 값은 아닙니다.”
- 적격 교전에서 3초 안에 명중이 없으면 시간은 측정 불가다. 3초 패널티를 실측 시간으로 노출하지 않는다.
- 측정 불가를 0초·실패·느린 반응으로 대체하지 않는다. AI에 “반격 표본 없음 → 선제공격 중심”과 같은 원인 추정도 전달하지 않는다.
- raw 점수 산정용 지연과 적격 코칭 관측은 별도다. 점수 설명에는 현재 raw 산식이라는 점을 명시하고 적격 시간으로 산식을 바꿨다고 설명하지 않는다.

## 연결 지점

- 최근 요약: 카드·툴팁, 카드 근거 label, AI prompt, debate 지표 별칭을 함께 변경한다. 이전 label은 호환 별칭으로만 읽는다.
- 단판: `MatchPerformancePanel`의 구 `tradeStats.reactionLatencyMs` 표시를 적격 helper로 전환한다. `types/stat.ts`의 duelStats 관측 타입을 연결한다. 만료/보존 데이터는 실제 evidence가 유지된 경우만 표시하고 누락은 null로 처리한다.
- 유저 비교: `counter_latency_ms` raw를 새 이름으로 재포장하지 않는다. 기존 migration의 `eligible_first_reply_latency_ms`만 비교에 사용한다. 응답 metric key는 기존 호환을 유지하고 null이면 비교 불가다. 무관한 전투 지표는 유지한다.
- 전술 지표 사전과 사용자 가이드도 같은 정의로 고친다. 아군 백업·트레이드 시간은 별도 지표이므로 일괄 치환하지 않는다.

## 칭호와 캐시

- #378의 pointMan 두 필수 지표 관측 조건을 유지한다. 현재 요약의 구 reaction 분포 보류를 해제하지 않는다. 다른 역할의 배점·CDF·선택 임계값은 바꾸지 않는다.
- 근거 문구의 “먼저 쏜다”, “첫 총성”, “착지 직후 주도”, “진입조”는 현재 지표가 입증하는 결과 표현으로 바꾼다. 판타지 칭호 자체를 일괄 제거하지 않는다.
- 반응값 없는 선봉 primary·secondary·조합 칭호가 생기지 않아야 한다.
- 현재 분포의 `ROLE_REFERENCE_VERSION=1`은 그대로 유지한다. 재산출하지 않은 분포를 새 버전이라고 표시하지 않는다.
- `buildSummaryCacheHash`에서 `ROLE_REFERENCE_VERSION`을 명시적으로 hash에 포함한다. 지표와 칭호 결과가 우연히 같아도 기준 버전이 달라지면 새 hash여야 한다.
- 단판 prompt 변경은 AI_CACHE_VERSION v6, 요약은 AI_SUMMARY_CACHE_VERSION v25로 구분한다. 기존 날짜 prefix는 구현일 기준으로 확인한다. AI_SQUAD_CACHE_VERSION의 기존 파생 구조를 유지한다. RESULT/계산/텔레메트리 버전은 그대로다.

## 검증과 운영 조건

- 기존 197개 전적 진단 결과는 회귀 자료다. 전체 PUBG 모집단이나 새 운영 분포로 사용하지 않는다.
- 단위·분석·공통 검증 및 fixture 브라우저로 375x667, 390x844, 430x932, 1440x900을 검사한다.
- DB 열을 읽는 배포는 기존 `20261028140000_first_reply_evidence` migration 적용이 선행돼야 한다. 이번 준비에서 운영 DB/R2 쓰기·삭제는 하지 않는다.
- child에 docs-private가 없으므로 추적 문서·실제 코드·루트의 관련 로컬 문서를 참조했다.
- 성공 기준: 합의한 명칭과 정의가 화면/AI에서 일치하고, 적격 근거 없는 시간·선봉 칭호가 나오지 않으며, 기준 버전 변경이 캐시를 확실히 분리한다.

## 호출 경로 대조와 아직 남은 검증

2026-10-28 추가 검색 기준이다. 정적 경로 확인과 실제 경로별 실행 검증은 구분한다. 필드명 검색은 의미가 같은 모든 계산을 증명하는 수단은 아니다.

| 경로 | 확인한 구현 | 처리·검증 범위 |
|---|---|---|
| 원본 이벤트→교전·시간 생성 | CombatHandler, firstReply, AnalysisEngine | 197개 전적 재계산은 기존 근거. 1차는 계산 변경 없이 유지 |
| 점수 | benchmarkScore, AnalysisEngine의 raw counterLatency 전달 | 적격 표시값과 구 점수 입력을 분리. 점수 불변 회귀 필요 |
| canonical/benchmark 저장 | persistMatchAnalysis, 기존 firstReply migration | raw와 eligible 열 분리 확인. DB 쓰기/RPC·view는 실제 적용 별도 |
| benchmark 조회 | benchmarkLookup, adaptObservedBenchmark | 지표별 관측 수와 계산 버전 확인. raw 평균으로 적격 평균 대체 금지 |
| 단판·요약·만료 전적 | match route, matchSummary, retainedPerformance, MatchPerformancePanel | 보존 whitelist에 새 evidence가 빠짐. 타입·보존·표시 회귀 필요 |
| 유저 비교 | battle route | raw counter_latency_ms 직접 조회 확인. eligible 전환 후 null·단위·비교 불가 검사 필요 |
| AI 생성·근거·표시 | ai-analyze, ai-summary, matchAiCoachingPrompt, matchAiEvidence, aiSummaryCardEvidence, aiSummaryDebate, aiSummaryCards, RecentAISummary | prompt·근거·별칭·후처리·표시를 함께 대조. 프롬프트 문자열만 수정해서 완료 처리하지 않음 |
| 칭호 | extractRoleMetrics→referencePercentile→roleScorePercentile→classifyRole→ai-summary | 생산 코드의 classifyRole 호출은 ai-summary 한 곳. primary·secondary·조합·보조 점수까지 null 전파 검사 필요 |
| 캐시 | ai-summary의 buildSummaryCacheHash와 조회/저장, cacheIdentity/constants | 기준 버전만 바뀌는 회귀 및 기존 캐시 미사용 검사 필요 |
| 과거 계산·복구 | calculation4StoredUpgrade, benchmarkRecoveryPlanner/Snapshot, match route recovery, legacyTeamRetentionRecovery | 정적 존재·필드 대조 단계. 잠금/CAS·승급·복구가 새 열을 덮거나 raw에서 근거를 만들지 않는지 별도 검사 전에는 검증 완료로 표시하지 않음 |
| 감사·회귀 도구 | audit_telemetry_calculations, audit_pubg_ai_accuracy 및 관련 tests | 구 점수 감사와 적격 시간 감사를 구분. 과거 버전 기대치를 무조건 새 이름으로 치환하지 않음 |

스쿼드의 아군 백업·복수 시간은 개인 반격과 별도다. ai-squad/squadAiCoachingPrompt의 해당 비교를 개인 반격으로 바꾸지 않는다. 저장 복구의 보호 조건이 변경돼야 한다면 단순 문구 수정에 섞지 않고 해당 테스트·문서 범위를 다시 명시한다.
