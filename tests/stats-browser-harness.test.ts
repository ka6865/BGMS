import { describe, expect, it } from "vitest";
import matchDetailReady from "./fixtures/stats/match-detail-ready.json";
import squadReady from "./fixtures/stats/squad-ready.json";
import {
  buildStatsApiRequest,
  cloneMatchDetailForRequest,
  cloneSummaryForRequest,
  createStatsBrowserScenario,
  createStatsQaClock,
  playerReadyForRequest,
  type StatsApiRequest,
} from "./fixtures/stats/browserScenarios";
import {
  createStatsRequestLedger,
  type StatsRequestRecord,
} from "./helpers/statsBrowserHarness";

const FIXTURE_NOW_MS = Date.parse("2026-08-11T12:00:00.000Z");

function request(
  url: string,
  input: { method?: string; body?: unknown; recordId?: number } = {},
): StatsApiRequest {
  return buildStatsApiRequest({
    recordId: input.recordId ?? 1,
    method: input.method ?? "GET",
    url,
    body: input.body,
  });
}

describe("stats browser pure harness contracts", () => {
  it("clone overrides request identity and clock without mutating the imported match fixture", () => {
    const original = JSON.stringify(matchDetailReady);
    const clock = createStatsQaClock(FIXTURE_NOW_MS);
    const cloned = cloneMatchDetailForRequest({
      matchId: "request-match",
      nickname: "RequestPlayer",
      clock,
    });

    expect(JSON.stringify(matchDetailReady)).toBe(original);
    expect(cloned).toMatchObject({
      matchId: "request-match",
      stats: {
        name: "RequestPlayer",
        playerId: "account.request-player",
      },
      createdAt: clock.readyIso,
    });
  });

  it("fixed QA clock yields exact ready and age fixture timestamps", () => {
    const clock = createStatsQaClock(FIXTURE_NOW_MS);

    expect(clock.nowIso).toBe("2026-08-11T12:00:00.000Z");
    expect(clock.readyIso).toBe("2026-08-10T12:00:00.000Z");
    expect(clock.daysAgo(13)).toBe("2026-07-29T12:00:00.000Z");
    expect(clock.daysAgo(15)).toBe("2026-07-27T12:00:00.000Z");
    expect(clock.daysAgo(91)).toBe("2026-05-12T12:00:00.000Z");
  });

  it("player and summary clones own the requested identity, match keys, and QA timestamps", () => {
    const clock = createStatsQaClock(FIXTURE_NOW_MS);
    const player = playerReadyForRequest({
      nickname: "KakaoPlayer",
      platform: "kakao",
      season: "division.bro.official.pc-2026-07",
      clock,
      recentMatchIds: ["request-match"],
    });
    const summary = cloneSummaryForRequest({
      matchId: "request-match",
      nickname: "KakaoPlayer",
      clock,
    });

    expect(player).toMatchObject({
      nickname: "KakaoPlayer",
      platform: "kakao",
      seasonId: "division.bro.official.pc-2026-07",
      recentMatches: ["request-match"],
      updatedAt: clock.readyIso,
    });
    expect(summary).toMatchObject({
      matchId: "request-match",
      createdAt: clock.readyIso,
      stats: {
        name: "KakaoPlayer",
        playerId: "account.kakao-player",
      },
    });
  });

  it("squad responses are named by groupKey rather than response order", async () => {
    const scenario = createStatsBrowserScenario({
      name: "squad",
      clock: createStatsQaClock(FIXTURE_NOW_MS),
    });
    const list = await scenario.resolve(request(
      "/api/pubg/squad-analyze?nickname=FixturePlayer&platform=steam",
    ));
    const g2 = await scenario.resolve(request(
      "/api/pubg/squad-analyze?nickname=FixturePlayer&platform=steam&groupKey=g2",
      { recordId: 2 },
    ));
    const g1 = await scenario.resolve(request(
      "/api/pubg/squad-analyze?nickname=FixturePlayer&platform=steam&groupKey=g1",
      { recordId: 3 },
    ));

    expect(list.body).toEqual({ groups: squadReady.groups });
    expect(g2.body).toEqual(squadReady.details.g2);
    expect(g1.body).toEqual(squadReady.details.g1);
    await expect(scenario.resolve(request(
      "/api/pubg/squad-analyze?nickname=FixturePlayer&platform=steam&groupKey=missing",
      { recordId: 4 },
    ))).rejects.toThrow(/groupKey/i);
    await expect(scenario.resolve(request(
      "/api/pubg/squad-analyze?nickname=FixturePlayer&platform=steam",
      { recordId: 5 },
    ))).resolves.toMatchObject({ status: 200 });
  });

  it("rejects wrong methods, missing required query, wrong JSON bodies, and unhandled PUBG endpoints", async () => {
    const scenario = createStatsBrowserScenario({
      name: "ready",
      clock: createStatsQaClock(FIXTURE_NOW_MS),
    });

    await expect(scenario.resolve(request(
      "/api/pubg/player?nickname=FixturePlayer&platform=steam",
      { method: "POST" },
    ))).rejects.toThrow(/method/i);
    await expect(scenario.resolve(request(
      "/api/pubg/player?nickname=FixturePlayer",
    ))).rejects.toThrow(/platform/i);
    await expect(scenario.resolve(request(
      "/api/pubg/suggest?q=Fi",
      { method: "POST" },
    ))).rejects.toThrow(/method/i);
    await expect(scenario.resolve(request(
      "/api/pubg/matches-summary",
      {
        method: "POST",
        body: { matchIds: ["wrong"], nickname: "Other", platform: "kakao" },
      },
    ))).rejects.toThrow(/summary|body|match/i);
    await expect(scenario.resolve(request(
      "/api/pubg/match?matchId=match-detail-1&nickname=FixturePlayer",
    ))).rejects.toThrow(/platform/i);
    await expect(scenario.resolve(request(
      "/api/pubg/unknown?nickname=FixturePlayer&platform=steam",
    ))).rejects.toThrow(/unexpected|endpoint/i);
  });

  it("rejects request bodies on every GET stats endpoint", async () => {
    const scenario = createStatsBrowserScenario({
      name: "squad",
      clock: createStatsQaClock(FIXTURE_NOW_MS),
    });
    const body = { unexpected: true };

    for (const url of [
      "/api/pubg/player?nickname=FixturePlayer&platform=steam",
      "/api/pubg/suggest?q=FixturePlayer",
      "/api/pubg/match?matchId=match-fixture-1&nickname=FixturePlayer&platform=steam",
      "/api/pubg/squad-analyze?nickname=FixturePlayer&platform=steam",
    ]) {
      await expect(scenario.resolve(request(url, { body }))).rejects.toThrow(/GET|body/i);
    }
  });

  it("advances retry counters only for matching semantic requests and ignores player _t", async () => {
    const scenario = createStatsBrowserScenario({
      name: "player-retry",
      clock: createStatsQaClock(FIXTURE_NOW_MS),
    });
    const first = request(
      "/api/pubg/player?nickname=FixturePlayer&platform=steam&_t=1",
    );
    const second = request(
      "/api/pubg/player?nickname=FixturePlayer&platform=steam&_t=2",
      { recordId: 2 },
    );
    const other = request(
      "/api/pubg/player?nickname=OtherPlayer&platform=steam&_t=3",
      { recordId: 3 },
    );

    expect(first.semanticKey).toBe(second.semanticKey);
    expect((await scenario.resolve(first)).status).toBe(500);
    expect((await scenario.resolve(other)).status).toBe(200);
    expect((await scenario.resolve(second)).status).toBe(200);
    expect(scenario.counters["player:FixturePlayer:steam"]).toBe(2);
    expect(scenario.counters["player:OtherPlayer:steam"]).toBe(1);
  });

  it("keeps summary and detail retries query/body-aware", async () => {
    const clock = createStatsQaClock(FIXTURE_NOW_MS);
    const summaryScenario = createStatsBrowserScenario({ name: "summary-retry", clock });
    const summaryBody = { matchIds: ["match-fixture-1"], nickname: "FixturePlayer", platform: "steam" };
    const summaryFirst = await summaryScenario.resolve(request("/api/pubg/matches-summary", {
      method: "POST",
      body: summaryBody,
    }));
    const wrongSummary = summaryScenario.resolve(request("/api/pubg/matches-summary", {
      recordId: 2,
      method: "POST",
      body: { ...summaryBody, nickname: "OtherPlayer" },
    }));
    const summarySecond = await summaryScenario.resolve(request("/api/pubg/matches-summary", {
      recordId: 3,
      method: "POST",
      body: summaryBody,
    }));
    expect(summaryFirst.status).toBe(500);
    await expect(wrongSummary).rejects.toThrow(/summary|body|identity/i);
    expect(summarySecond.status).toBe(200);

    const detailScenario = createStatsBrowserScenario({ name: "detail-retry", clock });
    expect((await detailScenario.resolve(request(
      "/api/pubg/match?matchId=match-detail-1&nickname=FixturePlayer&platform=steam",
    ))).status).toBe(500);
    await expect(detailScenario.resolve(request(
      "/api/pubg/match?matchId=match-detail-1&nickname=OtherPlayer&platform=steam",
      { recordId: 2 },
    ))).rejects.toThrow(/detail|identity|nickname/i);
    expect((await detailScenario.resolve(request(
      "/api/pubg/match?matchId=match-detail-1&nickname=FixturePlayer&platform=steam",
      { recordId: 3 },
    ))).status).toBe(200);
  });

  it("does not consume a retry attempt when the matching request becomes aborted", async () => {
    const scenario = createStatsBrowserScenario({
      name: "detail-retry",
      clock: createStatsQaClock(FIXTURE_NOW_MS),
    });
    const first = request(
      "/api/pubg/match?matchId=match-detail-1&nickname=FixturePlayer&platform=steam",
      { recordId: 10 },
    );
    const retry = request(
      "/api/pubg/match?matchId=match-detail-1&nickname=FixturePlayer&platform=steam",
      { recordId: 11 },
    );

    expect((await scenario.resolve(first)).status).toBe(500);
    scenario.abort(first);
    expect(scenario.counters["detail:match-detail-1:FixturePlayer:steam"]).toBe(0);
    expect((await scenario.resolve(retry)).status).toBe(500);
  });

  it("marks unauthenticated AI endpoints fatal", async () => {
    const scenario = createStatsBrowserScenario({
      name: "ready",
      clock: createStatsQaClock(FIXTURE_NOW_MS),
    });

    for (const pathname of ["/api/pubg/ai-summary", "/api/pubg/ai-analyze", "/api/pubg/ai-squad"]) {
      await expect(scenario.resolve(request(pathname, { method: "POST" }))).rejects.toThrow(/AI|unauthenticated|fatal/i);
    }
  });

  it("ledger distinguishes started, completed/successful, and aborted records", () => {
    const ledger = createStatsRequestLedger();
    const completed: StatsRequestRecord = ledger.start({
      method: "GET",
      url: "http://localhost/api/pubg/player?nickname=FixturePlayer&platform=steam",
      pathname: "/api/pubg/player",
      query: { nickname: "FixturePlayer", platform: "steam" },
      semanticKey: "GET /api/pubg/player?nickname=FixturePlayer&platform=steam",
      category: "stats-api",
    });
    ledger.complete(completed, 200, true);
    const aborted = ledger.start({
      method: "GET",
      url: "http://localhost/api/pubg/player?nickname=OtherPlayer&platform=steam",
      pathname: "/api/pubg/player",
      query: { nickname: "OtherPlayer", platform: "steam" },
      semanticKey: "GET /api/pubg/player?nickname=OtherPlayer&platform=steam",
      category: "stats-api",
    });
    ledger.abort(aborted);

    expect(ledger.count({ pathname: "/api/pubg/player", successful: true })).toBe(1);
    expect(ledger.count({ pathname: "/api/pubg/player", state: "completed" })).toBe(1);
    expect(ledger.count({ pathname: "/api/pubg/player", state: "aborted" })).toBe(1);
    expect(ledger.records).toHaveLength(2);
  });
});
