# BGMS OP.GG형 전적 페이지 리디자인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/stats`와 `/stats/[platform]/[nickname]`를 BGMS 블랙·골드 기반 OP.GG형 검색·2열 전적 화면으로 개편하고, Google Auto ads·수동 AdSense·Kakao AdFit을 안전하게 배치하면서 기존 전적검색 기능의 확정 버그를 회귀 테스트와 함께 수정한다.

**Architecture:** 서버 route는 URL의 플레이어·상위 탭·스쿼드 그룹만 파싱하고, `useStatsPageController`가 플레이어·요약 요청과 최신 응답 우선 상태를 소유한다. 화면은 검색, 프로필, 통계 레일, 매치 피드, 광고의 controlled 컴포넌트로 분리하며 기존 PUBG 분석·AI·텔레메트리 계산은 이동하거나 재작성하지 않는다. 광고는 선언형 레지스트리와 hydration-safe viewport 훅으로 실제 규격 하나만 마운트하고, Auto ads overlay는 전역 스크립트와 AdSense 콘솔이 소유한다.

**Tech Stack:** Next.js 16.1.1 App Router, React 19.2.3, TypeScript 5, Tailwind CSS v4, Vitest 4.1.5, React Testing Library 16.3.2, Puppeteer 25.1.0, Google AdSense, Kakao AdFit.

## Global Constraints

- 구현은 `develop` 기준 새 `codex/` 브랜치 Git 워크트리에서 시작하며 `superpowers:using-git-worktrees`를 사용한다.
- 기능 구현과 버그 수정은 `superpowers:test-driven-development`, 실패 재현 후 원인 분석은 `superpowers:systematic-debugging`, 완료 주장은 `superpowers:verification-before-completion`을 사용한다.
- 전적 UI 작업과 최종 브라우저 검증은 `bgms-frontend-qa`를 적용한다.
- 기존 PUBG API, AI 분석, 텔레메트리, 2D·3D 리플레이 알고리즘과 응답 계약은 변경하지 않는다.
- 최근 검색·즐겨찾기는 `pubg_recent_searches_v2`, `pubg_favorites_v2`의 기존 `string[]` 계약을 유지하고 `/stats/battle` 호환을 보존한다.
- 새 상태 관리 라이브러리와 새 UI 의존성을 추가하지 않는다.
- 새 스타일은 `.stats-page` 아래 또는 전적 전용 컴포넌트에만 적용하고 `:root`, 공용 팔레트, 다른 route의 카드 스타일은 바꾸지 않는다.
- 전적 중앙 콘텐츠는 최대 1,200px이며 `<768px` 단일 열·2×2 지표, `768~1023px` 단일 열·4열 지표, `>=1024px` `320px minmax(0,1fr)` 2열을 사용한다.
- 모바일 필수 QA는 `375×667`, `390×844`, `430×932`; 추가 QA는 `375×812`, `768×1024`, `1280×720`, `1440×900`, `1600×900`, `1920×1080`이다.
- 터치 대상은 최소 44×44px, 닉네임은 한 줄 말줄임과 `title`·접근 가능한 전체 이름, AI 요약은 모바일 2줄·데스크톱 3줄 뒤 확장을 제공한다.
- 프로필의 canonical 랭크/RP는 기록이 있는 `ranked.squad → ranked.duo → ranked.solo` 순서의 첫 bucket을 사용하고 통계 controls를 바꿔도 중복 표시하거나 흔들리지 않게 한다.
- 상세 지도·AI·리플레이는 기존처럼 사용자 동작 뒤 로드하며 새 셸 조립 때문에 eager fetch/import로 바꾸지 않는다.
- Google side rail과 top anchor는 JSX로 만들지 않는다. `app/layout.tsx`가 AdSense main script 한 개를 소유하고 AdSense 콘솔은 Side rails `Left and right`, Anchor `Top only`를 사용한다.
- 수동 광고는 CSS `hidden`으로 숨기지 않는다. viewport가 `unknown`이면 높이만 예약하고 provider 컴포넌트와 외부 네트워크 요청을 만들지 않는다.
- 모바일 인피드는 렌더 가능한 7개 이상일 때 6번째 매치 뒤 Google 한 개만, 태블릿·데스크톱은 6·11·16개 이상일 때 5·10·15번째 뒤에 Google·AdFit·Google 순서로 넣고 광고를 마지막 항목으로 만들지 않는다.
- 중간 AdFit 728×90은 상단 단위를 중복 마운트하지 않는다. 별도 `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT`이 설정된 경우에만 사용하고, 없으면 해당 중간 슬롯을 예약하거나 마운트하지 않는다.
- `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT`이 없는 상태는 코드 구현을 막지 않지만 승인된 광고 구성이 운영 완료된 상태는 아니다. Task 10은 별도 728×90 단위와 Preview 검증이 없으면 전체 완료로 표시하지 않고 `광고 운영 설정 대기`로 남긴다.
- Vitest는 현재 `tests/**/*.test.ts`만 수집하므로 JSX 테스트도 파일 확장자를 `.test.ts`로 두고 `React.createElement`, `// @vitest-environment jsdom`, `import "@testing-library/jest-dom/vitest"`를 사용한다.
- 확정 버그는 같은 fixture의 반복 재현 또는 반대 결과가 불가능한 코드 경로로 판정하고, 경로·입력·기대·실제·요청·코드 위치·원인·회귀 테스트·해결을 감사 보고서에 기록한다. 런타임 증거가 부족한 항목은 의심으로 남기고 임의 수정하지 않는다.

---

## File Structure

- Create: `types/stats-page.ts`
  - 페이지 상태, 플레이어 응답, controlled 필터와 컨트롤러 계약을 정의한다.
- Create: `lib/stats/statsPageModel.ts`
  - route 파싱, 플랫폼 검증, 통계 파생값, 매치 모드 분류, 저장소 정규화, 비교·무기 URL을 순수 함수로 제공한다.
- Create: `hooks/useStatsPageController.ts`
  - 플레이어·시즌·갱신·matches-summary 요청, AbortController, requestId, 화면 상태와 재시도를 소유한다.
- Create: `hooks/useStatsSearchHistory.ts`
  - hydration-safe 최근검색·즐겨찾기 `string[]` 로드와 추가·삭제·토글을 소유한다.
- Create: `hooks/useStatsAutocomplete.ts`, `hooks/useStatsProfilePrefill.ts`
  - 300ms 자동완성 abort/stale 처리와 로그인 프로필 닉네임 1회 자동입력을 각각 소유한다.
- Create: `hooks/useAdViewportClass.ts`
  - SSR/hydration에서는 `unknown`, 클라이언트에서는 네 광고 viewport 중 하나를 반환한다.
- Create: `lib/ads/statsAdPlacements.ts`
  - 전적 상단·매치 인피드 광고 규격과 삽입 기준을 선언한다.
- Create: `components/ads/ResponsiveAdSlot.tsx`
  - 선택된 provider creative 하나만 조건부 마운트한다.
- Modify: `components/ads/AdSenseBanner.tsx`, `components/ads/AdfitBanner.tsx`, `app/layout.tsx`
  - 전역 AdSense script 단일 소유권, 테스트 네트워크 차단, placement 멱등성을 보장한다.
- Create: `components/stat/layout/StatsPageShell.tsx`
  - 검색 초기·결과 상태와 광고 안전 영역을 조립한다.
- Create: `components/stat/layout/StatsPageStates.tsx`
  - 최초 loading, 전체 error, 결과 유지형 refreshing, 영역별 partial 상태를 접근 가능하게 렌더한다.
- Create: `components/stat/search/StatsSearchBar.tsx`, `components/stat/search/StatsLandingState.tsx`
  - 검색 입력·자동완성·최근검색·즐겨찾기와 초기 기능 카드 세 개를 렌더한다.
- Create: `components/stat/profile/PlayerProfileHeader.tsx`
  - 정체성·canonical 랭크/RP·갱신·시즌·액션을 렌더한다.
- Create: `components/stat/overview/StatsSectionTabs.tsx`, `components/stat/overview/StatsOverviewControls.tsx`, `components/stat/overview/StatsOverviewRail.tsx`
  - 상위 탭, 통계 모드/파티 크기, 핵심 지표·AI 한줄 요약을 controlled UI로 렌더한다.
- Modify: `components/stat/StatSummaryPanel.tsx`, `components/stat/RecentAISummary.tsx`
  - 통계 상태를 외부 제어로 전환하고 기존 AI 결과를 compact 요약에 전달한다.
- Create: `components/stat/matches/MatchFeed.tsx`, `components/stat/matches/CompactMatchRow.tsx`, `components/stat/matches/ExpandedMatchDetails.tsx`
  - 필터·광고 삽입·접힌 행·기존 상세 분석 경계를 분리한다.
- Modify: `components/stat/MatchCard.tsx`
  - 요청·상태 어댑터로 축소하고 상세 실패·재시도·stale 응답 방지를 추가한다.
- Modify: `components/stat/SquadAnalysisPanel.tsx`
  - `initialGroupKey` 복원과 그룹 변경 최신 응답 우선만 추가하고 분석·AI 계약은 유지한다.
- Modify: `components/stat/StatSearch.tsx`
  - 호환 entry로 남겨 `StatsPageShell`을 호출하며 기존 1,400줄 JSX와 요청 소유권을 제거한다.
- Modify: `app/stats/page.tsx`, `app/stats/[platform]/[nickname]/page.tsx`, `components/common/BottomNav.tsx`, `app/globals.css`
  - route state 전달, 상세 경로 nav 활성화, 전적 전용 responsive 스타일을 적용한다.
- Modify: `app/api/pubg/matches-summary/route.ts`, `lib/pubg-analysis/matchSummary.ts`
  - fallback 경기 시각을 원본 `created_at`으로 보존한다.
- Create: `docs/reviews/2026-08-10-stats-search-regression-audit.md`
  - baseline, 확정 버그, 의심 항목, 수정과 최종 기능 감사 결과를 기록한다.

---

### Task 1: 전적검색 baseline과 감사 계약 고정

**Files:**
- Create: `docs/reviews/2026-08-10-stats-search-regression-audit.md`
- Create: `tests/fixtures/stats/player-ready.json`
- Create: `tests/fixtures/stats/matches-summary-ready.json`
- Create: `tests/stat-search-baseline.test.ts`
- Create: `tests/battle-storage-compat.test.ts`
- Modify: `tests/stat-search-ui.test.ts`

**Interfaces:**
- Produces: 공통 플레이어 fixture `player-ready.json`, 매치 요약 fixture `matches-summary-ready.json`.
- Produces: 감사 표의 판정 `confirmed | suspected | fixed | not_reproduced`와 증거 필드.
- Consumes: 기존 `STORAGE_KEY_RECENT`, `STORAGE_KEY_FAVORITES`와 `/api/pubg/player`, `/api/pubg/matches-summary` 계약.

- [ ] **Step 1: baseline 테스트와 감사 문서의 기대 실패 조건을 작성한다**

```ts
// tests/stat-search-baseline.test.ts 핵심 케이스
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

it.fails("빈 닉네임은 요청하지 않고 인라인 오류를 표시한다", async () => {
  render(createElement(StatSearch));
  fireEvent.click(screen.getByRole("button", { name: "검색" }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent("닉네임을 입력해 주세요");
});

it("검색 성공은 canonical URL과 string[] 최근검색을 한 번만 갱신한다", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(playerReady));
  fetchMock.mockResolvedValueOnce(jsonResponse(summaryReady));
  render(createElement(StatSearch));
  await searchFor("steam", "FixturePlayer");
  expect(history.pushState).toHaveBeenCalledWith(null, "", "/stats/steam/FixturePlayer");
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT)!)).toEqual(["FixturePlayer"]);
  expect(playerRequests()).toHaveLength(1);
});
```

