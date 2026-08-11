# Task 10: 전적 페이지 브라우저 기능 감사·반응형 광고 QA·완료 보고

**Base:** `f1728a7`

**Goal:** 실제 Next dev server와 Puppeteer를 사용해 전적 페이지의 기능·경로 상태·오류 회복·반응형 레이아웃·광고 예약 경계를 결정론적으로 검증하고, 수행한 증거만 감사 문서와 설계 상태에 기록한다. 로컬 코드/QA와 운영 광고 설정을 명확히 분리한다.

**Binding override:** 이 brief는 plan의 Task 10 pseudocode를 전부 대체한다. 특히 기존 `match-detail-ready.json` 교체, squad 응답 queue, `removeAllListeners("request")`, `networkidle0`, scenario 간 Page 재사용, raw request count만으로 중복 성공 판정, 로컬 placeholder를 live fill로 간주하는 방식은 금지한다.

## Source of truth

우선순위는 다음과 같다.

1. 이 brief
2. 현재 코드와 기존 회귀 테스트
3. `docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md`
4. `docs/reviews/2026-08-10-stats-search-regression-audit.md`
5. plan Task 10의 목표와 최종 gate

상위 항목과 충돌하는 plan pseudocode는 사용하지 않는다.

## Files

- **Preserve unchanged:** `tests/fixtures/stats/match-detail-ready.json`
- Create: `tests/fixtures/stats/squad-ready.json`
- Create: `tests/fixtures/stats/browserScenarios.ts`
- Create: `tests/helpers/statsBrowserHarness.ts`
- Create: `tests/stats-browser-harness.test.ts`
- Create: `tests/stats-browser-smoke.test.ts`
- Create: `.superpowers/sdd/2026-08-10-opgg-style-stats-page-redesign/task-10-report.md`
- Modify: `docs/reviews/2026-08-10-stats-search-regression-audit.md`
- Modify: `docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md`
- Modify only if browser evidence proves a defect and a focused RED exists: affected production/test files
- Write ignored screenshots only: `tmp/stats-browser-qa/**`

Do not replace or rewrite `match-detail-ready.json`; Task 7 component tests import it directly. Browser responses clone it and override request-owned fields.

## Non-negotiable fixture clock and identity

Capture one runtime QA clock at suite start and inject it into every scenario factory:

```ts
export interface StatsQaClock {
  nowMs: number;
  nowIso: string;
  readyIso: string;
  daysAgo(days: 13 | 15 | 91): string;
}

export function createStatsQaClock(nowMs = Date.now()): StatsQaClock;
```

- ready player `updatedAt`: captured QA clock exactly 1일 전
- ready match `createdAt`/summary `playedAt`: captured QA clock exactly 1일 전
- age fixtures: 13일 전, 15일 전, 91일 전
- exact 14/90일 equality와 1ms 차이는 기존 unit tests 소유다. Browser smoke에서 경계 산술을 중복하지 않는다.

The outer smoke suite creates one `StatsQaClock`, passes it to every context/scenario, and records `nowIso` in the report. Browser and test process share the same host wall clock; 13/15/91-day cases are at least one full day away from the exact boundaries, so startup drift cannot invert their classification. Do not freeze the page with CDP virtual-time policy: it can stall Next dev timers, autocomplete debounce, and retry deadlines. Retry timing uses the real wall clock and explicit request/UI condition waits; exact timer boundaries remain unit-test owned.

Every response must match the request:

```ts
export function cloneMatchDetailForRequest(input: {
  matchId: string;
  nickname: string;
  clock: StatsQaClock;
}): MatchDetailFixture;
```

이 함수는 imported `match-detail-ready.json`을 deep clone하고 최소한 `matchId`, `stats.name`, `stats.playerId`, `createdAt`을 request와 QA clock에 맞춘다. 원본 fixture object를 mutate하지 않는다.

`playerReadyForRequest`는 requested nickname/platform, scenario season, recent match IDs, QA `updatedAt`을 override한다. Summary clone도 key와 내부 `matchId`/시간을 요청 match ID와 일치시킨다.

## Squad fixture contract

`squad-ready.json`은 queue가 아니라 named data를 제공한다.

```ts
interface SquadReadyFixture {
  groups: readonly SquadGroupFixture[];
  details: {
    g1: SquadDetailFixture;
    g2: SquadDetailFixture;
  };
}
```

