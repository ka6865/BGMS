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
| STATS-001 | intentional | `/stats`, `nickname=""` | 요청 0건 | 요청 0건 | 0건 | `StatSearch.tsx` `handleSearch` 231~240 | 빈 값 차단 정책 | `stat-search-baseline` “빈 닉네임…” | 현행 유지 |
| STATS-002 | intentional | `/stats`, 로딩·3초 쿨다운 중 추가 submit | player 요청은 1건만 발생 | `isSearchingRef`, `cooldown`, disabled button이 추가 submit 차단 | player 1건 | `StatSearch.tsx` 237~244, 340~345, 602~608 | 이중 호출과 API 소진 방지 정책 | `stat-search-baseline` “로딩과 쿨다운…” | 현행 유지 |
| STATS-003 | intentional | 검색 성공 후 스쿼드 탭, 시즌 변경 성공 | overview 탭으로 복귀 | 성공 분기에서 `setActiveTab("overview")` | player 시즌 요청 1건 추가 | `StatSearch.tsx` 289~295, 755~764 | 검색 성공 공통 후처리 | `stat-search-baseline` “시즌 변경…” | 현행 유지 |
| STATS-004 | confirmed | `/stats`, 2자 이상 입력, suggest `[]`, 저장 기록 0건 | `검색 결과가 없습니다.` 노출 | 드롭다운 외부 마운트 조건이 false라 0건 문구에 도달 불가 | suggest 1건 | `StatSearch.tsx` 499~545 | 안쪽 empty 문구와 외부 드롭다운 조건 불일치 | 후속 자동완성 UI 테스트 필요 | 후속 리디자인에서 조건 통합 |
| STATS-005 | confirmed | `/stats/steam/FixturePlayer?tab=squad&groupKey=A` | 스쿼드 탭과 A 그룹 복원 | metadata만 query를 읽고 페이지는 platform/nickname만 `StatSearch`에 전달; `activeTab`은 overview | player 자동검색 1건 | `app/stats/[platform]/[nickname]/page.tsx` 13~43, 83~91; `StatSearch.tsx` 87 | query 상태가 페이지 controller에 연결되지 않음 | 후속 deep-link 테스트 필요 | 후속 리디자인에서 tab/groupKey 복원 |
| STATS-006 | confirmed | 요약 `gameMode="squad-fpp"`, `matchType="competitive"` | 경쟁전 필터에 노출 | `dynamicMatchModes`에 gameMode만 복사해 일반전으로 분류 | summary 1건 | `StatSearch.tsx` 124~140, 943~969 | 필터가 `matchType`을 소실한 문자열 mode만 검사 | 후속 모드 분류 단위 테스 필요 | 후속 순수 분류 모델로 통합 |
| STATS-007 | confirmed | 요약 카드 “매치 상세 불러오기”, 상세 API 실패 | 실패 안내와 명시적 재시도 버튼 | 실패 분기가 ref만 해제하고 상태/문구 없음 | 클릭당 detail 1건 | `MatchCard.tsx` 837~870, 1012~1041 | detail error 표시 상태 부재 | 후속 detail failure UI 테스트 필요 | 후속 리디자인에서 partial/error·retry 추가 |
| STATS-008 | confirmed | fallback `pubg_player_matches.played_at` 누락 | 날짜 미상 또는 원본 시각 유지 | `createdAt`을 호출 현재 시각으로 생성 | 요약 라우트 내부 | `lib/pubg-analysis/matchSummary.ts` 29~56 | fallback builder의 `new Date().toISOString()` | `stat-search-ui` 90일 경계가 손상 영향을 보여줌; 직접 테스트 필요 | 후속에서 미상 상태 명시 |
| STATS-009 | confirmed | `/stats/kakao/FixturePlayer` → “이 플레이어와 비교하기” | `nick1`+​`platform1=kakao` | `/stats/battle?nick1=FixturePlayer`만 push | 0건 | `StatSearch.tsx` 746~748 | 비교 URL builder가 platform을 누락 | 후속 navigation 단위 테스트 필요 | 후속 URL builder로 교체 |
| STATS-010 | confirmed | 모바일 `/stats/steam/FixturePlayer`, `/stats/battle` | “AI 전적” nav active | 정확히 `/stats`일 때만 active | 0건 | `BottomNav.tsx` 50~64 | exact-path 비교 | 후속 BottomNav 테스트 필요 | `startsWith('/stats')` 정책으로 후속 수정 |
| STATS-011 | suspected | SSR `/stats`, localStorage에 기록 존재 | hydration warning 0건 | 서버 snapshot `[]`과 클라이언트 lazy initializer가 다른 markup을 만들 가능성 | 0건 | `StatSearch.tsx` 158~177, 499~570 | 브라우저 hydration 로그 필요 | 브라우저 hydration 테스트 필요 | 실제 SSR/hydration 재현 후 판정 |
| STATS-012 | suspected | `/stats` 검색 후 뒤로가기·문서 metadata 확인 | URL, 화면, metadata 동기화 | native `history.pushState` 사용; popstate/metadata 연결 없음 | player 1건 | `StatSearch.tsx` 318~324 | App Router를 우회한 URL만 변경 | 브라우저 navigation 테스트 필요 | 뒤로가기·metadata 실측 후 판정 |
| STATS-013 | suspected | direct `/stats/xbox/FixturePlayer` | 404 또는 플랫폼 validation 오류 | page/API에 platform allow-list validation이 보이지 않음 | player 1건 가능 | `app/stats/[platform]/[nickname]/page.tsx` 83~91; `player/route.ts` 127~142 | invalid shard가 외부 fetch/500으로 흐를 가능성 | 라우트 integration 테스트 필요 | direct URL 실행 후 판정 |
| STATS-014 | suspected | ready 결과에서 시즌 변경, player API 실패 | 이전 결과 유지+오류 안내 | 요청 시작 즉시 `setResult(null)` 수행 | player 1건 추가 | `StatSearch.tsx` 246~255, 264~286 | refresh가 아닌 검색은 기존 result 제거 | 브라우저 시즌 실패 테스트 필요 | 실제 UI 재현 후 판정 |
| STATS-015 | suspected | ready 결과의 강제 갱신 성공, 스쿼드 탭 상태 | 기획에 따라 현 탭 유지 또는 overview 복귀 | 공통 성공 분기는 overview로 복귀 | player `refresh=true` 1건 | `StatSearch.tsx` 289~295, 715~721 | 갱신과 시즌 변경이 같은 성공 후처리 사용 | 기획 확정 후 테스트 필요 | 제품 의도 확인 후 판정 |
| STATS-016 | suspected | A 직접 URL 요청 중 B route로 이동, A 응답이 나중 도착 | B 상태만 유지 | player GET에 AbortController/request token이 없고 prop 변경은 result만 비움 | player 2건 가능 | `StatSearch.tsx` 246~258, 354~381 | 최신 요청 우선 보장 부재 가능성 | race integration 테스트 필요 | 실제 route transition 재현 후 판정 |

