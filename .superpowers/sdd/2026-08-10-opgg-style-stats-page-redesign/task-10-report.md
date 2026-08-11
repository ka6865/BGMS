# Task 10 전적 페이지 브라우저 기능 감사·반응형 광고 QA 보고서

- worktree: /Users/kangheesung/10-19_개발/13_프로젝트/13.01_PUBG_지도_서비스/pubg-map-app-local/.worktrees/codex-opgg-stats-redesign
- branch: codex/opgg-stats-redesign
- base: f1728a7
- QA 일시: 2026-08-11 KST
- 최종 로컬 상태: 코드 구현 및 로컬 QA 완료 — 광고 운영 설정 대기
- 외부 운영: 수행하지 않음

## 1. RED → GREEN 기록

### Pure scenario/harness

초기 RED:

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts
FAIL — 0 tests 실행. ./fixtures/stats/squad-ready.json 및 Task 10 harness/scenario 구현이 없어 모듈 로드에 실패.
~~~

첫 구현 후 RED:

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts
FAIL — 3 failed, 6 passed. clone/fixture 계약은 통과했지만 dispatcher·ledger 연결과 retry lifecycle 계약이 남음.
~~~

aborted retry terminal semantics를 별도 강화한 RED:

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts
FAIL — 10 tests 중 1 failed. TypeError: scenario.abort is not a function.
~~~

최종 GREEN:

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)
exit 0
~~~

StatsScenarioState.abort(request)와 recordId별 reservation rollback을 추가했다. requestfailed는 scenario counter를 소비하지 않고 ledger를 aborted terminal로 만들며, requestfinished만 completed를 확정한다. _t 제외 semantic key, method/query/body 검증, squad groupKey 소유권, unauthenticated AI fatal gate를 pure assertion으로 실행했다.

### Safe-area browser RED → deterministic RED → GREEN

기존 브라우저 측 판단은 .stats-page.pb-safe-nav의 56px 예약과 57px BottomNav 경계 불일치였다. production 변경 전에 deterministic CSS RED를 실행했다.

~~~text
$ npx vitest run tests/stats-layout-boundary.test.ts
FAIL — safe-area assertion: received 56px, expected border-inclusive 57px.
~~~

app/globals.css의 route-scoped .stats-page.pb-safe-nav만 57px + env(safe-area-inset-bottom)으로 바꾸고 기존 layout boundary assertions를 보존했다.

~~~text
$ npx vitest run tests/stats-layout-boundary.test.ts
Test Files  1 passed (1)
Tests       7 passed (7)
exit 0
~~~

Browser layout row 375×667의 safe padding assertion도 pass했다. .pb-safe-nav의 다른 전역 utility는 바꾸지 않았다.

### Owned child lifecycle RED → GREEN

~~~text
$ npx vitest run tests/stats-child-lifecycle.test.ts
FAIL — TypeError: terminateOwnedChild is not a function.
~~~

terminateOwnedChild를 export하고 SIGTERM timeout 후 SIGKILL을 보내며 exit event 또는 실제 exitCode를 확인할 때까지 await하도록 최소 구현했다.

~~~text
$ npx vitest run tests/stats-child-lifecycle.test.ts
Test Files  1 passed (1)
Tests       1 passed (1)
exit 0
~~~

Fake child evidence는 SIGTERM → SIGKILL, exitCode=137 순서와 실제 exit event 완료를 확인한다.

## 2. Browser smoke 실행과 server lifecycle

### 중단된 in-flight run 회수

사용자 지시에 따라 먼저 PID를 확인했다.

~~~text
$ ps -p 52839,52841 -o pid=,ppid=,stat=,command=
52839 Vitest
52841 owned Next
~~~

약 30초 동안 기다린 뒤 다시 확인했을 때 두 PID와 .next/dev/lock이 사라졌다. 해당 outer exec가 중단되어 이 run의 stdout/result는 회수할 수 없었다. 기존 PID를 kill하지 않았고 lock도 삭제하지 않았다. 결과를 fresh pass로 간주하지 않았다.

### Fresh Puppeteer smoke

agent-browser는 main preflight에서 PATH에 없어 설치하지 않았고, Puppeteer smoke만 실행했다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts --testTimeout=90000 --silent=false
Test Files  1 passed (1)
Tests       43 passed (43)
Duration    63.32s
exit 0
~~~

이 fresh run의 owned Next child는 PID 54626이었다. afterAll에서 해당 PID만 stop했고, 종료 후 ps -p 52839,52841,54626에 출력이 없으며 .next/dev/lock도 없었다. 외부 listener/lock은 kill/delete하지 않았다.