- list GET response: `{ groups: squadReady.groups }`
- `groupKey=g1` detail: `squadReady.details.g1`
- `groupKey=g2` detail: `squadReady.details.g2`
- unknown/missing required group key는 dispatcher가 명시적으로 reject한다.

`SquadAnalysisPanel`의 실제 URL `groupKey`가 response ownership을 결정한다. 호출 순서에 따라 `shift()`하지 않는다.

## Canonical local types

`browserScenarios.ts` owns these types; do not leave them implicit:

```ts
import matchDetailReady from "./match-detail-ready.json";

export type MatchDetailFixture = typeof matchDetailReady;

export interface SquadGroupFixture {
  groupKey: string;
  members: readonly string[];
  matchCount: number;
}

export interface SquadMatchFixture {
  matchId: string;
  playedAt: string;
  [key: string]: unknown;
}

export interface SquadDetailFixture {
  groupKey: string;
  matchCount: number;
  stats: Record<string, unknown>;
  scores: Record<string, unknown>;
  roleProfiles: readonly Record<string, unknown>[];
  matchesSummary: readonly SquadMatchFixture[];
  squadGrade: string;
  benchmarkStats: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MockHttpResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
  delayMs?: number;
}

export interface StatsApiRequest {
  recordId: number;
  method: string;
  url: string;
  pathname: string;
  query: Readonly<Record<string, string>>;
  body?: unknown;
  semanticKey: string;
}
```

`semanticKey` is a stable literal derived from method + pathname + sorted semantic query + stable JSON body. Player `_t` is retained in evidence but excluded from the semantic key.

## Scenario model

`browserScenarios.ts`는 static response bag이 아니라 request-aware scenario state factory를 제공한다.

```ts
export type StatsBrowserScenarioName =
  | "ready"
  | "player-retry"
  | "not-found-then-ready"
  | "rate-limit"
  | "summary-retry"
  | "detail-retry"
  | "squad"
  | "expired"
  | "autocomplete-abort"
  | "season-refresh"
  | "route-race";

export interface StatsScenarioState {
  readonly name: StatsBrowserScenarioName;
  resolve(request: StatsApiRequest): Promise<MockHttpResponse>;
  readonly counters: Readonly<Record<string, number>>;
}

export function createStatsBrowserScenario(input: {
  name: StatsBrowserScenarioName;
  clock: StatsQaClock;
}): StatsScenarioState;
```

Required sequences are query-aware:

- `player-retry`: exact same player request `500 → 200`
- `not-found-then-ready`: nickname A `404` with Kakao B suggestion; B request `200`
- `summary-retry`: matching summary POST body `500 → 200`
- `detail-retry`: matching match GET query `500 → 200`
- `autocomplete-abort`: delayed old `q` and fast latest `q`; old request abort/stale result never renders
- `season-refresh`: base ready, `season=<literal>` response, `refresh=true` response are distinct
- `route-race`: A is delayed, B completes first; A abort/late completion cannot replace B
- `rate-limit`: 429 includes literal `Retry-After: 1`; before retry deadline no new successful player response
- `expired`: 13/15/91-day summaries using the fixed QA clock

Request validation must compare literal method and payload:

- player: `GET /api/pubg/player`, required `nickname`, `platform`; optional `season`, `refresh=true`; `_t` is recorded but ignored for semantic equality
- suggest: `GET /api/pubg/suggest`, exact `q`
- summaries: `POST /api/pubg/matches-summary`, JSON `{ matchIds, nickname, platform }`
- detail: `GET /api/pubg/match`, exact `matchId`, `nickname`, `platform`
- squad: `GET /api/pubg/squad-analyze`, exact nickname/platform and optional groupKey
- unauthenticated AI: `/api/pubg/ai-summary`, `/api/pubg/ai-analyze`, `/api/pubg/ai-squad` must receive zero requests; any request is fatal

## One dispatcher per Page