감사 문서는 다음 열을 실제 Markdown 표로 만든다.

```md
| ID | 상태 | 경로·입력 | 기대 | 실제 | 네트워크 | 코드 위치 | 원인 | 회귀 테스트 | 해결 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STATS-001 | confirmed | /stats, nickname="" | 인라인 검증 | 무반응 | 0건 | StatSearch.tsx handleSearch | 빈 값 조기 return | stat-search-baseline | Task 4 |
```

- [ ] **Step 2: 신규 baseline을 실행해 현재 결함을 재현한다**

Run: `npx vitest run tests/stat-search-baseline.test.ts tests/battle-storage-compat.test.ts tests/stat-search-ui.test.ts`

Expected: suite PASS. 빈 입력 결함은 `it.fails`가 현재 실패를 확인해 expected-failure로 기록하고, 기존 저장소 호환과 만료 helper는 일반 PASS한다. Task 4에서 구현 직전에 `it.fails`를 `it`으로 바꿔 red 상태를 만든다.

- [ ] **Step 3: 수정하지 않고 현재 기능·결함 증거를 문서에 기록한다**

다음은 `confirmed`, 브라우저 증거가 필요한 네 항목은 `suspected`로 기록한다.

```md
confirmed: 빈 검색 무반응, 자동완성 0건 UI 도달 불가, squad/groupKey 미복원,
시즌·강제갱신 후 overview 초기화, 후속 검색 의도 폐기, matchType 경쟁전 오분류,
상세 실패 재시도 부재, fallback 경기 시각 현재값 생성, 비교 URL platform1 유실

suspected: localStorage hydration 경고, history.pushState 뒤로가기·metadata 동기화,
invalid platform direct URL의 generic 500, 시즌 실패 시 이전 결과 소실
```

- [ ] **Step 4: 변경 전 통과 suite를 다시 실행한다**

Run: `npx vitest run tests/stat-search-ui.test.ts tests/match-card-demand-loading.test.ts tests/player-suggest-route.test.ts tests/suggest-players.test.ts tests/pubg-recent-matches.test.ts tests/player-matches-api.test.ts`

Expected: 6 files, 15 tests PASS. 이 숫자와 `npm run verify:core`의 error 0·기존 warning 45를 감사 문서 baseline에 기록한다.

- [ ] **Step 5: commit한다**

```bash
git add docs/reviews/2026-08-10-stats-search-regression-audit.md tests/fixtures/stats/player-ready.json tests/fixtures/stats/matches-summary-ready.json tests/stat-search-baseline.test.ts tests/battle-storage-compat.test.ts tests/stat-search-ui.test.ts
git commit -m "test(stats): 전적검색 회귀 감사 기준 추가"
```

---

### Task 2: 페이지 타입과 순수 파생 모델

**Files:**
- Create: `types/stats-page.ts`
- Create: `lib/stats/statsPageModel.ts`
- Create: `tests/stats-page-model.test.ts`
- Create: `tests/stat-match-filter.test.ts`
- Create: `tests/stat-search-navigation.test.ts`

**Interfaces:**
- Produces: `StatsPlatform`, `StatsSectionTab`, `StatsMode`, `StatsPartySize`, `StatsMatchFilter`, `StatsPageStatus`, `StatsPartialReason`, `StatsErrorType`, `PlayerStatsResponse`, `StatsOverviewMetrics`.
- Produces: `parseStatsPlatform`, `parseStatsSectionTab`, `normalizeStoredNames`, `getStatsOverviewMetrics`, `classifyMatchMode`, `filterRenderableMatches`, `buildStatsCompareUrl`, `buildStatsWeaponsUrl`.
- Consumes: `MatchSummaryData` from `lib/pubg-analysis/matchSummary.ts`.

- [ ] **Step 1: 순수 함수의 실패 테스트를 작성한다**

```ts
expect(parseStatsSectionTab("squad")).toBe("squad");
expect(parseStatsSectionTab("bad")).toBe("overview");
expect(parseStatsPlatform("kakao")).toBe("kakao");
expect(parseStatsPlatform("xbox")).toBeNull();
expect(normalizeStoredNames(["A", 3, "A", "B"])).toEqual(["A", "B"]);

expect(classifyMatchMode({ gameMode: "squad-fpp", matchType: "competitive" })).toBe("ranked");
expect(classifyMatchMode({ gameMode: "tdm", matchType: "official" })).toBe("tdm");
expect(classifyMatchMode({ gameMode: "squad-fpp", matchType: "official", mapName: "PillarCompound_Main" })).toBe("tdm");
expect(filterRenderableMatches(matches, missing, "ranked").map((m) => m.matchId)).toEqual(["ranked-1"]);

expect(buildStatsCompareUrl("Fixture Player", "kakao"))
  .toBe("/stats/battle?nick1=Fixture%20Player&platform1=kakao");
expect(buildStatsWeaponsUrl("Fixture Player", "steam"))
  .toBe("/stats/steam/Fixture%20Player/weapons");
```

- [ ] **Step 2: 테스트가 현재 export 부재로 실패하는지 확인한다**

Run: `npx vitest run tests/stats-page-model.test.ts tests/stat-match-filter.test.ts tests/stat-search-navigation.test.ts`

Expected: FAIL with import/export resolution errors.

- [ ] **Step 3: 공용 타입과 순수 모델을 구현한다**

```ts
// types/stats-page.ts
export type StatsPlatform = "steam" | "kakao";
export type StatsSectionTab = "overview" | "squad";
export type StatsMode = "ranked" | "normal";
export type StatsPartySize = "solo" | "duo" | "squad";
export type StatsMatchFilter = "all" | "normal" | "ranked" | "tdm";
export type StatsPageStatus = "idle" | "loading" | "ready" | "refreshing" | "partial" | "error";
export type StatsPartialReason = "summary_batch_failed" | "summary_missing" | "detail_failed" | "analysis_failed";
export type StatsErrorType = "not_found" | "rate_limit" | "server";
export interface StatsMatchModeMeta { gameMode?: string; matchType?: string; mapName?: string; }

export interface StatsBucket {
  roundsPlayed: number;
  kills: number;
  assists: number;
  deaths?: number;
  losses?: number;
  wins: number;
  top10s?: number;
  top10Ratio?: number;
  damageDealt: number;
  dBNOs: number;
  timeSurvived?: number;
  headshotKills?: number;
  roundMostKills?: number;
  currentTier?: { tier?: string; subTier?: string | number };
  currentRankPoint?: number;
}

export interface PlayerStatsResponse {
  nickname: string;
  platform: StatsPlatform;
  seasonId: string;
  seasons: readonly { id: string; name: string }[];
  stats: { ranked?: Partial<Record<StatsPartySize, StatsBucket | null>> | null; normal?: Partial<Record<StatsPartySize, StatsBucket | null>> | null };
  recentMatches: readonly string[];
  matchModes?: Record<string, string>;
  clan?: { id: string; name: string; tag: string; level: number; memberCount: number } | null;
  weaponMastery?: readonly unknown[];
  banType?: string | null;
  updatedAt?: string;
}

export type StatsOverviewMetrics =
  | { kind: "empty"; label: "기록 없음" }
  | {
      kind: "ready";
      roundsPlayed: number;
      kda: string;
      averageDamage: string;
      top10Rate: string;
      preferredMode: StatsPartySize;
    };
```

```ts
// lib/stats/statsPageModel.ts 핵심
export function parseStatsPlatform(value?: string): StatsPlatform | null {
  return value === "steam" || value === "kakao" ? value : null;
}

export function parseStatsSectionTab(value?: string): StatsSectionTab {
  return value === "squad" ? "squad" : "overview";
}

export function classifyMatchMode(input: StatsMatchModeMeta): Exclude<StatsMatchFilter, "all"> {
  const gameMode = input.gameMode?.toLowerCase() ?? "";
  const matchType = input.matchType?.toLowerCase() ?? "";
  if (gameMode.includes("tdm") || input.mapName === "PillarCompound_Main" || input.mapName === "Italy_TDM_Main") return "tdm";
  if (gameMode.includes("competitive") || gameMode.includes("ranked") || matchType.includes("competitive") || matchType.includes("ranked")) return "ranked";
  return "normal";
}

export const buildStatsCompareUrl = (nickname: string, platform: StatsPlatform) =>
  `/stats/battle?nick1=${encodeURIComponent(nickname)}&platform1=${platform}`;

export function selectCanonicalRankBucket(stats: PlayerStatsResponse["stats"]): StatsBucket | null {
  return (["squad", "duo", "solo"] as const)
    .map((partySize) => stats.ranked?.[partySize])
    .find((bucket): bucket is StatsBucket => Boolean(bucket && bucket.roundsPlayed > 0)) ?? null;
}
```

`getStatsOverviewMetrics`는 선택 bucket이 없거나 `roundsPlayed <= 0`이면 `{ kind: "empty", label: "기록 없음" }`을 반환하고, 데이터가 있으면 게임 수·KDA·평균 딜량·Top 10·선호 모드를 계산한다. 숫자 0을 빈 기록 대용으로 반환하지 않는다.

- [ ] **Step 4: 순수 모델 테스트를 통과시킨다**

Run: `npx vitest run tests/stats-page-model.test.ts tests/stat-match-filter.test.ts tests/stat-search-navigation.test.ts`

Expected: PASS.

- [ ] **Step 5: commit한다**

```bash
git add types/stats-page.ts lib/stats/statsPageModel.ts tests/stats-page-model.test.ts tests/stat-match-filter.test.ts tests/stat-search-navigation.test.ts
git commit -m "refactor(stats): 전적 화면 상태와 파생 모델 분리"
```

---

### Task 3: 최신 응답 우선 페이지 컨트롤러

**Files:**
- Create: `hooks/useStatsPageController.ts`
- Create: `tests/stats-page-controller.test.ts`
- Create: `tests/stat-search-season-refresh.test.ts`
- Modify: `components/stat/StatSearch.tsx`

**Interfaces:**
- Consumes: Task 2의 `PlayerStatsResponse`와 전적 상태 타입.
- Produces: `useStatsPageController(options: UseStatsPageControllerOptions): StatsPageController`.
- Produces: 객체형 `search(request?: StatsSearchRequest): Promise<PlayerStatsResponse | null>`, `refresh(): Promise<void>`, `retrySummaries(): Promise<void>`.

- [ ] **Step 1: abort·stale·refresh·partial 실패 테스트를 작성한다**