## 자체 검토

- production 코드는 수정하지 않았다.
- 빈 닉네임 요청 차단을 결함으로 올리지 않고 `intentional`로 고정했다.
- 로딩·쿨다운 중 중복 차단과 시즌 변경 성공 후 overview 복귀를 `intentional`로 고정했다.
- 코드만으로 단정하기 어려운 항목은 수정하지 않고 `suspected`로 남겼다.
- 결함 수정, URL 상태 모델, 요청 취소, 반응형 UI 변경은 후속 task 범위로 보존했다.

## 우려와 후속 확인

- `verify:core`는 통과했지만 기존 lint warning 43개가 남아 있다.
- STATS-011~016은 브라우저·App Router·실제 API 상태가 필요해 이 태스크에서 확정하지 않았다.
- `buildBasicMatchSummary` date fallback은 90일 만료 표시와 직접 연결되므로 후속 모델 분리 시 명시적 unknown 시각을 다뤄야 한다.

## Task 3 controller architecture hardening

- `useStatsPageController`가 player와 summary batch의 AbortController/requestId를 분리해 route identity 변경, back/forward 성격의 prop 변경, unmount에서 이전 응답을 격리한다. 이는 STATS-016의 architecture hardening이며 검색 UI에 두 번째 submit/latest-wins 동작을 추가한 것이 아니다.
- STATS-002의 로딩·쿨다운 중 중복 submit 차단은 `intentional` 그대로다. 같은 진행 중 request key는 같은 Promise를 반환하고, 다른 사용자 검색은 진행 중 요청을 교체하지 않는다.
- STATS-003의 성공한 시즌 변경 후 overview 복귀는 제품 의도(`intentional`)로 유지한다. STATS-015의 성공한 강제 갱신 후 overview 복귀는 현재 동작을 보존하되 제품 의도는 아직 `suspected`로 남기며, 이를 intentional 또는 fixed로 재분류하지 않는다.
- STATS-014는 controller가 시즌 변경·강제 갱신을 `refreshing`으로 처리해 실패 시 기존 player result와 탭을 유지하도록 보강했다. player profile이 성공한 뒤 summary batch만 실패하면 profile을 유지한 `partial`과 `retrySummaries()`를 제공한다.
- direct `initialTab="squad"`는 첫 route 자동검색 성공보다 우선한다. 실제 URL query를 `StatSearch` props에 연결하는 route-first 작업은 Task 4 범위로 남겨 STATS-005를 이 단계에서 fixed로 표시하지 않는다.
