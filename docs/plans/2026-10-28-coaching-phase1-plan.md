# 전적 지표·칭호 1차 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 선제 타격 성공률·반격 소요 시간의 표현과 관측 근거를 맞추고 칭호 기준 버전을 캐시에 연결한다.

**Architecture:** PR #378의 공통 firstReply helper와 기존 역할 분류기를 재사용한다. 기존 화면과 AI reader를 함께 보완하고 summary hash에 역할 기준 버전을 포함한다. 점수 산식과 CDF는 유지한다.

**Tech Stack:** 현재 package.json의 Next.js, React, TypeScript, Vitest, 기존 fixture 브라우저 하네스.

**Spec:** `docs/plans/2026-10-28-coaching-phase1-design.md`

## Global Constraints

- 명칭: **선제 타격 성공률**, **반격 소요 시간**.
- 실제 선제 발사 비율은 개발하지 않는다.
- raw 점수 산정용 지연과 적격 코칭 관측은 별도다.
- 기존 변경은 보존한다. 루트의 matchReportView 관련 변경을 가져오거나 덮어쓰지 않는다.
- 새 의존성·새 migration·전체 CDF 재산출·운영 쓰기·병합·배포는 이 계획에 포함하지 않는다.
- 기준 브랜치는 #378의 `ka6865/fix-first-reply-evidence`, 시작 HEAD는 `efd82fbf`다. 실행 전 원격 변경을 재확인한다.
- Next.js 코드를 수정하기 전 설치된 `node_modules/next/dist/docs/`의 관련 가이드를 확인한다.

## Review Focus

- raw 시간만 있는 과거 전적: 빠른 반격 수치로 노출하거나 0초로 채우지 않는다(Task 1).
- 적격 시간 누락/3초 내 명중 없음: 시간 측정 불가, 기존 점수 유지(Task 1).
- 이전 AI label과 새 label이 섞임: 동일 지표만 짝지으며 아군 백업 지표와 혼합하지 않는다(Task 1).
- 역할 기준 버전만 변경: 지표·경기·칭호 출력이 같아도 이전 캐시를 재사용하지 않는다(Task 2).
- 반응 근거 없는 높은 선제율: 선봉 primary·secondary·조합을 부여하지 않는다(Task 2).

---

### 실행 전 경로 대조

- [x] 설계의 호출 경로 표를 읽고 raw 점수·적격 관측·백업 시간을 구분한다. 필드명 전체 검색만으로 경로별 실행 검증까지 완료했다고 기록하지 않는다.
- [x] `calculation4StoredUpgrade`, `benchmarkRecoveryPlanner`/`benchmarkRecoverySnapshot`, match route recovery, `legacyTeamRetentionRecovery`를 끝까지 대조해 신규 관측의 손실·위조·덮어쓰기 여부를 확인한다. 영향이 있으면 기존 복구 잠금/CAS 계약을 유지한 최소 수정과 해당 도메인 테스트를 작업에 포함한다. 재분석된 유효 관측이 없는 과거 행은 null이어야 한다.
- [x] 복구·계산 승급 검증은 `tests/benchmark-recovery-planner.test.ts`, `tests/benchmark-recovery-canary.test.ts`, `tests/calculation-upgrade-write-lock.test.ts`, `tests/retained-performance.test.ts`를 연결한다. 이 사전 검증이 끝나기 전에는 전체 실사용 로직 파악·검증 완료라고 보고하지 않는다.

### Task 1: 화면·AI의 지표 정의와 관측 reader 일치

**Files:**
- Modify: `components/stat/RecentAISummary.tsx`, `components/stat/matches/MatchPerformancePanel.tsx`, `components/stat/layout/StatsPageShell.tsx`
- Modify: `types/stat.ts`, `lib/pubg/retainedPerformance.ts`(기존 보존 경계에서 적격 evidence를 전달할 때 필요한 최소 범위)
- Modify: `lib/pubg-analysis/aiSummaryCardEvidence.ts`, `lib/pubg-analysis/aiSummaryDebate.ts`
- Modify: `lib/pubg-analysis/matchAiCoachingPrompt.ts`, `lib/pubg-analysis/matchAiEvidence.ts`, `lib/pubg-analysis/aiSummaryCards.ts`, `app/api/pubg/ai-summary/route.ts`
- Modify: `app/api/pubg/battle/route.ts`, `docs/tactical_score_guide.md`
- Test: `tests/ai-summary-debate.test.ts`, `tests/ai-summary-evidence.test.ts`, `tests/ai-cache-routes.test.ts`, `tests/ai-coaching-judgment.test.ts`, `tests/calculation-basic-availability.test.ts`, `tests/stats-page-shell.test.ts`, `tests/retained-performance.test.ts`
- Create Test: `tests/match-performance-evidence.test.ts`