```ts
it("대상이 바뀌면 이전 요청을 abort하고 늦은 응답을 무시한다", async () => {
  const first = deferredResponse(playerA);
  const second = deferredResponse(playerB);
  fetchMock.mockImplementationOnce(first.fetch).mockImplementationOnce(second.fetch);
  const controller = renderStatsController({ initialNickname: "A" });
  act(() => controller.current.search({ nickname: "B", platform: "steam" }));
  second.resolve();
  first.resolve();
  await waitFor(() => expect(controller.current.result?.nickname).toBe("B"));
  expect(first.signal.aborted).toBe(true);
});

it("갱신 실패는 기존 결과와 탭을 유지한다", async () => {
  const controller = await renderReadyController({ initialTab: "squad" });
  fetchMock.mockResolvedValueOnce(jsonResponse({ error: "fail" }, 500));
  await act(() => controller.current.refresh());
  expect(controller.current.result?.nickname).toBe("FixturePlayer");
  expect(controller.current.sectionTab).toBe("squad");
  expect(controller.current.error?.type).toBe("server");
});

it("summary batch 실패는 프로필을 유지하고 재시도 가능한 partial로 둔다", async () => {
  const controller = await renderReadyController({ summaryStatus: 500 });
  expect(controller.current.status).toBe("partial");
  expect(controller.current.partialReasons).toContain("summary_batch_failed");
  expect(controller.current.result?.nickname).toBe("FixturePlayer");
});

it("404 추천과 반환 platform을 별도 상태로 보존한다", async () => {
  const controller = await renderControllerWithResponse(404, {
    code: "PLAYER_NOT_FOUND",
    suggestions: [{ nickname: "FixtureAlt", platform: "kakao" }],
  });
  expect(controller.current.suggestedPlayers).toEqual([{ nickname: "FixtureAlt", platform: "kakao" }]);
});

it("한 행의 복구가 다른 행의 같은 partial reason을 지우지 않는다", () => {
  controller.current.reportPartial("detail_failed", "match:a");
  controller.current.reportPartial("detail_failed", "match:b");
  controller.current.clearPartial("detail_failed", "match:a");
  expect(controller.current.partialReasons).toContain("detail_failed");
});

it("성공 후 60초 동안 같은 player의 강제갱신을 막는다", async () => {
  vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
  const controller = await renderReadyController({ updatedAt: "2026-08-10T00:00:00.000Z" });
  expect(controller.current.isRefreshCoolingDown).toBe(true);
  await act(() => controller.current.refresh());
  expect(playerRequests({ refresh: true })).toHaveLength(0);
  vi.advanceTimersByTime(60_000);
  expect(controller.current.isRefreshCoolingDown).toBe(false);
});
```

- [ ] **Step 2: 현재 구현이 후속 요청을 폐기해 테스트가 실패하는지 확인한다**

Run: `npx vitest run tests/stats-page-controller.test.ts tests/stat-search-season-refresh.test.ts`

Expected: FAIL because `useStatsPageController` does not exist and current `isSearchingRef` is not latest-wins.

- [ ] **Step 3: controller 계약을 구현한다**

```ts
export interface UseStatsPageControllerOptions {
  initialPlatform?: string;
  initialNickname?: string;
  initialTab?: StatsSectionTab;
  initialGroupKey?: string;
}

export interface StatsSearchRequest {
  nickname?: string;
  platform?: StatsPlatform;
  seasonId?: string;
  forceRefresh?: boolean;
}

export interface StatsPageController {
  status: StatsPageStatus;
  result: PlayerStatsResponse | null;
  error: { type: StatsErrorType; message: string; retryAt?: number } | null;
  suggestedPlayers: readonly { nickname: string; platform: StatsPlatform }[];
  refreshAvailableAt?: number;
  isRefreshCoolingDown: boolean;
  partialReasons: readonly StatsPartialReason[];
  platform: StatsPlatform;
  nickname: string;
  seasonId: string;
  sectionTab: StatsSectionTab;
  groupKey?: string;
  statsMode: StatsMode;
  partySize: StatsPartySize;
  matchFilter: StatsMatchFilter;
  matchSummaries: Record<string, MatchSummaryData>;
  missingMatchIds: ReadonlySet<string>;
  matchModeMeta: Record<string, StatsMatchModeMeta>;
  summaryStatus: "idle" | "loading" | "ready" | "error";
  setPlatform(value: StatsPlatform): void;
  setNickname(value: string): void;
  setSeasonId(value: string): void;
  setSectionTab(value: StatsSectionTab): void;
  setGroupKey(value?: string): void;
  setStatsMode(value: StatsMode): void;
  setPartySize(value: StatsPartySize): void;
  setMatchFilter(value: StatsMatchFilter): void;
  search(request?: StatsSearchRequest): Promise<PlayerStatsResponse | null>;
  refresh(): Promise<void>;
  retrySummaries(): Promise<void>;
  onModeDetected(matchId: string, gameMode: string, matchType?: string, mapName?: string): void;
  reportPartial(reason: StatsPartialReason, sourceId: string): void;
  clearPartial(reason: StatsPartialReason, sourceId: string): void;
}
```

각 player 검색은 현재 controller를 abort하고 증가한 `requestId`를 캡처한다. `if (requestId !== requestIdRef.current || signal.aborted) return null`을 JSON 파싱 뒤와 상태 반영 직전에 적용한다. `platform:nickname:seasonId:forceRefresh`가 같은 진행 중 요청은 `inFlightPromiseRef`의 동일 Promise를 반환하고, key가 다르면 이전 요청을 취소해 새 의도를 시작한다. 최초 검색만 `loading`에서 결과를 비우고, 시즌 변경·강제갱신은 `refreshing`에서 기존 결과를 유지한다. 요약 batch는 player identity별 별도 AbortController와 requestId를 사용한다.

hook effect는 `initialPlatform/initialNickname`이 모두 유효할 때 identity key를 만들고, 마지막 완료 key와 다르거나 route identity가 실제로 바뀐 경우에만 `search({ platform, nickname })`를 호출한다. 초기 nickname이 없으면 `idle`을 유지한다. 검색창 자체는 이 함수를 직접 호출하지 않고 Task 4의 route-first navigation만 사용한다.

429는 `Retry-After` header가 있으면 이를, 없으면 60초를 사용해 `retryAt`을 계산하고 같은 identity의 반복 요청을 그 시각까지 막는다. 다른 platform/nickname route 이동은 이 cooldown에 막히지 않는다. `missingMatchIds`가 한 개 이상이면 `summary_missing`, batch HTTP/네트워크 실패면 `summary_batch_failed`를 설정한다.

404 또는 `PLAYER_NOT_FOUND` 응답의 `suggestions`는 `suggestedPlayers`에 `{ nickname, platform }` 형태로 보존한다. 이 목록은 300ms autocomplete 목록과 별도이며, 새 검색 시작 또는 성공 때만 초기화한다.

성공 응답의 `updatedAt` 기준 60초 뒤를 `refreshAvailableAt`으로 두고 그 전에는 `isRefreshCoolingDown=true`로 강제갱신을 막아 헤더에 `최신 전적`을 표시한다. partial 원인은 내부 `Map<StatsPartialReason, Set<string>>`으로 저장해 `match:{matchId}`, `summary-batch`, `analysis:{matchId}`처럼 source별 report/clear하고 다른 행의 같은 오류를 지우지 않는다. `trackEvent({ name: "stats_searched", ... })`는 controller가 성공·실패 각각 정확히 한 번 기록한다.

- [ ] **Step 4: 기존 `StatSearch`의 요청·상태를 controller 반환값으로 교체하되 JSX는 유지한다**

```tsx
const controller = useStatsPageController({
  initialPlatform,
  initialNickname,
  initialTab,
  initialGroupKey,
});

const {
  status, result, error, platform, nickname, seasonId,
  sectionTab: activeTab, matchFilter: matchTab,
} = controller;
```

기존 positional `handleSearch` 중 초기 route 자동검색, 시즌 변경, 강제갱신만 객체형 `controller.search({ nickname, platform, seasonId, forceRefresh })`로 바꾼다. 검색창·최근검색·추천·매치 닉네임 클릭은 Task 4에서 route-first `navigateToPlayer`로 전환한다. 성공 시 `setActiveTab("overview")`를 제거하고 route identity 변경은 cooldown과 이전 error에 막히지 않게 한다.

- [ ] **Step 5: controller와 기존 baseline을 통과시킨다**

Run: `npx vitest run tests/stats-page-controller.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-baseline.test.ts`

Expected: PASS. 감사 문서의 latest-wins, 시즌·갱신 상태 항목을 `fixed`로 갱신한다.

- [ ] **Step 6: commit한다**

```bash
git add hooks/useStatsPageController.ts components/stat/StatSearch.tsx tests/stats-page-controller.test.ts tests/stat-search-season-refresh.test.ts docs/reviews/2026-08-10-stats-search-regression-audit.md
git commit -m "fix(stats): 검색 요청 최신 응답 우선 처리"
```

---

### Task 4: route 딥링크·검색 초기 화면·저장소 호환

**Files:**
- Create: `hooks/useStatsSearchHistory.ts`
- Create: `hooks/useStatsAutocomplete.ts`
- Create: `hooks/useStatsProfilePrefill.ts`
- Create: `components/stat/search/StatsSearchBar.tsx`
- Create: `components/stat/search/StatsLandingState.tsx`
- Create: `tests/stat-search-autocomplete.test.ts`
- Create: `tests/stat-search-prefill.test.ts`
- Create: `tests/stat-search-deep-link.test.ts`
- Modify: `app/stats/page.tsx`
- Modify: `app/stats/[platform]/[nickname]/page.tsx`
- Modify: `components/stat/StatSearch.tsx`
- Modify: `tests/stat-search-baseline.test.ts`
- Modify: `components/common/BottomNav.tsx`
- Create: `tests/bottom-nav-stats-active.test.ts`

**Interfaces:**
- Consumes: `StatsPageController`와 Task 2 저장소 정규화 함수.
- Produces: `StatSearchProps`의 `initialTab?: StatsSectionTab`, `initialGroupKey?: string`.
- Produces: `useStatsSearchHistory()`, `useStatsAutocomplete(query)`, `useStatsProfilePrefill(userId)`, `StatsSearchBarProps`, `StatsLandingStateProps`, `isStatsPath(pathname: string): boolean`.

- [ ] **Step 1: 딥링크·빈 검색·autocomplete empty·BottomNav 실패 테스트를 작성한다**

```ts
// Task 1의 빈 검색 `it.fails`를 일반 `it`으로 바꿔 이 Task의 red test로 전환한다.
expect(readPlayerPageProps({ tab: "squad", groupKey: "g2" })).toEqual({
  initialTab: "squad",
  initialGroupKey: "g2",
});
expect(isStatsPath("/stats")).toBe(true);
expect(isStatsPath("/stats/steam/FixturePlayer")).toBe(true);
expect(isStatsPath("/stats/steam/FixturePlayer/weapons")).toBe(true);
expect(isStatsPath("/rankings")).toBe(false);

fireEvent.click(screen.getByRole("button", { name: "1:1 전적 비교" }));
expect(router.push).toHaveBeenCalledWith("/stats/battle");

fireEvent.click(await screen.findByRole("button", { name: "FixtureAlt 카카오로 검색" }));
expect(router.push).toHaveBeenCalledWith("/stats/kakao/FixtureAlt");
```

자동완성 테스트는 fake timer 299ms에 0회, 300ms에 1회, `Ka`에서 `Kan`으로 바뀔 때 첫 signal abort, 0건 응답 시 `검색 결과가 없습니다`를 검증한다.

- [ ] **Step 2: 테스트를 실행해 현재 query 미전달과 exact pathname 판정 실패를 확인한다**

Run: `npx vitest run tests/stat-search-deep-link.test.ts tests/stat-search-autocomplete.test.ts tests/bottom-nav-stats-active.test.ts tests/stat-search-baseline.test.ts`

Expected: FAIL on squad initial tab, empty suggestion UI, inline blank validation, and detail path nav active.

- [ ] **Step 3: 서버 route에서 query를 파싱해 entry에 전달한다**

```tsx
export default async function PlayerStatsPage({ params, searchParams }: Props) {
  const [{ platform, nickname }, query] = await Promise.all([params, searchParams]);
  const validPlatform = parseStatsPlatform(platform);
  if (!validPlatform) redirect("/stats");
  return (
    <StatSearch
      initialPlatform={validPlatform}
      initialNickname={decodeURIComponent(nickname)}
      initialTab={parseStatsSectionTab(typeof query.tab === "string" ? query.tab : undefined)}
      initialGroupKey={typeof query.groupKey === "string" ? query.groupKey : undefined}
    />
  );
}
```

