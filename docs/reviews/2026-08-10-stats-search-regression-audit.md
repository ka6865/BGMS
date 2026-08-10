# 전적검색 회귀 baseline과 결함 감사

- 작성일: 2026-08-10
- 범위: `/stats`, `/stats/[platform]/[nickname]`, `/stats/battle`, 모바일 `BottomNav`
- 기준 커밋: `b2e6b16b66c0df77c51de93d68d695e6ff5f4bb0`
- 판정: `confirmed | suspected | fixed | not_reproduced | intentional`
- 방법: jsdom characterization test, 라우트·컴포넌트 코드 검사, 기존 회귀 suite 실행. 실제 브라우저 상태가 필요한 항목은 `suspected`로 남겼다.

## Baseline 결과

### 공통 fixture 계약

- `tests/fixtures/stats/player-ready.json`: `/api/pubg/player` 성공 응답. canonical nickname과 platform, 두 개 시즌, 경쟁전·일반전 통계, 최근 매치 ID, 갱신 시각을 고정한다.
- `tests/fixtures/stats/matches-summary-ready.json`: `/api/pubg/matches-summary` 성공 응답. `summaries` 맵과 `missingMatchIds`를 고정하고 매치 시각과 `matchType`을 명시한다.

### 변경 전 회귀 gate

2026-08-10 KST에 기준 커밋에서 지정 명령을 실행했다.

```text
$ npx vitest run tests/stat-search-ui.test.ts tests/match-card-demand-loading.test.ts tests/player-suggest-route.test.ts tests/suggest-players.test.ts tests/pubg-recent-matches.test.ts tests/player-matches-api.test.ts
Test Files  6 passed (6)
Tests       15 passed (15)

$ npm run verify:core
exit 0
eslint: 0 errors, 43 warnings
tsc --noEmit --pretty false: 0 errors
```

43개 warning은 기준 커밋에 이미 있던 저장소 전역 lint warning이며 이 감사에서 수정하지 않았다.

### 신규 characterization gate

```text
$ npx vitest run tests/stat-search-baseline.test.ts tests/battle-storage-compat.test.ts tests/stat-search-ui.test.ts
Test Files  3 passed (3)
Tests       8 passed (8)
```

빈 닉네임 요청 0건, 성공 검색의 player 요청 1건·canonical URL·`string[]` 최근검색, 로딩/쿨다운 중 중복 submit 차단, 시즌 성공 후 overview 복귀, 배틀 저장소 호환, 90일 만료 경계를 고정했다.

## 감사 표