Smoke는 domcontentloaded와 명시적 DOM/ledger condition만 기다렸다. networkidle0, page.removeAllListeners("request"), Page 재사용, static response queue는 사용하지 않았다.

### 실제 matrix

| matrix | 실제 실행값 | 결과 |
| --- | --- | --- |
| functional | 390×844, 1440×900 | 43개 전체 중 해당 rows pass |
| layout/ad | 375×667, 390×844, 430×932, 768×1024, 1440×900, 1600×900 | 각 row pass |
| resize | 767↔768, 1023↔1024 | 각 row pass |
| screenshot-only | 375×812, 1280×720, 1920×1080 | 각 row pass |
| audit | STATS-011/012/013/014/016 | audit test pass |
| full | 1 file / 43 tests | 43 passed / 0 failed |

Screenshots는 다음 실제 파일에 생성됐다.

- /Users/kangheesung/10-19_개발/13_프로젝트/13.01_PUBG_지도_서비스/pubg-map-app-local/.worktrees/codex-opgg-stats-redesign/tmp/stats-browser-qa/dev-server-check.png
- /Users/kangheesung/10-19_개발/13_프로젝트/13.01_PUBG_지도_서비스/pubg-map-app-local/.worktrees/codex-opgg-stats-redesign/tmp/stats-browser-qa/stats-screenshot-375x812.png
- /Users/kangheesung/10-19_개발/13_프로젝트/13.01_PUBG_지도_서비스/pubg-map-app-local/.worktrees/codex-opgg-stats-redesign/tmp/stats-browser-qa/stats-screenshot-1280x720.png
- /Users/kangheesung/10-19_개발/13_프로젝트/13.01_PUBG_지도_서비스/pubg-map-app-local/.worktrees/codex-opgg-stats-redesign/tmp/stats-browser-qa/stats-screenshot-1920x1080.png

현재 screenshot SHA-256 evidence:

~~~text
d8727dd76c06daf6e3daafe437e794b61b1bc4762753a60300ee927bda2aa0ac  dev-server-check.png
a320b2b46887c267006c7f8dadc7d3bad83f5a0cd823a1ec8aa27feda74c2dd7  stats-screenshot-375x812.png
a1485892a93021a2fdd9c2e8c16ff4de83b10d1c76c3e38831f7a80bd0f684fe  stats-screenshot-1280x720.png
cd029517b0d5a3009797eafda4a55381cc7f05fdc37c1b8ec961b0e4b77a2b02  stats-screenshot-1920x1080.png
~~~

## 3. Browser evidence boundaries

### Functional state assertions

- ready: dynamic route heading, recent match row, top ad registry state mounted, successful player and summary terminal records.
- loading: player retry row waits for [role="status"] before terminal retry assertions.
- partial/error: detail retry keeps compact row, asserts [data-testid="expanded-match-details"] [role="alert"], then asserts row-local 500 → 200 recovery. Summary retry similarly asserts inline error and retry recovery.
- 404: suggestion A→B uses returned Kakao platform.
- 429: literal Retry-After: 1 prevents a premature success.
- empty: empty submit produces zero player requests.
- storage: favorite/recent values exist only in the owning context; fresh context starts without them.
- expired: 13/15/91-day rows exercise the product’s existing expiry behavior; only the eligible detail request is successful.

### Team/weapon/tier/AI assertions

The smoke asserted only executed UI boundaries: tier evidence section, weapon section and 내 무기 상세 스탯, team section, AI section and CTA presence. Clicking the unauthenticated AI CTA was asserted to produce zero /api/pubg/ai-analyze requests; the pure/browser AI gate also checks zero /api/pubg/ai-summary, /api/pubg/ai-analyze, and /api/pubg/ai-squad requests. No authenticated finalVerdict behavior was claimed; existing component tests own that contract.

### Replay and map boundary

The smoke asserted the replay control set only: 3D 전술 리플레이, 2D 맵 리플레이, and 고정밀 리플레이 were present and enabled. Telemetry-backed route navigation and map/replay data rendering were not performed. Clicking those routes would leave the deterministic fixture contract and request /api/pubg/telemetry; therefore 2D/3D/map route navigation is explicitly 미검증, not pass evidence.

### Control-size evidence

이 최초 evidence는 selector별 첫 요소만 측정했으므로 “complete” evidence가 아니었다. Fix Round 1에서 ready/detail-error/detail-expanded/squad 상태별 모든 matched instance를 named record로 다시 측정했으며, 아래 §8 결과가 이 단락을 대체한다. 접힘·누락은 pass로 세지 않고 state별 hidden/not-applicable로 분리했다.

