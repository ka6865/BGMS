# PUBG AI 전적 분석 정확도 고도화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 공식 PUBG telemetry를 하나의 순수 계약으로 보존·샘플링하고, 최신 유효 10경기 및 서버 canonical 단일 매치 AI가 같은 정확한 입력을 사용하도록 고친다.

**Architecture:** telemetryContract.ts가 공식 allowlist, 필드 projection, 위치 정규화, lite/full 샘플링의 유일한 경계를 소유한다. 두 telemetry route는 이 함수를 호출하고 domain handler는 이미 필터된 이벤트를 모두 소비한다. recentMatchSelection.ts와 canonical row validator를 각각 순수 선택/검증 경계로 두어 AI route의 cache identity와 prompt 입력을 결정적으로 만든다. Task 5의 audit은 같은 입력에 legacy와 새 경계를 모두 실행하되 읽기만 수행한다.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, Supabase service-role read, Cloudflare R2 read, Node crypto SHA-256, tsx.

**Spec:** docs/superpowers/specs/2026-08-27-pubg-ai-analysis-accuracy-design.md

## Global Constraints

- match lite와 telemetry full/lite는 filterTelemetryEvents(events, context)만 공유 필터로 사용하며 route-local allowlist/projection을 남기지 않는다. filter는 입력 배열 순서를 보존한다.
- LogPlayerRedeployBRStart.characters[], LogPlayerKillV2.assists_AccountId/teamKillers_AccountId, itemPackage.location, Character.location/loc fallback, attack/vehicle/care-package 이벤트와 기존 scalar/legacy alias를 보존한다.
- LogPlayerUseThrowable.weapon의 현재 top-level 보존 계약을 유지한다. 이 필드가 모두 유실됐다고 가정하지 않으며 consumer가 없는 LogWeaponFireCount는 추가하지 않는다. full 경로에서 handler가 소비하던 레거시 LogWeaponFire와 LogExplosiveExplode는 보존한다.
- lite 위치는 팀원 전부와 비팀 10번째마다(ordinal % 10 === 0)만 남긴다. full은 사전 샘플링하지 않는다. MapReplayHandler에는 두 번째 sampling counter가 없다.
- 최근 선택은 score·winPlace와 무관한 최신 유효 unique 10개 전체다. matchType airoyale/seasonal, mode event/arcade/custom/training, map SafeHouse/Range/training만 제외하고 official/competitive/unknown은 허용한다. selection config/version과 effective selected IDs만 summary hash에 넣는다. Best 5 경로는 제거한다.
- 단일 AI cache hit 동작은 유지한다. cache miss/new generation은 서버 processed_match_telemetry의 current canonical fullResult만 사용하고 browser matchData는 match identity만 사용한다. canonical missing/stale은 HTTP 409 PUBG_AI_CANONICAL_NOT_READY로 종료하며 Gemini/upsert를 호출하지 않는다.
- coachingStyle은 mild | spicy만 허용하고 누락 시 spicy를 사용한다. 기존 NDJSON/JSON response와 table field는 intentional cache identity/error 외에 바꾸지 않는다.
- RESULT_VERSION = 73.0, TELEMETRY_VERSION = 61.0, AI_CACHE_VERSION = 2026-08-27.pubg-ai-accuracy-v1는 Task 5에서 각각 정확히 한 번만 변경한다.
- audit은 한 사용자의 공식 raw telemetry를 환경변수와 credentials가 이미 있을 때만 GET/select로 읽는다. DB/R2 write, PUBG POST, Gemini 전송은 금지한다. 조건이 없으면 official-shaped synthetic fixture를 사용하고 source/fallback 사유를 표시한다.
- 각 Task는 RED 테스트 → 최소 구현 → GREEN 테스트 → 독립 commit 순서로 진행한다. DB migration, UI 변경, model 변경은 하지 않는다. 변경 전 npm run verify:analysis baseline은 17 files / 210 tests pass이며, 신규 테스트를 이 suite에 추가한 최종 개수 전체가 통과해야 한다.

---

### Task 1: 공용 PUBG telemetry contract/filter

**Files:**
- Create: lib/pubg-analysis/telemetryContract.ts
- Test: tests/telemetry-contract.test.ts

**Interfaces:**
- Produces TelemetryFilterMode, TelemetryFilterContext, TelemetryEventRecord, readonly ordered TELEMETRY_EVENT_ALLOWLIST, normalizeTelemetryLocation(value: unknown): { x: number; y: number; z: number } | undefined, projectTelemetryEvent(event: unknown): TelemetryEventRecord | null, filterTelemetryEvents(events: readonly unknown[], context: TelemetryFilterContext): TelemetryEventRecord[].
- teamNames에는 기존 normalizeName 결과를, teamAccountIds에는 canonical account/player ID를 전달한다. 모듈은 route/client/server storage에 의존하지 않는다.

