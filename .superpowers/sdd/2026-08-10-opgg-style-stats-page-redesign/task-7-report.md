# Task 7 구현 보고서

- 작업일: 2026-08-10 KST
- 브랜치: `codex/opgg-stats-redesign`
- 시작 기준: `d2c3c9e2e9d83c6e79554b47b5cc55de6f37b67c`
- 범위: 매치 피드 필터·광고 순서, compact facade, 상세 request/error/AI ownership 분리, StatSearch live adapter

## root cause 추적

### 경쟁전 `matchType` 소실

1. `/api/pubg/matches-summary`의 processed telemetry 경로는 `buildMatchSummary()`가 `fullResult.matchType || matchInfo.matchType`을 summary에 포함한다.
2. `useStatsPageController.loadSummaries()`는 summary의 `gameMode`, `matchType`, `mapName`을 `matchModeMeta[matchId]`에 보존한다.
3. 기존 `StatSearch`가 `matchModeMeta`를 다시 `Record<matchId, gameMode>`인 `dynamicMatchModes`로 축소했다.
4. inline filter는 이 문자열에서만 `competitive`/`ranked`를 찾아 `gameMode="squad-fpp"`, `matchType="competitive"`를 일반전으로 오분류했다.

수정은 API/controller가 아닌 표시 경계에 적용했다. `MatchFeed`가 원래 `matchIds` 순서에서 missing을 먼저 제외하고, summary에 full metadata를 불변 overlay한 뒤 Task 2 `filterRenderableMatches`를 호출한다. stats mode/party selection은 controller의 별도 state를 그대로 사용한다.

### 상세 HTTP 실패가 보이지 않던 이유

1. 기존 `MatchCard.fetchFullMatch()`는 `response.ok`를 확인하지 않고 JSON의 `data.error`만 검사했다.
2. HTTP 오류/JSON 오류/catch는 in-flight ref를 `false`로 되돌릴 뿐 UI state를 만들지 않았다.
3. `initialMatchData` summary와 expanded flag가 남아 summary shape를 full detail처럼 렌더했으며 오류 문구·명시적 retry가 없었다.

`ExpandedMatchDetails`가 `summary | loading | ready | error` detail state, requestId, AbortController를 소유한다. 실패하면 compact summary는 facade에 남고 상세 영역만 오류와 `상세 다시 시도`를 표시한다. retry 성공은 같은 행의 `detail_failed` source만 회복한다.

## 구현 결과

### MatchFeed와 광고

- `MatchFeed`는 summary loading skeleton, batch error inline retry, 4개 controlled filter, 필터별 empty 문구를 매치 영역 안에서 표현한다.
- renderable 배열을 확정한 뒤 Task 5 `getStatsFeedSlots`를 호출한다. mobile 7개는 6번째 뒤, tablet fixture registry 16개는 5·10·15번째 뒤에 삽입하며 모든 경우 마지막 항목은 match다.
- `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT`이 없는 실제 registry는 after-10 예약/creative를 모두 생략해 tablet 5·15만 남긴다. stats-top unit fallback은 없다.
- `unknown` viewport는 mobile/tablet reservation을 CSS visibility class로 매치 사이에 두고 provider child는 0개다. `StatSearch` root에 `.stats-page`를 연결해 Task 5 reservation CSS scope가 실제 페이지에 적용된다.
- detail/analysis callback source를 `match:${matchId}`로 묶어 한 행 recovery가 다른 행 partial source를 지우지 않는다.

### compact facade와 상세 보존

- `MatchCard.tsx`는 126줄 facade로 축소해 summary, `isExpanded`, `hasExpandedOnce`와 identity별 mount 경계만 소유한다.
- `CompactMatchRow`는 순위, 맵·유형, 킬·피해·DBNO·생존, AI tier, 텍스트 상태/왼쪽 선, accessible expand button만 렌더한다.
- 첫 expand 전 `/api/pubg/match` 요청과 상세 selector는 0개다. 첫 expand 뒤 `ExpandedMatchDetails`는 collapse 중에도 `hidden` + `aria-hidden`으로 mounted 상태를 유지해 full detail, 열린 하위 section, AI stream/result cache를 보존한다.
- optional summary가 없는 debug consumer도 mount 0요청 후 명시적 `매치 상세 불러오기` 한 번으로 요청한다.
- 14일 초과 summary는 성공한 summary-only 보존 상태다. detail 요청, 오류, retry, partial report를 만들지 않는다. 기존 90일 telemetry expiry 안내와 replay 조건은 상세 구현에 유지했다.

### 상세 request·AI ownership