```ts
export interface StatsRequestRecord {
  id: number;
  method: string;
  url: string;
  pathname: string;
  query: Record<string, string>;
  body?: unknown;
  semanticKey: string;
  category: "stats-api" | "ad-external" | "analytics-external" | "other";
  state: "started" | "completed" | "aborted" | "unexpected";
  status?: number;
  successful: boolean;
  terminal: boolean;
}

export interface StatsRequestSelector {
  pathname: string;
  method?: string;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  semanticKey?: string;
  afterRecordId?: number;
  state?: StatsRequestRecord["state"];
  successful?: boolean;
}

export interface StatsRequestLedger {
  readonly records: readonly StatsRequestRecord[];
  count(selector: StatsRequestSelector): number;
  assertNoUnexpected(): void;
  assertNoUnauthenticatedAi(): void;
  throwIfUnexpected(): void;
}

export interface InstalledStatsDispatcher {
  ledger: StatsRequestLedger;
  waitForTerminal(input: { selector: StatsRequestSelector; count: number }): Promise<void>;
  withFatal<T>(condition: Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

export async function installStatsApiDispatcher(input: {
  page: Page;
  baseUrl: string;
  scenarioName: StatsBrowserScenarioName;
  clock: StatsQaClock;
}): Promise<InstalledStatsDispatcher>;
```

Dispatcher rules:

1. Call `page.setRequestInterception(true)` once per Page.
2. Attach one owned `request`, `response`, `requestfinished`, and `requestfailed` listener set.
3. Store exact handler references and remove them with `page.off(...)` in `dispose()`.
4. `page.removeAllListeners("request")` is forbidden.
5. Same-origin `/api/pubg/*` not handled by the scenario is recorded `unexpected`, aborted, and rejects an owned fatal promise. Every DOM/API condition wait runs through `dispatcher.withFatal(...)`, so unexpected traffic ends the current scenario immediately.
6. Same-origin document, `/_next/*`, fonts, RSC/navigation requests and unrelated non-PUBG paths continue normally.
7. Method/query/body mismatch on a known endpoint is `unexpected`; do not return a permissive static response.
8. Different-origin requests are classified, recorded, and aborted in local QA. Analytics requests are recorded separately from advertising and do not count against “local ad external zero.” No external request is allowed to make the test nondeterministic.

Use a `WeakMap<HTTPRequest, StatsRequestRecord>` so `response.request()`, `requestfinished`, and `requestfailed` update the exact start record. `response` records HTTP status only. `requestfinished` is the only event that transitions an expected response to terminal `completed` and computes `successful`; `requestfailed` transitions to terminal `aborted`. A per-record terminal guard prevents either event from overwriting an existing terminal state. “Successful” means a requestfinished expected response with the scenario’s accepted HTTP status, not merely a started request or received response headers.

`waitForTerminal` and `count` match full semantic selectors. Route-race waits specify B’s semantic key/query and `afterRecordId` captured before B navigation; A cannot satisfy B’s wait even though both share `/api/pubg/player`. The helper implementing DOM waits also calls `withFatal`, and every assertion boundary calls `throwIfUnexpected()`.

## StrictMode and duplicate-request accounting

Next dev StrictMode can produce 1–2 raw player starts and the first may abort. Tests must distinguish:

- `started`
- `completed`
- `aborted`
- `successful`

Ready flow passes when:

- raw player starts: 1 or 2
- successful player response: exactly 1
- UI ready transition: exactly 1 observed identity
- if two starts exist, at most the first is aborted

Two successful player responses are a defect. Double-submit is measured after the first successful result: two synchronous submit actions add **0** further successful player responses.

## Fresh browser isolation

```ts
export async function withStatsBrowserPage<T>(input: {
  browser: Browser;
  baseUrl: string;
  scenarioName: StatsBrowserScenarioName;
  viewport: { width: number; height: number };
  run(context: { browserContext: BrowserContext; page: Page; dispatcher: InstalledStatsDispatcher }): Promise<T>;
}): Promise<T>;
```

Every scenario/viewport creates a fresh `BrowserContext` and fresh `Page`, installs listeners before navigation, and closes both in `finally`. Do not reuse storage, auth, console logs, request ledger, or Page across matrix rows. A resize pair is one named scenario and may resize its own fresh Page across the two exact widths. The suite may share one Puppeteer `Browser`, but must close that Browser in its outermost `finally`/`afterAll` even when setup or a test fails.

## Dev server ownership

`statsBrowserHarness.ts` may start the dedicated server only when `STATS_BASE_URL` is not explicitly supplied.

```ts
export interface OwnedStatsDevServer {
  baseUrl: string;
  pid: number;
  stop(): Promise<void>;
}

export async function startOwnedStatsDevServer(): Promise<OwnedStatsDevServer>;
```