- [ ] **Step 1: 공식 shape와 샘플링을 고정하는 실패 테스트를 작성한다.** _T가 allowlist에 없는 event와 LogWeaponFireCount를 거절하되 기존 full consumer의 LogWeaponFire와 LogExplosiveExplode는 허용하는지 확인한다. 입력 배열 순서를 유지하며, official arrays, nested itemPackage.location, top-level throwable weapon, scalar를 보존하는지 확인한다. location이 있으면 loc보다 우선하고, x/y가 없을 때 synthetic {0,0}을 만들지 않는지도 확인한다.

~~~ts
import { describe, expect, it } from "vitest";
import {
  filterTelemetryEvents,
  projectTelemetryEvent,
} from "@/lib/pubg-analysis/telemetryContract";

describe("telemetry contract", () => {
  it("official arrays, nested location, scalar, alias, and throwable weapon을 보존한다", () => {
    const input = {
      _T: "LogPlayerKillV2",
      _D: "2026-08-27T00:00:01.000Z",
      assists_AccountId: ["account.a", "account.a", "account.b"],
      teamKillers_AccountId: ["account.t"],
      attacker: { accountId: "account.a", loc: { x: 1, y: 2 } },
      itemPackage: { location: { x: 3, y: 4, z: 5 }, itemPackageId: "package-1" },
      weapon: { itemId: "Item_Throwable" },
      damage: 42,
    };

    const projected = projectTelemetryEvent(input);

    expect(projected).toMatchObject({
      _T: "LogPlayerKillV2",
      assists_AccountId: ["account.a", "account.b"],
      assistantAccountIds: ["account.a", "account.b"],
      teamKillers_AccountId: ["account.t"],
      teamKillerAccountIds: ["account.t"],
      attacker: { location: { x: 1, y: 2, z: 0 } },
      itemPackage: { location: { x: 3, y: 4, z: 5 } },
      location: { x: 3, y: 4, z: 5 },
      weapon: { itemId: "Item_Throwable" },
      damage: 42,
    });
    expect(input.attacker).toEqual({ accountId: "account.a", loc: { x: 1, y: 2 } });
  });

  it("입력 순서를 유지하고 lite는 비팀 위치만 한 번 1/10 샘플링한다", () => {
    const positions = Array.from({ length: 20 }, (_, index) => ({
      _T: "LogPlayerPosition",
      _D: "2026-08-27T00:00:00.000Z",
      character: {
        accountId: "enemy-" + index,
        name: "Enemy" + index,
        location: { x: index, y: 0 },
      },
    }));
    const context = {
      mode: "lite" as const,
      teamNames: new Set<string>(),
      teamAccountIds: new Set<string>(),
    };

    expect(filterTelemetryEvents(positions, context)).toHaveLength(2);
    expect(filterTelemetryEvents(positions, { ...context, mode: "full" })).toHaveLength(20);
    expect(filterTelemetryEvents([
      { _T: "LogMatchEnd" },
      { _T: "LogMatchStart" },
    ], { ...context, mode: "full" }).map((event) => event._T)).toEqual([
      "LogMatchEnd",
      "LogMatchStart",
    ]);
  });

  it("unknown event와 unconsumed LogWeaponFireCount를 보존하지 않는다", () => {
    expect(projectTelemetryEvent({ _T: "LogWeaponFireCount" })).toBeNull();
    expect(projectTelemetryEvent({ _T: "LogFutureEvent" })).toBeNull();
    expect(projectTelemetryEvent({ _T: "LogWeaponFire" })).not.toBeNull();
    expect(projectTelemetryEvent({ _T: "LogExplosiveExplode" })).not.toBeNull();
  });
});
~~~

- [ ] **Step 2: RED를 확인한다.**

  Run: npx vitest run tests/telemetry-contract.test.ts

  Expected: FAIL because telemetryContract.ts가 없거나 새 projection/allowlist assertion이 현재 구현되지 않았다.

- [ ] **Step 3: 순수 contract를 최소 구현한다.** 고정 순서의 allowlist를 선언하고, _T/_D/common flags, actor/item/vehicle/scalar, redeploy/match-end characters, recalledPlayers, itemPackage ID/location, official account arrays와 legacy aliases를 새 object로 복사한다. 기존 full consumer 회귀 방지를 위해 LogWeaponFire와 LogExplosiveExplode를 보존하되 LogWeaponFireCount는 제외한다. LogMatchStart.characters와 itemPackage.items 전체는 lite 저장량을 늘리지 않도록 복사하지 않는다. location ?? loc를 canonicalize하되 유효한 x/y가 없으면 좌표 key를 생략한다. filterTelemetryEvents는 local enemy ordinal을 매 호출마다 0으로 시작하고 팀 actor 전부와 lite 비팀 ordinal 10의 배수만 반환하며 full에서는 모든 위치를 반환한다.