### Layout, overflow, ad and console evidence

- All layout and screenshot assertions observed globalOverflow=0 and internalOverflow=[].
- Shell cap assertion was ≤1200px; mobile top reservation was 100px, tablet/desktop reservation 90px; fluid in-feed reservations were ≥130px.
- The safe-area boundary passed after the focused 56px → 57px CSS fix; BottomNav overlap assertion passed.
- Local ad external request count was 0. DOM evidence was provider adfit, state mounted, and env unit DAN-fixture-stats-feed-728; this is a local placeholder/registry reservation and is not live fill evidence.
- Analytics was recorded separately from ads. A recorded ready flow had ad=0, analytics=2, other=0. These analytics/HMR/Supabase loopback messages were classified as local harness/environment traffic; page errors were empty and no Next error overlay was observed. They were not treated as product defects.

The ledger records started, completed, aborted, unexpected, HTTP status, and successful independently. response records status only; requestfinished/requestfailed own terminal transition. Aborted same-semantic requests release their scenario reservation and do not consume 500→200 retry counters. Every browser scenario calls throwIfUnexpected() and the full 43/43 command exited 0.

## 4. Audit/spec updates

docs/reviews/2026-08-10-stats-search-regression-audit.md was updated only with executed browser evidence for STATS-011/012/013/014/016 and the Task 10 layout/control/replay rulings. Replay telemetry navigation remains 미검증.

docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md ends exactly with:

~~~text
코드 구현 및 로컬 QA 완료 — 광고 운영 설정 대기

## 11. Final Luna/max review

Main이 direct `gpt-5.6-luna` / `reasoning_effort=max`로 current-code diff와 본 보고서를 읽기 전용 재검토했다. Critical 0건, Important 0건이며 이전 findings 9개는 모두 `Addressed`, 최종 verdict는 `Approved`였다. Reviewer는 새 테스트를 반복하지 않고 PID 68950의 current-code browser `43/43`, 영향 범위 gate, temporary layout 제거, STATS-016 `not_reproduced` 판정, fixture/tsconfig/PID/lock/staging 상태를 구현·문서와 대조했다.

최종 커밋 메시지는 `test(stats): 전적 페이지 반응형 QA 결과 기록`이며 push/PR/merge/deploy는 수행하지 않는다.
~~~

No TSX file changed, so the React condensed review was not run; this is recorded as TSX changes 없음.

## 5. Verification gates

The final non-browser command, forbidden-pattern grep, fixture/tsconfig diff checks, git diff --check, and final status are run after this report is written and their exact outputs are appended below before any staging decision.

## 6. Review and pending operations

Implementer 내부 context에서는 direct spawn callable이 없었지만, main이 read-only direct `gpt-5.6-luna` / `reasoning_effort=max` 리뷰를 수행했고 verdict는 `Changes requested`였다. 이 문서의 §8 Fix Round 1은 해당 Important 8개와 Minor 1개를 해결한 상태이며, main의 direct Luna/max re-review 전까지 review status와 progress는 pending이다. 다른 모델이나 CLI fallback은 사용하지 않았다.

Pending external operations, not performed:

1. dedicated deployment ad-feed environment setting
2. Preview real-ad validation
3. AdSense console side-rail/Top-only/exclusion setup and preview

The exact design status remains 코드 구현 및 로컬 QA 완료 — 광고 운영 설정 대기

## 7. Final gate append-only evidence

추가로 실행한 audit-only browser command는 다음과 같다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'browser-only regression audit' --testTimeout=120000 --silent=false --reporter=verbose
ownedPid=56839, baseUrl=http://127.0.0.1:53605, nowIso=2026-08-11T12:49:59.429Z
Test Files  1 passed (1)
Tests       1 passed | 42 skipped (43)
Duration    14.67s
exit 0
~~~

그 실행에서 기록된 request lifecycle은 STATS-011/012 player `2/2/0/2`, summary `2/2/0/2`, analytics `9 aborted`; STATS-013 player `0/0/0/0`, analytics `2 aborted`; STATS-014 base player `1/1/0/1`, summary `1/1/0/1`, season player `1/1/0/0` status 500, analytics `2 aborted`; STATS-016 A `1/0/0/0` evidence snapshot, B `1/1/0/1`, analytics `4 aborted`였다. 모든 해당 scenario의 ad external은 0, other external은 0, pageErrors는 []였다. STATS-011/012의 consoleErrors는 analytics Inspector 차단, Next HMR websocket handshake, local Supabase realtime loopback 거절만 포함했고 product overlay/page error로 판정하지 않았다.

