# Task 6 구현 보고서

- 작업일: 2026-08-10 KST
- 브랜치: `codex/opgg-stats-redesign`
- 시작 기준: `ba61859b3bcec6318ce677730a5f68ac27e5532f`
- 범위: 플레이어 프로필 헤더, controlled 핵심 통계 레일, 기존 수동 AI 요약 callback bridge

## 구현 결과

### canonical 프로필 헤더

- `PlayerProfileHeader` 하나가 `selectCanonicalRankBucket`을 사용해 기록이 있는 `ranked.squad → ranked.duo → ranked.solo` 첫 bucket의 티어·RP를 노출한다.
- 요약 레일의 랭크 카드를 제거해 `현재 랭크`는 header+panel 조합에서 한 번만 렌더된다.
- 플랫폼, 닉네임 `title`/truncate, 클랜, 제재 상태, 업데이트 시간을 보존했다. 클랜·제재 trigger는 기존 pointer-only wrapper 대신 keyboard 조작 가능한 native button이다.
- 시즌, 갱신, 즐겨찾기, 비교, 무기 action은 명확한 accessible name, `type="button"`, 44px 이상 세로 target을 갖는다. 즐겨찾기는 `aria-pressed`를 제공한다.
- 비교·무기는 Task 2의 `buildStatsCompareUrl`/`buildStatsWeaponsUrl`를 통해 공백 닉네임과 Kakao platform을 보존한다.

### controlled 통계 레일

- `StatSummaryPanel` 내부의 `mode`/`gameType` state를 제거하고 controller의 `statsMode`, `partySize`, setter와 `aiSummary`, `aiExpanded`, callback을 받는 controlled contract로 바꿨다.
- selection-aware mapper는 `stats[mode][partySize]`를 직접 선택해 ranked/normal × solo/duo/squad 6개 조합의 게임 수, KDA, 평균 딜량, Top 10, 파티 모드를 독립적으로 도출한다.
- 선택 bucket이 null이거나 플레이 수가 0이면 수치 `0`을 대신하지 않고 `기록 없음`을 명시한다.
- `StatsOverviewControls`, `StatsOverviewRail`, `StatsSectionTabs`는 모듈 상위에 정의되고 callback만 호출한다. 통계 모드/파티 선택은 매치 필터 state와 별도 controller setter를 사용한다.
- compact AI 레일은 snapshot 전에 기존 전체 AI 섹션으로 scroll/focus만 하고 API를 호출하지 않는다. snapshot 후에는 mobile 2줄/desktop 3줄 clamp와 controlled 더보기를 제공한다.

### AI callback·요청 소유권

- `AiSummarySnapshot`/`onSummaryChange` callback만 기존 `RecentAISummary` 수동 흐름에 추가했다. mount/rerender는 AI POST를 만들지 않고 기존 CTA가 유일한 시작점이다.
- identity는 primitive `platform + nickname + joined matchIds`로 구성했다. platform만 또는 IDs만 바뀌어도 snapshot을 null로 초기화하고 reader/abort/retry timer를 정리한다.
- `visuals` partial은 partial `DebateData` 시각 정보로만 저장하고 verdict snapshot을 배출하지 않는다. `final` JSON의 non-empty `finalVerdict`를 trim하고 이전 visuals의 `overallTier`와 합쳐진 때만 callback을 호출한다.
- 각 POST에 generation·identity·exact `AbortController` owner를 태그했다. 취소를 무시한 이전 reader A가 B 시작 후 늦게 완료되어도 B의 loading, reader/controller, global AI lock, snapshot을 해제하지 못한다.
- 자동 retry timer는 ref로 소유하고 identity/unmount에서 clear한다. PUBG API, AI endpoint payload, analytics event, telemetry 계산은 변경하지 않았다.

## 변경 파일

- `components/stat/profile/PlayerProfileHeader.tsx` (신규)
- `components/stat/overview/StatsSectionTabs.tsx` (신규)
- `components/stat/overview/StatsOverviewControls.tsx` (신규)
- `components/stat/overview/StatsOverviewRail.tsx` (신규)
- `components/stat/StatSummaryPanel.tsx`
- `components/stat/RecentAISummary.tsx`
- `components/stat/StatSearch.tsx`
- `tests/fixtures/stats/ai-ready.json` (신규)
- `tests/player-profile-header.test.ts` (신규)
- `tests/stat-summary-panel.test.ts` (신규)
- `tests/recent-ai-summary-bridge.test.ts` (신규)