**Interfaces:**
- Consumes: `firstReplyLatencyMs(result: any): number | null`, `readFirstReplyEvidence(result: any): FirstReplyEvidence | null` from `lib/pubg-analysis/firstReply.ts`.
- Produces: 기존 metric ID `initiative_rate` / `reaction_latency`와 내부 API 필드명을 유지한 표시·prompt 계약. 새 공통 label registry는 만들지 않는다.
- Battle: existing public comparison key `counter_latency_ms` stays; its numeric source becomes `eligible_first_reply_latency_ms`, converted ms→s once.

- [x] **Step 1: Add failing behavior tests.** Raw-only 3ms plus no evidence renders 측정 불가; valid evidence(sum=903,count=1) renders 0.90초; noReply-only renders 측정 불가; 0ms with valid evidence stays measured. Existing score output must be unchanged. Retained/missing payload tests verify evidence is validated, never inferred from raw.
- [x] **Step 2: Add label/reader regressions.** New initiative/reply labels pair with the matching current and legacy label aliases; backup latency stays separate. Battle with raw=3 and eligible=null is noncomparable, raw=3 and eligible=903 uses 0.90s. Existing zero fixture must carry valid eligible zero rather than receive a raw fallback.
- [x] **Step 3: Run these tests and confirm failures are the intended old behavior.** `npx vitest run tests/match-performance-evidence.test.ts tests/ai-summary-debate.test.ts tests/ai-summary-evidence.test.ts tests/calculation-basic-availability.test.ts tests/stats-page-shell.test.ts`.
- [x] **Step 4: Implement the minimum reader/type/copy changes.** Use the shared helper in the single-match component, preserve/validate evidence at the retained boundary, and read the new existing benchmark column for Battle. Match route already spreads duelStats; do not introduce a second calculation. Correct summary's “no reply samples → initiative-focused play” inference. 반격 표시에서만 유효한 0ms를 지원하고 다른 시간의 기존 미관측 판정은 유지한다. raw 점수 설명·아군 백업 용어를 일괄 치환하지 않는다.
- [x] **Step 5: Run the Task 1 tests plus `tests/ai-cache-routes.test.ts` and `tests/ai-coaching-judgment.test.ts`.** Include `tests/retained-performance.test.ts`; all run tests pass. Update user guide to explain qualified display versus unchanged raw scoring.
- [x] **Step 6: Commit only Task 1 files.** Suggested message: `fix: 전적 지표 명칭과 적격 반격 관측 표시 통일`.

### Task 2: 칭호 근거 보호와 기준 버전 캐시 연결

**Files:**
- Modify: `lib/pubg-analysis/roleClassifier.ts`, `lib/pubg-analysis/constants.ts`, `app/api/pubg/ai-summary/route.ts`
- Read: `lib/pubg-analysis/roleReference.ts`
- Test: `tests/role-classifier-rules.test.ts`, `tests/ai-cache-routes.test.ts`, `tests/audit-pubg-ai-accuracy.test.ts`

**Interfaces:**
- Consumes: `classifyRole(stats: any, _bench: any, overallTier: string): RoleInfo`; `ROLE_REFERENCE_VERSION: number`.
- Produces: same RoleInfo/API shape; `buildSummaryCacheHash` includes role reference version as an explicit hash part; same cache-table identity columns and lookup/write paths.