~~~ts
export function filterTelemetryEvents(
  events: readonly unknown[],
  context: TelemetryFilterContext,
): TelemetryEventRecord[] {
  let enemyPositionOrdinal = 0;
  return events.flatMap((event) => {
    const projected = projectTelemetryEvent(event);
    if (!projected) return [];
    if (projected._T !== "LogPlayerPosition" || context.mode === "full") return [projected];

    const actor = projected.character as Record<string, unknown> | undefined;
    const accountId = String(actor?.accountId ?? actor?.playerId ?? "");
    const normalizedName = normalizeName(String(actor?.name ?? actor?.characterName ?? ""));
    const isTeam = context.teamAccountIds.has(accountId) || context.teamNames.has(normalizedName);
    if (isTeam) return [projected];

    enemyPositionOrdinal += 1;
    return enemyPositionOrdinal % 10 === 0 ? [projected] : [];
  });
}
~~~

- [ ] **Step 4: GREEN과 불변성을 확인한다.**

  Run: npx vitest run tests/telemetry-contract.test.ts

  Expected: PASS; official arrays/scalars/nested objects와 top-level throwable weapon, 20개 enemy의 lite 2개/full 20개, input order가 모두 green이다.

- [ ] **Step 5: contract 단위로 commit한다.**

~~~bash
git add lib/pubg-analysis/telemetryContract.ts tests/telemetry-contract.test.ts
git commit -m "feat: add shared PUBG telemetry contract"
~~~

Task 1 commit 후 root review gate에서 allowlist, alias, sampling ownership을 확인한다.

### Task 2: 두 telemetry route와 domain handler 통합

**Files:**
- Modify: app/api/pubg/match/route.ts
- Modify: app/api/pubg/telemetry/route.ts
- Modify: lib/pubg-analysis/handlers/MapReplayHandler.ts
- Modify: lib/pubg-analysis/handlers/CombatHandler.ts
- Modify: lib/pubg-analysis/handlers/PositionHandler.ts
- Modify: lib/pubg-analysis/handlers/ZoneHandler.ts
- Test: tests/pubg-telemetry-integration.test.ts
- Test: tests/pubg-ingest-boundary.test.ts
- Test: tests/analysis-engine.test.ts

**Interfaces:**
- Consumes Task 1의 filterTelemetryEvents와 TelemetryFilterContext.
- Produces 두 route에서 한 번만 projection된 event 배열을 AnalysisEngine.run과 R2 payload에 전달한다. handler는 characters[], official kill arrays, nested care-package location, location/loc fallback을 읽고 위치를 다시 샘플링하지 않는다.

- [ ] **Step 1: route와 engine 경계의 실패 테스트를 추가한다.** route source가 shared filter를 import/call하는지, route-local raw filter/slim projection이 남지 않는지 정적 검사한다. AnalysisEngine에 동일한 fixture를 lite/full로 넣어 위치 수를 확인하고, redeploy wrapper, official assist arrays, nested care package, attack/vehicle event가 map/timeline에 도달하는지 확인한다.

~~~ts
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AnalysisEngine } from "@/lib/pubg-analysis/AnalysisEngine";
import { filterTelemetryEvents } from "@/lib/pubg-analysis/telemetryContract";

const teamNames = new Set(["player"]);
const teamAccountIds = new Set(["account.player"]);

function runFixture(rawEvents: readonly unknown[], mode: "lite" | "full") {
  const engine = new AnalysisEngine(
    "Player",
    "account.player",
    teamNames,
    teamAccountIds,
    new Set(),
    new Set(),
    "roster-1",
    mode,
  );
  return engine.run(
    filterTelemetryEvents(rawEvents, { mode, teamNames, teamAccountIds }),
    {
      id: "match-1",
      createdAt: "2026-08-27T00:00:00.000Z",
      mapName: "Baltic_Main",
      gameMode: "squad",
    },
    [],
    [],
    { name: "Player", playerId: "account.player", damageDealt: 0, kills: 0, timeSurvived: 600 },
    [],
    {},
  );
}

describe("route and handler telemetry boundary", () => {
  it("두 route가 공용 filter를 사용한다", () => {
    const matchRoute = fs.readFileSync("app/api/pubg/match/route.ts", "utf8");
    const telemetryRoute = fs.readFileSync("app/api/pubg/telemetry/route.ts", "utf8");
    expect(matchRoute).toContain("filterTelemetryEvents");
    expect(telemetryRoute).toContain("filterTelemetryEvents");
    expect(matchRoute).not.toContain("let posCount = 0");
    expect(matchRoute).not.toContain("const keepFields");
  });

  it("lite 적 위치는 두 번째 sampling 없이 2개, full은 20개다", () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      _T: "LogPlayerPosition",
      _D: "2026-08-27T00:00:00.000Z",
      character: {
        accountId: "enemy-" + index,
        name: "Enemy" + index,
        location: { x: index, y: 1 },
      },
    }));
    expect(runFixture(events, "lite").mapData.events.filter((event: any) => event.type === "position")).toHaveLength(2);
    expect(runFixture(events, "full").mapData.events.filter((event: any) => event.type === "position")).toHaveLength(20);
  });

  it("redeploy characters, official arrays, nested care package와 vehicle event를 소비한다", () => {
    const result = runFixture([
      {
        _T: "LogPlayerRedeployBRStart",
        _D: "2026-08-27T00:00:01.000Z",
        characters: [{
          character: {
            name: "Player",
            accountId: "account.player",
            location: { x: 1, y: 2 },
          },
        }],
      },
      {
        _T: "LogPlayerKillV2",
        _D: "2026-08-27T00:00:02.000Z",
        killer: {
          name: "Player",
          accountId: "account.player",
          location: { x: 4, y: 5 },
        },
        victim: {
          name: "Enemy",
          accountId: "account.enemy",
          location: { x: 8, y: 9 },
        },
        assists_AccountId: ["account.assist"],
        teamKillers_AccountId: ["account.player"],
      },
      {
        _T: "LogCarePackageLand",
        _D: "2026-08-27T00:00:03.000Z",
        itemPackage: { location: { x: 400, y: 500, z: 10 } },
      },
      {
        _T: "LogVehicleRide",
        _D: "2026-08-27T00:00:04.000Z",
        character: {
          name: "Player",
          accountId: "account.player",
          location: { x: 10, y: 20 },
        },
        vehicle: { vehicleId: "vehicle-1" },
      },
    ], "full");

    expect(result.mapData.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "carepackage_land", x: 4, y: 5 }),
      expect.objectContaining({ type: "ride" }),
      expect.objectContaining({
        type: "kill",
        assistants: [expect.objectContaining({ accountId: "account.assist" })],
      }),
    ]));
  });
});
~~~

