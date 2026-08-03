import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistMatchAnalysis,
  type PersistMatchAnalysisInput,
} from "../lib/pubg-analysis/persistMatchAnalysis";

type UpsertResult = { error: { message: string } | null };
type UpsertMock = ReturnType<
  typeof vi.fn<(values: unknown, options?: unknown) => Promise<UpsertResult>>
>;

const upserts = new Map<string, UpsertMock>();
const supabase = {
  from: vi.fn((table: string) => ({
    upsert: upserts.get(table),
  })),
} as unknown as SupabaseClient;

const input = {
  matchId: "match-1",
  playerNickname: "PlayerOne",
  platform: "steam",
  source: "user",
  forceBenchmark: false,
  matchAttr: { gameMode: "squad-fpp", mapName: "Baltic_Main" },
  rawParticipants: [
    {
      id: "participant-1",
      attributes: {
        stats: {
          playerId: "account-1",
          name: "PlayerOne",
          damageDealt: 100.9,
          kills: 1,
          winPlace: 10,
        },
      },
    },
  ],
  finalResult: {
    matchType: "official",
    gameMode: "squad-fpp",
    mapName: "Baltic_Main",
    isValidBenchmark: true,
    stats: { damageDealt: 100.9, kills: 1.4, winPlace: 10.4, timeSurvived: 900.4 },
    tradeStats: {
      teammateKnocks: 4,
      counterLatencyMs: 1234.6,
      revCount: 2,
      smokeRescues: 1,
      tradeKills: 3,
      tradeLatencyMs: 2345.6,
      suppCount: 2.4,
      enemyTeamWipes: 1.4,
    },
    killContribution: { solo: 2, assist: 1, cleanup: 1 },
    initiative_rate: 67.6,
    isolationData: { isCrossfire: true, isolationIndex: 2.4, minDist: 35.5, heightDiff: 4.6 },
    combatPressure: { pressureIndex: 7.4, utilityStats: { throwCount: 5.5 } },
    itemUseSummary: { smokes: 3.4, frags: 2.6 },
    deathDistance: 88.6,
    duelStats: { reversalRate: 45.5, duelWinRate: 55.5 },
    itemUseStats: { lethalThrowCount: 2.4 },
    benchmark: { tier: "B", score: 44.5, breakdown: { combat: 20.5, tactical: 14.5, survival: 9.5 } },
    deathPhase: 4.4,
  },
} satisfies PersistMatchAnalysisInput;

function setSuccessfulUpsert(table: string): UpsertMock {
  const upsert = vi.fn<(values: unknown, options?: unknown) => Promise<UpsertResult>>()
    .mockResolvedValue({ error: null });
  upserts.set(table, upsert);
  return upsert;
}

function createParticipants(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `participant-${index}`,
    attributes: {
      stats: {
        playerId: `account-${index}`,
        name: `Player${index}`,
        damageDealt: index,
        kills: 0,
        winPlace: index + 1,
      },
    },
  }));
}