- [ ] **Step 4: controlled 검색 UI와 초기 상태를 구현한다**

```ts
export interface StatsSearchBarProps {
  platform: StatsPlatform;
  nickname: string;
  recentSearches: readonly string[];
  favorites: readonly string[];
  suggestions: readonly { nickname: string; platform: StatsPlatform }[];
  suggesting: boolean;
  validationMessage?: string;
  onPlatformChange(value: StatsPlatform): void;
  onNicknameChange(value: string): void;
  onSubmit(): void;
  onQuickSearch(name: string): void;
  onSuggestionSelect(value: { nickname: string; platform: StatsPlatform }): void;
  onFavoriteToggle(name: string): void;
  onRecentRemove(name: string): void;
}
```

submit은 trim한 닉네임이 없으면 `닉네임을 입력해 주세요` alert를 표시한다. 최근검색·즐겨찾기 quick action은 저장된 이름과 현재 선택 `platform`을 controller에 넘긴다. dropdown 외부 조건을 `showDropdown && (nickname.length >= 2 || items.length > 0)`로 바꿔 0건 메시지가 도달하게 한다. 검색 초기 기능 카드는 `전적 요약`, `AI 분석`, `스쿼드 시너지` 세 개만 렌더한다.

`useStatsSearchHistory`는 서버와 hydration 첫 렌더에서 빈 배열을 반환한 뒤 `useEffect`에서 두 storage key를 읽어 `normalizeStoredNames`로 정리한다. 검색 성공은 `addRecent(canonicalNickname)`, 즐겨찾기는 `toggleFavorite(name)`, 삭제는 `removeRecent(name)`을 사용해 중복 제거·최근 10개 제한·`string[]` 직렬화를 보장한다.

```ts
export interface StatsAutocompleteState {
  suggestions: readonly { nickname: string; platform: StatsPlatform }[];
  suggesting: boolean;
  empty: boolean;
}

export function useStatsAutocomplete(query: string): StatsAutocompleteState;
export function useStatsProfilePrefill(userId?: string): { nickname?: string; platform?: StatsPlatform; loaded: boolean };
```

`useStatsAutocomplete`는 2자 미만이면 요청하지 않고, 300ms debounce 뒤 `/api/pubg/suggest`를 호출하며 query 변경·unmount에서 abort한다. `useStatsProfilePrefill`은 로그인 사용자의 `profiles.pubg_nickname/pubg_platform`을 한 번 읽고 `/stats` idle 화면에서 사용자가 아직 입력하지 않았을 때만 검색창을 채운다. Task 9의 `StatsPageShell`이 두 hook을 호출해 controlled `StatsSearchBar`에 넘긴다.

검색 입력 submit, 최근검색, 즐겨찾기, autocomplete, 404 추천, 매치 행 닉네임 클릭은 player API를 현재 `/stats` 인스턴스에서 먼저 호출하지 않는다. `router.push(`/stats/${platform}/${encodeURIComponent(nickname)}`)`로 route identity를 먼저 바꾸고, 동적 route에 전달된 `initialPlatform/initialNickname`을 본 `useStatsPageController` 한 곳만 player fetch를 시작한다. 시즌 변경·강제갱신만 현재 controller의 `search`를 직접 사용한다. 이 단일 소유권으로 landing fetch + route remount fetch 이중 호출을 막는다.

Task 1의 navigation assertion은 Task 4에서 router mock과 player 요청 1회 assertion으로 바꾼다. `history.pushState`는 제거하되 감사 문서의 기존 suspected 항목을 증거 없이 `fixed`로 바꾸지 않고, browser smoke의 back/forward·metadata 결과로 `not_reproduced` 또는 `fixed`를 판정한다. `it.fails`인 빈 검색 케이스는 이 단계 첫 red action에서 일반 `it`으로 바꾼 뒤 검증 UI를 구현한다.

404 `suggestedPlayers`는 오류 블록 안에서 별도로 렌더하고, 선택 시 suggestion이 반환한 platform으로 route-first 이동한다.

`StatsLandingStateProps`는 다음 계약으로 비교 진입을 보존한다.

```ts
export interface StatsLandingStateProps {
  onCompare(): void;
}
// "1:1 전적 비교" 버튼 → router.push("/stats/battle")
```

- [ ] **Step 5: BottomNav 활성 helper를 적용한다**

```ts
export const isStatsPath = (pathname: string) => pathname === "/stats" || pathname.startsWith("/stats/");
// item.active: isStatsPath(pathname) && !isMenuOpen
```

- [ ] **Step 6: 관련 테스트를 통과시킨다**

Run: `npx vitest run tests/stat-search-deep-link.test.ts tests/stat-search-autocomplete.test.ts tests/stat-search-prefill.test.ts tests/bottom-nav-stats-active.test.ts tests/stat-search-baseline.test.ts tests/stat-search-navigation.test.ts tests/battle-storage-compat.test.ts`

Expected: PASS. 감사 문서의 blank, autocomplete empty, deep-link, BottomNav 항목을 `fixed`로 갱신한다.

- [ ] **Step 7: commit한다**

```bash
git add hooks/useStatsSearchHistory.ts hooks/useStatsAutocomplete.ts hooks/useStatsProfilePrefill.ts components/stat/search/StatsSearchBar.tsx components/stat/search/StatsLandingState.tsx app/stats/page.tsx 'app/stats/[platform]/[nickname]/page.tsx' components/stat/StatSearch.tsx components/common/BottomNav.tsx tests/stat-search-baseline.test.ts tests/stat-search-autocomplete.test.ts tests/stat-search-prefill.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-navigation.test.ts tests/bottom-nav-stats-active.test.ts docs/reviews/2026-08-10-stats-search-regression-audit.md
git commit -m "feat(stats): 검색 초기 화면과 딥링크 복원"
```

---

### Task 5: 반응형 광고 레지스트리와 provider 안전 경계

**Files:**
- Create: `hooks/useAdViewportClass.ts`
- Create: `lib/ads/statsAdPlacements.ts`
- Create: `components/ads/ResponsiveAdSlot.tsx`
- Modify: `components/ads/AdSenseBanner.tsx`
- Modify: `components/ads/AdfitBanner.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`
- Create: `tests/stats-ad-placements.test.ts`
- Create: `tests/responsive-ad-slot.test.ts`
- Create: `tests/ad-provider-initialization.test.ts`
- Create: `tests/stats-auto-ads-boundary.test.ts`

**Interfaces:**
- Produces: `AdViewportClass`, `useAdViewportClass`, `StatsAdPlacementId`, `createStatsAdPlacements`, `selectStatsAdCreative`, `getStatsFeedSlots`, `ResponsiveAdSlot`.
- Consumes: 기존 AdSense client `ca-pub-3993032200487955`, fluid slot `4661728917`, layout key `-fb+5w+4e-db+86`, AdFit mobile `DAN-tQGcqmddMC8tPpXA`, top leaderboard `DAN-dPiCxgIGtXKjLPP3`.

- [ ] **Step 1: viewport·registry·provider 초기화 실패 테스트를 작성한다**

```ts
const placements = createStatsAdPlacements({ feedAdfitUnit: "DAN-fixture-stats-feed-728" });
expect(resolveAdViewportClass({ min768: false, min1280: false, min1600: false })).toBe("mobile");
expect(selectStatsAdCreative({ placements, placement: "stats-top", viewportClass: "mobile", renderableMatchCount: 0 }))
  .toMatchObject({ provider: "adfit", width: 320, height: 100 });
expect(getStatsFeedSlots({ placements, viewportClass: "mobile", renderableMatchCount: 6 })).toEqual([]);
expect(getStatsFeedSlots({ placements, viewportClass: "mobile", renderableMatchCount: 7 }).map((x) => x.afterMatchCount)).toEqual([6]);
expect(getStatsFeedSlots({ placements, viewportClass: "tablet", renderableMatchCount: 16 }).map((x) => x.afterMatchCount)).toEqual([5, 10, 15]);

const withoutFeedAdfit = createStatsAdPlacements({ feedAdfitUnit: undefined });
expect(getStatsFeedSlots({ placements: withoutFeedAdfit, viewportClass: "tablet", renderableMatchCount: 16 }).map((x) => x.afterMatchCount)).toEqual([5, 15]);
```

표 기반 테스트로 mobile `6→[]`, `7→[6]`, tablet/desktop/wide `5→[]`, `6→[5]`, `10→[5]`, `11→[5,10]`, `15→[5,10]`, `16→[5,10,15]`를 고정한다. jsdom 컴포넌트 테스트는 `unknown`에서 provider mock 0회와 `mobile-only`/`tablet-up` class·data만 확인하고, `renderToString → hydrateRoot → viewport resolve` 과정의 hydration error 0건과 활성 creative 하나를 검증한다. 실제 100/90/130px 예약 높이는 Task 10 Puppeteer에서 측정한다. provider 테스트는 local/test 외부 script 0개, `AdSenseBanner`가 main script를 추가하지 않음, `<StrictMode>`와 같은 creative signature 두 렌더에서도 live Kakao area·`ba.min.js`가 한 개인지 검증한다.

- [ ] **Step 2: 신규 광고 테스트가 현재 구현에서 실패하는지 확인한다**

Run: `npx vitest run tests/stats-ad-placements.test.ts tests/responsive-ad-slot.test.ts tests/ad-provider-initialization.test.ts tests/stats-auto-ads-boundary.test.ts`

Expected: FAIL because registry/hook/slot are missing and `AdSenseBanner` still appends a main script fallback.

- [ ] **Step 3: viewport와 광고 레지스트리를 구현한다**

```ts
export type AdViewportClass = "unknown" | "mobile" | "tablet" | "desktop" | "wide";
export type StatsAdPlacementId = "stats-top" | "stats-mobile-after-6" | "stats-after-5" | "stats-after-10" | "stats-after-15";

export type AdFitCreative = Readonly<{
  provider: "adfit";
  adUnit: string;
  width: 320 | 728;
  height: 100 | 90;
}>;

export type AdSenseFluidCreative = Readonly<{
  provider: "adsense";
  client: string;
  slot: string;
  format: "fluid";
  layoutKey: string;
  minHeight: 130;
}>;

export type ManualAdCreative = AdFitCreative | AdSenseFluidCreative;
export type AdReservationVisibility = "all" | "mobile-only" | "tablet-up";

export interface StatsAdPlacement {
  id: StatsAdPlacementId;
  provider: "adfit" | "adsense";
  afterMatchCount: 5 | 6 | 10 | 15 | null;
  minRenderableMatches: 0 | 6 | 7 | 11 | 16;
  reservation: "responsive-horizontal" | "fluid-infeed" | "tablet-horizontal";
  reservationVisibility: AdReservationVisibility;
  creatives: Partial<Record<Exclude<AdViewportClass, "unknown">, ManualAdCreative>>;
}

export interface StatsFeedSlot {
  placement: Exclude<StatsAdPlacementId, "stats-top">;
  provider: "adfit" | "adsense";
  afterMatchCount: 5 | 6 | 10 | 15;
  reservationVisibility: Exclude<AdReservationVisibility, "all">;
  state: "reserved" | "mounted";
}

export function createStatsAdPlacements(config: { feedAdfitUnit?: string }): Readonly<Record<StatsAdPlacementId, StatsAdPlacement | null>>;
export type StatsAdRegistry = ReturnType<typeof createStatsAdPlacements>;

export function selectStatsAdCreative(input: {
  placements: StatsAdRegistry;
  placement: StatsAdPlacementId;
  viewportClass: AdViewportClass;
  renderableMatchCount: number;
}): ManualAdCreative | null;

export function getStatsFeedSlots(input: {
  placements: StatsAdRegistry;
  viewportClass: AdViewportClass;
  renderableMatchCount: number;
}): readonly StatsFeedSlot[];

export interface ResponsiveAdSlotProps {
  placement: StatsAdPlacementId;
  viewportClass: AdViewportClass;
  renderableMatchCount?: number;
  className?: string;
}

export function useAdViewportClass(): AdViewportClass {
  return useSyncExternalStore(subscribeToAdMediaQueries, readAdViewportSnapshot, () => "unknown");
}
```