- [ ] **Step 2: 관련 테스트를 RED로 실행한다.**

  Run: npx vitest run tests/pubg-telemetry-integration.test.ts tests/pubg-ingest-boundary.test.ts tests/analysis-engine.test.ts

  Expected: FAIL because route-local projection drops nested/array fields, MapReplayHandler samples again, or handlers still read only legacy field paths.

- [ ] **Step 3: 두 route와 handler를 shared contract로 교체한다.** match route는 participant/roster team set과 mode lite로 raw telemetry를 한 번 필터링하고 결과를 analyze R2/engine에 공유한다. telemetry route는 이미 읽은 myInfo/rosters/participants에서 내 roster와 teamNames/teamAccountIds를 만든 뒤 요청 mode와 함께 context에 전달한다. CombatHandler.handleRecall은 characters의 wrapper/direct actor를 먼저 순회한 뒤 기존 fallback을 읽고, kill consumer는 assists_AccountId ?? assistantAccountIds와 teamKillers_AccountId ?? teamKillerAccountIds를 사용한다. MapReplayHandler는 itemPackage.location ?? event.location을 읽고 characters·vehicle/care-package event를 map event로 기록한다. PositionHandler·ZoneHandler·CombatHandler의 모든 actor 위치 fallback은 location ?? loc로 통일한다. MapReplayHandler.handlePosition에서 positionEventCount modulo guard를 제거한다. 현재 top-level LogPlayerUseThrowable.weapon 보존은 변경하지 않는다.

~~~ts
const filteredTelemetry = filterTelemetryEvents(rawTelemetry, {
  mode: "lite",
  teamNames,
  teamAccountIds,
});

const replayTelemetry = filterTelemetryEvents(rawTelemetry, {
  mode,
  teamNames,
  teamAccountIds,
});
~~~

replayTelemetry는 mode가 full일 때 사전 제거 없이 전체 위치를 전달한다. route에 두 번째 actor projector나 position counter를 남기지 않는다.

- [ ] **Step 4: 통합 및 기존 engine 테스트를 GREEN으로 실행한다.**

  Run: npx vitest run tests/pubg-telemetry-integration.test.ts tests/pubg-ingest-boundary.test.ts tests/analysis-engine.test.ts

  Expected: PASS; lite enemy 20개가 2개, full이 20개이고, route source에 중복 sampling/projection이 없으며, redeploy/assist/care-package/vehicle/location fallback이 consumer 결과에 나타난다.

- [ ] **Step 5: route/handler 통합을 commit한다.**

~~~bash
git add app/api/pubg/match/route.ts app/api/pubg/telemetry/route.ts \
  lib/pubg-analysis/handlers/MapReplayHandler.ts \
  lib/pubg-analysis/handlers/CombatHandler.ts \
  lib/pubg-analysis/handlers/PositionHandler.ts \
  lib/pubg-analysis/handlers/ZoneHandler.ts \
  tests/pubg-telemetry-integration.test.ts tests/pubg-ingest-boundary.test.ts tests/analysis-engine.test.ts
git commit -m "fix: unify PUBG telemetry filtering across routes"
~~~

Task 2 commit 후 root review gate에서 official-first fallback과 API field compatibility를 확인한다.

### Task 3: 최신 유효 10경기 selector와 summary cache identity

**Files:**
- Create: lib/pubg-analysis/recentMatchSelection.ts
- Modify: app/api/pubg/ai-summary/route.ts
- Test: tests/recent-match-selection.test.ts
- Test: tests/ai-cache-routes.test.ts