- detail과 AI owner identity는 `platform:normalizedNickname:matchId`다. identity 변경/unmount에서 exact AbortController를 취소하고 requestId/generation이 다른 늦은 응답을 무시한다.
- A detail abort 뒤 B ready 후 늦은 A success가 B data나 partial을 덮지 않으며 abort는 failure callback을 만들지 않는다.
- AI도 composite owner key를 `aiManager`에 전달한다. same match A→B에서 늦은 A reader/finally는 B local loading/global lock/controller를 해제하지 않는다.
- collapse는 AI 요청을 abort하지 않는다. hidden 상태에서 final NDJSON chunk/done을 수신하고 reopen 후 verdict와 열린 AI section을 그대로 표시한다.
- AI HTTP 실패는 `analysis_failed`만 report하고 CTA retry 성공은 같은 reason/source를 recovery한다. 자동 AI 요청은 추가하지 않았다.
- `onModeDetected`는 summary와 full detail 모두 `gameMode + matchType + mapName` 전체를 전달한다. 기존 두-인자 callback도 추가 인자를 무시할 뿐 richer controller metadata를 `undefined`로 덮지 않는다.

### 기존 상세 기능 보존

- 기존 `MatchCard`의 상세 계산·JSX를 `ExpandedMatchDetails`로 이동했으며 placeholder로 축약하지 않았다.
- 팀 damage share/전술 badge, 차량 교전, 본인·스쿼드 무기 normalization, 티어 근거, timeline/map selected event, 팀원 navigation을 유지했다.
- per-match AI `/api/pubg/ai-analyze` body의 `matchData`, nickname, platform, coachingStyle과 chunk/done 결과 렌더링을 유지했다.
- 2D `/maps/{map}?playback=...&nickname=...&platform=...`, 3D `/replay/3d?matchId=...&nickname=...&platform=...` route와 analytics event를 유지했다. source characterization은 새 실제 소비자 파일을 검사하도록 이동했다.

## 변경 파일

- `components/stat/matches/MatchFeed.tsx` (신규)
- `components/stat/matches/CompactMatchRow.tsx` (신규)
- `components/stat/matches/ExpandedMatchDetails.tsx` (기존 상세 구현 이동)
- `components/stat/MatchCard.tsx` (facade)
- `components/stat/StatSearch.tsx` (live adapter, `.stats-page`)
- `tests/fixtures/stats/match-detail-ready.json` (신규)
- `tests/match-feed-ad-placement.test.ts` (신규)
- `tests/match-card-demand-loading.test.ts`
- `tests/match-card-detail-state.test.ts` (신규)
- `tests/stat-search-match-feed-integration.test.ts` (신규)
- `tests/telemetry-consumers.test.ts`
- `docs/reviews/2026-08-10-stats-search-regression-audit.md`

## TDD 증거

### RED — feed/detail 경계

production 수정 전에 지정 3파일 명령을 실행했다.

```text
$ npx vitest run tests/match-feed-ad-placement.test.ts tests/match-card-demand-loading.test.ts tests/match-card-detail-state.test.ts
Test Files  3 failed (3)
Tests       7 failed | 1 passed (8)
exit        1
```

`MatchFeed` module 부재, accessible `매치 상세 펼치기` facade 부재, 상세 error/retry/abort/identity 상태 부재로 실패했다.

### RED — StatSearch live integration

```text
$ npx vitest run tests/stat-search-match-feed-integration.test.ts
Test Files  1 failed (1)
Tests       1 failed (1)
Assertion   경쟁전 선택 뒤 ranked-by-type 행을 찾지 못함
exit        1
```

기존 inline filter가 `matchType="competitive"`를 잃는 실제 STATS-006 증상을 재현했다.

### GREEN — 최종 검증

```text
$ npx vitest run tests/match-feed-ad-placement.test.ts tests/match-card-demand-loading.test.ts tests/match-card-detail-state.test.ts tests/stat-search-ui.test.ts tests/stat-search-match-feed-integration.test.ts
Test Files  5 passed (5)
Tests       23 passed (23)

$ npx vitest run tests/stat-match-filter.test.ts tests/stats-ad-placements.test.ts tests/responsive-ad-slot.test.ts tests/telemetry-consumers.test.ts tests/analysis-engine.test.ts tests/pubg-analysis-stability.test.ts tests/stats-page-controller.test.ts
Test Files  7 passed (7)
Tests       75 passed (75)

$ npx vitest run tests/stats-page-model.test.ts tests/stat-search-baseline.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-navigation.test.ts tests/match-card-demand-loading.test.ts tests/ai-cache-routes.test.ts
Test Files  7 passed (7)
Tests       44 passed (44)

$ npx tsc --noEmit --pretty false
exit 0 (출력 없음)

$ npx eslint <Task 7 변경 TSX/test 파일>
exit 0 (출력 없음)

$ npm run verify:core
exit 0
eslint: 0 errors, 기존 43 warnings
tsc: 0 errors

$ git diff --check
exit 0 (출력 없음)
```

## 자체 검토 및 관심 사항

- React condensed review에서 direct import, module-level component, primitive effect dependency, functional expansion state, native button/aria-expanded, request cleanup과 hidden mount를 확인했다. 신규 변경 대상 ESLint warning/error는 0개다.
- request ownership 회귀는 detail A→B late response, unmount abort, AI same-match A→B late finally, collapse 중 deferred AI를 각각 검증한다. abort는 partial failure가 아니고 실패 attempt는 reason별 한 번만 report된다.
- fixture는 팀, weapon/squad weapon, benchmark/tier evidence, map/timeline, AI, replay를 실제 `MatchData` shape로 제공하며 각 selector/route/payload를 소비자 동작으로 검증한다.
- 실제 feed AdFit env는 여전히 없으므로 after-10 operational slot은 pending이며 top unit을 재사용하지 않았다.
- 로컬/jsdom에서는 provider 네트워크를 실행하지 않았다. 실제 광고 채움, smooth collapse 위치, 375~1920px 시각 QA는 Task 9/10과 배포 미리보기 대상이다.
- 저장소 전역 기존 ESLint warning 43개는 범위 밖이며 신규 대상에는 warning이 없다.