복원된 기존 layout boundary test를 포함한 focused 결과:

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)
exit 0

$ npx vitest run tests/stats-child-lifecycle.test.ts tests/stats-layout-boundary.test.ts
Test Files  2 passed (2)
Tests       7 passed (7)
exit 0

$ npx vitest run tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stats-page-controller.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-autocomplete.test.ts tests/match-card-detail-state.test.ts tests/squad-analysis-panel-state.test.ts tests/stats-auto-ads-boundary.test.ts tests/responsive-ad-slot.test.ts tests/bottom-nav-stats-active.test.ts
Test Files  11 passed (11)
Tests       80 passed (80)
exit 0
~~~

최종 non-browser automatic gate:

~~~text
$ npm run verify:core && npx vitest run
verify:core: exit 0; eslint 0 errors / 43 pre-existing warnings; tsc --noEmit 0 errors
Test Files  133 passed | 2 skipped (135)
Tests       1299 passed | 49 skipped (1348)
Duration    14.96s
exit 0
~~~

첫 non-browser gate에서는 tests/stats-browser-smoke.test.ts:294의 `error` unknown TypeScript error로 exit 2였다. pageerror message normalization을 test harness에 추가한 뒤 위 GREEN gate를 재실행했다. production TSX는 변경하지 않았다.

최종 cleanup/diff gates:

~~~text
$ git diff --check
diff_check_exit=0
$ git diff --exit-code -- tests/fixtures/stats/match-detail-ready.json
fixture_diff_exit=0
$ git diff --exit-code -- tsconfig.json
tsconfig_diff_exit=0
$ test -e .next/dev/lock
next_lock_exit=1 (lock absent)
$ forbidden legacy rg command
forbidden_grep_exit=1 (no matches)
$ ps -p 52839,52841,54626,56839 -o pid=,stat=,command=
(no output; no owned or prior in-flight process remains)
~~~

Next가 browser 실행 중 자동으로 포맷한 tsconfig.json은 HEAD 내용으로 apply_patch 복구했고, 위 diff exit 0을 확인했다. preserved match-detail-ready.json도 SHA-256 `3f13807bb845756f9e70b8329b9176df9182378de96a968af9fade17b1345d51`에서 변경되지 않았다.

## 8. Fix Round 1 — direct Luna/max Changes requested 대응

### Review 상태 교정

Main의 read-only direct gpt-5.6-luna / max 리뷰에서 Important 8개와 Minor 1개가 Changes requested로 전달됐다. Implementer는 다른 모델이나 CLI fallback을 사용하지 않았고, 이 round의 결과는 main direct Luna/max re-review 전까지 pending review다. 커밋과 staging은 수행하지 않는다.

### Pure harness RED → GREEN

Finding 8의 GET body strict validation을 먼저 추가했다.

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts -t 'rejects request bodies on every GET stats endpoint'
Test Files  1 failed (1)
Tests       1 failed | 10 skipped (11)
Failure     player GET with body resolved 200 instead of rejecting
exit 1
~~~

player/suggest/match/squad GET resolver에 body 존재 strict reject를 추가했다.

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts -t 'rejects request bodies on every GET stats endpoint'
Test Files  1 passed (1)
Tests       1 passed | 10 skipped (11)
exit 0

$ npx vitest run tests/stats-browser-harness.test.ts
Test Files  1 passed (1)
Tests       11 passed (11)
exit 0
~~~

### Browser targeted RED/GREEN

Layout/resize assertion 추가의 첫 실행은 제품 결함 없이 GREEN이었다. 이전 smoke가 값을 수집만 하던 evidence gap이었으며 production 변경은 없었다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'layout/ad evidence|fresh bidirectional resize evidence' --testTimeout=90000 --silent=false --reporter=verbose
ownedPid=62062
Test Files  1 passed (1)
Tests       8 passed | 35 skipped (43)
Duration    19.55s
exit 0
~~~

Controls/429/detail/squad/audit 강화의 첫 묶음에서 STATS-016 terminal gap이 RED로 재현됐다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'functional ready/double-submit/control flow|429 Retry-After|detail expand error|squad list/groupKey|controls preserve match filters|invalid platform redirects|browser-only regression audit' --testTimeout=90000 --silent=false --reporter=verbose
ownedPid=62231
Test Files  1 failed (1)
Tests       3 failed | 10 passed | 30 skipped (43)
Duration    121.78s
Failure     route-race 390/1440 및 STATS-016에서 PlayerA가 30초 후에도 started/non-terminal
exit 1
~~~