| ID | 상태 | 경로·입력 | 기대 | 실제 | 네트워크 | 코드 위치 | 원인 | 회귀 테스트 | 해결 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STATS-001 | intentional | `/stats`, `nickname=""` | 요청 0건 | submit disabled, route 이동·요청 0건 | 0건 | `StatSearch.tsx` `submitDisabled`, `navigateToPlayer` | 빈 값 차단 정책 | `stat-search-baseline` “빈 닉네임…” | 현행 유지 |
| STATS-002 | intentional | `/stats`, 로딩·쿨다운 중 추가 submit | player 요청은 1건만 발생 | disabled button과 동기 navigation ref가 추가 submit/push를 차단 | player 1건 | `StatSearch.tsx` `navigateToPlayer`, `StatsSearchBar.tsx` | 이중 호출과 API 소진 방지 정책 | `stat-search-baseline`, `stat-search-deep-link` one-push | 현행 유지 |
| STATS-003 | intentional | 검색 성공 후 스쿼드 탭, 시즌 변경 성공 | overview 탭으로 복귀 | 성공 분기에서 `setActiveTab("overview")` | player 시즌 요청 1건 추가 | `StatSearch.tsx` 289~295, 755~764 | 검색 성공 공통 후처리 | `stat-search-baseline` “시즌 변경…” | 현행 유지 |
| STATS-004 | fixed | `/stats`, 2자 이상 입력, suggest `[]`, 저장 기록 0건 | `검색 결과가 없습니다` 노출 | 300ms 응답 후 빈 결과 문구 노출 | suggest 1건 | `useStatsAutocomplete.ts`, `StatsSearchBar.tsx` | 드롭다운 조건을 query 길이와 저장 항목으로 통합 | `stat-search-autocomplete` debounce·empty·stale 응답 | abort와 requestId로 최신 query만 반영 |
| STATS-005 | fixed | `/stats/steam/FixturePlayer?tab=squad&groupKey=g2` → g1 선택 → overview → squad | 스쿼드 탭·g2 초기 선택과 g1 remount 복원 | route prop이 controller `groupKey`로 들어가 panel selector/detail/share에 전달되고 overview 왕복 후도 g1이 유지됨 | player 1건, squad list 1건, 유효 group detail 1건씩 | `app/stats/[platform]/[nickname]/page.tsx`, `useStatsPageController.ts`, `StatSearch.tsx`, `SquadAnalysisPanel.tsx` | route query 와 panel local/URL selection 소유권이 분리되어 controller value가 panel에 연결되지 않음 | `stat-search-deep-link` controller→panel·overview 왕복, `squad-analysis-panel-state` | `groupKey`를 유일 authority로 삼고 invalid/undefined만 첫 group으로 상위 reconcile |
| STATS-006 | fixed | 요약 `gameMode="squad-fpp"`, `matchType="competitive"` | 경쟁전 필터에 노출 | full `matchModeMeta` overlay를 거쳐 경쟁전 행으로 유지 | summary 1건 | `MatchFeed.tsx`, `statsPageModel.ts` | 기존 `dynamicMatchModes` projection이 `matchType`을 소실 | `stat-match-filter`, `match-feed-ad-placement`, `stat-search-match-feed-integration` | missing-first renderable 배열과 Task 2 분류 모델로 통합 |
| STATS-007 | fixed | 요약 카드 “매치 상세 펼치기”, 상세 API 실패 | 실패 안내와 명시적 재시도 버튼 | compact 요약을 유지하고 상세 영역만 오류·retry 표시 | 클릭당 detail 1건 | `MatchCard.tsx`, `ExpandedMatchDetails.tsx` | 기존 fetch 분기가 HTTP 상태를 검사하지 않고 ref만 해제해 오류 표현 state가 없었음 | `match-card-detail-state`, `match-card-demand-loading` | detail requestId/AbortController/error state와 source partial callback 추가 |
| STATS-008 | fixed | raw `match_stats_raw` row에 `played_at` 없고 `created_at`만 존재 | 서로 다른 요청 시각에도 안정적 `createdAt` 반환 | raw select가 `created_at`을 읽고 helper가 `played_at ?? created_at ?? request-time`을 적용해 두 요청이 같은 DB 저장 시각을 반환 | summaries route 2건 | `matches-summary/route.ts`, `matchSummary.ts` | raw select이 `created_at`을 생략해 helper가 매 요청의 `new Date()`로 떨어짐 | `matches-summary-route` helper precedence·route 두 요청·select 컬럼, `stat-search-ui` 14/90일 strict cutoff | raw select에 `created_at` 추가; `created_at`은 실제 경기 시각이 아닌 안정 fallback으로만 사용 |
| STATS-009 | confirmed | `/stats/kakao/FixturePlayer` → “이 플레이어와 비교하기” | `nick1`+​`platform1=kakao` | `/stats/battle?nick1=FixturePlayer`만 push | 0건 | `StatSearch.tsx` 746~748 | 비교 URL builder가 platform을 누락 | 후속 navigation 단위 테스트 필요 | 후속 URL builder로 교체 |
| STATS-010 | fixed | 모바일 `/stats/steam/FixturePlayer`, `/stats/battle` | “AI 전적” nav active | `/stats`와 모든 하위 path에서 active | 0건 | `BottomNav.tsx` `isStatsPath` | exact-path 비교 | `bottom-nav-stats-active` | 경계가 있는 `/stats/` prefix helper 적용 |
| STATS-011 | suspected | SSR `/stats`, localStorage에 기록 존재 | hydration warning 0건 | hook 첫 state는 빈 배열이고 effect에서 storage를 읽도록 변경했으나 실제 hydration 로그 미측정 | 0건 | `useStatsSearchHistory.ts`, `StatsSearchBar.tsx` | 브라우저 hydration 로그 필요 | storage 비배열·초기 write 회귀만 자동화 | 실제 SSR/hydration 재현 후 판정 |
| STATS-012 | suspected | `/stats` 검색 후 뒤로가기·문서 metadata 확인 | URL, 화면, metadata 동기화 | player 진입은 `router.push` route-first로 변경했으나 실제 back/forward와 metadata 미측정 | landing player 0건, 동적 route player 1건 | `StatSearch.tsx` `navigateToPlayer` | App Router 연결은 구현됐지만 브라우저 history 증거 필요 | `stat-search-deep-link`, `stat-search-baseline` | 뒤로가기·metadata 실측 후 판정 |
| STATS-013 | suspected | direct `/stats/xbox/FixturePlayer` | 404 또는 플랫폼 validation 오류 | page/API에 platform allow-list validation이 보이지 않음 | player 1건 가능 | `app/stats/[platform]/[nickname]/page.tsx` 83~91; `player/route.ts` 127~142 | invalid shard가 외부 fetch/500으로 흐를 가능성 | 라우트 integration 테스트 필요 | direct URL 실행 후 판정 |
| STATS-014 | suspected | ready 결과에서 시즌 변경, player API 실패 | 이전 결과 유지+오류 안내 | 요청 시작 즉시 `setResult(null)` 수행 | player 1건 추가 | `StatSearch.tsx` 246~255, 264~286 | refresh가 아닌 검색은 기존 result 제거 | 브라우저 시즌 실패 테스트 필요 | 실제 UI 재현 후 판정 |
| STATS-015 | suspected | ready 결과의 강제 갱신 성공, 스쿼드 탭 상태 | 기획에 따라 현 탭 유지 또는 overview 복귀 | 공통 성공 분기는 overview로 복귀 | player `refresh=true` 1건 | `StatSearch.tsx` 289~295, 715~721 | 갱신과 시즌 변경이 같은 성공 후처리 사용 | 기획 확정 후 테스트 필요 | 제품 의도 확인 후 판정 |
| STATS-016 | suspected | A 직접 URL 요청 중 B route로 이동, A 응답이 나중 도착 | B 상태만 유지 | player GET에 AbortController/request token이 없고 prop 변경은 result만 비움 | player 2건 가능 | `StatSearch.tsx` 246~258, 354~381 | 최신 요청 우선 보장 부재 가능성 | race integration 테스트 필요 | 실제 route transition 재현 후 판정 |