- [x] **Step 1: Add failing cache tests.** With identical match selection, prompts, visuals and mocked classifier output, reference version 1→2 changes the persisted `match_ids_hash`; same version/inputs yields the same hash and hits cache; legacy hash misses. Assert version participates in both lookup and save through the existing route mock harness.
- [x] **Step 2: Extend role regressions.** initiative-only and reaction-only pointMan remain null; no primary/secondary/combo pointMan when current summary withholds reaction; normal two-observation classifier cases remain supported. Assert the displayed metric labels and descriptions do not claim first firing or reflexes.
- [x] **Step 3: Run `npx vitest run tests/role-classifier-rules.test.ts tests/ai-cache-routes.test.ts tests/audit-pubg-ai-accuracy.test.ts` and verify intended failures.**
- [x] **Step 4: Implement explicit reference-version hashing and accurate copy.** Keep reference version 1 and all quantiles/thresholds intact. Wording proposal: pointMan title “교전의 선봉”, description “선제 타격 교전의 성공률과 피격 후 반격 기록이 두드러집니다.”; dropPredator description “경기 초반에 넣는 피해 비중이 높습니다.”; grenadier+brawler combo “폭발의 난투꾼”. These names are implementer proposals, not user-approved copy.
- [x] **Step 5: Set AI_CACHE_VERSION suffix v6 and AI_SUMMARY_CACHE_VERSION suffix v25 with the implementation date.** Preserve the current derived squad-version structure; update tests pinning versions. Do not change calculation, RESULT, telemetry or population versions.
- [x] **Step 6: Run Task 2 tests; commit.** Suggested message: `fix: 칭호 근거 설명과 기준 버전 캐시 연결`.

### Task 3: 통합·모바일 검증과 PR 검토 준비

**Files:**
- Modify: `tests/recent-ai-summary-partial-browser.test.ts`, `tests/fixtures/stats/browserScenarios.ts` only when new observations/states are needed.
- Read/Reuse: `tests/stats-browser-smoke.test.ts`, `tests/helpers/statsBrowserHarness.ts`.
- Modify: `docs/operations/2026-10-28-first-reply-evidence.md`, `docs/operations/2026-10-28-first-reply-wide-audit.md`.
- Local only if present: root `docs-private/.project_context.md` and `docs-private/tier_score_rules.md`.

**Interfaces:**
- Consumes: current summary NDJSON and comparison response contracts unchanged by Tasks 1–2.
- Produces: test evidence, screenshots as local artifacts, a coherent #378 description and remaining 2차 work list.

- [x] **Step 1: Update existing browser assertions.** New labels, missing-observation tooltip, valid/unknown/no-reply states, legacy labels absent from active cards. Keep existing retry/partial-success assertions.
- [x] **Step 2: Run `RUN_SUMMARY_PARTIAL_BROWSER=true npx vitest run tests/recent-ai-summary-partial-browser.test.ts`.** Confirm actual runs at 375x667, 390x844, 430x932, 1440x900; no overflow, readable tooltip, no console errors.
- [x] **Step 3: Use the existing stats fixture harness for changed single-match panel and glossary.** `RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts`; provide STATS_BASE_URL for a verified existing server. Do not delete a dev lock or start a conflicting server. Add viewport coverage to existing cases if any required size is missing.
- [x] **Step 4: Run `npm run verify:core`, `npm run verify:analysis`, `npm run test:unit`.** No errors or failed tests; report skips and pre-existing warnings. Reuse migration checks from #378 if schema is unchanged; do not claim they were newly rerun.
- [x] **Step 5: Update docs and review the complete diff.** Explain new names, raw/qualified distinction, temporary pointMan withholding, cache/reference versions, the existing migration prerequisite, and no new population calibration. Independent review after implementation.
- [ ] **Step 6: Commit docs/browser changes, push and update PR #378 title/body around final behavior.** Recheck #377/#378 status and overlapping files before integration; do not automatically merge, deploy or apply the migration. Report CI results or pending status accurately.

## 자체 검토

- 목적·관측·칭호·캐시·모바일·운영 조건을 위 3개 작업에 연결했다.
- 새 발사 지표·분포 학습·스키마 추가·의존성 추가는 포함하지 않는다.
- 1차에서 기존 분포의 오래된 기준까지 해결하지는 않는다. pointMan 보류를 유지하고 2차로 넘긴다.
