# 전적 매치 티어 근거 팝오버 복원 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 매치 상세를 펼쳤을 때 티어 근거 패널이 자동 노출되는 회귀를 제거하고, 기존처럼 AI 등급 배지 상호작용에서만 근거를 표시한다.

**Architecture:** `ExpandedMatchDetails`는 상세 통계·AI·리플레이만 렌더링한다. `CompactMatchRow`는 상세 펼침 버튼과 독립된 AI 등급 버튼 및 반응형 팝오버를 소유하고, 기존 티어 근거 계산·표시 컴포넌트를 팝오버 콘텐츠로 재사용한다.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, Vitest, Testing Library

## Global Constraints

- 전술 점수, 티어 산식, API 요청 및 캐시 identity는 변경하지 않는다.
- 데스크톱은 AI 등급 배지 hover/focus/click, 모바일은 탭으로 팝오버를 연다.
- AI 등급 배지 조작은 매치 상세 펼침 상태를 바꾸거나 `/api/pubg/match` 요청을 만들지 않는다.
- 모바일 팝오버는 배경 스크롤을 잠그고 닫기 버튼 및 44px 이상 터치 대상을 제공한다.
- 기존 팀·무기·지도·AI 코칭·2D/3D 리플레이 상세 기능을 유지한다.

---

### Task 1: 티어 근거 표시 소유권 복원

**Files:**
- Modify: `components/stat/matches/CompactMatchRow.tsx`
- Modify: `components/stat/matches/ExpandedMatchDetails.tsx`
- Modify: `components/stat/MatchCard.tsx`
- Modify: `tests/match-card-detail-state.test.ts`
- Modify: `docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md`

**Interfaces:**
- Consumes: `MatchSummaryData`, `estimateUserTier`, 기존 `MatchPerformancePanel` 티어 근거 렌더링
- Produces: `CompactMatchRowProps.isMobile: boolean`, 독립적인 AI 티어 근거 버튼/팝오버, 자동 패널이 제거된 상세 본문

- [x] **Step 1: 상세 자동 노출 회귀 테스트 작성**

  `tests/match-card-detail-state.test.ts`에서 초기·상세 성공 후 `매치 성과 및 티어 근거` region이 없고 AI 등급 버튼 조작 후에만 나타나는 데스크톱/모바일 동작을 검증한다.

- [x] **Step 2: RED 확인**

  Run: `npx vitest run tests/match-card-detail-state.test.ts`

  Expected: 현재 `ExpandedMatchDetails`가 근거 panel을 무조건 렌더링하므로 2개 테스트가 실패한다.

- [x] **Step 3: 최소 구현**

  `ExpandedMatchDetails`에서 상시 `MatchPerformancePanel` 호출을 제거한다. `CompactMatchRow`에 `isMobile`을 전달하고 상세 버튼과 중첩되지 않는 AI 등급 버튼을 만든다. 기존 근거 panel은 해당 버튼이 연 팝오버 내부에서만 렌더링한다.

- [x] **Step 4: 관련 회귀 검증**

  Run: `npx vitest run tests/match-card-detail-state.test.ts tests/match-card-demand-loading.test.ts tests/match-feed-ad-placement.test.ts`

  Expected: 모든 테스트 PASS, AI 배지 조작 전 `/api/pubg/match` 추가 요청 0건.

- [x] **Step 5: 정적·코어 검증**

  Run: `npx tsc --noEmit --pretty false`

  Run: `npm run verify:core`

  Expected: 신규 TypeScript/ESLint 오류 0건.

- [x] **Step 6: 반응형 브라우저 검증**

  실행 중인 로컬 서버에서 `375x667`, `390x844`, `430x932`, `1280x720`을 확인한다. 상세 펼침 직후 자동 패널 없음, AI 배지 탭/hover 후 팝오버 표시, 모바일 닫기/스크롤 잠금, 텍스트 겹침과 하단 내비게이션 간섭 없음을 확인한다.

- [ ] **Step 7: 커밋**

  ```bash
  git add components/stat/matches/CompactMatchRow.tsx components/stat/matches/ExpandedMatchDetails.tsx components/stat/MatchCard.tsx tests/match-card-detail-state.test.ts docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md docs/superpowers/plans/2026-08-12-stats-tier-evidence-popover-fix.md
  git commit -m "fix(stats): 매치 티어 근거 상호작용 복원"
  ```