## Task 1 자체 검토

- production 코드는 수정하지 않았다.
- 빈 닉네임 요청 차단을 결함으로 올리지 않고 `intentional`로 고정했다.
- 로딩·쿨다운 중 중복 차단과 시즌 변경 성공 후 overview 복귀를 `intentional`로 고정했다.
- 코드만으로 단정하기 어려운 항목은 수정하지 않고 `suspected`로 남겼다.
- 결함 수정, URL 상태 모델, 요청 취소, 반응형 UI 변경은 후속 task 범위로 보존했다.

## Task 4 route-first 검색과 저장소 호환

- landing submit, 최근검색, 즐겨찾기, autocomplete 선택은 현재 `/stats` 인스턴스에서 player API를 호출하지 않고 동적 player route를 먼저 연다. 404 추천은 API가 반환한 platform을 사용하고, MatchCard 닉네임 클릭도 동일한 route owner 규칙을 따른다.
- 동기 double click/Enter는 navigation ref로 한 번만 push한다. 동적 route의 controller만 player 요청을 시작하며, 빈 닉네임·로딩·쿨다운 submit 차단은 유지한다.
- 최근검색은 controller가 반환한 canonical nickname 성공을 identity별 한 번만 기록한다. 404, 시즌 변경, 강제 갱신은 기존 이름의 순서를 다시 올리지 않으며 저장 형식은 `string[]`이다.
- profile prefill은 userId에 키를 두며, 조회 전에 사용자가 입력하면 늦은 profile 응답이 입력값을 덮어쓰지 않는다. 기존 `StatSearch`의 중복 profile query는 제거했다.
- Task 4에서 STATS-004·STATS-010을 jsdom 회귀로 `fixed` 판정했고 STATS-005의 URL query→controller 초기 prop 경계를 열었다. Task 8에서 controller→panel selector/detail·overview 왕복을 추가 검증해 STATS-005의 최종 `fixed` 증거를 보완했다. STATS-011과 STATS-012는 실제 브라우저 SSR/hydration·back/forward 증거가 없으므로 `suspected`를 유지한다.

## 우려와 후속 확인

- `verify:core`는 통과했지만 기존 lint warning 43개가 남아 있다.
- STATS-011~016은 브라우저·App Router·실제 API 상태가 필요해 이 태스크에서 확정하지 않았다.
- `buildBasicMatchSummary`는 raw `played_at`이 없으면 DB `created_at`을 안정 fallback으로 쓴다. 이는 실제 경기 시각이 아니므로 후속 모델 분리 시 명시적 unknown 시각을 여전히 다뤄야 한다.

## Task 3 controller architecture hardening

- `useStatsPageController`가 player와 summary batch의 AbortController/requestId를 분리해 route identity 변경, back/forward 성격의 prop 변경, unmount에서 이전 응답을 격리한다. 이는 STATS-016의 architecture hardening이며 검색 UI에 두 번째 submit/latest-wins 동작을 추가한 것이 아니다.
- STATS-002의 로딩·쿨다운 중 중복 submit 차단은 `intentional` 그대로다. 같은 진행 중 request key는 같은 Promise를 반환하고, 다른 사용자 검색은 진행 중 요청을 교체하지 않는다.
- STATS-003의 성공한 시즌 변경 후 overview 복귀는 제품 의도(`intentional`)로 유지한다. STATS-015의 성공한 강제 갱신 후 overview 복귀는 현재 동작을 보존하되 제품 의도는 아직 `suspected`로 남기며, 이를 intentional 또는 fixed로 재분류하지 않는다.
- STATS-014는 controller가 시즌 변경·강제 갱신을 `refreshing`으로 처리해 실패 시 기존 player result와 탭을 유지하도록 보강했다. player profile이 성공한 뒤 summary batch만 실패하면 profile을 유지한 `partial`과 `retrySummaries()`를 제공한다.
- direct `initialTab="squad"`는 첫 route 자동검색 성공보다 우선한다. Task 4의 URL query→`StatSearch` props 연결 후 Task 8에서 controller `groupKey`→controlled panel과 overview 왕복 회귀까지 연결해 STATS-005를 전체 경로에서 `fixed`로 갱신했다.