describe("persistMatchAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upserts.clear();
    for (const table of [
      "match_stats_raw",
      "pubg_player_cache",
      "pubg_player_matches",
      "global_benchmarks",
      "processed_match_telemetry",
    ]) {
      setSuccessfulUpsert(table);
    }
  });

  it("raw stats와 player cache를 현재 conflict key와 변환 규칙으로 저장한다", async () => {
    const result = await persistMatchAnalysis(supabase, input);

    expect(upserts.get("match_stats_raw")).toHaveBeenCalledWith(
      [{
        match_id: "match-1",
        platform: "steam",
        player_id: "playerone",
        damage: 100,
        kills: 1,
        win_place: 10,
        game_mode: "squad-fpp",
        map_name: "Baltic_Main",
        is_analysis_sample: true,
      }],
      { onConflict: "match_id,platform,player_id" },
    );
    expect(upserts.get("pubg_player_cache")).toHaveBeenCalledWith(
      [expect.objectContaining({
        id: "account-1",
        platform: "steam",
        nickname: "PlayerOne",
        lower_nickname: "playerone",
      })],
      { onConflict: "id" },
    );
    expect(result.failures).toEqual([]);
  });

  it("분석 대상자와 인간 승자만 raw stats에 저장하고 표본 역할을 구분한다", async () => {
    await persistMatchAnalysis(supabase, {
      ...input,
      rawParticipants: [
        {
          id: "target",
          attributes: {
            stats: {
              playerId: "account-target",
              name: "PlayerOne",
              damageDealt: 120.8,
              kills: 2,
              winPlace: 8,
            },
          },
        },
        {
          id: "winner",
          attributes: {
            stats: {
              playerId: "account-winner",
              name: "HumanWinner",
              damageDealt: 500.9,
              kills: 6,
              winPlace: 1,
            },
          },
        },
        {
          id: "bystander",
          attributes: {
            stats: {
              playerId: "account-bystander",
              name: "Bystander",
              damageDealt: 50,
              kills: 0,
              winPlace: 20,
            },
          },
        },
        {
          id: "ai-winner",
          attributes: {
            stats: {
              playerId: "ai.123",
              name: "BotWinner",
              damageDealt: 700,
              kills: 8,
              winPlace: 1,
            },
          },
        },
      ],
    });

    expect(upserts.get("match_stats_raw")).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          player_id: "playerone",
          is_analysis_sample: true,
        }),
        expect.objectContaining({
          player_id: "humanwinner",
          is_analysis_sample: false,
        }),
      ],
      { onConflict: "match_id,platform,player_id" },
    );
  });

  it("benchmark의 전체 column mapping과 점수 의미를 현재 route와 동일하게 유지한다", async () => {
    await persistMatchAnalysis(supabase, input);

    expect(upserts.get("global_benchmarks")).toHaveBeenCalledWith({
      match_id: "match-1",
      platform: "steam",
      player_id: "playerone",
      damage: 100,
      kills: 1,
      win_place: 10,
      game_mode: "squad-fpp",
      map_name: "Baltic_Main",
      counter_latency_ms: 1235,
      initiative_rate: 68,
      revive_rate: 50,
      is_crossfire: true,
      utility_count: 6,
      smoke_count: 3,
      frag_count: 3,
      pressure_index: 7,
      enemy_death_distance: 89,
      survival_time: 900,
      isolation_index: 2,
      min_dist: 36,
      height_diff: 5,
      smoke_rate: 25,
      trade_rate: 75,
      solo_kill_rate: 50,
      reversal_rate: 46,
      duel_win_rate: 56,
      trade_latency_ms: 2346,
      lethal_throw_count: 2,
      tier: "B",
      score: 44.5,
      combat_score: 20.5,
      tactical_score: 14.5,
      survival_score: 9.5,
      supp_count: 2,
      team_wipes: 1,
      match_type: "official",
      death_phase: 4,
      filter_version: 8,
      source: "user",
    }, { onConflict: "match_id,platform,player_id" });
    expect(upserts.get("processed_match_telemetry")).not.toHaveBeenCalled();
  });

  it.each([
    ["custom", "squad-fpp"],
    ["official", "tdm"],
    ["competitive", "trainingroom"],
  ])("비표준 BR matchType=%s gameMode=%s는 benchmark를 저장하지 않는다", async (matchType, gameMode) => {
    await persistMatchAnalysis(supabase, {
      ...input,
      finalResult: { ...input.finalResult, matchType, gameMode },
    });

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
  });

  it("유효하지 않은 benchmark는 강제 옵션이 없으면 저장하지 않는다", async () => {
    await persistMatchAnalysis(supabase, {
      ...input,
      finalResult: { ...input.finalResult, isValidBenchmark: false },
    });

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
  });

  it("AI 참가자를 player cache에서 제외한다", async () => {
    await persistMatchAnalysis(supabase, {
      ...input,
      rawParticipants: [{
        id: "ai-participant",
        attributes: {
          stats: { playerId: "ai.123", name: "Bot", damageDealt: 0, kills: 0, winPlace: 50 },
        },
      }],
    });

    expect(upserts.get("pubg_player_cache")).not.toHaveBeenCalled();
  });

  it("player cache에는 실제 분석 대상자 한 명만 한 번 저장한다", async () => {
    await persistMatchAnalysis(supabase, {
      ...input,
      rawParticipants: [
        input.rawParticipants[0],
        ...createParticipants(50),
      ],
    });

    expect(upserts.get("pubg_player_cache")).toHaveBeenCalledTimes(1);
    expect(upserts.get("pubg_player_cache")).toHaveBeenCalledWith(
      [expect.objectContaining({
        id: "account-1",
        nickname: "PlayerOne",
        lower_nickname: "playerone",
      })],
      { onConflict: "id" },
    );
  });

  it("benchmark 선택 값이 없으면 현재 route와 같은 안전 기본값을 저장한다", async () => {
    await persistMatchAnalysis(supabase, {
      ...input,
      finalResult: {
        matchType: "official",
        gameMode: "squad-fpp",
        isValidBenchmark: true,
        stats: {},
      },
    });

    expect(upserts.get("global_benchmarks")).toHaveBeenCalledWith(expect.objectContaining({
      damage: 0,
      kills: 0,
      win_place: 100,
      counter_latency_ms: 0,
      initiative_rate: 0,
      revive_rate: 0,
      is_crossfire: false,
      utility_count: 0,
      smoke_count: 0,
      frag_count: 0,
      pressure_index: 0,
      enemy_death_distance: 0,
      survival_time: 0,
      isolation_index: 0,
      min_dist: 0,
      height_diff: 0,
      smoke_rate: 0,
      trade_rate: 0,
      solo_kill_rate: 0,
      reversal_rate: 0,
      duel_win_rate: 0,
      trade_latency_ms: 0,
      lethal_throw_count: 0,
      tier: "C",
      score: 0,
      combat_score: 0,
      tactical_score: 0,
      survival_score: 0,
      supp_count: 0,
      team_wipes: 0,
      death_phase: 0,
      filter_version: 8,
    }), { onConflict: "match_id,platform,player_id" });
  });

  it("trusted internal forceBenchmark는 유효하지 않은 표준 BR benchmark를 허용한다", async () => {
    await persistMatchAnalysis(supabase, {
      ...input,
      forceBenchmark: true,
      finalResult: { ...input.finalResult, isValidBenchmark: false },
    });

    expect(upserts.get("global_benchmarks")).toHaveBeenCalledTimes(1);
  });

  it("trusted internal forceBenchmark도 비표준 모드 benchmark는 허용하지 않는다", async () => {
    await persistMatchAnalysis(supabase, {
      ...input,
      forceBenchmark: true,
      finalResult: {
        ...input.finalResult,
        gameMode: "tdm",
        isValidBenchmark: false,
      },
    });

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
  });

  it.each([
    "match_stats_raw",
    "pubg_player_cache",
    "pubg_player_matches",
    "global_benchmarks",
  ] as const)("%s 저장 오류를 taskName/message로 반환하고 다른 저장은 계속한다", async (failedTable) => {
    upserts.get(failedTable)?.mockResolvedValueOnce({ error: { message: `${failedTable} failed` } });

    const result = await persistMatchAnalysis(supabase, input);

    expect(result.failures).toContainEqual({ taskName: failedTable, message: `${failedTable} failed` });
    for (const table of ["match_stats_raw", "pubg_player_cache", "pubg_player_matches", "global_benchmarks"] as const) {
      if (table !== failedTable) expect(upserts.get(table)).toHaveBeenCalled();
    }
  });

  it("저장 promise reject를 실패로 반환하고 독립 benchmark 저장은 계속한다", async () => {
    upserts.get("match_stats_raw")?.mockRejectedValueOnce(new Error("raw rejected"));

    const result = await persistMatchAnalysis(supabase, input);

    expect(result.failures).toContainEqual({ taskName: "match_stats_raw", message: "raw rejected" });
    expect(upserts.get("global_benchmarks")).toHaveBeenCalled();
  });
});
