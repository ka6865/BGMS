---
name: bgms-pubg-analysis
description: Use when working on BGMS match analysis, telemetry and replay cache identity, AI coaching quality or cache compatibility, squad scenes, tier scores, benchmark evidence, and stats request stability.
---

# BGMS PUBG Analysis Skill

## 언제 사용하나

- `/api/pubg/*`, `lib/pubg-analysis/*`, `components/stat/*` 수정
- AI 전적 분석, AI 요약, AI 스쿼드 코칭, 원인 장면 리포트 수정
- `processed_match_telemetry`, `match_stats_raw`, `global_benchmarks`, AI 캐시 테이블 수정
- 티어 산식, tactical score, benchmark fallback 수정

## 먼저 읽을 파일

- `docs-private/.project_context.md`
- `docs-private/.pubg-telemetry-guide.md`
- `docs-private/telemetry_data_classification.md`
- `docs-private/tier_score_rules.md`
- `docs/tactical_score_guide.md`
- 관련 route/component/lib/test 파일

`docs-private/`는 로컬 문서다. 없는 작업 폴더에서는 관련 구현·테스트와 저장소의 `docs/`를 기준으로 확인하고 누락을 보고한다. 요청 주제에 필요한 문서만 읽는다.

## AI 캐시 작업 시 우선 읽을 파일

- `lib/pubg-analysis/constants.ts`
- `lib/pubg-analysis/cacheIdentity.ts`
- `app/api/pubg/ai-analyze/route.ts`
- `app/api/pubg/ai-summary/route.ts`
- `app/api/pubg/ai-squad/route.ts`
- `scripts/cleanup_ai_cache.ts`
- `tests/ai-cache-routes.test.ts`
- `supabase/migrations/20260611000000_ai_cache_stabilization.sql`
- `supabase/migrations/20260611121020_stabilize_pubg_analysis_identity.sql`

AI 캐시 요청에서는 위 파일을 먼저 확인하고 실제 호출부가 필요할 때 범위를 넓힌다.

`prompt_version`은 route별 실제 구성과 함께 확인한다. 단일 경기 코칭은 `AI_MATCH_PROMPT_VERSION`(`AI_CACHE_VERSION`에 단일 경기 프롬프트 접미사를 붙인 값)에 canonical 분석 행의 `calculationVersion`(상수가 아님)을 결합하고, 최근 요약과 스쿼드는 각각 `AI_SUMMARY_CACHE_VERSION`, `AI_SQUAD_CACHE_VERSION`을 사용한다. 엔진 결과·텔레메트리·계산·AI 프롬프트·모집단 근거 버전을 하나의 버전으로 취급하지 않는다.

기존 AI 캐시가 있어도 현재 canonical 분석과 모집단 근거 검증을 우회하지 않게 확인한다. `force`의 캐시 우회 범위도 각 route에서 확인한다.

## 텔레메트리·리플레이 캐시 작업

- 우선 `lib/pubg-analysis/telemetryIdentity.ts`, `telemetryCacheKey.server.ts`, `telemetryPayload.ts`, `telemetryContract.ts`, `telemetryMapCache.ts`, `telemetryRegistry.server.ts`를 읽는다. 클라이언트 흐름은 `hooks/useTelemetry.ts`와 관련 소비자로 확장한다.
- 분석 DB identity는 `match_id + platform + player_id`이고, 리플레이 캐시는 `matchId + platform + playerId + mode + telemetryVersion`을 구분한다. 공개 identity는 원본 계정 ID 대신 `playerKey`를 사용한다.
- 기존 R2 객체의 존재만으로 cache hit을 인정하지 않는다. 요청 identity, payload 계약, registry 상태와 호환 버전을 확인한다.
- 일반 쓰기 lease/claim과 recovery claim/finalize를 구분한다. 대상 점유·토큰·원자적 finalize·응답 유실 후 상태 확인·활성 lease 정리 보호를 유지한다. 임의 unlock이나 삭제로 경합을 해소하지 않는다.
- 복구 변경은 관련 `supabase/migrations/20260902171741_telemetry_cache_recovery_claim.sql`, `20260904005531_telemetry_cache_recovery_finalize.sql`, `20260904130000_telemetry_cache_recovery_safety.sql`과 해당 테스트를 확인한다. 운영 적용은 Supabase 스킬의 환경·승인 기준을 따른다.

## benchmark 신뢰 조건

- `lib/pubg-analysis/benchmarkLookup.ts`의 filter 버전·모집단 근거·계산 버전·최소 표본 계약을 확인한다. 상수의 과거 값을 문서에서 복사하지 않는다.
- exact 티어의 유효 표본이 부족하면 같은 티어군의 유효 관측치를 사용한다. 근거가 없는 경우 비교값을 만들어 채우지 않는다.
- `benchmarkScore.ts`, `benchmarkRecoveryPlanner.ts`, `benchmarkRecoverySnapshot.ts`와 변경한 reader를 함께 확인한다. recovery 계획과 운영 쓰기 실행을 구분한다.