**Interfaces:**
- Produces RECENT_MATCH_SELECTION_VERSION, RecentMatchCandidate<T>, SelectionRejectionReason, RecentMatchSelection<T>, normalizeMatchId(rawId: unknown): string | null, selectRecentMatches(candidates, options), buildMatchSelectionKey(ids, selectionVersion?).
- ai-summary consumes selection.selected for aggregate, mastery, trend, mode/map grouping, benchmark prompt, and hash. bestMatches/Best 5 logic does not remain.

- [ ] **Step 1: deterministic selector failure tests를 작성한다.** official·competitive·unknown 허용, airoyale·seasonal 제외, mode/map token 제외, duplicate canonical ID, invalid date, stable tie, fewer-than-10, selection version/hash independence를 각각 고정한다.

~~~ts
import { describe, expect, it } from "vitest";
import {
  buildMatchSelectionKey,
  selectRecentMatches,
  type RecentMatchCandidate,
} from "@/lib/pubg-analysis/recentMatchSelection";

function candidate(
  id: string | null,
  createdAt: string | null,
  matchType: string | null,
  gameMode: string | null,
  mapName: string | null,
  sourceIndex: number,
  score: number,
): RecentMatchCandidate<{ score: number }> {
  return { id, createdAt, matchType, gameMode, mapName, sourceIndex, value: { score } };
}

describe("recent match selection", () => {
  it("최신 valid unique 10개를 score와 무관하게 선택한다", () => {
    const result = selectRecentMatches([
      candidate("shard:a", "2026-08-01T00:00:00.000Z", "official", "squad", "Erangel_Main", 0, 1),
      candidate("a", "2026-08-02T00:00:00.000Z", "competitive", "squad", "Erangel_Main", 1, 99),
      candidate("b", "2026-08-03T00:00:00.000Z", "airoyale", "squad", "Erangel_Main", 2, 100),
      candidate("c", "2026-08-04T00:00:00.000Z", "unknown", "normal-training", "Erangel_Main", 3, 100),
      candidate("d", "2026-08-05T00:00:00.000Z", "official", "squad", "SafeHouse_Main", 4, 100),
    ]);

    expect(result.selected.map(({ id }) => id)).toEqual(["a"]);
    expect(result.rejected.map(({ reason }) => reason)).toEqual(expect.arrayContaining([
      "duplicate_id",
      "match_type_excluded",
      "mode_excluded",
      "map_excluded",
    ]));
    expect(buildMatchSelectionKey(["a", "a"], result.selectionVersion)).toBe(
      buildMatchSelectionKey(["a"], result.selectionVersion),
    );
    expect(buildMatchSelectionKey(["a"], "recent-valid-10-v2")).not.toBe(
      buildMatchSelectionKey(["a"], result.selectionVersion),
    );
  });

  it("유효 후보가 10개를 넘으면 최신순 10개만 남기고 old high score를 무시한다", () => {
    const candidates = Array.from({ length: 11 }, (_, index) => candidate(
      "match-" + index,
      new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
      "official",
      "squad",
      "Erangel_Main",
      index,
      index === 0 ? 100 : 1,
    ));
    expect(selectRecentMatches(candidates).selected.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => "match-" + (10 - index)),
    );
  });
});
~~~

- [ ] **Step 2: selector RED를 확인한다.**

  Run: npx vitest run tests/recent-match-selection.test.ts

  Expected: FAIL because the pure selector, rejection reasons, and selection-version key are absent.

- [ ] **Step 3: selector를 구현하고 summary route에 연결한다.** canonical ID의 마지막 colon segment를 사용하고, duplicate winner를 parseable newest date → sourceIndex → lexical ID로 결정한다. matchType은 airoyale/seasonal만 제외하고 mode/map token은 각각 event|arcade|custom|training, safehouse|range|training을 case-insensitive로 제외한다. 유효 후보를 date 내림차순, invalid date 후순위, sourceIndex/ID tie-break로 정렬해 기본 10개를 반환한다. route는 processed rows와 필요한 missing match 결과마다 sourceIndex를 부여해 selector를 먼저 실행하고, selection 이후 effective IDs로 hash를 만든 다음 force가 아닐 때 cache lookup을 수행한다. selection.selected만 aggregate/group/benchmark/mastery/trend에 전달하고 bestMatches와 poolForBest를 삭제한다. buildMatchSelectionKey(selectedIds, selectionVersion) 앞에 AI_CACHE_VERSION을 붙여 SHA-256해 summary cache에 사용한다.

~~~ts
const selection = selectRecentMatches(candidates, {
  limit: 10,
  selectionVersion: RECENT_MATCH_SELECTION_VERSION,
});
const selectedMatches = selection.selected.map(({ value }) => value);
const selectionKey = buildMatchSelectionKey(
  selection.selected.map(({ id }) => id as string),
  selection.selectionVersion,
);
const matchIdsHash = crypto
  .createHash("sha256")
  .update(AI_CACHE_VERSION + "\n" + selectionKey)
  .digest("hex");
const summaryStats = aggregateMatches(selectedMatches);
const masteryStats = aggregateMatches(selectedMatches);
const matchesForTrend = selectedMatches;
~~~