첫 handled-request 보정만으로는 full-document navigation에서 abort callback이 오지 않아 RED가 유지됐다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'invalid platform redirects|browser-only regression audit' --testTimeout=90000 --silent=false --reporter=verbose
ownedPid=62709
Test Files  1 failed (1)
Tests       3 failed | 40 skipped (43)
Duration    111.21s
Failure     동일 PlayerA terminal timeout
exit 1
~~~

원인은 제품 UI overwrite가 아니라 Puppeteer가 paused interception을 이전 document 폐기 시 terminal network event로 전달하지 않는 harness lifecycle이었다. in-document fetch AbortSignal bridge와 main-frame navigation 시 이전 document의 exact active stats request abort bridge를 추가했다. B 요청 자체를 근거로 임의 취소하지 않는다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'invalid platform redirects' --testTimeout=90000 --silent=false --reporter=verbose
ownedPid=62986
Test Files  1 passed (1)
Tests       2 passed | 41 skipped (43)
Duration    13.69s
exit 0
~~~

A는 802–803ms 관찰 후 terminal aborted 1건, successful 0건이었고 B는 completed 200/successful 1건이었다. B heading/URL은 유지됐다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'browser-only regression audit|squad list/groupKey|detail expand error' --testTimeout=90000 --silent=false --reporter=verbose
ownedPid=63121
Test Files  1 passed (1)
Tests       5 passed | 38 skipped (43)
Duration    18.15s
exit 0
~~~

첫 fresh full에서는 desktop 429 timer anchor가 실제 1초 deadline을 넘어서는 automation timing으로 유일하게 실패했다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts --testTimeout=90000 --silent=false --reporter=dot
ownedPid=63263
Test Files  1 failed (1)
Tests       1 failed | 42 passed (43)
Duration    67.59s
Failure     1440×900 429 button-disabled assertion
exit 1
~~~

900ms 관찰을 navigation 직전부터 시작하도록 바꿔, UI 처리 시간이 관찰창 밖에 더해지지 않게 했다. 900ms가 지난 뒤에도 successful player 0건과 retry disabled를 assert한다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t '429 Retry-After' --testTimeout=90000 --silent=false --reporter=verbose
ownedPid=63917
Test Files  1 passed (1)
Tests       2 passed | 41 skipped (43)
Duration    13.49s
exit 0
~~~

same-Shell 보정 전 중간 fresh full(후속 정정은 §9):

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts --testTimeout=90000 --silent=false --reporter=dot
nowIso=2026-08-11T13:34:05.889Z
baseUrl=http://127.0.0.1:56656
ownedPid=63999
Test Files  1 passed (1)
Tests       43 passed (43)
Duration    61.88s
exit 0
~~~

모든 위 owned PID는 각 suite afterAll에서 종료됐고 .next/dev/lock은 남지 않았다. Browser 종료 뒤 Next의 tsconfig.json 자동 변경은 HEAD 내용으로 복구했다.

### Finding 9개 해결 결과

| finding | 실제 해결/증거 | 판정 |
| --- | --- | --- |
| 1. inactive provider unmount | 767→768→767에서 mobile stats-mobile-after-6/adsense child가 제거되고 tablet stats-after-5/adsense, stats-after-10/adfit, stats-after-15/adsense child가 나타난 뒤 다시 제거됨. 각 placement는 child data-ad-owner-key 정확히 1개 | addressed |
| 2. layout/AI assertions | grid 1/2 column, profile→top ad→tabs→overview/match DOM/좌표 순서, 1440×900 first viewport co-visibility, long nickname title+ellipsis+scrollWidth>clientWidth, AI region focus/viewport intersection을 실제 assert | addressed |
| 3. resize 양방향 | 767→768→767과 1023→1024→1023을 같은 fresh Page에서 왕복 검증 | addressed |
| 4. control 44px instance | ready/detail-error/detail-expanded/squad 상태에서 selector의 모든 matched instance를 named record로 측정. required state group visibleCount를 assert하고 hidden/missing은 pass에서 제외 | addressed |
| 5. 429 900ms | navigation 직전부터 실제 wall clock ≥900ms 후 player successful=0, retry disabled를 assert한 뒤 deadline release와 200 recovery 확인 | addressed |
| 6. STATS-014 preservation | season 500 전후 profile title/nickname/platform, match ID, compact row text snapshot이 exact equal임을 assert | addressed |
| 7. STATS-016 terminal | A delay 600ms보다 긴 800ms 관찰 뒤 A terminal aborted/successful 0, B completed successful 1, B heading/URL 유지 | addressed |
| 8. GET body reject | player/suggest/match/squad GET body strict rejection pure 11/11 | addressed |
| 9. replay 제목/범위 | test 제목을 replay controls availability로 교정. telemetry navigation은 계속 미검증 | addressed |