`stats-after-10`의 creative는 `process.env.NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT`이 비어 있으면 `null`이다. 상단 `DAN-dPiCxgIGtXKjLPP3`를 중간 슬롯에 재사용하지 않는다. `getStatsFeedSlots`는 모바일과 tablet+ 규칙을 별도 분기로 구현하고 renderable count를 기준으로 마지막 광고를 방지한다.

default registry는 `createStatsAdPlacements({ feedAdfitUnit: process.env.NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT })`로 만들되 테스트는 factory 인자를 직접 전달한다. `getStatsFeedSlots({ viewportClass: "unknown" })`는 provider creative 없이 mobile-only after-6과 tablet-up after-5/15 예약 token을 반환하고, feed AdFit unit이 설정된 경우에만 tablet-up after-10도 반환한다. CSS media query가 현재 화면의 예약 token 하나 또는 두세 개만 높이를 갖게 하고 inactive token은 `display:none`이다. resolved viewport에서는 활성 token만 남기며 creative가 `null`이면 즉시 `null`을 반환해 빈 mounted 컨테이너를 만들지 않는다.

- [ ] **Step 4: `ResponsiveAdSlot`과 예약 CSS를 구현한다**

```tsx
<div
  aria-label="광고"
  className={`stats-ad-slot stats-ad-slot--${reservation} stats-ad-slot--${reservationVisibility}`}
  data-ad-placement={placement}
  data-ad-provider={creative?.provider ?? registeredProvider}
  data-ad-visibility={reservationVisibility}
  data-ad-state={viewportClass === "unknown" ? "reserved" : "mounted"}
>
  {creative?.provider === "adfit" && <AdfitBanner key={`${placement}:${creative.adUnit}:${creative.width}x${creative.height}`} placementId={placement} adUnit={creative.adUnit} adWidth={creative.width} adHeight={creative.height} />}
  {creative?.provider === "adsense" && <AdSenseBanner placementId={placement} client={creative.client} slot={creative.slot} format="fluid" layoutKey={creative.layoutKey} minHeight={130} />}
</div>
```

`.stats-page` 아래에 mobile 320×100, tablet+ 728×90, fluid `min-height:130px` 예약 규칙을 작성한다. `.stats-ad-slot--mobile-only`는 기본 표시·768px 이상 숨김, `.stats-ad-slot--tablet-up`은 기본 숨김·768px 이상 표시로 고정한다. 설정이 없는 중간 AdFit은 컨테이너도 반환하지 않는다.

- [ ] **Step 5: provider 소유권을 고친다**

`AdSenseBanner`는 `document.head.appendChild(mainScript)` fallback을 제거하고 `NODE_ENV !== "production"`이면 placeholder만 렌더한다. `AdfitBanner`는 `placementId:adUnit:widthxheight` creative signature를 DOM owner key로 사용해 같은 creative의 두 인스턴스·StrictMode effect가 겹쳐도 Kakao area와 script를 하나만 만든다. 767→768px 전환은 React `key`로 기존 creative를 정리한 뒤 새 unit·width·height를 초기화하고, 최종 Kakao area/script가 하나이며 새 data attribute를 갖는지 테스트한다. `StatsPageShell`/`MatchFeed` 통합 테스트도 live `data-ad-placement` 값의 유일성을 검증한다. Kakao 단위별 script 방식은 유지한다. 각 provider effect는 초기화 예외를 내부에서 흡수해 콘텐츠와 다른 provider로 전파하지 않는다. `app/layout.tsx`는 production일 때만 `id="adsbygoogle-main-js"` 한 개를 렌더하고 local/test에서는 script DOM도 만들지 않는다.

- [ ] **Step 6: 광고 테스트와 core 검증을 통과시킨다**

Run: `npx vitest run tests/stats-ad-placements.test.ts tests/responsive-ad-slot.test.ts tests/ad-provider-initialization.test.ts tests/stats-auto-ads-boundary.test.ts && npm run verify:core`

Expected: PASS, TypeScript error 0. 기존 경고는 새로 증가하지 않는다.

- [ ] **Step 7: commit한다**

```bash
git add hooks/useAdViewportClass.ts lib/ads/statsAdPlacements.ts components/ads/ResponsiveAdSlot.tsx components/ads/AdSenseBanner.tsx components/ads/AdfitBanner.tsx app/layout.tsx app/globals.css tests/stats-ad-placements.test.ts tests/responsive-ad-slot.test.ts tests/ad-provider-initialization.test.ts tests/stats-auto-ads-boundary.test.ts
git commit -m "feat(ads): 전적 페이지 반응형 광고 경계 추가"
```

---

### Task 6: 프로필 헤더·controlled 통계 레일·AI 요약

**Files:**
- Create: `components/stat/profile/PlayerProfileHeader.tsx`
- Create: `components/stat/overview/StatsSectionTabs.tsx`
- Create: `components/stat/overview/StatsOverviewControls.tsx`
- Create: `components/stat/overview/StatsOverviewRail.tsx`
- Modify: `components/stat/StatSummaryPanel.tsx`
- Modify: `components/stat/RecentAISummary.tsx`
- Modify: `components/stat/StatSearch.tsx`
- Create: `tests/fixtures/stats/ai-ready.json`
- Create: `tests/player-profile-header.test.ts`
- Create: `tests/stat-summary-panel.test.ts`
- Create: `tests/recent-ai-summary-bridge.test.ts`

**Interfaces:**
- Consumes: Task 2의 `StatsOverviewMetrics`와 Task 3의 controlled state callbacks.
- Produces: canonical rank가 한 번만 렌더되는 `PlayerProfileHeader`, controlled controls, `AiSummarySnapshot` callback.

- [ ] **Step 1: 프로필·6개 통계 조합·AI callback 실패 테스트를 작성한다**

```ts
expect(screen.getAllByText("현재 랭크")).toHaveLength(1);
expect(screen.getByText("FixtureNickname")).toHaveAttribute("title", "FixtureNickname");

for (const mode of ["ranked", "normal"] as const) {
  for (const partySize of ["solo", "duo", "squad"] as const) {
    rerenderPanel({ mode, partySize });
    expect(screen.getByTestId("rounds-played")).toHaveTextContent(expected[mode][partySize]);
  }
}

expect(onSummaryChange).toHaveBeenLastCalledWith({
  verdict: "fixture verdict",
  tier: "A",
});

const finalJson = JSON.stringify(aiReady);
fetchMock.mockResolvedValueOnce(new Response([
  JSON.stringify({ type: "visuals", data: { overallTier: "A" } }),
  JSON.stringify({ type: "final", data: finalJson }),
  JSON.stringify({ type: "done", valid: true }),
  "",
].join("\n"), { headers: { "Content-Type": "application/x-ndjson" } }));
```

- [ ] **Step 2: 현재 내부 상태·rank 중복 구조로 테스트가 실패하는지 확인한다**

Run: `npx vitest run tests/player-profile-header.test.ts tests/stat-summary-panel.test.ts tests/recent-ai-summary-bridge.test.ts`

Expected: FAIL because the new components and callback do not exist.

- [ ] **Step 3: 프로필과 controls를 구현한다**

```ts
export interface PlayerProfileHeaderProps {
  player: PlayerStatsResponse;
  seasonId: string;
  refreshing: boolean;
  isRefreshCoolingDown: boolean;
  refreshAvailableAt?: number;
  favorite: boolean;
  onSeasonChange(value: string): void;
  onRefresh(): void;
  onFavoriteToggle(): void;
  onCompare(): void;
  onWeapons(): void;
}

export interface StatsOverviewControlsProps {
  mode: StatsMode;
  partySize: StatsPartySize;
  onModeChange(value: StatsMode): void;
  onPartySizeChange(value: StatsPartySize): void;
}

export interface StatSummaryPanelProps {
  stats: PlayerStatsResponse["stats"];
  mode: StatsMode;
  partySize: StatsPartySize;
  aiSummary: AiSummarySnapshot | null;
  aiExpanded: boolean;
  onModeChange(value: StatsMode): void;
  onPartySizeChange(value: StatsPartySize): void;
  onAiOpen(): void;
  onAiToggle(): void;
}

export interface StatsSectionTabsProps {
  value: StatsSectionTab;
  onChange(value: StatsSectionTab): void;
}

export interface StatsOverviewRailProps {
  metrics: StatsOverviewMetrics;
  aiSummary: AiSummarySnapshot | null;
  aiExpanded: boolean;
  onAiOpen(): void;
  onAiToggle(): void;
}
```

헤더는 `selectCanonicalRankBucket`으로 기록이 있는 `ranked.squad → ranked.duo → ranked.solo` 첫 bucket의 tier/RP를 canonical 표시한다. 레일에서는 tier 블록을 제거한다. 시즌·갱신·즐겨찾기·비교·무기 버튼은 44px hit area와 명확한 `aria-label`을 제공하며 비교·무기 이동은 Task 2의 URL builder를 사용한다.

- [ ] **Step 4: controlled 요약 레일을 구현한다**

`StatSummaryPanel`의 내부 `mode`, `gameType`을 제거하고 위 controlled props를 받는다. 내부에서 `StatsOverviewControls`와 `StatsOverviewRail`을 조립한다. `StatsOverviewRail`은 게임 수, KDA, 평균 딜량, Top 10, 선호 모드와 empty 상태를 카드 중첩 없이 렌더한다. `<768px` 2×2, `768~1023px` 4열, `>=1024px` 320px 레일 규칙을 사용한다.

- [ ] **Step 5: 기존 AI 결과를 compact 요약으로 연결한다**

```ts
export interface AiSummarySnapshot { verdict: string; tier?: string; }
export interface RecentAISummaryProps {
  matchIds: readonly string[];
  nickname: string;
  platform: string;
  isMobile?: boolean;
  onSummaryChange?(summary: AiSummarySnapshot | null): void;
}
```

nickname/platform/matchIds identity가 바뀌면 먼저 `onSummaryChange?.(null)`을 호출한다. `debateData`가 바뀌어도 `typeof debateData.finalVerdict === "string" && debateData.finalVerdict.trim().length > 0`일 때만 finalVerdict와 `visuals.overallTier`을 callback으로 내보내 incomplete visuals event에서 undefined verdict를 만들지 않는다. 새 API나 자동 AI 호출은 추가하지 않는다. 레일은 결과 전에는 `AI 분석 시작` CTA로 기존 전체 섹션에 스크롤하고, 결과 뒤에는 2/3줄 clamp와 `더보기`를 제공한다.

Task 6 안에서 기존 `StatSearch` 호출부를 controller state와 local `aiSummary/aiExpanded` state를 넘기는 controlled `StatSummaryPanel`로 즉시 바꿔 이 task commit 자체가 compile되게 한다. Task 9는 이 조립을 새 shell로 이동한다.

