# Task 8 구현 보고서

- 작업일: 2026-08-10 KST
- 브랜치: `codex/opgg-stats-redesign`
- 시작 기준: `f615a6ca85a8e77d69f3e88ce88bec3d62cfa112`
- 범위: controlled squad `groupKey`, `StatSearch` adapter, raw summary `created_at` 안정 fallback, audit·회귀

## 시작 상태·root cause

- 작업 전 worktree는 clean이고 linked worktree였다. 지정 base·branch와 일치했다.
- 기존 `SquadAnalysisPanel` 목록 effect가 `useSearchParams().groupKey`를 dependency로 가지고 local `selectedGroupKey`를 초기화했다. `StatSearch`는 controller에 이미 있는 `groupKey/setGroupKey`를 panel에 넘기지 않아 route/controller와 panel 선택의 소유권이 분리됐다.
- detail GET은 local selection을 사용했므로 prop g2보다 URL g1이 우선했고, selector 변경은 상위 controller에 전달되지 않았다. selector에 accessible name도 없었다.
- raw `match_stats_raw` query는 `created_at`을 select하지 않았고 `buildBasicMatchSummary` helper는 `played_at` 부재 시 매 request의 `new Date()`를 `createdAt`으로 생성했다. 동일 row의 만료 상태가 요청 시각에 따라 변할 수 있었다.

## TDD RED

### controlled panel·controller wiring

production 수정 전에 `squad-analysis-panel-state`, `stat-search-deep-link`, 직접 panel 소비자를 수정/추가했다.

```text
$ npx vitest run tests/squad-analysis-panel-state.test.ts tests/stat-search-deep-link.test.ts tests/client-data-fetch-error-ui.test.ts
Test Files  2 failed | 1 passed (3)
Tests       5 failed | 15 passed (20)
exit        1
```

실패 증거:

- `스쿼드 그룹` combobox accessible name 부재.
- prop `groupKey="g2"`보다 URL g1을 선택하고 AI payload도 g1을 사용.
- invalid/undefined key를 첫 g1으로 올리는 callback 0회.
- `StatSearch` mock panel에 controller groupKey가 없어 `squad-group-none`으로 렌더.

### raw timestamp stability

```text
$ npx vitest run tests/matches-summary-route.test.ts tests/stat-search-ui.test.ts
Test Files  1 failed | 1 passed (2)
Tests       2 failed | 2 passed (4)
exit        1
```

- `created_at`만 있는 helper input이 fake now `2026-08-10T12:34:56.000Z`를 반환했다.
- 동일 raw row의 첫 route 응답이 DB `2026-07-01T10:00:00.000Z`가 아니라 첫 request time `2026-08-10T00:00:00.000Z`를 반환했다.
- 14일·90일 exact equality=false, cutoff 1ms 이전=true 회귀는 RED 시점에도 통과했다.

## 구현

### controlled `groupKey`

- `SquadAnalysisPanelProps` platform을 `StatsPlatform`으로 제한하고 `groupKey?: string`, `onGroupKeyChange(value: string)`를 추가했다.
- `useSearchParams`, local `selectedGroupKey`를 제거했다. selector value/change, detail GET, share URL은 모두 controlled prop/callback을 사용한다.
- list GET callback dependency는 `nickname/platform`뿐이다. group prop 변경 시 groups를 지우거나 list를 재요청하지 않는다.
- groups 준비 후 key가 undefined/invalid일 때만 첫 key를 상위에 올리고, 검증된 key만 detail GET을 보낸다.
- `StatSearch`가 controller `groupKey/setGroupKey`를 destructure해 panel에 전달한다. g1 선택 후 overview에서 panel이 unmount됐다가 squad로 돌아와도 controller의 g1이 복원된다.
- selector에 `aria-label="스쿼드 그룹"`을 추가했다.

### 요청 수·기존 기능 계약

- valid g2 초기: list GET 1건, g2 detail GET 1건, AI POST 0건.
- controlled g1 변경: list GET은 여전히 1건, g1 detail GET만 1건 추가, g2 detail은 1건 유지.
- invalid `missing`: missing detail GET 0건, first g1 reconcile callback 1회.
- CTA 후 `/api/pubg/ai-squad` payload의 g2, nickname, platform, matchIds, coachingStyle을 검증했다.
- share URL의 `tab=squad`, `groupKey=g2`, 3개 UTM, image download filename, 2D map match ID를 소비자 동작으로 검증했다.

### raw fallback 안정성

- `match_stats_raw` select에 실제 존재하는 `created_at`을 추가했다.
- helper input의 `played_at/created_at`을 nullable로 받고 `played_at ?? created_at ?? new Date().toISOString()` 순서로 반환한다.
- fake system time을 달리한 route 두 번이 모두 같은 raw `created_at` 값을 반환하고 select 문자열이 해당 컬럼을 포함함을 검증했다.
- `created_at`은 실제 경기 시각이 아니라 `played_at` 부재 시 request-time 변동을 막는 DB 저장 시각 fallback으로만 분류했다.

## GREEN·회귀 검증

```text
$ npx vitest run tests/squad-analysis-panel-state.test.ts tests/matches-summary-route.test.ts tests/stat-search-deep-link.test.ts tests/client-data-fetch-error-ui.test.ts tests/stat-search-ui.test.ts
Test Files  5 passed (5)
Tests       24 passed (24)

$ npx vitest run tests/squad-analysis.test.ts tests/squad-cause-scenes.test.ts tests/matches-summary-route.test.ts tests/stat-search-ui.test.ts tests/match-card-detail-state.test.ts
Test Files  5 passed (5)
Tests       26 passed (26)

$ npx eslint components/stat/SquadAnalysisPanel.tsx components/stat/StatSearch.tsx app/api/pubg/matches-summary/route.ts lib/pubg-analysis/matchSummary.ts tests/squad-analysis-panel-state.test.ts tests/matches-summary-route.test.ts
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

## audit 판정

- STATS-005는 단순 route initial prop 증거에서 controller→panel selection/detail/share→overview 왕복 증거로 구체화해 `fixed`를 유지했다.
- STATS-008은 `pubg_player_matches.played_at` 일반론이 아니라 raw `match_stats_raw` select+builder precedence 재현으로 바로잡고 `fixed`로 갱신했다.
- squad list/detail stale-response overwrite는 재현되지 않은 가설이다. AbortController/requestId를 추가하지 않았고 `fixed`로 기록하지 않았다.
- Kakao compare production은 수정하지 않았다.

## React condensed review·자체 검토

- direct imports, module-level component 경계, primitive effect dependency를 확인했다. list callback은 `nickname/platform`, reconcile/detail은 `firstGroupKey/hasSelectedGroup/groupKey`를 사용한다.
- selector 상태를 effect로 복사하지 않고 controlled prop을 바로 렌더한다. 새 inline component 정의나 불필요한 memo를 추가하지 않았다.
- 상세 선택 시 list를 지우지 않고 invalid에서 외부 detail을 보내지 않는 요청 경계를 테스트했다.
- 기존 Node `--localstorage-file` warning과 저장소 전역 ESLint warning 43개는 범위 밖이며 신규 대상에 warning은 없다.

## 관심 사항

- raw `created_at`은 실제 경기 시각이 아니므로 만료 판정의 정밀도를 높이려면 후속 스키마/적재 경로에서 raw `played_at` 또는 explicit unknown을 다뤄야 한다.
- stale group response 가설은 이 Task의 `fixed` 범위가 아니다. 실제 재현 또는 별도 race 계약이 생기면 그 때 request ownership을 추가한다.