- Select an unused port; never kill an existing listener to reclaim a fixed port.
- Before start, detect an existing `.next/dev/lock`. Do not delete it. If it belongs to another running server or cannot safely be attributed, return a clear blocker.
- Set `NEXT_PUBLIC_ADFIT_STATS_FEED_UNIT=DAN-fixture-stats-feed-728` in the child environment **before** starting Next.
- Spawn the worktree’s local Next binary, record the direct child PID, and wait by polling HTTP/document readiness.
- Readiness has a 120-second deadline and captures a bounded stderr tail for diagnostics.
- If spawn succeeds but readiness, compilation, or setup fails, the catch path terminates and awaits only the owned child PID before rethrowing.
- `stop()` sends termination only to the process/PID this helper created and waits for exit. It must not use `pkill`, port-wide kill, or remove lock files. A bounded shutdown timeout may escalate only that same owned PID.
- `afterAll/finally` always stops an owned server and never stops an explicitly supplied external `STATS_BASE_URL`.

## Navigation and condition waits

`page.goto` must use `waitUntil: "domcontentloaded"`. `networkidle0` and generic network-idle waits are forbidden.

Every transition waits on a named condition through `dispatcher.withFatal(...)`:

- document/body boundary exists
- page state selector/text appears
- relevant semantic dispatcher terminal/completed count reaches the expected value
- expected URL/history state matches
- unexpected request promise/ledger remains clean

Avoid fixed sleeps except the 300ms autocomplete debounce test, which should still wait on request start/abort and latest UI result rather than assume only elapsed time proves completion.

## Server/browser verification gate

After starting the dev server, before the full smoke suite:

1. open landing `/stats`
2. capture a screenshot in `tmp/stats-browser-qa/dev-server-check.png`
3. assert meaningful body content
4. assert no Next error overlay
5. capture console/pageerror messages
6. assert platform input and search controls exist

Use the available browser verification workflow, but replace its generic network-idle wait with the explicit `domcontentloaded`/DOM conditions required above.

Main-agent visual gut-check after server start uses the installed `agent-browser` CLI when available:

```text
agent-browser open <owned-base-url>/stats
agent-browser wait "[data-testid='stats-auto-ads-boundary']"
agent-browser screenshot tmp/stats-browser-qa/dev-server-check.png
agent-browser eval 'document.querySelector("[data-nextjs-dialog], .vite-error-overlay") ? "ERROR_OVERLAY" : "OK"'
agent-browser snapshot -i
agent-browser close
```

Do not substitute `agent-browser wait --load networkidle` for the selector wait.

## RED contracts

### A. Pure harness/scenario tests

`tests/stats-browser-harness.test.ts` must fail before implementation and then prove:

- imported match fixture remains unchanged after clone override
- requested matchId/nickname and QA timestamp are reflected in the clone
- a fixed clock passed to `createStatsQaClock(...)` yields hand-derived ready/13/15/91-day literal timestamps in unit tests
- squad list is `{ groups: [...] }` and g1/g2 selection is by groupKey
- each route rejects wrong method, missing query, wrong summary body, or unhandled `/api/pubg/*`
- sequence counters advance only for the matching semantic request
- `_t` does not change semantic player request equality
- AI endpoints are fatal in unauthenticated scenarios
- request ledger distinguishes completed/successful/aborted

Initial RED:

```text
npx vitest run tests/stats-browser-harness.test.ts
```

Expected: FAIL because scenario/harness exports and squad fixture do not exist. A pass caused only by a skipped suite is invalid RED.

### B. Browser smoke RED

`tests/stats-browser-smoke.test.ts` uses:

```ts
const describeBrowser = process.env.RUN_STATS_BROWSER_SMOKE === "true" ? describe : describe.skip;
```

First browser RED:

```text
RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts --testTimeout=60000
```

Expected: fail on the first concrete missing selector/condition/harness behavior. Distinguish harness defects, automation failures, and actual UI defects in `task-10-report.md` before changing production.

If browser evidence proves a product defect, write or strengthen a deterministic component/unit RED first, run it, then make the smallest production fix. Do not patch production to satisfy an interception mistake.

## Functional browser matrix

Full functional flows run at exactly:

- `390×844`
- `1440×900`

At both sizes verify, with fresh context per scenario:

- landing search and one successful dynamic-route player load
- synchronous double-submit adds no successful request
- Steam and Kakao identity
- empty submit sends zero player requests
- 404 suggestion A→B with returned platform
- 429 retry disabled before deadline
- 500 player retry `500→200`
- summary inline retry `500→200`
- detail expand, error, row-local retry `500→200`
- favorite and recent search storage within its scenario only
- delayed autocomplete old q abort and latest q result
- season change and force refresh use distinct query-aware response
- overview/squad switch, list `{groups}`, `groupKey=g1/g2`, history/back-forward
- mode/party controls do not change match filter
- AI/full detail/team/weapon/tier/map/2D replay/3D replay controls exist and preserve their URLs/payload boundaries
- 14/90-day product behavior using 13/15/91-day fixture rows
- 404, 429, 500, empty, loading, partial and ready UI states

Unauthenticated browser AI gate:

- `/api/pubg/ai-summary`: 0 requests
- `/api/pubg/ai-analyze`: 0 requests
- `/api/pubg/ai-squad`: 0 requests

Authenticated NDJSON `finalVerdict` remains owned by existing component tests and is not reimplemented in browser interception.

## Browser-only regression audit evidence

Update these rows only from actual browser evidence:

- STATS-011: SSR/hydration with stored search data; capture hydration-pattern console errors
- STATS-012: back/forward plus title/canonical/OG synchronization
- STATS-013: direct invalid platform redirect without PUBG player request
- STATS-014: failed season request preserves previous result and displays error
- STATS-016: delayed A route cannot replace completed B route

STATS-015 force-refresh overview reset remains `suspected`; browser observation does not establish product intent.

Metadata unit evidence alone never promotes STATS-012. Record exact browser URL, DOM metadata, request counts, and observed outcome.

## Responsive/layout/ad matrix

Fresh context/Page for each layout row:

- `375×667`
- `390×844`
- `430×932`
- `768×1024`
- `1440×900`
- `1600×900`

Fresh resize scenarios:

- `767↔768`
- `1023↔1024`

Screenshot-only rows, not duplicate full functional flows:

- `375×812`
- `1280×720`
- `1920×1080`

Write screenshots under ignored `tmp/stats-browser-qa/` with scenario and viewport in each filename.

Measure and record:

- global overflow: `documentElement.scrollWidth - clientWidth`
- internal overflow: every visible `.stats-page` descendant whose scroll width or bounding rect exceeds its container/shell
- central shell width and 1,200px cap
- desktop grid columns and mobile single-column order
- profile/top ad/tabs/overview/match start ordering
- BottomNav overlap/safe padding
- long nickname truncation/title
- AI clamp and focus/scroll target
- inactive provider child unmount after breakpoint transition
- exact top reservation: mobile 100px, tablet+ 90px
- fluid reservation: at least 130px
- `data-ad-placement`, provider and state for registry/placeholder evidence only

`data-ad-state="mounted"` proves only that a development placeholder/registry slot is selected. It is never evidence of live fill.

## Control sizing

Return a named record for every major visible control:

```ts
interface ControlSizeEvidence {
  name: string;
  role: string;
  width: number;
  height: number;
  violates44: boolean;
}
```

At minimum measure platform, nickname input, search, recent/favorite/remove, season, refresh, favorite/compare/weapons, section tabs, mode/party, match filters, match expand/retry, AI CTA, squad group selector and BottomNav controls. Report the complete width/height violation list, not only a single minimum value. New Shell/States controls and primary interactions below 44×44 are blocking defects; nested legacy detail controls are classified from actual impact and documented if not in current production-fix scope.

## Local external request accounting

“Local external zero” applies only to advertising network/script traffic:

- AdSense/adsbygoogle/Google advertising hosts and script URLs
- Kakao AdFit `ba.min.js`/creative hosts

Record GA and Vercel Analytics/Speed Insights separately. They do not make the advertising zero assertion fail and must not be silently omitted from evidence.

The report must distinguish:

- ad external requests
- analytics external requests
- other external requests
- local placeholder/reservation DOM

## Evidence ownership and documentation

`task-10-report.md` records every command, actual exit code/count, browser scenario, viewport, screenshot path, console/page errors, request lifecycle counts, size/overflow measurement, and failure classification. Never copy expected counts as observed output.

`docs/reviews/2026-08-10-stats-search-regression-audit.md` is updated only for scenarios actually executed. Each changed row includes path/input, expected, observed UI, started/completed/aborted/successful request counts, code boundary, browser evidence and ruling.

`docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md` must end with the exact status:

```text
코드 구현 및 로컬 QA 완료 — 광고 운영 설정 대기
```

