import { describe, expect, it, vi } from "vitest";
import {
  buildProcessedTelemetryUpsert,
  getValidFullResult,
  getValidFullResultForMatch,
  isFullResultForPlayerPlatform
} from "../lib/pubg-analysis/cacheIdentity";
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION } from "../lib/pubg-analysis/constants";
import { aggregateTierBenchmarkRows, fetchTierBenchmarkStats, isTrustedBenchmarkAggregate } from "../lib/pubg-analysis/benchmarkLookup";
import { adaptBenchmark, adaptObservedBenchmark } from "../lib/pubg-analysis/benchmarkAdapter";
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

  it("processed 저장은 benchmark score/breakdown을 finite 0..100으로 정규화하고 입력과 기타 필드를 보존한다", () => {
    const fullResult = {
      matchId: "match-1",
      stats: { name: "Player_A", damageDealt: 320 },
      unrelatedField: { keep: true },
      benchmark: {
        score: -5,
        displayTier: "A+",
        breakdown: {
          combat: 101,
          tactical: Number.NaN,
          survival: Number.POSITIVE_INFINITY,
          label: "keep",
        },
      },
    };
    const inputSnapshot = structuredClone(fullResult);

    const payload = buildProcessedTelemetryUpsert("match-1", "Player_A", "KAKAO", fullResult);
    const persisted = payload.data.fullResult as typeof fullResult & {
      player_id: string;
      platform: string;
    };

    expect(persisted.benchmark).toMatchObject({
      score: 0,
      displayTier: "A+",
      breakdown: {
        combat: 100,
        tactical: 0,
        survival: 0,
        label: "keep",
      },
    });
    expect(persisted.unrelatedField).toEqual({ keep: true });
    expect(persisted.player_id).toBe("player_a");
    expect(persisted.platform).toBe("kakao");
    expect(fullResult).toEqual(inputSnapshot);
    expect(persisted).not.toBe(fullResult);
    expect(persisted.benchmark).not.toBe(fullResult.benchmark);
    expect(persisted.benchmark.breakdown).not.toBe(fullResult.benchmark.breakdown);
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

  it.each([
    ["legacy filter version", { filter_version: 7 }],
    ["current filter without preservation evidence", { filter_version: 8, population_evidence_version: 0 }],
    ["missing preservation evidence", { match_count: 5, avg_damage: 999 }],
  ] as const)("benchmark 조회는 %s aggregate를 비교에 사용하지 않는다", async (_label, evidence) => {
    const contaminated = { ...evidence, tier: "A", match_count: 5, avg_damage: 999 };
    const query: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: contaminated, error: null }),
      limit: vi.fn().mockResolvedValue({ data: [contaminated], error: null }),
    };
    const supabase = { from: vi.fn().mockReturnValue(query) };

    await expect(fetchTierBenchmarkStats(supabase, {
      gameMode: "squad",
      matchType: "official",
      tier: "A",
    })).resolves.toBeNull();
  });

  it("benchmark 조회는 명시적으로 현재 filter와 population provenance가 함께 있는 aggregate만 사용한다", async () => {
    const trusted = {
      filter_version: 8,
      population_evidence_version: 1,
      tier: "A",
      match_count: 5,
      avg_damage: 300,
    };
    const query: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: trusted, error: null }),
      limit: vi.fn().mockResolvedValue({ data: [trusted], error: null }),
    };
    const supabase = { from: vi.fn().mockReturnValue(query) };

    expect(isTrustedBenchmarkAggregate(trusted)).toBe(true);
    await expect(fetchTierBenchmarkStats(supabase, {
      gameMode: "squad",
      matchType: "official",
      tier: "A",
    })).resolves.toMatchObject({ filter_version: 8, population_evidence_version: 1 });
  });

  it("같은 티어군 fallback 벤치마크는 match_count로 가중 평균한다", () => {
    const aggregated = aggregateTierBenchmarkRows([
      { tier: "A+", match_count: 1, avg_damage: 600, avg_damage_count: 1, avg_trade_latency_ms: 6000, avg_trade_latency_ms_count: 1 },
      { tier: "A", match_count: 3, avg_damage: 200, avg_damage_count: 3, avg_trade_latency_ms: 12000, avg_trade_latency_ms_count: 3 }
    ], "A+");

    expect(aggregated).toMatchObject({
      tier: "A",
      match_count: 4,
      avg_damage: 300,
      avg_trade_latency_ms: 10500
    });
  });

  it("같은 티어군 aggregate는 null·공백 metric을 0으로 바꾸지 않고 관측값만 가중한다", () => {
    const aggregated = aggregateTierBenchmarkRows([
      { tier: "A+", match_count: 2, avg_damage: null, avg_pressure_index: "" },
      { tier: "A", match_count: 3, avg_damage: 400, avg_damage_count: 3, avg_pressure_index: null },
    ], "A+");

    expect(aggregated).toMatchObject({
      match_count: 5,
      avg_damage: 400,
    });
    expect(aggregated).not.toHaveProperty("avg_pressure_index");
  });

  it("grouped aggregate는 음수 metric을 양수 row와 평균내어 관측값으로 세탁하지 않는다", () => {
    const aggregated = aggregateTierBenchmarkRows([
      { tier: "A+", match_count: 5, avg_damage: -900, avg_damage_count: 5 },
      { tier: "A", match_count: 5, avg_damage: 300, avg_damage_count: 5 },
    ], "A+");

    expect(aggregated).toMatchObject({ match_count: 10, avg_damage: 300, avg_damage_count: 5 });
  });

  it("rate metric은 0..100 밖의 grouped 관측값을 생략한다", () => {
    const aggregated = aggregateTierBenchmarkRows([
      { tier: "A+", match_count: 5, avg_trade_rate: 101, avg_trade_rate_count: 5 },
    ], "A+");

    expect(aggregated).not.toHaveProperty("avg_trade_rate");
    expect(aggregated).not.toHaveProperty("avg_trade_rate_count");
  });

  it("fine-tier 표본이 5 미만이면 같은 base tier aggregate가 5 이상일 때만 채택한다", async () => {
    const exact = {
      tier: "A+",
      match_count: 3,
      avg_damage: 900,
      avg_damage_count: 3,
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
    };
    const grouped = [
      exact,
      {
        tier: "A",
        match_count: 2,
        avg_damage: 300,
        avg_damage_count: 2,
        filter_version: 8,
        population_evidence_version: POPULATION_EVIDENCE_VERSION,
      },
    ];
    const query: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: exact, error: null }),
      limit: vi.fn().mockResolvedValue({ data: grouped, error: null }),
    };
    const supabase = { from: vi.fn().mockReturnValue(query) };

    await expect(fetchTierBenchmarkStats(supabase, {
      gameMode: "squad",
      matchType: "official",
      tier: "A+",
    })).resolves.toMatchObject({
      tier: "A",
      match_count: 5,
      avg_damage: 660,
    });
    expect(query.in).toHaveBeenCalledWith("tier", ["A+", "A", "A-"]);
  });

  it("fine-tier와 base-tier aggregate 모두 5 미만이면 observed benchmark를 생략한다", async () => {
    const exact = { tier: "A+", match_count: 3, avg_damage: 900, avg_damage_count: 3 };
    const query: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: exact, error: null }),
      limit: vi.fn().mockResolvedValue({
        data: [exact, { tier: "A", match_count: 1, avg_damage: 300, avg_damage_count: 1 }],
        error: null,
      }),
    };
    const supabase = { from: vi.fn().mockReturnValue(query) };

    await expect(fetchTierBenchmarkStats(supabase, {
      gameMode: "squad",
      matchType: "official",
      tier: "A+",
    })).resolves.toBeNull();
  });

  it("observed adapter는 null metric을 생략하고 historical adapter default와 구분한다", () => {
    const raw = {
      match_count: 5,
      avg_damage: null,
      avg_duel_win_rate: null,
      avg_initiative_rate: 0,
      avg_initiative_rate_count: 5,
      avg_counter_latency_ms: 0,
      avg_counter_latency_ms_count: 5,
      avg_trade_latency_ms: null,
    };

    expect(adaptObservedBenchmark(raw)).toMatchObject({
      sampleCount: 5,
      avgInitiativeRate: 0,
      avgCounterLatency: 0,
    });
    expect(adaptObservedBenchmark(raw)).not.toHaveProperty("avgDamage");
    expect(adaptObservedBenchmark(raw)).not.toHaveProperty("avgDuelWinRate");
    expect(adaptObservedBenchmark(raw)).not.toHaveProperty("avgTradeLatency");
    expect(adaptBenchmark(raw)).toMatchObject({
      avgDamage: 250,
      avgDuelWinRate: 50,
      avgTradeLatency: 12,
    });
  });

  it("observed adapter는 음수·비유한 metric을 생략하고 명시적 0은 관측값으로 보존한다", () => {
    const raw = {
      match_count: 5,
      avg_damage: -1,
      avg_damage_count: 5,
      avg_initiative_rate: 0,
      avg_initiative_rate_count: 5,
      avg_duel_win_rate: "malformed",
      avg_duel_win_rate_count: 5,
      avg_pressure_index: Number.POSITIVE_INFINITY,
      avg_pressure_index_count: 5,
    };

    const observed = adaptObservedBenchmark(raw);
    expect(observed).toMatchObject({ sampleCount: 5, avgInitiativeRate: 0 });
    expect(observed).not.toHaveProperty("avgDamage");
    expect(observed).not.toHaveProperty("avgDuelWinRate");
    expect(observed).not.toHaveProperty("avgPressureIndex");
  });

  it("observed adapter는 전체 match_count를 metric 표본 수로 대체하지 않는다", () => {
    expect(adaptObservedBenchmark({ match_count: 10, avg_damage: 300 })).not.toHaveProperty("avgDamage");
    expect(adaptObservedBenchmark({ match_count: 10, avg_damage: 300, avg_damage_count: 4 })).not.toHaveProperty("avgDamage");
    expect(adaptObservedBenchmark({ match_count: 10, avg_damage: 300, avg_damage_count: 5 })).toMatchObject({
      sampleCount: 10,
      avgDamage: 300,
      metricSampleCounts: { avgDamage: 5 },
    });
  });

  it.each([
    ["fractional", 2.5],
    ["greater than total", 11],
    ["negative", -1],
  ])("observed adapter는 %s metric count를 근거로 노출하지 않는다", (_label, count) => {
    const observed = adaptObservedBenchmark({
      match_count: 10,
      avg_damage: 300,
      avg_damage_count: count,
    });

    expect(observed).not.toHaveProperty("avgDamage");
    expect(observed).not.toHaveProperty("metricSampleCounts.avgDamage");
  });

  it("명시적 metric count가 없는 grouped arithmetic은 adapter에서 관측값으로 노출되지 않는다", () => {
    const aggregated = aggregateTierBenchmarkRows([
      { tier: "A+", match_count: 5, avg_damage: 300 },
      { tier: "A", match_count: 5, avg_damage: 500 },
    ], "A+");

    expect(aggregated).toMatchObject({ avg_damage: 400, match_count: 10 });
    expect(aggregated).not.toHaveProperty("avg_damage_count");
    expect(adaptObservedBenchmark(aggregated)).not.toHaveProperty("avgDamage");
  });

  it("observed rate는 100 초과 값을 clamp하지 않고 생략한다", () => {
    const observed = adaptObservedBenchmark({
      match_count: 5,
      avg_trade_rate: 101,
      avg_trade_rate_count: 5,
    });

    expect(observed).not.toHaveProperty("avgTradeRate");
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