- [ ] **Step 6: 관련 테스트를 통과시킨다**

Run: `npx vitest run tests/player-profile-header.test.ts tests/stat-summary-panel.test.ts tests/recent-ai-summary-bridge.test.ts`

Expected: PASS.

- [ ] **Step 7: commit한다**

```bash
git add components/stat/profile/PlayerProfileHeader.tsx components/stat/overview/StatsSectionTabs.tsx components/stat/overview/StatsOverviewControls.tsx components/stat/overview/StatsOverviewRail.tsx components/stat/StatSummaryPanel.tsx components/stat/RecentAISummary.tsx components/stat/StatSearch.tsx tests/fixtures/stats/ai-ready.json tests/player-profile-header.test.ts tests/stat-summary-panel.test.ts tests/recent-ai-summary-bridge.test.ts
git commit -m "feat(stats): 프로필과 핵심 통계 레일 구성"
```

---

### Task 7: 매치 피드·접힌 행·상세 오류 격리

**Files:**
- Create: `components/stat/matches/MatchFeed.tsx`
- Create: `components/stat/matches/CompactMatchRow.tsx`
- Create: `components/stat/matches/ExpandedMatchDetails.tsx`
- Modify: `components/stat/MatchCard.tsx`
- Create: `tests/match-feed-ad-placement.test.ts`
- Modify: `tests/match-card-demand-loading.test.ts`
- Create: `tests/match-card-detail-state.test.ts`

**Interfaces:**
- Consumes: Task 2 `filterRenderableMatches`, Task 5 `getStatsFeedSlots`·`ResponsiveAdSlot`.
- Produces: `MatchFeedProps`, `CompactMatchRowProps`, `ExpandedMatchDetailsProps`.
- Preserves: `/api/pubg/match`, `/api/pubg/ai-analyze`, telemetry, map, replay contracts and expand-on-demand behavior.

```ts
export interface CompactMatchRowProps {
  summary: MatchSummaryData;
  isExpanded: boolean;
  onToggle(): void;
}

export interface ExpandedMatchDetailsProps {
  matchId: string;
  nickname: string;
  platform: StatsPlatform;
  summary: MatchSummaryData;
  isMobile: boolean;
  onNicknameClick?(nickname: string): void;
  onModeDetected?(matchId: string, gameMode: string, matchType?: string, mapName?: string): void;
  onFailure?(reason: "detail_failed" | "analysis_failed"): void;
  onRecovery?(reason: "detail_failed" | "analysis_failed"): void;
}
```

- [ ] **Step 1: DOM 순서와 상세 실패 테스트를 작성한다**

```ts
expect(renderFeed({ viewportClass: "mobile", matchCount: 7 }).ids()).toEqual([
  "match-1", "match-2", "match-3", "match-4", "match-5", "match-6",
  "ad-stats-mobile-after-6", "match-7",
]);
expect(renderFeed({ viewportClass: "tablet", matchCount: 16 }).adAfterCounts()).toEqual([5, 10, 15]);
expect(renderFeed({ viewportClass: "tablet", matchCount: 5 }).adAfterCounts()).toEqual([]);

fireEvent.click(screen.getByRole("button", { name: "매치 상세 펼치기" }));
await screen.findByText("상세 정보를 불러오지 못했습니다");
expect(screen.getByText("요약 fixture")).toBeVisible();
fireEvent.click(screen.getByRole("button", { name: "상세 다시 시도" }));
expect(matchRequests()).toHaveLength(2);
```

- [ ] **Step 2: 현재 인덱스 하드코딩과 오류 UI 부재로 실패하는지 확인한다**

Run: `npx vitest run tests/match-feed-ad-placement.test.ts tests/match-card-demand-loading.test.ts tests/match-card-detail-state.test.ts`

Expected: FAIL on mobile after-6, no-trailing-ad, detail error/retry.

- [ ] **Step 3: `MatchFeed`를 구현한다**

```ts
export interface MatchFeedProps {
  matchIds: readonly string[];
  summaries: Record<string, MatchSummaryData>;
  missingMatchIds: ReadonlySet<string>;
  matchModeMeta: Record<string, StatsMatchModeMeta>;
  summaryStatus: "idle" | "loading" | "ready" | "error";
  filter: StatsMatchFilter;
  viewportClass: AdViewportClass;
  nickname: string;
  platform: StatsPlatform;
  onFilterChange(value: StatsMatchFilter): void;
  onRetrySummaries(): void;
  onNicknameClick(name: string): void;
  onModeDetected(matchId: string, gameMode: string, matchType?: string, mapName?: string): void;
}
```

누락 summary를 먼저 제외하고 filter를 적용한 `renderableMatches`로 광고 삽입점을 계산한다. viewport `unknown`이면 after-5/6/10/15 예약 token을 해당 match 사이에 넣고 CSS visibility로 현재 화면 공간만 확보한다. resolved 뒤에는 활성 광고 token만 유지한다. `summaryStatus="loading"`은 compact skeleton, `error`는 매치 영역 상단 인라인 재시도, 필터 결과 0개는 필터별 empty 문구를 표시한다.

- [ ] **Step 4: `MatchCard`를 controller/facade로 유지하며 표시 경계를 추출한다**

`MatchCard`는 `initialMatchData` summary, `isExpanded`, `hasExpandedOnce`만 소유하는 facade로 축소한다. 최초 open 때 `hasExpandedOnce=true`로 만들고 이후 `<ExpandedMatchDetails>`는 계속 mount한 채 접힌 동안 `hidden`과 `aria-hidden`으로만 감춰 상세·AI state와 full-match 캐시를 보존한다. `CompactMatchRow`는 순위, 맵·유형, 킬·피해·DBNO·생존, AI 등급, 상태 텍스트·왼쪽 선과 `aria-expanded` 버튼만 렌더한다. 현재 compact 영역에 섞인 tier 근거 tooltip, replay quick action, 팀·무기·지도·AI 버튼은 모두 상세로 이동한다.

`ExpandedMatchDetails`는 full-match `MatchDetailState`, AbortController/requestId, 기존 line 559~1006의 파생값·AI state/handler와 line 1402 이후 상세 JSX를 함께 소유한다. 따라서 identity+summary props만으로 내부에서 전체 데이터를 만들며 `MatchData`나 수십 개 계산 callback을 facade에서 전달하지 않는다. 팀 목록, 무기 통계, 티어 근거, 지도, AI, 2D/3D replay의 기존 payload와 lazy 조건을 그대로 옮기고 각각 fixture assertion을 추가한다.

`tests/match-card-detail-state.test.ts`는 상세 성공 fixture로 `팀원`, `무기 사용`, `티어 산정 근거`, 지도 container, AI 분석 CTA/finalVerdict, `2D 리플레이`, `3D 리플레이`를 각각 찾고 route/payload가 기존 값과 같은지 검증한다. 최초 compact mount에서는 이 상세 selector와 `/api/pubg/match` 요청이 모두 없어야 한다.

- [ ] **Step 5: 상세 요청에 abort·requestId·오류·재시도를 추가한다**

```ts
type MatchDetailState =
  | { status: "summary" }
  | { status: "loading" }
  | { status: "ready"; data: MatchData }
  | { status: "error"; message: string };
```

expand 전에는 full-match 요청을 하지 않는다. matchId/nickname/platform 변경과 unmount에서 abort하고 늦은 응답을 무시한다. 오류 시 compact summary를 유지하며 상세 영역만 retry한다. AI·telemetry 오류도 해당 섹션 callback으로 `analysis_failed`를 알리고 다른 행을 유지한다.

- [ ] **Step 6: 매치 테스트와 기존 만료 정책을 통과시킨다**

Run: `npx vitest run tests/match-feed-ad-placement.test.ts tests/match-card-demand-loading.test.ts tests/match-card-detail-state.test.ts tests/stat-search-ui.test.ts`

Expected: PASS. 감사 문서의 match filter와 상세 retry 항목을 `fixed`로 갱신한다.

- [ ] **Step 7: commit한다**

```bash
git add components/stat/matches/MatchFeed.tsx components/stat/matches/CompactMatchRow.tsx components/stat/matches/ExpandedMatchDetails.tsx components/stat/MatchCard.tsx tests/match-feed-ad-placement.test.ts tests/match-card-demand-loading.test.ts tests/match-card-detail-state.test.ts docs/reviews/2026-08-10-stats-search-regression-audit.md
git commit -m "feat(stats): 매치 피드와 상세 오류 상태 분리"
```

---

### Task 8: 스쿼드 최신 응답 우선과 fallback 경기 시각 버그

**Files:**
- Modify: `components/stat/SquadAnalysisPanel.tsx`
- Modify: `components/stat/StatSearch.tsx`
- Modify: `app/api/pubg/matches-summary/route.ts`
- Modify: `lib/pubg-analysis/matchSummary.ts`
- Create: `tests/squad-analysis-panel-state.test.ts`
- Create: `tests/matches-summary-route.test.ts`
- Modify: `tests/stat-search-deep-link.test.ts`
- Modify: `tests/client-data-fetch-error-ui.test.ts`

**Interfaces:**
- Consumes: controlled `groupKey?: string` and `setGroupKey` from the page controller.
- Produces: controlled `SquadAnalysisPanelProps`.
- Preserves: 기존 `/api/pubg/squad-analyze` 목록·상세·AI 분석 응답.

```ts
export interface SquadAnalysisPanelProps {
  nickname: string;
  platform: StatsPlatform;
  groupKey?: string;
  onGroupKeyChange(value: string): void;
}
```

- [ ] **Step 1: group stale와 fallback createdAt 실패 테스트를 작성한다**

```ts
it("group 변경 시 이전 상세 응답을 무시한다", async () => {
  const first = deferredJson(group1Detail);
  const second = deferredJson(group2Detail);
  renderSquad({ groupKey: "g1", onGroupKeyChange, detailResponses: [first, second] });
  fireEvent.change(screen.getByLabelText("스쿼드 그룹"), { target: { value: "g2" } });
  second.resolve();
  first.resolve();
  expect(await screen.findByText("group2 detail")).toBeVisible();
  expect(screen.queryByText("group1 detail")).not.toBeInTheDocument();
});

expect(fallbackSummary.createdAt).toBe("2026-07-01T10:00:00.000Z");
```

- [ ] **Step 2: 현재 요청과 fallback select에서 실패하는지 확인한다**

Run: `npx vitest run tests/squad-analysis-panel-state.test.ts tests/matches-summary-route.test.ts tests/stat-search-deep-link.test.ts`

Expected: FAIL on late group response and raw fallback timestamp.

- [ ] **Step 3: 스쿼드 groupKey와 요청 경계를 구현한다**

controller의 `groupKey`를 controlled 값으로 사용하고 유효하지 않으면 첫 group을 `onGroupKeyChange`로 올린다. group 목록, 상세, AI 요청 각각 AbortController/requestId를 사용하며 현재 `groupKey`와 일치하는 응답만 반영한다. overview로 전환해 panel이 unmount돼도 controller의 groupKey가 남아 다시 squad로 돌아올 때 같은 group을 연다. 공유 URL의 `tab=squad&groupKey=...` 생성 계약은 유지한다.

같은 Task에서 기존 `StatSearch` 호출은 `groupKey={controller.groupKey}`와 `onGroupKeyChange={controller.setGroupKey}`를 넘기고, 기존 `client-data-fetch-error-ui` 렌더 helper는 `groupKey={undefined}`와 `onGroupKeyChange={() => {}}`를 넘겨 독립 compile을 유지한다.