- [ ] **Step 4: selector와 summary cache route를 GREEN으로 확인한다.**

  Run: npx vitest run tests/recent-match-selection.test.ts tests/ai-cache-routes.test.ts

  Expected: PASS; score가 높은 오래된 경기가 새 유효 경기 대신 선택되지 않고, rejected ID는 hash를 바꾸지 않으며, selected 10개가 AI/mastery/trend에 모두 쓰이고, 기존 cache-hit stream field가 동일하다.

- [ ] **Step 5: selector 단위를 commit한다.**

~~~bash
git add lib/pubg-analysis/recentMatchSelection.ts app/api/pubg/ai-summary/route.ts \
  tests/recent-match-selection.test.ts tests/ai-cache-routes.test.ts
git commit -m "fix: analyze latest valid PUBG matches as a stable set"
~~~

Task 3 commit 후 root review gate에서 effective ID hash가 selection version과 AI_CACHE_VERSION을 모두 포함하는지 확인한다.

### Task 4: 단일 매치 AI의 canonical lookup와 schema/style validation

**Files:**
- Modify: lib/pubg-analysis/cacheIdentity.ts
- Modify: app/api/pubg/ai-analyze/route.ts
- Test: tests/ai-cache-routes.test.ts
- Test: tests/pubg-analysis-stability.test.ts

**Interfaces:**
- Produces CanonicalMatchLookup = { matchId: string; playerId: string; platform: string; minResultVersion: number }와 getValidFullResultForMatch(row: unknown, expected: CanonicalMatchLookup): Record<string, unknown> | null.
- ai-analyze는 기존 cache identity (match_id, normalized player_id, normalized platform, coaching_style, AI_CACHE_VERSION)를 먼저 조회하고, miss에서만 validator를 거쳐 canonical prompt를 만든다.

- [ ] **Step 1: canonical, style, forged input 경계의 실패 테스트를 작성한다.** 기존 ai-cache-routes Supabase/Gemini mocks를 확장해 cache hit이 canonical query와 Gemini를 건너뛰는지, miss에서 forged browser stats가 prompt에 나타나지 않는지, missing/mismatched/stale row가 409와 고정 error code를 내고 Gemini/upsert를 하지 않는지 확인한다. mild와 spicy는 통과하고 wild는 400 PUBG_AI_INVALID_COACHING_STYLE을 받아야 한다.

~~~ts
it("canonical row가 없으면 forged browser matchData를 사용하지 않고 409를 반환한다", async () => {
  const response = await aiAnalyzePOST(createRequest({
    matchData: { matchId: "match-1", stats: { kills: 9999 }, timeline: ["forged"] },
    nickname: "Player",
    platform: "steam",
    coachingStyle: "spicy",
  }));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "canonical match analysis is not ready",
    errorCode: "PUBG_AI_CANONICAL_NOT_READY",
    retryable: true,
  });
  expect(mockGenerateContentStream).not.toHaveBeenCalled();
  expect(matchCache.upsert).not.toHaveBeenCalled();
});

it("validator는 matching identity와 current result version만 통과시킨다", () => {
  const validRow = {
    match_id: "match-1",
    player_id: "player",
    platform: "steam",
    data: {
      fullResult: {
        matchId: "match-1",
        player_id: "player",
        platform: "steam",
        v: RESULT_VERSION,
        stats: { name: "Player", kills: 2 },
      },
    },
  };
  const expected = {
    matchId: "match-1",
    playerId: "player",
    platform: "steam",
    minResultVersion: RESULT_VERSION,
  };

  expect(getValidFullResultForMatch(validRow, expected)).toMatchObject({ matchId: "match-1" });
  expect(getValidFullResultForMatch({ ...validRow, match_id: "other" }, expected)).toBeNull();
  expect(getValidFullResultForMatch({
    ...validRow,
    data: { fullResult: { ...validRow.data.fullResult, v: RESULT_VERSION - 1 } },
  }, expected)).toBeNull();
});