### Layout/ad actual evidence

- 767 mobile: stats-top/adfit owner 320x100 + stats-mobile-after-6/adsense owner 1개.
- 768 tablet: mobile placement DOM 0; stats-top/adfit 728x90 + stats-after-5/adsense + stats-after-10/adfit fixture 728x90 + stats-after-15/adsense가 각각 provider child 1개.
- 768→767 복귀: tablet placements DOM 0, mobile placement와 320x100 top child가 exact 복귀.
- 1023: gridColumnCount=1. 1024: gridColumnCount=2, resolved columns 320px + remainder. 1023 복귀 시 gridColumnCount=1. 세 상태의 tablet placement/provider/owner-key 배열은 동일하다.
- 모든 layout/resize row에서 globalOverflow=0, internalOverflow=[], shell≤1200, mobile top 100, tablet+ top 90, fluid≥130, safe-area overlap pass.
- 1440×900 scrollY=0에서 profile/top ad/tabs/overview/match가 모두 first viewport와 교차하고 overview/match는 같은 top 좌표다.
- long nickname 390×844는 scrollWidth=2489/clientWidth=175, 1440×900은 scrollWidth=2973/clientWidth=965였다. title literal, text-overflow ellipsis, nowrap, overflow hidden을 함께 assert했다.
- local ad external=0이며 mounted/provider child evidence는 placeholder registry 증거일 뿐 live fill이 아니다.

### AI focus/scroll 및 browser 범위

390×844에서 AI region rect는 top=671.5, bottom=843.5, viewportHeight=844였고, 1440×900에서는 top=593.5, bottom=765.5, viewportHeight=900이었다. 두 경우 모두 region의 첫 button이 document.activeElement였고 /api/pubg/ai-summary, /api/pubg/ai-analyze, /api/pubg/ai-squad는 0건이었다.

Authenticated AI 결과 clamp/finalVerdict는 이 unauthenticated deterministic browser scope에서 실행하지 않았다. 기존 component tests 소유이며 browser pass로 주장하지 않는다.

### Control instance actual scope와 분류

“전체 control”은 앱 전체의 임의 button이 아니라 다음 실제 state별 named scope를 뜻한다.

- ready: search platform/nickname/submit 각 1, recent quick/favorite/remove 각 1, profile refresh/favorite/compare/weapons/season 각 1, section tabs 2, stats mode 2, party 3, match filters 4, match expand 1, overview AI open 1, mobile BottomNav 5.
- detail-error: ready 공통 visible controls + match collapse 1 + detail retry 1. retry는 94.09×44로 pass.
- detail-expanded: 공통 visible controls + expanded detail의 모든 visible button 8–9개 + replay modal options 3개. AI CTA는 mobile 302×252, desktop 732×252; replay options는 mobile 316×88/92/92, desktop 462×88/92/92.
- squad: 공통 search/profile/tabs + squad group selector 1 + squad root의 모든 visible button 4개. Overview-only mode/party/filter/match/AI-open은 hidden/not-applicable이며 pass로 세지 않았다.

실측 legacy violations는 다음처럼 별도 분류했다.

- ready mobile: “전체” match filter 41.78×44, BottomNav 비활성 4개 약 74.8×38. active AI 전적 nav 80.78×49.68은 pass. Desktop ready violation 0.
- detail-expanded: replay-open 약 103.95×33 mobile/111.97×34.5 desktop, coaching style 98.44×32 및 85.14×32. AI CTA와 replay options는 44px pass.
- squad desktop: selector 288×40.84, coaching style 100.98×24/103.7×24, AI report 126.41×32, map feedback 1118×42. 이들은 기존 nested squad/detail controls로 기록했다.
- 새 Shell/States primary control violation은 0이었다.

접히거나 해당 state에서 없는 control은 hidden/not-applicable evidence로 남겼으며 44px pass에 포함하지 않았다.

### 남은 미검증

- map/2D/3D telemetry-backed navigation과 data rendering
- authenticated AI browser flow와 AI result clamp/finalVerdict
- Preview/live ad fill 및 외부 AdSense/AdFit 운영 설정

이 시점까지는 production TSX/CSS를 추가 변경하지 않았다. 후속 same-Shell 검토와 main scope-freeze 판정은 §9에 append했으며, 이 단락의 STATS-016/full 표현은 §9가 대체한다.

## 9. Scope freeze — STATS-016 same-Shell 판정 교정

### 추가 리뷰 지적과 RED