## 전적 분석 리포트 방향성 요청

전적 분석 리포트 고도화 방향성을 요청받았을 때만 `references/report-direction.md`(이 스킬 폴더 기준)의 우선 파일 목록과 답변 구조를 읽는다.

## 핵심 원칙

- `processed_match_telemetry` identity는 `match_id + platform + player_id` 기준이다.
- AI 캐시는 `platform`, 정규화된 `player_id`, `prompt_version`을 키에 포함한다.
- 개인 지표와 스쿼드 지표를 섞지 않는다.
- `itemUseSummary`, `itemUseStats`, `global_benchmarks` 개인 행동 카운트는 분석 대상 플레이어 기준이다.
- 스쿼드 복구 지표는 가능한 경우 `timeline`에서 팀 단위로 재산출한다.
- AI가 측정 불가한 의도, 심리, 소통, 엄폐, 안전성, 교전 각을 단정하지 않게 프롬프트와 후처리를 확인한다.

## 작업 루프

1. 요청이 단일 매치, 최근 요약, 스쿼드, 원인 장면, 티어 중 어디인지 분류한다.
2. 저장소별 identity와 버전, 현재 canonical 분석·모집단 근거 조건을 확인한다.
3. 캐시 hit, force 재분석, fallback 경로를 같이 검토한다.
4. UI 문구가 사용자가 이해할 수 있는 단위인지 확인한다.
5. 변경한 계약을 검증하는 기존 테스트를 실행하고, 동작 변경에 필요한 경우 추가하거나 갱신한다.

## 추천 검증

```bash
npm run verify:analysis
npm run verify:core
```

세부 변경별 테스트는 아래를 우선 연결한다.
- 단일 매치/점수: `tests/analysis-engine.test.ts`, `tests/pubg-analysis-stability.test.ts`
- AI 캐시/요약/스쿼드 캐시: `tests/ai-cache-routes.test.ts`
- 원인 장면/스쿼드 복구: `tests/squad-cause-scenes.test.ts`, `tests/squad-recovery-stats.test.ts`
- 리플레이 identity/계약/캐시: `tests/telemetry-identity.test.ts`, `tests/telemetry-contract.test.ts`, `tests/telemetry-map-cache.test.ts`, `tests/telemetry-replay-request.test.ts`
- 복구·계산 쓰기 경합: `tests/recovery-release-blockers.test.ts`, `tests/calculation-upgrade-write-lock.test.ts`, `tests/benchmark-recovery-canary.test.ts`
- benchmark 신뢰·복구 계획: `tests/global-benchmark-reader-contract.test.ts`, `tests/benchmark-recovery-planner.test.ts`
- 계산·개인 근거: `tests/telemetry-calculation-audit.test.ts`, `tests/personal-telemetry-evidence.test.ts`
- AI 판정·리포트 검사: `tests/ai-coaching-judgment.test.ts`, `tests/ai-coaching-report-check.test.ts`
- 전적 요청·화면 상태: `tests/stats-page-model.test.ts`, `tests/stats-page-controller.test.ts`, `tests/stats-sync-failure-ui.test.ts` 및 frontend QA의 브라우저 하네스

`verify:analysis`는 위 추가 테스트 전체를 포함하지 않는다. 변경별 파일을 `npx vitest run <테스트 파일>`로 실행하고 넓은 코드 영향은 `npm run test:unit`으로 확인한다.

AI 리포트가 생성돼 있으면 `npm run test:ai:report`로 기본 케이스·원문 품질·정량 감사 결과를 확인한다. 실제 데이터 보고서는 `test:ai:report:real`을 사용한다. 두 명령은 보고서 검사이며 Gemini 실행을 대신하지 않는다. 실제 Gemini 검증은 호출 비용·전송 대상을 요청 범위와 대조하고, 실제 유저 데이터를 전송하는 `test:ai:real-data`는 기존 사용자 허가와 `--allow-external-ai` 조건을 확인한다. 캐시 결과·후처리 결과만으로 원문 품질 통과를 주장하지 않는다.

## 문서화

- 계산식이나 저장 키가 바뀌면 `docs-private/.project_context.md`에 반영한다.
- 텔레메트리 원본 필드 의미가 바뀐 경우에만 `docs-private/.pubg-telemetry-guide.md`, `docs-private/telemetry_data_classification.md`를 갱신한다.
- 사용자 설명 문구가 바뀌면 `docs/tactical_score_guide.md`와 개발용 `docs-private/tier_score_rules.md`의 역할을 섞지 않는다.
