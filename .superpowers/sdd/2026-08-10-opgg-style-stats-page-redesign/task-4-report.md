# Task 4 구현 보고서

- 작업일: 2026-08-10 KST
- 브랜치: `codex/opgg-stats-redesign`
- 시작 기준: `392870a67fc6f6c290e6043a82c3f9bd53d03299`
- 범위: route-first 검색 진입, deep-link query 복원, 검색 초기 화면, autocomplete/profile/history hook, 모바일 stats 활성 경계

## 구현 결과

### route-first 단일 player 요청 소유권

- landing submit, 최근검색, 즐겨찾기, autocomplete 선택은 `router.push('/stats/{platform}/{encodedNickname}')`만 수행한다. landing `StatSearch`는 player API를 호출하지 않는다.
- 동적 route의 `useStatsPageController`만 player fetch를 소유한다. 동기 double click/Enter는 `navigationPendingRef`로 push 한 번만 허용하고 route identity가 바뀌면 guard를 해제한다.
- 404 추천은 응답에 포함된 platform을 사용한다. MatchCard 닉네임 클릭도 route-first로 이동한다.
- 검색 submit의 blank/loading/cooldown 차단은 유지했다. MatchCard 행 이동은 검색 submit이 아니므로 성공 후 refresh cooldown과 별개로 route 이동을 허용했다.
- 시즌 변경과 강제 갱신만 기존 controller `search()`를 직접 호출하며, Task 3의 overview reset/실패 시 기존 결과 유지 동작을 보존했다.

### deep-link와 현재 페이지 배선

- 동적 Next page가 `params`와 `searchParams`를 병렬 await하고 platform을 검증한다.
- `tab`은 `parseStatsSectionTab`, `groupKey`는 단일 문자열만 받아 `StatSearch`의 `initialTab`/`initialGroupKey`로 전달한다.
- Next 16 route module에는 임의 helper export를 추가하지 않았다. 테스트는 default page가 만든 실제 `StatSearch` element props를 검사한다.
- 새 hook과 `StatsSearchBar`/`StatsLandingState`는 현재 `StatSearch`에 연결했다. 기존 결과 UI는 유지하고 legacy 검색/landing markup만 제거했다.

### autocomplete, profile, storage

- autocomplete는 2자 이상, 300ms debounce, abort와 requestId 최신성 검사를 적용했다. 새 응답 뒤 늦게 도착한 이전 JSON은 반영하지 않는다.
- 0건 응답은 열린 dropdown에서 `검색 결과가 없습니다`를 렌더한다.
- profile prefill은 `userId`에 키를 두어 undefined에서 로그인 사용자로 바뀐 경우 새 조회를 시작한다. 사용자가 먼저 입력하면 지연 응답이 검색창을 덮어쓰지 않는다. 기존 `StatSearch` 중복 profile query는 제거했다.
- history hook은 첫 render에서 빈 배열을 사용하고 effect에서 storage를 읽는다. 비배열/손상 값은 제거하고 `normalizeStoredNames`로 정규화한다. 초기 빈 배열은 storage에 쓰지 않는다.
- 최근검색은 controller 성공 결과의 canonical nickname만 identity별 한 번 추가한다. 404, 같은 player의 시즌 변경/강제 갱신은 순서를 올리지 않으며 저장 계약은 `string[]`, 최근 10개 제한이다.
- quick row의 즐겨찾기/삭제 액션은 propagation을 중단한다.

### BottomNav와 감사 문서

- `isStatsPath`는 `/stats`와 `/stats/` 하위 경로만 active로 판정한다.
- 감사 문서에서 STATS-004, STATS-005, STATS-010을 자동화 증거에 따라 `fixed`로 갱신했다.
- STATS-001 blank request 0건과 STATS-002 loading/cooldown 차단은 `intentional`로 유지했다.
- STATS-011 hydration, STATS-012 native history/back-forward는 실제 브라우저 증거가 없어 `suspected`를 유지했다.

## 변경 파일

- `hooks/useStatsSearchHistory.ts` (신규)
- `hooks/useStatsAutocomplete.ts` (신규)
- `hooks/useStatsProfilePrefill.ts` (신규)
- `components/stat/search/StatsSearchBar.tsx` (신규)
- `components/stat/search/StatsLandingState.tsx` (신규)
- `components/stat/StatSearch.tsx`
- `app/stats/[platform]/[nickname]/page.tsx`
- `components/common/BottomNav.tsx`
- `tests/stat-search-baseline.test.ts`
- `tests/stat-search-autocomplete.test.ts` (신규)
- `tests/stat-search-prefill.test.ts` (신규)
- `tests/stat-search-deep-link.test.ts` (신규)
- `tests/bottom-nav-stats-active.test.ts` (신규)
- `docs/reviews/2026-08-10-stats-search-regression-audit.md`