it("지원하지 않는 coachingStyle을 fail-closed한다", async () => {
  const response = await aiAnalyzePOST(createRequest({
    matchData: { matchId: "match-1" },
    nickname: "Player",
    platform: "steam",
    coachingStyle: "wild",
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ errorCode: "PUBG_AI_INVALID_COACHING_STYLE" });
});
~~~

- [ ] **Step 2: canonical route 테스트를 RED로 확인한다.**

  Run: npx vitest run tests/ai-cache-routes.test.ts tests/pubg-analysis-stability.test.ts

  Expected: FAIL because cache miss currently sends request matchData directly to buildMatchAiCoachingPrompt and there is no current-version/match identity validator or style allowlist.

- [ ] **Step 3: validator와 route canonical boundary를 구현한다.** validator는 row/data/fullResult record, row/fullResult canonical match ID, existing player/name/platform identity, v >= minResultVersion를 모두 검사한다. route는 body에서 match ID만 꺼내 400으로 형식 검증하고 style을 먼저 allowlist한다. 기존 cache hit을 그대로 반환한다. miss에서 processed_match_telemetry.select("match_id,player_id,platform,data")를 expected match/player/platform으로 조회하고 validator가 null이면 정확히 409 JSON을 반환하며 Gemini, cache upsert, prompt builder를 호출하지 않는다. 통과한 fullResult만 buildMatchAiCoachingPrompt({ matchData: canonicalFullResult, coachingStyle })에 넣고 기존 sanitization/usage/stream/cache response를 유지한다.

~~~ts
const canonicalFullResult = getValidFullResultForMatch(canonicalRow, {
  matchId,
  playerId,
  platform: cachePlatform,
  minResultVersion: RESULT_VERSION,
});
if (!canonicalFullResult) {
  return NextResponse.json({
    error: "canonical match analysis is not ready",
    errorCode: "PUBG_AI_CANONICAL_NOT_READY",
    retryable: true,
  }, { status: 409 });
}

const { fullPrompt, backupContext } = buildMatchAiCoachingPrompt({
  matchData: canonicalFullResult,
  coachingStyle,
});
~~~

- [ ] **Step 4: canonical route와 stability 테스트를 GREEN으로 실행한다.**

  Run: npx vitest run tests/ai-cache-routes.test.ts tests/pubg-analysis-stability.test.ts

  Expected: PASS; valid canonical row만 prompt에 들어가고, forged/missing/mismatch/stale row는 409/no-Gemini/no-upsert이며, cache hit/mild/spicy/default style의 기존 response 형식이 유지된다.

- [ ] **Step 5: single AI canonical unit을 commit한다.**

~~~bash
git add lib/pubg-analysis/cacheIdentity.ts app/api/pubg/ai-analyze/route.ts \
  tests/ai-cache-routes.test.ts tests/pubg-analysis-stability.test.ts
git commit -m "fix: gate single-match AI on canonical telemetry"
~~~

Task 4 commit 후 root review gate에서 browser matchData 수치가 prompt/DB write 경로에 남지 않는지 확인한다.

### Task 5: 읽기 전용 before/after audit, 버전 bump, 전체 검증

**Files:**
- Modify: lib/pubg-analysis/constants.ts
- Create: scripts/audit_pubg_ai_accuracy.ts
- Create: tests/fixtures/pubg-official-shaped-telemetry.json
- Create: tests/audit-pubg-ai-accuracy.test.ts
- Modify: package.json

**Interfaces:**
- Produces AccuracyAuditOptions, AccuracyAuditReport, runAccuracyAudit(options?: AccuracyAuditOptions): Promise<AccuracyAuditReport>; report는 schemaVersion, source/fallback, player fingerprint, single-match metrics, recent selection, telemetry aggregates, remoteWritesAttempted: 0, externalAiCalls: 0를 가진다.
- Consumes Task 1 contract와 Task 3 selector. 세 버전 상수는 이 Task에서만 변경한다.

- [ ] **Step 1: synthetic fixture와 audit/version 실패 테스트를 먼저 작성한다.** fixture는 redeploy characters[], V2 official arrays, nested care-package location, Character.loc, attack/vehicle/care-package, top-level throwable weapon, 20 enemy positions와 여러 match metadata를 포함한다. 테스트는 redacted report가 raw name/account/match ID/event/URL을 포함하지 않고, legacy/new single metrics와 selection fingerprints/counts, zero writes/external calls, source label과 version 값을 확인한다.

~~~ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AI_CACHE_VERSION, RESULT_VERSION, TELEMETRY_VERSION } from "@/lib/pubg-analysis/constants";
import { runAccuracyAudit } from "@/scripts/audit_pubg_ai_accuracy";

describe("anonymous PUBG AI accuracy audit", () => {
  it("synthetic fallback은 aggregate/fingerprint만 반환한다", async () => {
    const report = await runAccuracyAudit({
      source: "synthetic_fixture",
      fixturePath: path.resolve("tests/fixtures/pubg-official-shaped-telemetry.json"),
      nickname: "FixturePlayer",
      platform: "steam",
      limit: 25,
    });

    expect(report.source).toBe("synthetic_fixture");
    expect(report.remoteWritesAttempted).toBe(0);
    expect(report.externalAiCalls).toBe(0);
    expect(report.recentSelection.nextCount).toBeLessThanOrEqual(10);
    expect(JSON.stringify(report)).not.toMatch(/accountId|playerId|matchId|FixturePlayer|LogPlayerAttack|https?:/);
    expect(report.telemetry.next.positionEvents).toBe(2);
  });

  it("의미 버전은 지정 값으로 한 번만 bump된다", () => {
    expect(RESULT_VERSION).toBe(73.0);
    expect(TELEMETRY_VERSION).toBe(61.0);
    expect(AI_CACHE_VERSION).toBe("2026-08-27.pubg-ai-accuracy-v1");
  });
});
~~~

- [ ] **Step 2: audit 테스트를 RED로 실행한다.**

  Run: npx vitest run tests/audit-pubg-ai-accuracy.test.ts

  Expected: FAIL because audit runner/fixture/npm script가 없고 constants가 이전 값이다.

