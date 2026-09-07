# 스쿼드 범위 분리 및 계산 버전 배포 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these steps inline. 사용자는 기존 배포 전 필수 작업의 실행을 승인했다. 작업별 검증 후 진행하며 운영 데이터 이행을 코드 완료와 혼동하지 않는다.

**Goal:** 요청자의 개인 지표를 팀 전체 값으로 쓰지 않고, 계산 버전이 다른 결과·비교 표본·캐시가 섞이지 않는 배포를 준비한다.

**Architecture:** 원본을 순회하는 기존 AnalysisEngine에 요청자와 무관한 팀 관측 수집기를 연결한다. 스쿼드 응답은 그 관측 계약만 사용하며 개인 benchmark를 조회하지 않는다. 계산 버전 이행은 저장·조회·복구 계약을 함께 바꾸고 제한된 원본 재계산으로 연결한다.

**Tech Stack:** TypeScript, Next.js, Vitest, Supabase PostgreSQL, R2, Gemini.

**Spec:** docs/plans/2026-09-07-real-telemetry-gemini-audit.md의 배포 전 필수 작업.

## Global Constraints

- RESULT_VERSION=73과 v72→v73 조건부 복구 RPC는 별도 migration 검증 없이 변경하지 않는다.
- 개인/팀 scope, 경기 identity, 관측 불가와 관측된 0을 구분한다.
- 구형 개인 지표를 팀 집계의 fallback으로 쓰지 않는다.
- 같은 경기 원본을 추가 다운로드하지 않는다. 운영 전체 재계산/전체 Gemini 재생성은 하지 않는다.
- 집중사격 calibration=pending, 미측정 종합 등급 보류를 유지한다.

## 1. 팀 관측과 소비 경계 (이번 구현)

Files: lib/pubg-analysis/squadObservations.ts, AnalysisEngine.ts, types.ts, squadAnalysis.ts, squadAiCoachingPrompt.ts, constants.ts; tests/squad-observations.test.ts, final-release-blockers-squad.test.ts, telemetry-gemini-real.integration.test.ts.

- [x] `SquadObservationCollector(teamAccountIds, mode)`를 만들고 기존 원본 순회에서 `observe(event, ts)`를 호출한다.
- [x] `result()`는 version=1, scope=squad, 정렬된 teamAccountIds, status/issues, 팀 기절/소생/연막구출/복수 및 복수 시간 합계·건수를 반환한다. 원본 시작/끝/필수 ID가 없으면 missing.
- [x] 팀 기절은 피해자 생명별 중복 제거, 소생은 해당 기절 이후 같은 피해자만 인정. 연막은 기절 후15초/소생 전/투척자-기절 위치100m 이내, 소생30초 조건이며 실제 연막 효과를 주장하지 않는다.
- [x] 복수는 아군을 기절시킨 동일 적을 다른 아군이30초 미만에 처치한 경우, 피해자 생명별1회. 소생/사망/재배치 생명주기와 중복 Kill/KillV2를 검증한다.
- [x] `aggregateSquadObservations`는 경기별 중복 제거와 동일 팀/버전 검증 후 시간 합계÷관측 수, 전체 소생/기절 분자·분모를 반환한다. 하나라도 결측이면 부분 합을 전체 수치처럼 노출하지 않는다.
- [x] `squadAnalysis` 개인 isolation/trade/revive/wipe/cover fallback을 제거한다. 팀 고립도/전멸/엄호와 검증되지 않은 팀 benchmark/점수는 null. 개인 역할 통계는 유지한다.
- [x] 실제2경기×4명 raw/full/cache 관측 동일성 및 조회자 독립성을 확인한다. 과거 결과와 혼합할 때 보류하는 회귀를 추가한다.
- [x] 전체 테스트, core, build, 실제 Gemini 부분 코칭을 확인한다.

## 2. 계산 버전 저장·조회 이행 (별도 migration 단위)

변경 대상: lib/pubg-analysis/persistMatchAnalysis.ts, cacheIdentity.ts, benchmarkLookup.ts, benchmarkAdapter.ts; app/api/pubg/match/route.ts, ai-analyze/route.ts, ai-summary/route.ts; supabase/migrations의 global_benchmarks/benchmark_stats_by_tier 정의 및 복구 함수.

- `global_benchmarks.calculation_version`은 기존행에 현버전을 붙이지 않고 NULL로 남긴다. 신규 writer가 canonical fullResult.calculationVersion을 저장한다.
- aggregate의 GROUP BY와 유일성에 calculation_version을 포함한다. 조회도 같은 계산 버전을 필수 조건으로 사용한다. 개인/팀 모집단은 별도 scope이며 이번 팀 benchmark는 미구축으로 보류한다.
- processed 결과를 재사용할 때 계산 버전을 검사한다. 기본 전적은 표시할 수 있어도 오래된 전술 지표를 현재 AI/요약 계산에 섞지 않는다.
- 결과/프롬프트 identity에 계산 버전을 포함하고, 신구 혼합 요약은 유효 표본 수와 제외 이유를 표시한다.
- 공개 지도 캐시 v61의 읽기/쓰기/registry/정리 경로를 함께 새 버전으로 전환한다. map만 일괄 삭제하는 방식은 쓰지 않는다.
- 로컬 migration 검증: 이전 DB 스냅샷에서 열·집계 생성, 기존 NULL 유지, 서로 다른 버전의 같은 mode/tier 분리, v72→v73 복구 경합 테스트.