## Task 7 매치 피드·상세 오류 격리

- STATS-006 root cause는 matches-summary 응답이나 controller가 아니었다. processed summary의 `matchType`은 `buildMatchSummary`에서 응답에 포함되고 `useStatsPageController`도 `matchModeMeta[matchId].matchType`으로 보존했다. 기존 `StatSearch`가 이를 `Record<matchId, gameMode>` 문자열로 다시 투영하면서 `matchType="competitive"`를 버렸고 inline filter가 `squad-fpp`만 보고 일반전으로 오분류했다. `MatchFeed`는 원래 match ID 순서에서 missing을 먼저 제외하고 summary에 full metadata를 불변 overlay한 뒤 `filterRenderableMatches`로 분류한다.
- STATS-007 root cause는 `/api/pubg/match` 실패 뒤 표현 가능한 상태가 없었던 것이다. 기존 코드는 `response.ok`를 확인하지 않았고 `data.error` 또는 catch에서 in-flight ref만 해제했다. summary object와 expanded flag는 남아 summary를 full detail처럼 렌더했으며 명시적 오류·재시도 UI가 없었다. `ExpandedMatchDetails`가 `summary/loading/ready/error` state, requestId, AbortController를 소유하고 compact row는 facade 밖에서 계속 유지된다.
- `MatchCard`는 summary, `isExpanded`, `hasExpandedOnce`만 소유한다. 첫 expand 전 detail 요청은 0개이며, 첫 expand 후 상세를 `hidden`/`aria-hidden`으로 유지해 접기 중에도 full detail, 열린 하위 section, AI stream/result가 보존된다. 14일 초과 summary는 detail 요청이나 partial failure 없이 보존 안내만 제공한다.
- 상세·AI owner key는 `platform:normalizedNickname:matchId`다. A identity abort 후 늦은 A response/finally가 B state나 AI lock을 덮거나 해제하지 않으며 abort는 partial failure로 보고하지 않는다. 실패·회복 source는 `match:${matchId}`여서 한 행 회복이 다른 행의 partial을 지우지 않는다.
- 광고는 최종 renderable count로 `getStatsFeedSlots`를 호출한다. mobile after-6, tablet fixture 5·10·15, missing feed env 5·15, unknown viewport reservation을 원래 매치 사이에 놓고 trailing ad를 만들지 않는다. unknown은 provider child를 mount하지 않고 `.stats-page` 아래 mobile/tablet visibility class만 예약한다.

## Task 8 controlled squad groupKey·raw fallback 시각

- `SquadAnalysisPanel`은 `useSearchParams`와 local `selectedGroupKey`를 제거하고 controller가 주는 `groupKey`를 selector, detail GET, share URL의 유일 authority로 삼는다. list GET dependency는 primitive `nickname/platform`뿐이며 g2 초기에 list 1건+g2 detail 1건, g1 변경 후 list 재요청 없이 g1 detail 1건을 추가한다.
- groups 준비 후 `groupKey`가 undefined 또는 invalid일 때만 첫 key를 `onGroupKeyChange`로 올린다. invalid key detail GET은 0건이며 selector에 `스쿼드 그룹` accessible name을 추가했다.
- controller→panel integration 테스는 g2 deep link, g1 선택, overview unmount, squad remount 후 g1 복원을 실제 상위 state로 검증한다. 마운트 AI POST 0건, CTA payload, `tab=squad&groupKey=g2`·UTM share, image download, 2D map도 소비자 동작으로 보존했다.
- raw `match_stats_raw` select에 `created_at`을 추가하고 helper는 nullable `played_at ?? created_at ?? request-time`을 사용한다. `created_at`은 경기 시각이 아니라 `played_at` 부재 시 요청별 현재 시각 생성을 막는 DB 저장 시각 fallback이다.
- 2026-08-10T00:00:00.000Z 기준 14일/90일 exact equality는 모두 not expired, 1ms 이전은 expired로 고정했다.
- squad list/detail stale-response overwrite는 재현되지 않은 가설이므로 AbortController/requestId를 추가하지 않았고 `fixed`로 판정하지 않는다.