- [ ] **Step 3: read-only audit, fixture, npm script와 one-time version bump를 구현한다.** runAccuracyAudit는 credentials가 모두 존재할 때 한 normalized user의 processed_match_telemetry rows를 read-only select하고, 선택한 match의 공식 match endpoint를 Authorization GET한 뒤 asset telemetry URL은 API key 없이 GET한다. 모든 dependency는 select/GET만 허용한다. 환경·권한·raw data가 없으면 고정 fallbackReason과 synthetic fixture로 전환한다. legacy reference는 기존 allowlist, route 1/10, recent 10→Best 5 선택을 side-effect-free로 재현하고, 새 contract/selector와 같은 입력을 적용해 singleMatchMetrics, telemetry, recentSelection의 legacy/next/delta를 계산한다. player/match/account/name/URL은 SHA-256 prefix 16자로 바꾸고 raw event·response·stack trace를 report/log에 넣지 않는다. redaction 검사가 실패하면 output file을 쓰지 않고 exit code 1이다. package.json에는 audit:pubg-ai-accuracy: tsx scripts/audit_pubg_ai_accuracy.ts를 추가하고 신규 분석 테스트들을 verify:analysis 명령에 포함한다. 이 변경에서만 RESULT_VERSION=73.0, TELEMETRY_VERSION=61.0, AI_CACHE_VERSION=2026-08-27.pubg-ai-accuracy-v1로 바꾼다.

~~~ts
const report: AccuracyAuditReport = {
  schemaVersion: "1",
  source,
  fallbackReason,
  playerFingerprint: fingerprint(normalizedNickname),
  loadedMatchCount,
  singleMatchMetrics: compareNumericMaps(legacySingle, nextSingle),
  recentSelection: {
    legacyCount: legacySelected.length,
    nextCount: selection.selected.length,
    legacyMatchFingerprints: legacySelected.map(({ id }) => fingerprint(id)),
    nextMatchFingerprints: selection.selected.map(({ id }) => fingerprint(id as string)),
    legacyExcluded,
    nextExcluded,
  },
  telemetry: compareNumericMaps(legacyTelemetry, nextTelemetry),
  remoteWritesAttempted: 0,
  externalAiCalls: 0,
};
assertRedacted(report);
return report;
~~~

- [ ] **Step 4: audit와 전체 verification을 실행한다.**

  Run:

~~~bash
npx vitest run tests/audit-pubg-ai-accuracy.test.ts tests/telemetry-contract.test.ts \
  tests/recent-match-selection.test.ts tests/ai-cache-routes.test.ts \
  tests/pubg-telemetry-integration.test.ts
npm run audit:pubg-ai-accuracy -- --nickname "$PUBG_AUDIT_NICKNAME" --platform steam --limit 25 --output tmp/pubg-ai-accuracy-audit.json
npm run verify:analysis
npm run verify:core
npm run verify:admin
npm run test:unit
npm test -- --runInBand
git diff --check
~~~

  Expected: focused tests, synthetic audit, lint/typecheck, admin/analysis suites, Vitest and Jest pass; verify:analysis는 기존 210개와 신규 테스트가 모두 통과한다. Credentials가 없으면 audit output은 source synthetic_fixture와 fallback 사유를 포함한다. Credentials가 이미 있으면 한 real user official raw telemetry read-only 실행을 한 번 추가하고 report에 raw identifier와 remote write가 없는지 확인한다. Gemini 호출, DB/R2 write, migration diff가 없어야 한다.

- [ ] **Step 5: version/audit unit을 commit한다.**

~~~bash
git add lib/pubg-analysis/constants.ts scripts/audit_pubg_ai_accuracy.ts \
  tests/fixtures/pubg-official-shaped-telemetry.json tests/audit-pubg-ai-accuracy.test.ts package.json
git commit -m "test: add anonymous PUBG AI accuracy audit"
~~~

Task 5 commit 후 root final review에서 세 version 대입이 각각 한 번인지, audit redaction과 zero-write evidence를 확인한다.

## Final handoff checklist

- [ ] git diff --check가 깨끗하고 Task별 변경 파일 이외의 production/UI/migration 파일이 없다.
- [ ] npm run verify:analysis가 기존 210개와 새 분석 테스트 전체를 통과하며 npm run verify:core, npm run verify:admin, 전체 Vitest/Jest가 통과한다.
- [ ] contract, route/engine, recent selector, canonical AI, audit 테스트와 synthetic fixture가 통과한다.
- [ ] 환경·credentials가 이미 있을 때만 한 real user official raw telemetry audit을 실행했으며, 그 외에는 synthetic source/fallback label이 있다.
- [ ] report와 로그에는 raw identity, match ID, URL, raw event가 없고 remoteWritesAttempted=0, externalAiCalls=0이다.
- [ ] RESULT_VERSION, TELEMETRY_VERSION, AI_CACHE_VERSION가 각각 지정 값으로 한 번만 변경됐고 LogWeaponFireCount consumer, DB migration, UI/model 변경이 없다.
