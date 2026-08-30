import { describe, expect, it, vi } from "vitest";
import {
  buildProcessedTelemetryUpsert,
  getValidFullResult,
  getValidFullResultForMatch,
  isFullResultForPlayerPlatform
} from "../lib/pubg-analysis/cacheIdentity";
import { RESULT_VERSION } from "../lib/pubg-analysis/constants";
import { aggregateTierBenchmarkRows, fetchTierBenchmarkStats } from "../lib/pubg-analysis/benchmarkLookup";
import { estimateAverageTierFromRows } from "../lib/pubg-analysis/tierAveraging";
import { classifyRole } from "../lib/pubg-analysis/roleClassifier";

describe("PUBG analysis identity stabilization", () => {
  it("processed 캐시는 내부 stats.name이 요청 유저와 다르면 무시한다", () => {
    const copiedTeammateRow = {
      match_id: "match-1",
      platform: "steam",
      player_id: "teammate_b",
      data: {
        fullResult: {
          player_id: "teammate_b",
          platform: "steam",
          stats: { name: "Player_A", damageDealt: 500 }
        }
      }
    };

    expect(getValidFullResult(copiedTeammateRow, "teammate_b", "steam")).toBeNull();
    expect(getValidFullResult(copiedTeammateRow, "player_a", "steam")).toBeNull();
  });

  it("processed 저장 payload는 분석 대상 유저 1명과 platform을 명시한다", () => {
    const payload = buildProcessedTelemetryUpsert("match-1", "Player_A", "KAKAO", {
      stats: { name: "Player_A", damageDealt: 320 },
      team: [{ name: "Player_A" }, { name: "Teammate_B" }]
    });

    expect(payload).toMatchObject({
      match_id: "match-1",
      platform: "kakao",
      player_id: "player_a",
      data: {
        fullResult: {
          player_id: "player_a",
          platform: "kakao",
          stats: { name: "Player_A", damageDealt: 320 }
        }
      }
    });
  });

  it("platform이 다르면 같은 닉네임의 캐시도 무시한다", () => {
    const fullResult = {
      player_id: "player_a",
      platform: "steam",
      stats: { name: "Player_A" }
    };

    expect(isFullResultForPlayerPlatform(fullResult, "Player_A", "steam")).toBe(true);
    expect(isFullResultForPlayerPlatform(fullResult, "Player_A", "kakao")).toBe(false);
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

  it("validator는 canonical fullResult ID, row/data shape, player/platform을 모두 확인한다", () => {
    const expected = {
      matchId: "match-1",
      playerId: "player",
      platform: "steam",
      minResultVersion: RESULT_VERSION,
    };
    const validRow = {
      match_id: "shard:match-1",
      player_id: "PLAYER",
      platform: "STEAM",
      data: {
        fullResult: {
          match_id: "match-1",
          player_id: "player",
          platform: "steam",
          v: RESULT_VERSION + 1,
          stats: { name: "Player", kills: 2 },
        },
      },
    };

    expect(getValidFullResultForMatch(validRow, expected)).toBe(validRow.data.fullResult);
    expect(getValidFullResultForMatch({ ...validRow, data: null }, expected)).toBeNull();
    expect(getValidFullResultForMatch({ ...validRow, data: { fullResult: [] } }, expected)).toBeNull();
    expect(getValidFullResultForMatch({
      ...validRow,
      data: { fullResult: { ...validRow.data.fullResult, match_id: "other" } },
    }, expected)).toBeNull();
    expect(getValidFullResultForMatch({ ...validRow, player_id: "other" }, expected)).toBeNull();
    expect(getValidFullResultForMatch({ ...validRow, platform: "kakao" }, expected)).toBeNull();
  });
});

describe("PUBG benchmark and tier stabilization", () => {
  it.each([
    { code: "PGRST002", status: 503, message: "schema cache unavailable" },
    { code: "PGRST116", status: 406, message: "JSON object requested, multiple (or no) rows returned" },
    { code: "PGRST205", status: 404, message: "Could not find the table or view" },
  ])("benchmark 조회는 non-null DB 오류($code)를 null 기본값으로 삼지 않고 전파한다", async (databaseError) => {
    const query: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: databaseError }),
      limit: vi.fn().mockResolvedValue({ data: null, error: databaseError }),
    };
    const supabase = { from: vi.fn().mockReturnValue(query) };

    await expect(fetchTierBenchmarkStats(supabase, {
      gameMode: "squad",
      matchType: "official",
      tier: "A",
    })).rejects.toMatchObject(databaseError);
    expect(query.limit).not.toHaveBeenCalled();
  });

  it("benchmark 조회는 error:null인 실제 no-row 결과만 null로 반환한다", async () => {
    const query: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const supabase = { from: vi.fn().mockReturnValue(query) };

    await expect(fetchTierBenchmarkStats(supabase, {
      gameMode: "squad",
      matchType: "official",
      tier: "A",
    })).resolves.toBeNull();
    expect(query.limit).toHaveBeenCalledTimes(1);
  });

  it("같은 티어군 fallback 벤치마크는 match_count로 가중 평균한다", () => {
    const aggregated = aggregateTierBenchmarkRows([
      { tier: "A+", match_count: 1, avg_damage: 600, avg_trade_latency_ms: 6000 },
      { tier: "A", match_count: 3, avg_damage: 200, avg_trade_latency_ms: 12000 }
    ], "A+");

    expect(aggregated).toMatchObject({
      tier: "A",
      match_count: 4,
      avg_damage: 300,
      avg_trade_latency_ms: 10500
    });
  });

  it("배틀 평균 티어는 실제 score 평균을 우선하고 S+ fallback도 지원한다", () => {
    expect(estimateAverageTierFromRows([
      { tier: "D-", score: 95 },
      { tier: "D-", score: 85 }
    ])).toBe("S+");

    expect(estimateAverageTierFromRows([
      { tier: "S+" },
      { tier: "S" }
    ])).toBe("S+");
  });
});

