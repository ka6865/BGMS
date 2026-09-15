# PUBG 전적 보존 기반 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 내부 discovery 상태를 사용자에게 노출하지 않고 저장된 전체 전적의 건수와 필터 페이지를 정확히 보여주며 수집 워커를 소량 canary로 실행할 수 있게 한다.

**Architecture:** 최근 20경기 응답은 요약 경계로 유지하고, 전체 전적 목록은 `pubg_player_matches` 서버 쿼리의 필터·페이지 결과만 사용한다. discovery 진행 상태는 UI와 브라우저 폴링에서 제거하고 워커 CLI와 GitHub Actions 로그에서 관찰한다.

**Tech Stack:** Next.js App Router, React, TypeScript, Supabase/PostgREST, Vitest, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-15-pubg-history-release-design.md`

## Global Constraints

- 사용자 화면에 pending, retry, unavailable 건수를 표시하지 않는다.
- `recentMatches` 최대 20개 경계는 최근 요약용으로 유지한다.
- 필터와 `totalCount`는 저장된 전체 전적 기준으로 계산한다.
- 서비스 역할 키는 서버와 워커에서만 사용한다.
- 워커는 기본 최대 300건을 유지하되 1~300 범위의 명시적 `--limit`를 지원한다.
- 닉네임만 같은 기존 저장 행은 identity가 검증된 것으로 간주하지 않는다.
- 워커 활성화와 메인 병합은 별도 최종 승인 전에는 실행하지 않는다.

---

### Task 1: 전체 전적 필터와 건수 API

**Files:**
- Modify: `lib/pubg/playerMatches.ts`
- Modify: `app/api/pubg/player/matches/route.ts`
- Test: `tests/player-matches.test.ts`
- Test: `tests/match-history-ingest-api.test.ts`

**Interfaces:**
- Produces: `PlayerMatchHistoryFilter`, `normalizePlayerMatchHistoryFilter(value)`, `fetchPlayerMatchesPaginated(..., filter)`
- Produces: JSON `matches`, `page`, `pageSize`, `totalCount`, `totalPages`

- [ ] 필터별 쿼리와 필터된 `totalCount`를 검증하는 실패 테스트를 추가한다.
- [ ] `all`, `normal`, `ranked`, `casual`, `tdm`만 허용하는 정규화 함수를 구현한다.
- [ ] `match_type`과 `game_mode`의 기존 분류 규칙을 재사용해 Supabase 쿼리에 필터를 적용한다.
- [ ] API가 `filter` 쿼리 파라미터를 전달하고 잘못된 값은 `all`로 정규화하게 한다.
- [ ] `npx vitest run tests/player-matches.test.ts tests/match-history-ingest-api.test.ts`를 실행한다.

### Task 2: 사용자 전적 목록 표현

**Files:**
- Modify: `hooks/useStatsPageController.ts`
- Modify: `components/stat/layout/StatsPageShell.tsx`
- Modify: `components/stat/matches/MatchFeed.tsx`
- Modify: `types/stats-page.ts`
- Test: `tests/stats-page-controller.test.ts`
- Test: `tests/stats-page-shell.test.ts`
- Test: `tests/match-history-ingest-progress.test.ts`

**Interfaces:**
- Consumes: Task 1의 `filter`, `totalCount`, `totalPages`
- Produces: controller `historyTotalCount`, 필터 변경 시 1페이지 서버 재조회

- [ ] 전체 저장 건수 표시와 discovery 문구 비노출을 검증하는 실패 테스트를 추가한다.
- [ ] controller가 `totalCount`를 검증해 `historyTotalCount`로 보관하게 한다.
- [ ] 필터 변경 함수가 새 필터로 1페이지를 직접 조회하도록 만들어 React 상태 갱신 순서에 의존하지 않게 한다.
- [ ] `HistoryIngestNotice`와 discovery 기반 10초 폴링을 제거한다. 성과 완료 폴링은 별도 성과 단계에서 유지 여부를 검토한다.
- [ ] MatchFeed 제목을 `저장된 전적 N경기 · P/T페이지`로 변경하고 현재 페이지 20개를 전체처럼 표현하지 않게 한다.
- [ ] 빈 상태 문구를 `최근 14일` 단정 대신 `BGMS에 저장된 ... 기록이 없습니다`로 변경한다.
- [ ] 관련 Vitest를 실행한다.

### Task 3: 수집 워커 canary와 중복 방지

**Files:**
- Modify: `scripts/ingest_discovered_matches.ts`
- Modify: `lib/pubg/discoveryWorker.ts`
- Modify: `.github/workflows/pubg-match-retention.yml`
- Test: `tests/discovered-match-worker.test.ts`
- Test: `tests/match-discovery-sync.test.ts`

**Interfaces:**
- Produces: CLI `--limit <1..300>`
- Produces: 이미 동일 `platform + account_id + match_id`로 저장된 경기의 `saved` 완료 처리

- [ ] `--limit 3`이 claim 상한을 3으로 제한하고 잘못된 값이 실패하는 테스트를 추가한다.
- [ ] CLI 인자를 파싱해 `runDiscoveryWorker`의 `limit`에 전달한다.
- [ ] ingest 전에 동일 account ID의 기존 저장 행을 확인하고 있으면 PUBG 요청을 생략한다.
- [ ] dry-run 결과에 전체 대기 건수와 가장 오래된 준비 시각을 출력한다.
- [ ] 워크플로 수동 실행에서 canary limit를 선택할 수 있게 하되 활성화 변수가 없으면 자동 스케줄은 계속 차단한다.
- [ ] 관련 Vitest와 `git diff --check`를 실행한다.

### Task 4: 통합 검증과 배포 준비

**Files:**
- Modify: `docs/operations/pubg-tracking.md`
- Verify: 전적 보존 관련 전체 변경

**Interfaces:**
- Consumes: Tasks 1~3의 API, UI, CLI 계약
- Produces: 리뷰 가능한 첫 번째 기능 커밋과 canary 절차

- [ ] 운영 문서의 사용자 표시, `--limit 3`, 3건→20건 canary 절차를 갱신한다.
- [ ] 전적 보존·회귀 테스트 묶음을 실행한다.
- [ ] `npm run verify:core`, `npm run build`, `npm run verify:migrations`를 실행한다.
- [ ] 375x667, 390x844, 430x932, 데스크톱에서 목록·필터·페이지·오류 상태를 확인한다.
- [ ] 최신 `origin/main` 위로 재배치한 뒤 전적 보존 기반 파일만 기능 커밋으로 준비한다.
- [ ] Preview에서 기본 전적과 Zucchini__ 62건/4페이지를 확인한다.
- [ ] 메인 병합과 워커 활성화 전에 사용자에게 diff·검증·운영 영향을 제시한다.