기존 route-race가 `page.goto(A) → page.goto(B)` full-document navigation을 사용해 main-frame abort bridge로 A를 terminal 처리했다는 지적을 재현했다. 기존 흐름에 stable Shell witness를 추가한 RED는 새 document에서 witness가 사라짐을 확인했다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'invalid platform redirects without player request and route race keeps B' --testTimeout=90000 --silent=false --reporter=verbose
baseUrl=http://127.0.0.1:57524, ownedPid=65268
Test Files  1 failed (1)
Tests       2 failed | 41 skipped (43)
Duration    16.38s
Failure     witnessPresent=false, sameDocument=false, sameShell=false
exit 1
~~~

이는 이전 full-navigation GREEN이 same-Shell identity race 증거가 아님을 보여준 harness/test RED였다.

다음으로 생산 구조를 변경하기 전, 사용자가 제안한 실제 흐름 `PlayerB` initial ready → search input에 `PlayerA` 입력 → 실제 검색 button/router.push → `page.goBack()` B를 실행했다. 두 viewport 모두 document와 navigation entry 1개는 유지되었지만 `.stats-page` DOM instance는 remount됐다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'same-Shell client route race keeps B' --testTimeout=90000 --silent=false --reporter=verbose
baseUrl=http://127.0.0.1:57831, ownedPid=66062
Test Files  1 failed (1)
Tests       2 failed | 41 skipped (43)
Duration    12.48s
Failure     witnessPresent=true, sameDocument=true, navigationEntryCount=1, sameShell=false, markerPreserved=false
exit 1
~~~

중간에 patched history API 흐름을 시도한 browser run(PID 65501, owned Next PID 65535)은 사용자 interrupt로 direct output을 회수할 수 없었다. 중복 run을 시작하지 않고 기존 process가 종료될 때까지 기다렸으며, PID 65501/65535 종료와 lock 부재를 확인했다. 이 run은 pass/fail 증거로 사용하지 않는다.

### Main scope-freeze 판정과 정리

중간에 `app/stats/layout.tsx`/`app/stats/StatsRouteShell.tsx`로 persistent Shell을 강제하는 구조를 만들었고, 그 상태의 targeted 2/2, audit 1/1, full 43/43을 확인했다. 다만 main은 이를 실제 제품 결함의 최소 수정이 아니라 테스트에 맞춘 구조 변경으로 판정했다. 두 파일은 untracked 상태에서 `apply_patch` delete했고, 해당 persistent-layout boundary test도 제거했다. 그 중간 43/43은 현재 제품 구조의 최종 full evidence로 주장하지 않는다.

최종 판정은 다음과 같다.

- 기존 Next App Router의 dynamic route remount가 A request를 unmount AbortController로 격리하는 경계다.
- same-instance race를 위해 생산 layout을 바꾸지 않는다.
- STATS-016은 새 architecture로 `fixed`가 아니라, 기존 client route에서 stale A overwrite가 `not_reproduced`된 것으로 교정한다.
- main-frame navigation abort bridge는 이 판정 근거에 사용하지 않았다. A terminal source는 `fetch-signal`이었다.

### 구조 제거 후 영향 범위 GREEN

이 시점의 scope freeze 지시에 따라 route-remount 기능 2행과 audit 1행만 재실행했다. 후속 사용자가 현재 구조의 마지막 fresh full 1회를 명시적으로 요청했으며, 그 결과는 §10에 별도로 기록했다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts -t 'client route remount race keeps B|browser-only regression audit' --testTimeout=120000 --silent=false --reporter=verbose
nowIso=2026-08-11T13:56:14.263Z
baseUrl=http://127.0.0.1:59006
ownedPid=68317
Test Files  1 passed (1)
Tests       3 passed | 40 skipped (43)
Duration    21.86s
exit 0
~~~

390×844, 1440×900 기능 row와 STATS-016 audit의 exact 결과:

- initial B player 200/successful 1 + B summary 200/successful 1
- actual search button으로 A route를 시작한 후 A player `1/0/1/0`, terminalSource=`fetch-signal`, successful 0
- `page.goBack()`은 same-document response `null`; A/B 시점 모두 witnessPresent=true, sameDocument=true, navigationEntryCount=1, sameShell=false, markerPreserved=false
- return B는 `afterRecordId=5` 이후 player record id 6이 200/successful, summary record id 7이 200/successful
- B player total `2/2/0/2`, B summary total `2/2/0/2`; B heading/URL 유지, A heading 없음
- A delay 600ms를 넘는 실제 관찰 800–802ms
- audit scenario ad external 0, analytics external 2 aborted, other 0, pageErrors []

