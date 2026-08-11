# Task 9 구현 보고서

## 결과

`StatSearch`를 hook이 없는 호환 wrapper로 축소하고, 기존 controller·history·profile prefill·autocomplete·route-first navigation·AI identity 소유 로직을 `StatsPageShell`로 이동했다. 결과 존재를 rendering authority로 삼아 ready 외 refreshing/partial/error+result에서도 profile·tab·feed를 유지한다.

Shell은 전역 `<main>`을 중첩하지 않는 `<section>` boundary다. route boot 중 landing/top ad flash를 막고, idle landing 또는 result 상태에서만 `stats-top` responsive slot을 정확히 하나 소유한다. 기존 direct AdFit/AdSense, inline mobile/tablet pair, 양쪽 160×600 rail, `7728921550` slot을 page boundary에서 제거했다. Feed 광고 소유는 `MatchFeed`에 남겼다.

## 변경 파일

- 생성: `components/stat/layout/StatsPageShell.tsx`
- 생성: `components/stat/layout/StatsPageStates.tsx`
- 수정: `components/stat/StatSearch.tsx`
- 수정: `components/stat/search/StatsSearchBar.tsx`
- 수정: `app/stats/page.tsx`
- 수정: `app/stats/[platform]/[nickname]/page.tsx`
- 수정: `app/globals.css`
- 생성: `tests/stats-page-shell.test.ts`
- 생성: `tests/stats-layout-boundary.test.ts`
- 수정: `tests/stats-auto-ads-boundary.test.ts`
- 수정: `tests/stat-search-baseline.test.ts`
- 수정: `tests/stat-search-deep-link.test.ts`
- 수정: `tests/stat-search-season-refresh.test.ts`
- 수정: `docs/reviews/2026-08-10-stats-search-regression-audit.md`

## 구현 계약

- `StatsPageShell`만 `useStatsPageController`, 검색 기록, profile prefill, autocomplete, navigation guard, AI snapshot identity, timer/effect를 소유한다.
- `StatsPageStates`는 page-level loading/refreshing/error/404 suggestion/retry만 표현한다. Summary/detail retry는 기존 feed/row boundary를 유지한다.
- season/force-refresh 실패 retry를 위해 `{ nickname, platform, seasonId, forceRefresh }` exact intent를 request 직전 ref에 저장한다. dynamic route 최초 실패일 때만 initial props fallback을 사용한다.
- 3초 local cooldown, loading/navigation guard, 429 `retryAt` owned timeout을 모두 retry disabled에 반영한다. Timer는 unmount/신규 deadline에서 cleanup한다.
- overview DOM은 summary rail + `MatchFeed` grid → guide → full AI 하나 순서다. 최근 매치 0건은 focusable `AI 분석` region과 accessible empty status를 유지한다.
- landing/dynamic route page는 별도 max-width wrapper 없이 `StatSearch`를 직접 반환한다.
- `.stats-page` 범위에 black/gold token, 1200px width, 8/16px grid, 1024px `320px minmax(0, 1fr)`, safe-area padding을 추가했다. 전역 button override와 sticky rail은 추가하지 않았다.
- `StatsSearchBar`의 platform label과 platform/input/search/quick/favorite/remove/suggestion 44px target을 명시했다.
- audit `STATS-009`의 전체 row를 Task 6 builder wiring과 Kakao/spaced nickname 회귀 근거로 `fixed`로 정정했다. Browser-only suspected 항목은 올리지 않았다.

## TDD 증거

### RED

생산 코드 수정 전 실행:

```text
npx vitest run tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stats-auto-ads-boundary.test.ts tests/stat-search-baseline.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-ai-parent-identity.test.ts
```

결과: exit 1, `5 failed | 1 passed`, `6 failed | 23 passed`. 주요 RED는 missing `StatsPageShell`, legacy manual provider/rail source, route nested wrapper, missing approved boundary/tokens/grid, platform accessible label이었다. DOM 중첩 가정 때문에만 실패한 test는 없었다.

### 초기 GREEN

```text
npx vitest run tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stats-auto-ads-boundary.test.ts
```

결과: exit 0, `3 passed`, `19 passed`.

### exact-intent test unblock