describe("PUBG derived value semantics", () => {
  const baseRoleStats = {
    mLen: 1,
    userInitiativeRate: 0,
    avgReactionLatency: "측정 불가",
    avgMinDistStr: "50m",
    totalMaxHitDist: 0,
    avgIsolationStr: "1.0",
    avgDuelWinRate: 0,
    totalReversalWins: 0,
    totalTeamWipes: 0,
    totalRidingShotKills: 0,
    totalRidingShotKnocks: 0,
    totalLeadShotKills: 0,
    totalLeadShotKnocks: 0,
    totalEdgePlay: 0,
    totalBluezoneWaste: 0,
    avgPressureIndex: 0,
    avgDeathPhase: 0,
    goldenTimeAvg: { early: 0, mid1: 0, mid2: 0, late: 0 },
    totalBaitCount: 0,
    totalSuppCount: 0,
    weaponStatsFinal: {},
    weaponMatchCount: {}
  };

  it("팀의 방패 역할 점수는 연막 시도보다 실제 연막 구출 성공을 더 크게 본다", () => {
    const failedAttempts = classifyRole({
      ...baseRoleStats,
      totalTeammateKnocks: 3,
      totalSmokeCount: 3,
      totalSmokeRescues: 0,
      totalRevCount: 0,
      totalTradeKills: 0
    }, {}, "B");

    const successfulRescues = classifyRole({
      ...baseRoleStats,
      totalTeammateKnocks: 3,
      totalSmokeCount: 3,
      totalSmokeRescues: 3,
      totalRevCount: 0,
      totalTradeKills: 0
    }, {}, "B");

    expect(failedAttempts.scores.shield).toBeLessThan(15);
    expect(successfulRescues.scores.shield).toBeGreaterThan(failedAttempts.scores.shield + 35);
  });
});