생산 코드에 same-Shell architecture 변경은 남지 않았다. staging/commit은 수행하지 않았고 main direct Luna/max 최종 리뷰 대기 상태다.

### Scope-freeze focused 종료 gate

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts tests/stats-layout-boundary.test.ts --reporter=verbose
Test Files  2 passed (2)
Tests       17 passed (17)
Duration    1.62s
exit 0

$ npx eslint tests/stats-browser-harness.test.ts tests/stats-browser-smoke.test.ts tests/helpers/statsBrowserHarness.ts tests/fixtures/stats/browserScenarios.ts tests/stats-layout-boundary.test.ts
exit 0 (output none)

$ npx tsc --noEmit --pretty false
exit 0 (output none)

$ git diff --check
exit 0
$ git diff --exit-code -- tsconfig.json
exit 0
$ git diff --exit-code -- tests/fixtures/stats/match-detail-ready.json
exit 0
$ shasum -a 256 tests/fixtures/stats/match-detail-ready.json
3f13807bb845756f9e70b8329b9176df9182378de96a968af9fade17b1345d51
$ test ! -e app/stats/layout.tsx && test ! -e app/stats/StatsRouteShell.tsx && test ! -e .next/dev/lock
exit 0
$ ps -axo pid=,ppid=,stat=,command= | rg 'next dev|stats-browser-smoke|vitest'
owned/running result 0 (self rg only)
$ git diff --cached --name-only
(output none; staging 0)
~~~

이 checkpoint에 persistent stats layout 파일은 없고, `tsconfig.json`과 preserved match-detail fixture는 HEAD diff 0이며, owned Next/Vitest process와 `.next/dev/lock`은 남지 않았다. 후속 명시 지시로 실행한 최종 full은 §10이 대체한다.

남은 미검증은 map/2D/3D telemetry-backed navigation·data rendering, authenticated AI browser clamp/finalVerdict, Preview/live ad fill이다. 외부 작업은 수행하지 않았다.

## 10. Temporary layout 제거 후 마지막 fresh full·final-review checkpoint

사용자가 지정한 마지막 1회를 현재 코드(`app/stats/layout.tsx`, `app/stats/StatsRouteShell.tsx` 없음)에서 fresh 실행했다. 이후 full browser는 반복하지 않았다.

~~~text
$ RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts --testTimeout=120000 --silent=false --reporter=dot
nowIso=2026-08-11T14:00:33.299Z
baseUrl=http://127.0.0.1:59253
ownedPid=68950
Test Files  1 passed (1)
Tests       43 passed (43)
Duration    64.08s
exit 0
~~~

Full에 포함된 STATS-016은 persistent Shell을 강제하지 않고, 실제 search button/router.push A → `page.goBack()` B에서 same document/nav entry 1개 + Shell remount, A `fetch-signal` abort/successful 0, 신규 B `afterRecordId` 200/successful 1, B heading/URL 유지를 assertion했다. 판정은 `not_reproduced`이다.

지정된 non-browser 영향 범위 gate만 실행했고 full `npx vitest run`은 반복하지 않았다.

~~~text
$ npx vitest run tests/stats-browser-harness.test.ts --reporter=verbose
Test Files  1 passed (1)
Tests       11 passed (11)
Duration    218ms
exit 0

$ npx vitest run tests/stats-child-lifecycle.test.ts tests/stats-layout-boundary.test.ts --reporter=verbose
Test Files  2 passed (2)
Tests       7 passed (7)
Duration    5.21s
exit 0

$ npx eslint tests/stats-browser-harness.test.ts tests/stats-browser-smoke.test.ts tests/helpers/statsBrowserHarness.ts tests/fixtures/stats/browserScenarios.ts tests/stats-child-lifecycle.test.ts tests/stats-layout-boundary.test.ts
exit 0 (output none)

$ npx tsc --noEmit --pretty false
exit 0 (output none)

$ npm run verify:core
exit 0; eslint 0 errors / 43 pre-existing warnings; tsc 0 errors
~~~

마지막 cleanup 확인에서 `tsconfig.json` HEAD diff 0, `match-detail-ready.json` diff 0/SHA-256 `3f13807bb845756f9e70b8329b9176df9182378de96a968af9fade17b1345d51`, temporary app files 0, `.next/dev/lock` 0, owned/running Next·Vitest PID 0, staged file 0이었다. commit/staging은 수행하지 않았다.

상태는 main direct Luna/max final review pending이다. 남은 미검증은 map/2D/3D telemetry-backed navigation·data rendering, authenticated AI browser clamp/finalVerdict, Preview/live ad fill이다.

코드 구현 및 로컬 QA 완료 — 광고 운영 설정 대기