실제 URL 계약을 강화하던 중 force-refresh test가 5초 timeout을 반복했다. Read-only trace로 이전 season test가 fake timers를 복원하지 않아 다음 test의 최초 `findByText`부터 fake clock에 묶인 harness leakage임을 확인했다. Production retry flow는 변경하지 않고 `afterEach`에 `vi.useRealTimers()`를 추가했다.

```text
npx vitest run tests/stat-search-season-refresh.test.ts -t "실패한 force refresh retry는 cooldown 이후 refresh=true URL을 정확히 재사용한다"
```

결과: exit 0, `1 passed | 4 skipped`. 이후 두 exact retry test를 `2026-08-10T00:00:00Z` 고정 clock, 2,999ms disabled, +1ms fresh enabled node, `_t` 제외 query equality, success 후 error/refreshing 해제로 강화했다.

## 최종 검증

Focused:

```text
npx vitest run tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stats-auto-ads-boundary.test.ts tests/stat-search-baseline.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-match-feed-integration.test.ts tests/stat-summary-panel.test.ts tests/stat-match-filter.test.ts tests/stat-search-ai-parent-identity.test.ts tests/squad-analysis-panel-state.test.ts tests/player-profile-header.test.ts
```

결과: exit 0, `12 passed`, `66 passed`.

Related ownership/ads:

```text
npx vitest run tests/stats-page-controller.test.ts tests/stat-search-autocomplete.test.ts tests/stat-search-prefill.test.ts tests/battle-storage-compat.test.ts tests/match-feed-ad-placement.test.ts tests/responsive-ad-slot.test.ts tests/ad-provider-initialization.test.ts tests/recent-ai-summary-bridge.test.ts
```

결과: exit 0, `8 passed`, `47 passed`.

Targeted lint/type/diff:

```text
npx eslint components/stat/layout/StatsPageShell.tsx components/stat/layout/StatsPageStates.tsx components/stat/StatSearch.tsx components/stat/search/StatsSearchBar.tsx app/stats/page.tsx 'app/stats/[platform]/[nickname]/page.tsx' tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts
npx tsc --noEmit --pretty false
git diff --check
```

결과: 모두 exit 0, 대상 warning/error 0.

Core:

```text
npm run verify:core
```

결과: exit 0. 기존 범위 밖 파일의 warning 43개, error 0.

## React condensed review

- Import는 모듈 상단 direct import로 유지했고 inline component 정의를 추가하지 않았다.
- result recent-recording effect를 object 전체가 아닌 primitive identity/nickname dependency로 제한했다.
- guideline/AI/timer 상태는 functional update와 owner cleanup을 사용한다.
- `Date.now()`를 render에서 호출하지 않고 retry deadline effect 안에 가두었다.
- Shell은 전역 main을 중첩하지 않고, interactive control은 `type=button`, accessible name/label, explicit minimum target을 갖는다.
- AI summary는 result platform+nickname+matchIds primitive identity에 태그된 snapshot만 노출하고 full owner를 하나만 mount한다.

## Self-review / 우려

- 전체 검색·prefill·history·AI 로직은 기존 `StatSearch`에서 우선 이동한 뒤 JSX 배치만 바꾸었다. API/telemetry/storage 계약은 변경하지 않았다.
- Source scan은 legacy provider 재유입을 막는 보조 경계일 뿐이며, real `SidebarFooterWrapper` + controller + `RecentAISummary` landmark test로 player 1 request/main 1/top 1/full AI 1을 별도 검증했다.
- Task 10 전이므로 실제 browser viewport screenshot, hydration/back-forward, 광고 fill, AdSense console Auto Ads anchor/side rail 상태는 완료로 주장하지 않는다.
- `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT` 운영값이 없는 현재 환경에서 after-10은 Task 5 계약대로 omit되며 top unit fallback을 사용하지 않는다.

## Fix Round 1

### RED 근거

```text
npx vitest run tests/stat-search-season-refresh.test.ts tests/stats-layout-boundary.test.ts tests/stats-page-shell.test.ts
```

결과: exit 1, `3 files`, `22 tests`, `2 failed`, `20 passed`. `A 실패 intent...` 테스트에서 PlayerA 요청이 2건이 아닌 3건이었고, Shell layout 테스트에서 result 외부 stack이 `gap-4`로 관찰되어 `gap-2 md:gap-4` 계약을 위반했다.