- [ ] **Step 4: raw fallback 시각을 원본에서 보존한다**

`match_stats_raw` select에 `created_at`을 포함한다. `buildBasicMatchSummary` 입력 타입은 `played_at?: string; created_at?: string`을 허용하고 `createdAt: row.played_at ?? row.created_at ?? new Date().toISOString()`로 매핑한다. `created_at`은 실제 경기시각이 아니라 DB 저장시각이므로 원본 `played_at` 부재 시 매 요청마다 현재시각을 새로 만드는 일을 막는 안정 fallback으로만 사용한다. 14일·90일 만료 정책 테스트를 함께 실행한다.

- [ ] **Step 5: 테스트를 통과시킨다**

Run: `npx vitest run tests/squad-analysis-panel-state.test.ts tests/matches-summary-route.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-ui.test.ts`

Expected: PASS. 감사 문서의 group stale와 fallback createdAt을 `fixed`로 갱신한다.

- [ ] **Step 6: commit한다**

```bash
git add components/stat/SquadAnalysisPanel.tsx components/stat/StatSearch.tsx app/api/pubg/matches-summary/route.ts lib/pubg-analysis/matchSummary.ts tests/squad-analysis-panel-state.test.ts tests/matches-summary-route.test.ts tests/stat-search-deep-link.test.ts tests/client-data-fetch-error-ui.test.ts docs/reviews/2026-08-10-stats-search-regression-audit.md
git commit -m "fix(stats): 스쿼드 응답과 매치 시각 일관성 보장"
```

---

### Task 9: `StatsPageShell` 최종 조립과 route-scoped 디자인

**Files:**
- Create: `components/stat/layout/StatsPageShell.tsx`
- Create: `components/stat/layout/StatsPageStates.tsx`
- Modify: `components/stat/StatSearch.tsx`
- Modify: `app/stats/page.tsx`
- Modify: `app/stats/[platform]/[nickname]/page.tsx`
- Modify: `app/globals.css`
- Create: `tests/stats-page-shell.test.ts`
- Create: `tests/stats-layout-boundary.test.ts`

**Interfaces:**
- Consumes: Tasks 3–8의 controller, 검색, 헤더, overview, match, squad, ads 컴포넌트.
- Produces: `StatsPageShellProps { initialPlatform?: string; initialNickname?: string; initialTab?: StatsSectionTab; initialGroupKey?: string }`.
- `StatSearch`는 동일 props를 받아 `StatsPageShell`만 반환하는 호환 export가 된다.

```ts
export interface StatsPageShellProps {
  initialPlatform?: string;
  initialNickname?: string;
  initialTab?: StatsSectionTab;
  initialGroupKey?: string;
}

export interface StatsPageStatesProps {
  status: StatsPageStatus;
  error: StatsPageController["error"];
  suggestedPlayers: StatsPageController["suggestedPlayers"];
  hasResult: boolean;
  onRetry(): void;
  onSuggestedPlayer(value: { nickname: string; platform: StatsPlatform }): void;
}
```

- [ ] **Step 1: 상태·레이아웃·광고 안전 영역 실패 테스트를 작성한다**

```ts
expect(renderShell({ status: "idle" })).toHaveLandingOrder(["search", "quick-links", "top-ad"]);
expect(renderShell({ status: "loading" })).toHaveAccessibleStatus("플레이어 전적을 불러오는 중");
expect(renderShell({ status: "partial" })).toKeepVisible(["player-header", "stats-overview", "match-retry"]);
expect(screen.getByTestId("stats-auto-ads-boundary"))
  .toHaveAttribute("google-side-rail-overlap", "false");
expect(source).not.toContain("STATS_DESKTOP_AD_UNIT");
expect(source).not.toContain('slot="7728921550"');
```

- [ ] **Step 2: 테스트를 실행해 셸 부재와 기존 수동 레일을 확인한다**

Run: `npx vitest run tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stats-auto-ads-boundary.test.ts`

Expected: FAIL because the shell does not exist and manual 160×600 rails remain.

- [ ] **Step 3: 셸을 조립한다**

```tsx
<main
  className="stats-page stats-auto-ads-excluded min-h-full w-full bg-[#0d0d0d] text-white"
  data-testid="stats-auto-ads-boundary"
  {...({ "google-side-rail-overlap": "false" } as Record<"google-side-rail-overlap", string>)}
>
  <StatsSearchBar {...searchProps} />
  {status === "idle" && <StatsLandingState onCompare={() => router.push("/stats/battle")} />}
  <StatsPageStates
    status={status}
    error={controller.error}
    suggestedPlayers={controller.suggestedPlayers}
    hasResult={Boolean(result)}
    onRetry={() => void controller.search()}
    onSuggestedPlayer={navigateToPlayer}
  />
  {result && <PlayerProfileHeader {...profileProps} />}
  <ResponsiveAdSlot placement="stats-top" viewportClass={viewportClass} />
  {result && <StatsSectionTabs value={sectionTab} onChange={controller.setSectionTab} />}
  {result && sectionTab === "overview" && (
    <div className="stats-result-grid">
      <StatSummaryPanel
        stats={result.stats}
        mode={controller.statsMode}
        partySize={controller.partySize}
        aiSummary={aiSummary}
        aiExpanded={aiExpanded}
        onModeChange={controller.setStatsMode}
        onPartySizeChange={controller.setPartySize}
        onAiOpen={scrollToRecentAiSummary}
        onAiToggle={() => setAiExpanded((value) => !value)}
      />
      <MatchFeed {...matchFeedProps} />
    </div>
  )}
  {result && sectionTab === "squad" && <SquadAnalysisPanel groupKey={groupKey} onGroupKeyChange={controller.setGroupKey} {...squadProps} />}
  {result && sectionTab === "overview" && (
    <section id="recent-ai-analysis">
      <RecentAISummary {...recentAiProps} onSummaryChange={setAiSummary} />
    </section>
  )}
</main>
```

검색 전체 오류만 결과 영역을 대체한다. refreshing은 기존 결과 위 인라인 상태, partial은 실패 영역만 표시한다. 상위 탭은 헤더 아래 공통 위치에서 overview/squad 모두 접근 가능하게 둔다.

`StatsPageShell`은 `useStatsAutocomplete(controller.nickname)`, `useStatsSearchHistory()`, `useStatsProfilePrefill(user?.id)`를 호출한다. idle이고 검색 입력이 비어 있을 때만 prefill을 적용하고, `result` identity가 처음 ready가 될 때 `addRecent(result.nickname)`을 한 번 호출한다. `navigateToPlayer`는 search/quick/suggestion/row nickname의 유일한 route-first 함수다.

- [ ] **Step 4: BGMS balanced 스타일을 route 범위로 적용한다**

`app/globals.css`의 `.stats-page` 아래에 배경 `#0d0d0d`, 카드 `#161616`, 강조 표면 `#1f1f1f`, accent `#F2A900`, border `rgba(255,255,255,0.08)`, 본문/보조/비활성 흰색 100%/60%/30%, 양호 `#2dd4bf`, 저성과·오류 `#ef6b6b`을 적용한다. 제목 24/32px, 닉네임 모바일 20/28px·desktop 24/32px, 핵심 수치 20/24px, 라벨 11/16px, 매치 14/20px·12/18px을 사용한다. max-width 1,200, gap 8/16, 1024px `320px minmax(0,1fr)`, 44px hit area, nickname ellipsis, AI line clamp, BottomNav safe padding을 구현하고 카드 안 카드 중첩을 제거한다. AI 보라 강조는 한 카드와 등급에만 사용한다.

- [ ] **Step 5: 기존 entry와 manual rails를 정리한다**

`StatSearch.tsx`는 `export default function StatSearch(props) { return <StatsPageShell {...props} />; }`만 남긴다. CSS-hidden 320/728 쌍, 수동 160×600 AdFit/AdSense 양쪽 aside, 직접 광고 ID와 인덱스 조건을 제거한다.

- [ ] **Step 6: 셸·기능 회귀 테스트를 통과시킨다**

Run: `npx vitest run tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stats-auto-ads-boundary.test.ts tests/stat-search-baseline.test.ts tests/stat-search-deep-link.test.ts tests/stat-summary-panel.test.ts tests/stat-match-filter.test.ts`

Expected: PASS. `stats-page-shell`은 실제 controls를 클릭해 ranked/normal × solo/duo/squad 여섯 조합의 fixture 수치가 바뀌고 매치 filter 선택은 그대로 유지되는지 통합 검증한다.

- [ ] **Step 7: commit한다**

```bash
git add components/stat/layout/StatsPageShell.tsx components/stat/layout/StatsPageStates.tsx components/stat/StatSearch.tsx app/stats/page.tsx 'app/stats/[platform]/[nickname]/page.tsx' app/globals.css tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts
git commit -m "feat(stats): OP.GG형 전적 결과 셸 완성"
```

---

### Task 10: 브라우저 기능 감사·반응형 광고 QA·완료 보고

**Files:**
- Create: `tests/fixtures/stats/match-detail-ready.json`
- Create: `tests/fixtures/stats/squad-ready.json`
- Create: `tests/fixtures/stats/browserScenarios.ts`
- Create: `tests/helpers/statsBrowserHarness.ts`
- Create: `tests/stats-browser-smoke.test.ts`
- Modify: `docs/reviews/2026-08-10-stats-search-regression-audit.md`
- Modify: `docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md` (코드 QA와 광고 운영 상태를 분리해 기록)

**Interfaces:**
- Consumes: intercepted APIs `/api/pubg/player`, `/api/pubg/suggest`, `/api/pubg/matches-summary`, `/api/pubg/match`, `/api/pubg/squad-analyze`.
- Produces: 동일 fixture 기반 before/after 감사 결과, viewport별 스크린샷 경로, 실제 광고 preview 운영 체크리스트.

```ts
// tests/fixtures/stats/browserScenarios.ts
import playerReady from "./player-ready.json";
import summariesReady from "./matches-summary-ready.json";
import matchReady from "./match-detail-ready.json";
import squadReady from "./squad-ready.json";

export type StatsBrowserScenarioName =
  | "ready" | "not-found" | "rate-limit" | "server"
  | "summary-error" | "detail-error" | "squad" | "expired";

export interface MockHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown): MockHttpResponse => ({ status: 200, body });
const browserMatchIds = Array.from({ length: 16 }, (_, index) => `fixture-match-${index + 1}`);
const baseReadySummary = Object.values(summariesReady.summaries)[0];
const browserSummaries = Object.fromEntries(browserMatchIds.map((matchId, index) => [
  matchId,
  {
    ...baseReadySummary,
    matchId,
    gameMode: index % 4 === 0 ? "tdm" : "squad-fpp",
    matchType: index % 3 === 0 ? "competitive" : "official",
  },
]));
const readyScenario = {
  player: ok({ ...playerReady, recentMatches: browserMatchIds }),
  suggest: ok({ suggestions: [] }),
  summaries: ok({ summaries: browserSummaries, missingMatchIds: [] }),
  match: ok(matchReady),
  squad: [ok(squadReady.groups), ok(squadReady.g1), ok(squadReady.g2)] as const,
};

const squadScenario = { ...readyScenario, squad: [ok(squadReady.groups), ok(squadReady.g1), ok(squadReady.g2)] as const };
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const expiredScenario = {
  ...readyScenario,
  player: ok({ ...playerReady, recentMatches: ["before14", "after14", "after90"] }),
  summaries: ok({
    summaries: {
      before14: { ...baseReadySummary, matchId: "before14", playedAt: daysAgo(13) },
      after14: { ...baseReadySummary, matchId: "after14", playedAt: daysAgo(15) },
      after90: { ...baseReadySummary, matchId: "after90", playedAt: daysAgo(91) },
    },
    missingMatchIds: [],
  }),
};

export const statsBrowserScenarios: Record<StatsBrowserScenarioName, {
  player: MockHttpResponse;
  suggest: MockHttpResponse;
  summaries: MockHttpResponse;
  match: MockHttpResponse;
  squad: readonly MockHttpResponse[];
}> = {
  ready: readyScenario,
  "not-found": { ...readyScenario, player: { status: 404, body: { code: "PLAYER_NOT_FOUND", error: "찾을 수 없음", suggestions: [{ nickname: "FixtureAlt", platform: "kakao" }] } } },
  "rate-limit": { ...readyScenario, player: { status: 429, headers: { "Retry-After": "60" }, body: { error: "호출 한도 초과" } } },
  server: { ...readyScenario, player: { status: 500, body: { error: "fixture server error" } } },
  "summary-error": { ...readyScenario, summaries: { status: 500, body: { error: "fixture summary error" } } },
  "detail-error": { ...readyScenario, match: { status: 500, body: { error: "fixture detail error" } } },
  squad: squadScenario,
  expired: expiredScenario,
};
```