`app/stats/page.tsx`는 이미 landing `StatSearch`를 렌더하고 있어 별도 server wrapper 변경 없이 현재 `StatSearch` 배선으로 실제 `/stats` 동작이 바뀐다.

## TDD 증거

### RED 1 — Task 4 기본 계약

```text
$ npx vitest run tests/stat-search-deep-link.test.ts tests/stat-search-autocomplete.test.ts tests/bottom-nav-stats-active.test.ts tests/stat-search-baseline.test.ts
Test Files  4 failed (4)
Tests       8 failed | 2 passed (10)
```

실패는 누락된 autocomplete hook/component, `isStatsPath` 미노출과 상세 경로 inactive, blank submit enabled, landing router push 0회, query 초기 props 누락, 비교/3개 카드 누락, 404 추천 route-first 미적용에서 발생했다.

### RED 2 — preflight hazard 보강

```text
$ npx vitest run tests/stat-search-deep-link.test.ts tests/stat-search-autocomplete.test.ts tests/stat-search-prefill.test.ts
Test Files  2 failed | 1 passed (3)
Tests       10 failed | 7 passed (17)
```

구체적으로 default page query 전달, landing/quick/autocomplete/404/MatchCard route-first, one-push guard, userId 전환 직후 `loaded=false`, storage 초기 read 보호가 실패했다. autocomplete stale old/new 응답 테스트는 당시 부분 구현의 signal 검사로 이미 pass했고 이후 requestId도 함께 적용했다.

### GREEN — Step 6 전체

```text
$ npx vitest run tests/stat-search-deep-link.test.ts tests/stat-search-autocomplete.test.ts tests/stat-search-prefill.test.ts tests/bottom-nav-stats-active.test.ts tests/stat-search-baseline.test.ts tests/stat-search-navigation.test.ts tests/battle-storage-compat.test.ts
Test Files  7 passed (7)
Tests       27 passed (27)
Duration    2.78s
```

환경 출력으로 Node의 빈 `--localstorage-file` warning과 jsdom의 `Window.scrollTo()` 미구현 안내가 있었지만 실패는 없었다.

## 추가 검증

```text
$ npx tsc --noEmit --pretty false
exit 0 (출력 없음)

$ npm run verify:core
exit 0
eslint: 0 errors, 43 warnings
tsc: 0 errors

$ git diff --check
exit 0 (출력 없음)
```

`verify:core`의 43개 warning은 작업 전 감사에 기록된 저장소 전역 기존 warning이며 Task 4 파일에서 새 warning은 없다.

## 자체 검토

- Next App Router 점검: async `params`/`searchParams` 계약을 유지하고 독립 입력은 `Promise.all`로 await했다. server→client props는 문자열만 전달하며 route module extra export를 만들지 않았다.
- React 점검: storage browser API는 effect 안에서만 읽고, 외부 click listener는 cleanup한다. profile effect dependency는 primitive field로 제한했다. transient navigation ownership은 ref, 사용자 표시 상태는 state로 분리했다.
- 경로 생성은 모든 player 진입에서 `encodeURIComponent`를 사용한다. 404는 추천 platform, MatchCard는 현재 result platform을 사용한다.
- canonical history 기록은 result identity ref로 중복을 막으며 favorite/recent write는 모두 normalized `string[]`이다.
- 결과/요약/AI/telemetry JSX와 API shape는 변경하지 않았다. Task 9의 결과 shell/레이아웃 재구성으로 범위를 넓히지 않았다.

## 우려와 후속 확인

- 브라우저 SSR hydration console과 App Router back/forward/metadata는 이번 jsdom/server element 테스트만으로 확정할 수 없다. 감사의 STATS-011/012는 의도적으로 `suspected`다.
- jsdom은 MatchCard 클릭 후 기존 `window.scrollTo`를 구현하지 않아 안내를 출력한다. route assertion과 player 요청 수에는 영향이 없다.
- 실제 browser에서 route 전환 시 navigation pending 시각 상태, 저장 history hydration, metadata 전환을 후속 smoke로 확인해야 한다.