### Root cause

- `StatsPageShell`의 기존 `initialNickname/initialPlatform` effect는 route 전환 시 navigation pending만 초기화하고 `lastSearchIntentRef`는 초기화하지 않았다. 따라서 A route의 season 실패 intent가 B route 최초 실패 뒤 retry에 재사용됐다.
- result 외부 stack과 overview 외부 stack이 모두 `gap-4`였고, AI guide 외부 wrapper가 `mt-4 mb-6`을 소유하고 있었다.

### 변경

- route identity effect에서 `lastSearchIntentRef`를 clear하여 route 최초 실패 retry가 initial nickname/platform, current initial season, `forceRefresh=false` fallback을 사용하도록 수정했다.
- result/overview 외부 stack을 각각 `gap-2 md:gap-4`로 변경했다.
- AI guide outer wrapper의 `mt-4 mb-6`만 제거하고 내부 guide spacing은 유지했다.
- `tests/stats-page-shell.test.ts`의 guide margin assertion을 `mt-4`, `mb-6` 각각의 `not.toHaveClass` assertion으로 강화했다.
- metadata/redirect/filter production 동작은 변경하지 않았으며 STATS-012는 fixed로 올리지 않았다.

### GREEN

```text
npx vitest run tests/stat-search-season-refresh.test.ts tests/stats-layout-boundary.test.ts tests/stats-page-shell.test.ts
```

결과: exit 0, `3 passed`, `22 passed`.

### Fresh full validation

Focused:

```text
npx vitest run tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stats-auto-ads-boundary.test.ts tests/stat-search-baseline.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-match-feed-integration.test.ts tests/stat-summary-panel.test.ts tests/stat-match-filter.test.ts tests/stat-search-ai-parent-identity.test.ts tests/squad-analysis-panel-state.test.ts tests/player-profile-header.test.ts
```

결과: exit 0, `12 passed`, `71 passed`. 기존 Task 9의 66 tests에 Fix Round 1 회귀·metadata/redirect·filter·layout 보강 5 tests가 추가된 실제 fresh count다.

Related ownership/ads:

```text
npx vitest run tests/stats-page-controller.test.ts tests/stat-search-autocomplete.test.ts tests/stat-search-prefill.test.ts tests/battle-storage-compat.test.ts tests/match-feed-ad-placement.test.ts tests/responsive-ad-slot.test.ts tests/ad-provider-initialization.test.ts tests/recent-ai-summary-bridge.test.ts
```

결과: exit 0, `8 passed`, `47 passed`.

Targeted lint/type/diff:

```text
npx eslint components/stat/layout/StatsPageShell.tsx components/stat/layout/StatsPageStates.tsx components/stat/StatSearch.tsx components/stat/search/StatsSearchBar.tsx app/stats/page.tsx 'app/stats/[platform]/[nickname]/page.tsx' tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stat-search-season-refresh.test.ts
npx tsc --noEmit --pretty false
git diff --check
```

결과: 모두 exit 0, 대상 warning/error 0.

```text
npm run verify:core
```

결과: exit 0. 기존 범위 밖 warning 43개, error 0.

### Fix Round 1 React condensed review

- route identity effect는 primitive `initialNickname`/`initialPlatform` dependency를 유지하고 transient retry intent만 ref에서 clear하므로 추가 render나 effect loop를 만들지 않는다.
- 새 inline component, import, bundle dependency, 전역 listener를 추가하지 않았다.
- layout 변경은 기존 Shell의 route-scoped utility class에만 한정했고 접근성 이름·focus·button 계약은 변경하지 않았다.
- metadata/redirect/filter production 경계는 그대로 두고 보존 테스트만 추가했다.

### Fix Round 1 별도 read-only review

- direct `gpt-5.6-luna`의 최고 지원 reasoning `max`로 `47bf7d9..b5e97f6` review package를 읽기 전용 검토했다.
- Spec compliant, Task quality `Approved` 판정을 받았다.
- Critical, Important, Minor finding은 모두 0건이다.
- reviewer는 suite를 재실행하지 않았고, 위 fresh validation은 controller가 직접 실행한 exit code와 count를 근거로 한다.
