# Task 1 구현 보고서

## 상태

DONE_WITH_CONCERNS

production 코드 수정 없이 전적검색 characterization baseline, 공통 fixture, 배틀 localStorage 호환성, 90일 만료 경계, 회귀 감사표를 고정했다.

## 변경 파일

- 생성: `docs/reviews/2026-08-10-stats-search-regression-audit.md`
  - 7개 confirmed, 3개 intentional, 6개 suspected 항목을 요구된 10개 열 Markdown 표로 기록했다.
  - 변경 전/후 test 수와 `verify:core` 진단 수를 실제 실행값으로 기록했다.
- 생성: `tests/fixtures/stats/player-ready.json`
  - canonical player, 플랫폼, 두 개 시즌, 모드별 통계, 최근 매치, 갱신 시각을 가진 player-ready 계약이다.
- 생성: `tests/fixtures/stats/matches-summary-ready.json`
  - 명시적 `createdAt`, `gameMode`, `matchType`, 요약 출처를 가진 matches-summary-ready 계약이다.
- 생성: `tests/stat-search-baseline.test.ts`
  - 빈 닉네임 요청 0건.
  - 검색 성공 후 player 요청 1건, canonical URL, `string[]` 최근검색.
  - 로딩/쿨다운 중 submit 차단.
  - 시즌 변경 성공 후 overview 탭 복귀.
- 생성: `tests/battle-storage-compat.test.ts`
  - 공유 `STORAGE_KEY_RECENT`, `STORAGE_KEY_FAVORITES` `string[]` 소비 계약.
  - 손상된 JSON 제거 후 화면 렌더링 계약.
- 수정: `tests/stat-search-ui.test.ts`
  - 기존 90일 만료 helper 2개 테스트를 1ms 초과/정확한 경계값으로 강화했다. 테스트 수는 유지했다.
- 생성: `.superpowers/sdd/2026-08-10-opgg-style-stats-page-redesign/task-1-report.md`
  - 본 보고서.

## Red/Green 근거

이 태스크는 production 행동을 변경하지 않는 characterization task이므로 의도적인 behavior RED를 만들지 않았다. 처음 실행에서 나타난 RED는 행동 결함이 아니라 Vitest jsdom이 제공한 불완전한 `localStorage` 심에서 발생한 test-environment error였다.

### 최초 실행 — test harness RED

```text
$ npx vitest run tests/stat-search-baseline.test.ts tests/battle-storage-compat.test.ts tests/stat-search-ui.test.ts
exit 1
Test Files  2 failed | 1 passed (3)
Tests       6 failed | 2 passed (8)
TypeError: localStorage.clear is not a function
```

오류가 행동 누락을 검증하지 않으므로 production을 수정하지 않고 테스트 지역 `Storage` double을 추가했다.

### 수정 후 GREEN

```text
$ npx vitest run tests/stat-search-baseline.test.ts tests/battle-storage-compat.test.ts tests/stat-search-ui.test.ts
exit 0
Test Files  3 passed (3)
Tests       8 passed (8)
Duration    1.51s
```

characterization 항목은 기준 production에서 일반 PASS했다. 빈 입력 차단을 결함으로 보고하거나 수정하지 않았다.

## 정확한 검증 명령과 결과

### 변경 전 회귀 gate 캡처

```text
$ npx vitest run tests/stat-search-ui.test.ts tests/match-card-demand-loading.test.ts tests/player-suggest-route.test.ts tests/suggest-players.test.ts tests/pubg-recent-matches.test.ts tests/player-matches-api.test.ts
exit 0
Test Files  6 passed (6)
Tests       15 passed (15)
Duration    1.71s

$ npm run verify:core
exit 0
eslint: 0 errors, 43 warnings
tsc --noEmit --pretty false: 0 errors
```

### 변경 후 최종 gate

```text
$ npx vitest run tests/stat-search-ui.test.ts tests/match-card-demand-loading.test.ts tests/player-suggest-route.test.ts tests/suggest-players.test.ts tests/pubg-recent-matches.test.ts tests/player-matches-api.test.ts && npm run verify:core
exit 0
Test Files  6 passed (6)
Tests       15 passed (15)
Vitest duration 951ms
eslint: 0 errors, 43 warnings
tsc --noEmit --pretty false: 0 errors

$ git diff --check
exit 0
```

## 요구사항 자체 검토

- [x] 지정된 두 fixture를 생성했다.
- [x] 지정된 baseline/compat 테스트를 생성했다.
- [x] `stat-search-ui` 기존 2개 테스트 수를 유지하면서 만료 경계를 강화했다.
- [x] 빈 닉네임을 `intentional`로 판정했다.
- [x] 로딩/쿨다운 중 중복 차단을 `intentional`로 판정했다.
- [x] 시즌 변경 성공 후 overview 복귀를 `intentional`로 판정했다.
- [x] 지정된 7개 결함을 `confirmed`로 기록했다.
- [x] 브라우저/제품 의도 증거가 필요한 6개 항목을 `suspected`로 보존했다.
- [x] production 코드를 수정하지 않았다.
- [x] 지정 회귀 suite와 `verify:core`를 실행했다.

## 자체 리뷰

- 새 테스트는 external fetch, auth, Supabase, 광고, 복잡한 하위 표시 컴포넌트만 경계에서 대체하고 `StatSearch`·`BattleClient`의 실제 상태 변경과 DOM 결과를 검증한다.
- canonical URL은 실제 `window.history.pushState`, 최근검색은 실제 `Storage` 효과를 검증한다.
- 중복 submit 테스트는 로딩 promise를 직접 제어해 로딩과 쿨다운 두 구간의 player 요청 수를 검증한다.
- fixture는 후속 task의 타입 교체와 모드 분류 테스트가 재사용할 수 있게 현재 API 필드를 충분히 포함한다.
- `git diff --check`는 통과했다.

## 우려

- 저장소 전역 `verify:core`는 0 errors로 통과했지만 기준 커밋에서부터 존재한 lint warning 43개를 계속 보고한다.
- STATS-011~016은 Task 1에서 브라우저 실증·제품 의도 확정을 하지 않았으므로 `suspected`로 남아 있다.
- 이 태스크는 감사 baseline이므로 confirmed 결함을 수정하지 않았다.