`readyScenario`는 Task 1의 player/summary JSON을 import하고 full-match 팀·무기·tier·map·replay 필드와 AI finalVerdict를 포함한다. `squadScenario.squad`는 같은 `/api/pubg/squad-analyze`에 대한 목록, g1 상세, g2 상세 순서 응답을 갖는다. `expiredScenario`는 14일 경계 전·후와 90일 이후 `playedAt`을 가진 세 summary를 갖는다.

```ts
// tests/helpers/statsBrowserHarness.ts
import type { Page } from "puppeteer";
import { statsBrowserScenarios, type StatsBrowserScenarioName } from "../fixtures/stats/browserScenarios";

export async function installStatsApiInterception(page: Page, scenarioName: StatsBrowserScenarioName) {
  const scenario = statsBrowserScenarios[scenarioName];
  const squadQueue = [...scenario.squad];
  await page.setRequestInterception(true);
  page.removeAllListeners("request");
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    const response = pathname === "/api/pubg/player" ? scenario.player
      : pathname === "/api/pubg/suggest" ? scenario.suggest
      : pathname === "/api/pubg/matches-summary" ? scenario.summaries
      : pathname === "/api/pubg/match" ? scenario.match
      : pathname === "/api/pubg/squad-analyze" ? (squadQueue.shift() ?? scenario.squad.at(-1)!)
      : null;
    if (!response) return void request.continue();
    return void request.respond({
      status: response.status,
      contentType: "application/json",
      headers: response.headers,
      body: JSON.stringify(response.body),
    });
  });
}

export async function openFixtureStats(page: Page, path: string, scenario: StatsBrowserScenarioName = "ready") {
  await installStatsApiInterception(page, scenario);
  await page.goto(`${process.env.STATS_BASE_URL ?? "http://127.0.0.1:3000"}${path}`, { waitUntil: "networkidle0" });
}

export const overflowWidth = (page: Page) => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
export const minInteractiveSize = (page: Page) => page.$$eval(".stats-page button, .stats-page a", (nodes) => Math.min(...nodes.filter((node) => (node as HTMLElement).offsetParent !== null).map((node) => Math.min((node as HTMLElement).getBoundingClientRect().width, (node as HTMLElement).getBoundingClientRect().height))));
export const mountedManualAds = (page: Page) => page.$$eval('[data-ad-state="mounted"]', (nodes) => nodes.map((node) => node.getAttribute("data-ad-placement")));
export function expectedAds(width: number, feedAdfitEnabled = true) {
  if (width < 768) return ["stats-top", "stats-mobile-after-6"];
  return ["stats-top", "stats-after-5", ...(feedAdfitEnabled ? ["stats-after-10"] : []), "stats-after-15"];
}
```

- [ ] **Step 1: Puppeteer smoke의 실패 기대를 작성한다**

```ts
import puppeteer, { type Browser, type Page } from "puppeteer";
import { expectedAds, minInteractiveSize, mountedManualAds, openFixtureStats, overflowWidth } from "./helpers/statsBrowserHarness";

const describeBrowser = process.env.RUN_STATS_BROWSER_SMOKE === "true" ? describe : describe.skip;

describeBrowser("stats browser smoke", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => { await browser.close(); });

  it.each([
  [375, 667], [375, 812], [390, 844], [430, 932], [768, 1024], [1280, 720], [1440, 900], [1600, 900], [1920, 1080],
])("%ix%i에서 핵심 흐름과 광고 경계가 유지된다", async (width, height) => {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await openFixtureStats(page, "/stats/steam/FixturePlayer?tab=overview");
  expect(await overflowWidth(page)).toBe(0);
  expect(await minInteractiveSize(page)).toBeGreaterThanOrEqual(44);
  expect(await mountedManualAds(page)).toEqual(expectedAds(width));
  expect(await page.$$eval("#adsbygoogle-main-js", (nodes) => nodes.length)).toBe(0);
  });
});
```

- [ ] **Step 2: dev server를 확인하고 smoke를 실행한다**

Run: `lsof -nP -iTCP:3107 -sTCP:LISTEN`

3107번의 기존 서버는 환경을 신뢰하지 않고 종료하거나 다른 테스트 포트를 선택한다. 새 워크트리에서 `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT=DAN-fixture-stats-feed-728 npm run dev -- --port 3107`로 전용 서버를 시작한다. 로컬 fixture 단위는 provider placeholder만 선택하며 외부 Kakao 요청을 만들지 않는다. `.next/dev/lock`은 서버 확인 전에 삭제하지 않는다.

Run: `RUN_STATS_BROWSER_SMOKE=true STATS_BASE_URL=http://127.0.0.1:3107 npx vitest run tests/stats-browser-smoke.test.ts --testTimeout=30000`

Expected: 첫 실행에서 selector·상태·레이아웃 차이가 있으면 FAIL. 자동화 실패와 실제 UI 실패를 구분해 기록한다.

- [ ] **Step 3: browser에서 기능 감사 매트릭스를 실행한다**

다음 흐름을 scenario를 바꿔 각각 2회 확인한다: 검색 성공, 빈 값·404·429·500, Steam/Kakao, 최근검색·즐겨찾기, 300ms autocomplete abort/empty, 시즌 전환·갱신, overview/squad/groupKey, 6개 통계 조합, 4개 매치 필터, 상세 펼침·500 retry, 14일·90일 만료, 비교·무기 URL, 뒤로가기. 상세 성공 fixture에서는 팀 목록, 무기 통계, 티어 근거, 지도, 비로그인 AI 로그인 CTA와 AI 요청 0건, 2D replay, 3D replay action을 각각 확인한다. authenticated NDJSON AI finalVerdict는 `recent-ai-summary-bridge`와 `match-card-detail-state` 컴포넌트 테스트에서 검증한다. 결과를 감사 문서의 기대·실제·네트워크 열에 기록한다.

- [ ] **Step 4: 모든 viewport에서 시각 QA를 수행한다**

각 viewport에서 프로필·상단 광고·통계·매치 시작점, 1,200px 중앙 셸, 긴 닉네임, empty/loading/error/partial, 44px hit area, line clamp, BottomNav 간섭, 접힘 포커스와 scroll, breakpoint 변경 후 숨은 광고 0개를 확인한다. Puppeteer의 `getBoundingClientRect()`로 mobile top 100px, tablet+ top 90px, fluid 예약 최소 130px과 inactive reservation `display:none`을 측정한다. 1440×900 첫 화면에는 프로필·상단 배너·통계·매치 시작점이 함께 보여야 한다. 1600px 이상은 중앙 셸이 side rail 안전 영역을 유지해야 한다.

- [ ] **Step 5: 로컬 광고와 외부 운영 경계를 검증한다**

로컬 Network에서 `googlesyndication`, `adsbygoogle`, `t1.kakaocdn.net`, `ba.min.js` 요청과 `#adsbygoogle-main-js` DOM이 모두 0인지 확인하고 placeholder 규격만 캡처한다. Preview 빌드 전 배포 환경에 별도 728×90 단위인 `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT`을 등록하고 새 빌드를 만든다. 배포 preview에서는 main script DOM 1개, AdFit/AdSense 실제 slot console error, no-fill이 콘텐츠 오류로 전파되지 않음을 확인한다. AdSense 콘솔 작업은 사용자 또는 별도 승인 브라우저 작업으로 다음을 적용한다.

```text
Side rails: Left and right
Anchor: Top only
In-page excluded selector: .stats-auto-ads-excluded
Preview: /stats and /stats/steam/{fixture-like-real-player}
```

`NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT`이 설정되지 않았으면 tablet+ 16개 매치의 live 광고가 after-5·15만 존재하고 after-10 컨테이너·예약 공간이 없음을 확인한다. 별도 단위 생성 권한이 없으면 안전한 미노출 상태와 필요한 728×90 단위·환경변수 등록을 남은 운영 작업으로 보고한다. 실제 Auto ads preview에서는 375·768·1600px에서 상단 앵커 닫기 버튼이 56px 글로벌 헤더와 검색창을 가리지 않는지 별도 기록한다.

- [ ] **Step 6: 전체 자동 검증을 실행한다**

Run: `npm run verify:core && npx vitest run`

Expected: exit 0, TypeScript/ESLint error 0, 모든 Vitest PASS. 기존 warning 수보다 새 warning이 늘지 않는다.

- [ ] **Step 7: 변경 경계와 금지 패턴을 검사한다**

Run: `rg -n 'STATS_DESKTOP_AD_UNIT|slot="7728921550"|document.head.appendChild\(mainScript\)|setActiveTab\("overview"\)|pathname === .\/stats.' components/stat components/ads components/common app/stats app/layout.tsx`

Expected: no matches for removed legacy patterns.

Run: `git diff --check && git status --short`

Expected: whitespace errors 없음; 계획된 변경만 표시.

- [ ] **Step 8: 감사 문서와 설계 상태를 완료한다**

모든 확정 버그에 regression test와 commit을 연결한다. 의심 항목은 재현 결과에 따라 `fixed`, `not_reproduced`, 또는 증거와 함께 `suspected`로 유지한다. 모바일 QA 결과 또는 미실행 사유를 최종 보고에 반드시 포함한다. dedicated AdFit unit, Preview 실광고, AdSense console 세 항목까지 완료된 경우에만 설계 상태를 `구현 및 QA 완료`로 바꾼다. 하나라도 권한·설정 때문에 남으면 `코드 구현 및 로컬 QA 완료 — 광고 운영 설정 대기`로 기록하고 전체 사용자 요구를 완전 완료했다고 주장하지 않는다.

- [ ] **Step 9: 최종 commit한다**

```bash
git add tests/fixtures/stats/match-detail-ready.json tests/fixtures/stats/squad-ready.json tests/fixtures/stats/browserScenarios.ts tests/helpers/statsBrowserHarness.ts tests/stats-browser-smoke.test.ts docs/reviews/2026-08-10-stats-search-regression-audit.md docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md
git commit -m "test(stats): 전적 리디자인 QA 결과 기록"
```

- [ ] **Step 10: 구현 브랜치 완료 절차를 수행한다**

`superpowers:requesting-code-review`로 명세·계획·감사 문서 대비 리뷰를 받고 P1/P2를 해결한다. 모든 검증이 통과한 뒤 `superpowers:finishing-a-development-branch`로 사용자에게 merge/PR/브랜치 유지 선택지를 제시한다.