## Fix Round 1 — live 상세의 성과·티어 근거 복구

### 리뷰 검증과 root cause

- 지적사항을 실제 facade 경로에서 확인했다. `ExpandedMatchDetails` 내부의 `detailsOnly=true`로 인해 기존 헤더는 항상 `!detailsOnly` 분기 뒤에 있었다.
- 팀 피해 비중, 배지, 34/27/21 점수, impact grade/reason, next-tier 정보, 세부 근거 section이 모두 이 dead header에 있었고 live expanded 영역에는 `TierEvidenceSummary` 요약만 있었다.
- fixture의 `teamDamageShare=66.3`, `화력 담당`, breakdown 34/27/21, `impactScore=87`, `impactGrade=CARRY`, `화력 기여`는 이미 실제 `MatchData` shape에 있어 변조하지 않고 literal 기댓값으로 사용했다.

### RED

production 수정 전 live `MatchCard` facade 테스트에 exact-value와 모바일 toggle 기댓값을 추가했다.

```text
$ npx vitest run tests/match-card-detail-state.test.ts
Test Files  1 failed (1)
Tests       2 failed | 7 passed (9)
Assertion   `팀 66.3%`를 live expanded DOM에서 찾지 못함
exit        1
```

데스크톱 exact-value 테스트와 모바일 accessible detail-toggle 테스트가 동일한 dead-render 원인으로 실패했다.

### 구현

- module-level `MatchPerformancePanel`을 추가해 live expanded 영역에 팀 피해 비중·배지·티어 점수·impact·next-tier·세부 근거를 함께 표시했다.
- 34/27/21 점수와 next S+ 진행도는 이름·min/max/now가 있는 `progressbar`로 표현했다. impact는 `87 · 캐리 (CARRY)`와 `화력 기여`를 함께 노출한다.
- 데스크톱은 전투·전술·생존 세부 section을 즉시 표시하고, 모바일은 기존과 같이 접힌 `상세 근거 보기` button에서 시작해 `aria-expanded`로 상태를 전달한다. target은 44px 이상이다.
- `detailsOnly`, `isExpanded`, tooltip layout/ref/effect, 모바일 body-lock, 맵명 번역 등 dead header 전용 로직과 중복 JSX 280여 줄을 제거했다. compact facade/toggle은 상위 `MatchCard`에만 남아 중복되지 않는다.

### GREEN 및 회귀

```text
$ npx vitest run tests/match-card-detail-state.test.ts
Test Files  1 passed (1)
Tests       9 passed (9)

$ npx vitest run tests/match-feed-ad-placement.test.ts tests/match-card-demand-loading.test.ts tests/match-card-detail-state.test.ts tests/stat-search-ui.test.ts tests/stat-search-match-feed-integration.test.ts
Test Files  5 passed (5)
Tests       24 passed (24)

$ npx vitest run tests/stat-match-filter.test.ts tests/stats-ad-placements.test.ts tests/responsive-ad-slot.test.ts tests/telemetry-consumers.test.ts tests/analysis-engine.test.ts tests/pubg-analysis-stability.test.ts tests/stats-page-controller.test.ts
Test Files  7 passed (7)
Tests       75 passed (75)

$ npx vitest run tests/stats-page-model.test.ts tests/stat-search-baseline.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-navigation.test.ts tests/match-card-demand-loading.test.ts tests/ai-cache-routes.test.ts
Test Files  7 passed (7)
Tests       44 passed (44)

$ npx eslint components/stat/matches/ExpandedMatchDetails.tsx tests/match-card-detail-state.test.ts
exit 0 (출력 없음)

$ npx tsc --noEmit --pretty false
exit 0 (출력 없음)

$ npm run verify:core
exit 0
eslint: 0 errors, 기존 43 warnings
tsc: 0 errors

$ git diff --check
exit 0 (출력 없음)
```

### Fix Round 1 자체 검토

- 변경된 TSX는 direct import, module-level panel, functional toggle state, primitive 후속성을 유지한다. inline component 정의나 derived-state effect를 추가하지 않았다.
- live facade 테스트가 exact fixture value와 실제 accessible role을 검증하므로 제목만 남는 회귀를 잡는다. 모바일은 접힘/펼침 DOM 상태를 별도로 검증한다.
- replay, vehicle, weapon, team, AI/request ownership은 수정하지 않았고 Task 7 회귀 묶음으로 보존을 확인했다.
- 기존 관심 사항인 feed AdFit env 부재와 실브라우저 시각 QA 미수행은 변화 없이 남아 있다.