## TDD 증거

### RED — 신규 UI·AI bridge

production 수정 전 brief의 정확한 focused 명령을 실행했다.

```text
$ npx vitest run tests/player-profile-header.test.ts tests/stat-summary-panel.test.ts tests/recent-ai-summary-bridge.test.ts
Test Files  3 failed (3)
Tests       4 failed (4)
Duration    6.12s
```

`PlayerProfileHeader`/`StatsSectionTabs` module이 없어 두 suite가 load 실패했고, 기존 AI suite는 initial/identity null callback, final snapshot, visuals-only 게이트, stale-A owner 보존 4개가 모두 실패했다.

### 호환성 RED — section button role

최초 `StatsSectionTabs` 구현이 explicit `role="tab"`으로 기존 native button 상호작용 계약을 바꿔 검색 회귀에서 실제 실패를 확인했다.

```text
$ npx vitest run tests/stat-search-baseline.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-deep-link.test.ts
Test Files  2 failed | 1 passed (3)
Tests       4 failed | 15 passed (19)
```

`role="group"` + native button + `aria-pressed`로 복구해 기존 조회·클릭·클래스 계약을 보존했다.

### GREEN — Task 6 focused/related gates

```text
$ npx vitest run tests/player-profile-header.test.ts tests/stat-summary-panel.test.ts tests/recent-ai-summary-bridge.test.ts
Test Files  3 passed (3)
Tests       19 passed (19)
Duration    5.65s

$ npx vitest run tests/stats-page-model.test.ts tests/stat-search-baseline.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-navigation.test.ts tests/match-card-demand-loading.test.ts tests/ai-cache-routes.test.ts
Test Files  7 passed (7)
Tests       41 passed (41)
Duration    5.98s

$ npx tsc --noEmit --pretty false
exit 0 (출력 없음)

$ npx eslint <Task 6 변경 TSX/test 파일>
exit 0 (출력 없음)

$ npm run verify:core
exit 0
eslint: 0 errors, 기존 43 warnings
tsc: 0 errors

$ git diff --check
exit 0 (출력 없음)
```

## 자체 검토

- canonical 랭크는 squad·duo·solo가 모두 있는 fixture에서 squad 우선을, squad 0 rounds에서 duo fallback을 검증했다. header+panel 조합의 `현재 랭크` 노출은 정확히 1개다.
- 6개 통계 조합은 서로 다른 literal rounds/KDA/damage/Top10 기댓값으로 검증해 canonical ranked mapper로 회귀하는 변이를 잡는다.
- same nickname의 platform-only 변경과 IDs-only 변경을 별도 rerender하고 mount/rerender POST 0개를 확인했다.
- visuals-only, `done(valid:false)`, final+done, abort 무시 stale reader를 별도 검증했다. 이전 A finally 후에도 B lock이 active이고 POST가 2개에서 늘지 않는다.
- React condensed review에서 direct imports, primitive effect dependency, module-level component, functional toggle, native button/label, render 중 ref write 금지를 적용했다.
- 신규 소스/테스 대상 ESLint warning/error는 0개다. 전체 저장소 기존 warning 43개는 범위 밖이다.
- UI skill의 mobile 브라우저 QA는 이번 functional boundary에서 실행하지 않았다. Task 6은 Task 9 full shell 스타일을 선행하지 않았고, 375/390/430px 실제 overflow·touch·clamp·scroll/focus 확인은 Task 9/10 browser QA 대상이다.

## 관심 사항

- `RecentAISummary` 전체 섹션은 기존 1,300줄 UI와 수동 요청 흐름을 유지했다. 이번 작업은 callback/generation ownership만 추가했으며 대규모 분해는 범위 밖이다.
- Task 9가 `StatsPageShell`에서 프로필·요약·매치 2열 조립을 완성할 때 실제 mobile/desktop 레이아웃을 확정해야 한다.