## 3. 제한 재계산과 배포 판정

변경 대상: scripts/audit_telemetry_calculations.ts 및 제한 이행 스크립트, docs/plans의 실행 기록.

- 먼저 dry-run으로 명시된 platform/nickname/matchId 후보와 현재 버전, 원본 보유, 예상 처리 건수를 출력한다.
- 기존 원본이 있는 명시된 경기만 한 번에 하나씩 재계산하고, 기존 행의 버전/identity를 WHERE 조건으로 다시 확인해 동시 갱신을 덮어쓰지 않는다.
- 원본이 없으면 재다운로드를 자동 확장하지 않고 제외한다. Gemini는 검증용 명시 요청만 호출한다.
- MiaeQ_Q/KangHeeSung_ 동일 팀/동일 경기 응답과 반복 조회 캐시, 지표 결측/비교 없음/429/복구 경합을 확인한다.
- 위 migration과 canary가 성공한 뒤에만 main PR의 배포 가능 상태를 결정한다.

## 1단계 실행 결과 (2026-09-07, develop)

- 팀 관측 계약 v1 도입, 개인 수치 fallback과 개인 benchmark 조회(상세 요청당 최대2회)를 제거했다. 팀 관측이 없는 과거 결과 또는 신구 혼합 결과는 해당 팀 지표를 보류한다.
- 실제 보관 원본 c3fd0fe9: 팀 기절4/소생1/연막구출0/복수1/시간합5596ms. 5f7180ba: 기절5/소생2/연막구출0/복수1/시간합6592ms.
- 같은 선택 경기2개 합계: 기절9/소생3/연막구출0/복수2, 평균 `(5596+6592)/2=6094ms`. 4명 각각의 raw/full/cache 결과가 동일했다. 상위5경기를 고르는 기존 개인 점수 기준은 유지하므로 서로 다른 선택 경기 집합까지 같다는 뜻은 아니다.
- 실제 Gemini 스쿼드 mild/spicy2회 모두 HTTP200, 팀 수치6.09초와 종합 등급null 확인. DB/auth/storage는 메모리 대체이며 운영 이행 검증은 아니다. 자유 문장의 의미를 모두 증명하지 않는다.
- 리뷰에서 발견한 playerId alias 및 singular recalledPlayer/recallingPlayer 생명주기를 수정했다. 기절 없이 소생만 나타나면 관측된0으로 처리하지 않는다. 중복 소생과 리콜 실행자 생명 상태 보존 회귀 포함.
- 전체 Vitest2358통과/59선택실행skipped/실패0. core는 종료0, TypeScript통과/기존ESLint경고55개/오류0. 최종프로덕션build종료0.
- 프로덕션 빌드 기반 브라우저 QA: 375×667,390×844,430×932,768×1024,1280×720에서 수평 overflow/JS오류 없음. 실제 원본 팀 집계 응답을 API fixture로 사용했고 외부 인증/DB는 호출하지 않았다. 60초 이내 탭 재진입 추가조회0, 만료 뒤 갱신 및 관측 누락409 안내 확인.
- 운영 반영은 아직 불가: 2단계 계산 버전 저장·조회 migration과 3단계 제한 재계산 canary가 남아 있다. RESULT_VERSION73/공개지도v61/기존 DB·R2는 이번 단계에서 바꾸지 않았다.

## 2·3단계 실행 결과 (2026-09-07, develop)

- 계산 버전 2 저장·조회 조건, 버전별 비교 view, 개인/요약/팀 AI 캐시 분리, 공개 지도 v62를 반영했다. v61 복구 worker와 함께 동작하도록 DB 복구 계약을 확장했다.
- `20260907133015_analysis_calculation_version.sql` 로컬 PostgreSQL 검증 및 운영 적용 완료. 기존 6,667개 행에 새 계산 버전을 임의 부여하지 않았다. 구버전 writer의 하향 덮어쓰기, v72 복구 중 계산 provenance 변경, 점 포함 경기 ID의 저장 경로 오인을 차단했다.
- 명시된 8개 선수·경기 후보에서 MiaeQ_Q의 정식 저장 기록 2개만 실제 원본 재계산 후 갱신했다. raw/full 값 일치, 원자적 processed+benchmark 갱신, 사후 전체 결과 대조와 `already_current` 재실행 확인. 다른 6개는 canonical_missing으로 제외했다.
- 운영 DB를 읽는 새 코드의 개인/스쿼드 API HTTP200, 팀 합계 기절9·소생3·복수2·평균6094ms 확인. 같은 계산 표본2건이므로 비교 평균과 종합 등급은 보류한다.
- 이번 실제 Gemini 9회, 개인6/요약1/스쿼드2 모두200. 원본 일치 시험 포함10개통과. DB 이행에서는 Gemini 호출/원본 다운로드/삭제/R2 쓰기 모두0.
- 과거 전체 데이터의 이행 완료를 의미하지 않는다. 기본 전적은 유지하며, 이전 계산만 있는 AI는 업데이트 대기로 처리한다. 전면 사용 가능 범위는 검증된 원본 기반 점진 이행과 함께 넓혀야 한다.
- 통합 코드/화면 점검 결과와 후속 성능·정확도 방향은 [전적·분석·리플레이 감사](../reviews/2026-09-07-stats-analysis-replay-audit.md)에 기록한다.