unless all three are independently complete:

1. real dedicated feed ad environment setting in the deployment target
2. Preview real-ad validation
3. AdSense console side-rail/Top-only/exclusion setup and preview

The local fixture env does not satisfy item 1. No deployment, Preview change, or AdSense/AdFit account mutation is authorized in this task.

## Verification

Pure harness:

```text
npx vitest run tests/stats-browser-harness.test.ts
```

Browser smoke:

```text
RUN_STATS_BROWSER_SMOKE=true npx vitest run tests/stats-browser-smoke.test.ts --testTimeout=60000
```

Existing focused ownership gates after any product fix:

```text
npx vitest run tests/stats-page-shell.test.ts tests/stats-layout-boundary.test.ts tests/stats-page-controller.test.ts tests/stat-search-season-refresh.test.ts tests/stat-search-deep-link.test.ts tests/stat-search-autocomplete.test.ts tests/match-card-detail-state.test.ts tests/squad-analysis-panel-state.test.ts tests/stats-auto-ads-boundary.test.ts tests/responsive-ad-slot.test.ts tests/bottom-nav-stats-active.test.ts
```

Final **non-browser** automatic gate (this does not prove smoke execution):

```text
npm run verify:core && npx vitest run
```

This gate may show `stats-browser-smoke` as skipped when `RUN_STATS_BROWSER_SMOKE` is absent. Task completion additionally requires the separate browser command above to have exit 0 with a populated task report and screenshots; never infer browser success from the non-browser gate.

Forbidden legacy patterns:

```text
rg -n 'STATS_DESKTOP_AD_UNIT|slot="7728921550"|document\.head\.appendChild\(mainScript\)|DAN-dPiCxgIGtXKjLPP3.*stats-after-10|stats-after-10.*DAN-dPiCxgIGtXKjLPP3' components/stat components/ads app/stats app/layout.tsx
```

Expected: no matches. Do not grep `pathname === "/stats"`; the approved BottomNav prefix helper is governed by:

```text
npx vitest run tests/bottom-nav-stats-active.test.ts
```

Then:

```text
git diff --check
git status --short
```

Before completion, run the React condensed review for any changed TSX. Then use the available `spawn_agent` tool with explicit `model="gpt-5.6-luna"` and `reasoning_effort="max"`; omitted model/reasoning and fallback are forbidden.

Task review inputs:

- brief: this file
- report: `.superpowers/sdd/2026-08-10-opgg-style-stats-page-redesign/task-10-report.md`
- package: SDD `review-package` over `f1728a7..HEAD`

Final whole-branch review inputs:

- plan/spec/audit
- progress ledger deferred/parked lines
- package: SDD `review-package` over `git merge-base develop HEAD` through `HEAD`

Both reviewers are read-only. Append their exact verdicts/findings to `task-10-report.md`. Any Critical/Important finding enters one Luna/max fix wave and scoped Luna/max re-review. If direct Luna spawn fails, stop and report; never substitute another model.

## Commit and external-action boundary

Before staging, prove the preserved fixture is unchanged:

```text
git diff --exit-code -- tests/fixtures/stats/match-detail-ready.json
```

Stage only Task 10 implementation/evidence files and any proven focused bug fix:

```text
git add tests/fixtures/stats/squad-ready.json tests/fixtures/stats/browserScenarios.ts tests/helpers/statsBrowserHarness.ts tests/stats-browser-harness.test.ts tests/stats-browser-smoke.test.ts docs/reviews/2026-08-10-stats-search-regression-audit.md docs/superpowers/specs/2026-08-09-opgg-style-page-redesign-design.md
git add -f .superpowers/sdd/2026-08-10-opgg-style-stats-page-redesign/task-10-brief.md .superpowers/sdd/2026-08-10-opgg-style-stats-page-redesign/task-10-report.md
```

If focused production/test files were changed from proven browser RED, list them explicitly in the report and stage those exact paths separately. Do not use broad `git add .`.

Final neutral commit message:

```text
test(stats): 전적 페이지 반응형 QA 결과 기록
```

Do not push, create PR, merge, deploy, or modify external advertising accounts without separate explicit user approval.

## Completion report contract

The final user report separates:

1. code and local QA completed
2. confirmed/not-reproduced/suspected bug rulings with evidence
3. automated tests and browser screenshots
4. advertising operations still pending

Never claim full advertising/operations completion while the exact pending status above applies.
