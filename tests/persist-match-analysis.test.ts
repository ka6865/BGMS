import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWeaponMetaMatchSamples,
  buildBenchmarkRow,
  persistMatchAnalysis,
  type RecoveryBenchmarkGuard,
  type PersistMatchAnalysisInput,
} from "../lib/pubg-analysis/persistMatchAnalysis";
import { POPULATION_EVIDENCE_VERSION } from "../lib/pubg-analysis/constants";

type UpsertResult = { error: { message: string } | null };
type UpsertMock = ReturnType<
  typeof vi.fn<(values: unknown, options?: unknown) => Promise<UpsertResult>>
>;
type UpdateResult = { data: unknown[] | null; error: { message: string } | null };
type UpdateMock = ReturnType<typeof vi.fn<(values: unknown) => {
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn<() => Promise<UpdateResult>>>;
}> >;

const upserts = new Map<string, UpsertMock>();
const updates = new Map<string, UpdateMock>();
const updateQueries = new Map<string, {
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn<() => Promise<UpdateResult>>>;
}>();
const supabase = {
  from: vi.fn((table: string) => ({
    upsert: upserts.get(table),
    update: updates.get(table),
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

function setSuccessfulUpdate(table: string): UpdateMock {
  const query = {
    eq: vi.fn(),
    is: vi.fn(),
    select: vi.fn<() => Promise<UpdateResult>>().mockResolvedValue({ data: [{ id: 1 }], error: null }),
  };
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  const update = vi.fn<(values: unknown) => typeof query>().mockReturnValue(query);
  updates.set(table, update);
  updateQueries.set(table, query);
  return update;
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
    updates.clear();
    updateQueries.clear();
    for (const table of [
      "match_stats_raw",
      "pubg_player_cache",
      "pubg_player_matches",
      "global_benchmarks",
      "processed_match_telemetry",
      "weapon_meta_match_samples",
    ]) {
      setSuccessfulUpsert(table);
    }
    setSuccessfulUpdate("global_benchmarks");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
      source: "user",
    }, { onConflict: "match_id,platform,player_id" });
    expect(upserts.get("processed_match_telemetry")).not.toHaveBeenCalled();
  });

  it("pure benchmark-row builder는 ordinary upsert와 recovery payload에 같은 row를 제공한다", async () => {
    const built = buildBenchmarkRow(input);

    expect(built).toEqual(expect.objectContaining({
      match_id: "match-1",
      player_id: "playerone",
      platform: "steam",
      game_mode: "squad-fpp",
      match_type: "official",
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
    }));

    await persistMatchAnalysis(supabase, input);
    expect(upserts.get("global_benchmarks")).toHaveBeenCalledWith(
      built,
      { onConflict: "match_id,platform,player_id" },
    );
  });

  it("recovery benchmark uses an atomic legacy-marker guard instead of an unconditional upsert", async () => {
    const recoveryBenchmarkGuard: RecoveryBenchmarkGuard = {
      id: 17,
      matchId: "match-1",
      playerId: "playerone",
      platform: "steam",
      gameMode: "squad-fpp",
      matchType: "official",
      tier: "B",
      filterVersion: null,
      populationEvidenceVersion: null,
    };
    const update = updates.get("global_benchmarks");

    const result = await persistMatchAnalysis(supabase, {
      ...input,
      recoveryBenchmarkGuard,
    });

    expect(result.failures).toEqual([]);
    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      match_id: "match-1",
      platform: "steam",
      player_id: "playerone",
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
    }));
    const query = update?.mock.results[0]?.value as {
      eq: ReturnType<typeof vi.fn>;
      is: ReturnType<typeof vi.fn>;
    };
    expect(query.eq).toHaveBeenCalledWith("id", 17);
    expect(query.eq).toHaveBeenCalledWith("match_id", "match-1");
    expect(query.eq).toHaveBeenCalledWith("platform", "steam");
    expect(query.eq).toHaveBeenCalledWith("player_id", "playerone");
    expect(query.eq).toHaveBeenCalledWith("game_mode", "squad-fpp");
    expect(query.eq).toHaveBeenCalledWith("match_type", "official");
    expect(query.eq).toHaveBeenCalledWith("tier", "B");
    expect(query.is).toHaveBeenCalledWith("filter_version", null);
    expect(query.is).toHaveBeenCalledWith("population_evidence_version", null);
  });

  it("recovery benchmark reports a marker race when the conditional update affects no row", async () => {
    const query = updateQueries.get("global_benchmarks");
    // Replace the default affected-row proof with an empty result, modeling a
    // concurrent worker advancing this identity to the current marker.
    query?.select.mockResolvedValue({ data: [], error: null });
    const recoveryBenchmarkGuard: RecoveryBenchmarkGuard = {
      id: 17,
      matchId: "match-1",
      playerId: "playerone",
      platform: "steam",
      gameMode: "squad-fpp",
      matchType: "official",
      tier: "B",
      filterVersion: null,
      populationEvidenceVersion: null,
    };

    const result = await persistMatchAnalysis(supabase, {
      ...input,
      recoveryBenchmarkGuard,
    });

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
    expect(result.failures).toContainEqual(expect.objectContaining({
      taskName: "global_benchmarks",
      message: expect.stringContaining("recovery benchmark marker changed"),
    }));
  });

  it("recovery benchmark permits a legacy A+ row to be CAS-updated with the recomputed A tier", async () => {
    const recoveryBenchmarkGuard: RecoveryBenchmarkGuard = {
      id: 17,
      matchId: "match-1",
      playerId: "playerone",
      platform: "steam",
      gameMode: "squad-fpp",
      matchType: "official",
      tier: "A+",
      filterVersion: null,
      populationEvidenceVersion: null,
    };
    const update = updates.get("global_benchmarks");

    const result = await persistMatchAnalysis(supabase, {
      ...input,
      finalResult: {
        ...input.finalResult,
        benchmark: { ...input.finalResult.benchmark, tier: "A" },
      },
      recoveryBenchmarkGuard,
    });

    expect(result.failures).toEqual([]);
    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ tier: "A" }));
    const query = update?.mock.results[0]?.value as {
      eq: ReturnType<typeof vi.fn>;
    };
    expect(query.eq).toHaveBeenCalledWith("tier", "A+");
  });

  it.each([
    ["score", -5, 0],
    ["score", 101, 100],
    ["combat_score", -5, 0],
    ["combat_score", 101, 100],
    ["tactical_score", -5, 0],
    ["tactical_score", 101, 100],
    ["survival_score", -5, 0],
    ["survival_score", 101, 100],
    ["score", Number.NaN, 0],
    ["score", Number.POSITIVE_INFINITY, 0],
  ] as const)("persisted %s clamps malformed score %s to %s at the DB boundary", async (field, value, expected) => {
    const benchmark = {
      ...input.finalResult.benchmark,
      score: field === "score" ? value : input.finalResult.benchmark?.score,
      breakdown: {
        ...input.finalResult.benchmark?.breakdown,
        combat: field === "combat_score" ? value : input.finalResult.benchmark?.breakdown?.combat,
        tactical: field === "tactical_score" ? value : input.finalResult.benchmark?.breakdown?.tactical,
        survival: field === "survival_score" ? value : input.finalResult.benchmark?.breakdown?.survival,
      },
    };

    await persistMatchAnalysis(supabase, {
      ...input,
      finalResult: { ...input.finalResult, benchmark },
    });

    const row = upserts.get("global_benchmarks")?.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(row[field]).toBe(expected);
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

  it.each([
    ["official", "squad-ai"],
    ["official", "ai_match"],
    ["official", "solo-bot"],
  ])("AI/bot metadata matchType=%s gameMode=%s는 forceBenchmark에도 global benchmark를 오염시키지 않는다", async (matchType, gameMode) => {
    await persistMatchAnalysis(supabase, {
      ...input,
      forceBenchmark: true,
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
      isolation_index: -1,
      min_dist: -1,
      height_diff: -1,
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
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
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

  it("known BR + canonical matchType만 global·weapon 모집단에 함께 들어간다", async () => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const eligibleInput = {
      ...input,
      finalResult: {
        ...input.finalResult,
        createdAt: "2026-08-12T01:00:00.000Z",
        weaponStats: { M249: { damage: 100, kills: 1 } },
      },
    };

    expect(buildWeaponMetaMatchSamples(eligibleInput)).toHaveLength(1);
    await persistMatchAnalysis(supabase, eligibleInput);

    expect(upserts.get("global_benchmarks")).toHaveBeenCalledTimes(1);
    expect(upserts.get("weapon_meta_match_samples")).toHaveBeenCalledTimes(1);
    expect(upserts.get("weapon_meta_match_samples")).toHaveBeenCalledWith(
      [expect.objectContaining({ match_type: "official", weapon_name: expect.any(String) })],
      { onConflict: "match_id,platform,player_id,weapon_name" },
    );
  });

  it("secondary ranked evidence는 benchmark match_type을 competitive로 정규화한다", async () => {
    await persistMatchAnalysis(supabase, {
      ...input,
      finalResult: {
        ...input.finalResult,
        matchType: "official",
        matchInfo: { mode: "ranked" },
      },
    });

    expect(upserts.get("global_benchmarks")).toHaveBeenCalledWith(
      expect.objectContaining({ match_type: "competitive", game_mode: "squad-fpp" }),
      { onConflict: "match_id,platform,player_id" },
    );
  });

  it.each([
    ["custom flag", {
      finalResult: { attributes: { isCustomMatch: true } },
      matchAttr: {},
    }],
    ["event flag", {
      finalResult: { telemetryFlags: { isEventMode: true } },
      matchAttr: {},
    }],
    ["TDM map", {
      finalResult: { mapName: " Italy_TDM_Main " },
      matchAttr: { mapName: " Italy_TDM_Main " },
    }],
    ["unknown mode", {
      finalResult: { gameMode: undefined },
      matchAttr: { gameMode: undefined },
    }],
    ["custom mode family", {
      finalResult: { gameMode: "normal-squad-fpp" },
      matchAttr: {},
    }],
    ["unknown matchType", {
      finalResult: { matchType: "unknown" },
      matchAttr: {},
    }],
  ] as const)("%s는 global·weapon 모집단에는 들어가지 않지만 raw/history는 보존한다", async (_label, override) => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const ineligibleInput = {
      ...input,
      matchAttr: { ...input.matchAttr, ...override.matchAttr },
      finalResult: {
        ...input.finalResult,
        createdAt: "2026-08-12T01:00:00.000Z",
        weaponStats: { M249: { damage: 100, kills: 1 } },
        ...override.finalResult,
      },
    } as PersistMatchAnalysisInput;

    expect(buildWeaponMetaMatchSamples(ineligibleInput)).toEqual([]);
    await persistMatchAnalysis(supabase, ineligibleInput);

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
    expect(upserts.get("weapon_meta_match_samples")).not.toHaveBeenCalled();
    expect(upserts.get("match_stats_raw")).toHaveBeenCalled();
    expect(upserts.get("pubg_player_matches")).toHaveBeenCalled();
  });

  it.each([
    ["canonical true, legacy false", true, false],
    ["canonical false, legacy true", false, true],
  ] as const)("boolean exclusion evidence is monotonic (%s) for global and weapon populations", async (_label, finalFlag, inputFlag) => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const conflictingInput = {
      ...input,
      matchAttr: {
        ...input.matchAttr,
        isCustomMatch: inputFlag,
      },
      finalResult: {
        ...input.finalResult,
        createdAt: "2026-08-12T01:00:00.000Z",
        attributes: { isCustomMatch: finalFlag },
        weaponStats: { M249: { damage: 100, kills: 1 } },
      },
    } as PersistMatchAnalysisInput;

    expect(buildWeaponMetaMatchSamples(conflictingInput)).toEqual([]);
    await persistMatchAnalysis(supabase, conflictingInput);

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
    expect(upserts.get("weapon_meta_match_samples")).not.toHaveBeenCalled();
    expect(upserts.get("match_stats_raw")).toHaveBeenCalled();
    expect(upserts.get("pubg_player_matches")).toHaveBeenCalled();
  });

  it.each([
    ["nested custom flag in input", {
      matchInfo: { mode: "squad-fpp", attributes: { isCustomMatch: true } },
    }, {
      matchInfo: { mode: "squad-fpp", attributes: { isCustomMatch: false } },
    }],
    ["nested event flag in final result", {
      matchInfo: { mode: "squad-fpp", telemetryFlags: { isEventMode: false } },
    }, {
      matchInfo: { mode: "squad-fpp", telemetryFlags: { isEventMode: true } },
    }],
  ] as const)("nested exclusion evidence remains monotonic (%s)", async (_label, inputEvidence, finalEvidence) => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const conflictingInput = {
      ...input,
      matchAttr: {
        ...input.matchAttr,
        ...inputEvidence,
      },
      finalResult: {
        ...input.finalResult,
        createdAt: "2026-08-12T01:00:00.000Z",
        attributes: finalEvidence,
        weaponStats: { M249: { damage: 100, kills: 1 } },
      },
    } as PersistMatchAnalysisInput;

    expect(buildWeaponMetaMatchSamples(conflictingInput)).toEqual([]);
    await persistMatchAnalysis(supabase, conflictingInput);

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
    expect(upserts.get("weapon_meta_match_samples")).not.toHaveBeenCalled();
    expect(upserts.get("match_stats_raw")).toHaveBeenCalled();
    expect(upserts.get("pubg_player_matches")).toHaveBeenCalled();
  });

  it("conflicting nested mode evidence is retained instead of being overwritten by a canonical-looking alias", async () => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const conflictingInput = {
      ...input,
      matchAttr: {
        ...input.matchAttr,
        matchInfo: { mode: "tdm" },
      },
      finalResult: {
        ...input.finalResult,
        createdAt: "2026-08-12T01:00:00.000Z",
        attributes: { matchInfo: { mode: "squad-fpp" } },
        weaponStats: { M249: { damage: 100, kills: 1 } },
      },
    } as PersistMatchAnalysisInput;

    expect(buildWeaponMetaMatchSamples(conflictingInput)).toEqual([]);
    await persistMatchAnalysis(supabase, conflictingInput);

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
    expect(upserts.get("weapon_meta_match_samples")).not.toHaveBeenCalled();
    expect(upserts.get("match_stats_raw")).toHaveBeenCalled();
    expect(upserts.get("pubg_player_matches")).toHaveBeenCalled();
  });

  it("mixed telemetry object and array evidence both reach the benchmark gate", async () => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const conflictingInput = {
      ...input,
      finalResult: {
        ...input.finalResult,
        createdAt: "2026-08-12T01:00:00.000Z",
        telemetry: { LogMatchStart: { isCustomGame: true } },
        telemetryEvents: [{ _T: "LogMatchEnd" }],
        weaponStats: { M249: { damage: 100, kills: 1 } },
      },
    } as PersistMatchAnalysisInput;

    expect(buildWeaponMetaMatchSamples(conflictingInput)).toEqual([]);
    await persistMatchAnalysis(supabase, conflictingInput);

    expect(upserts.get("global_benchmarks")).not.toHaveBeenCalled();
    expect(upserts.get("weapon_meta_match_samples")).not.toHaveBeenCalled();
    expect(upserts.get("match_stats_raw")).toHaveBeenCalled();
    expect(upserts.get("pubg_player_matches")).toHaveBeenCalled();
  });

  it("new benchmark and weapon rows carry explicit population provenance and preserve missing-vs-zero isolation", async () => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const missingInput = {
      ...input,
      finalResult: {
        ...input.finalResult,
        createdAt: "2026-08-12T01:00:00.000Z",
        isolationData: { isCrossfire: false },
        weaponStats: { M249: { damage: 100, kills: 1 } },
      },
    } as PersistMatchAnalysisInput;

    await persistMatchAnalysis(supabase, missingInput);

    const benchmarkRow = upserts.get("global_benchmarks")?.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(benchmarkRow).toMatchObject({
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
      isolation_index: -1,
      min_dist: -1,
      height_diff: -1,
    });
    const weaponRows = upserts.get("weapon_meta_match_samples")?.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    expect(weaponRows[0]).toMatchObject({
      filter_version: 8,
      population_evidence_version: POPULATION_EVIDENCE_VERSION,
    });

    await persistMatchAnalysis(supabase, {
      ...missingInput,
      finalResult: {
        ...missingInput.finalResult,
        isolationData: { isCrossfire: false, isolationIndex: 0, minDist: 0, heightDiff: 0 },
      },
    });
    const measuredZeroRow = upserts.get("global_benchmarks")?.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(measuredZeroRow).toMatchObject({ isolation_index: 0, min_dist: 0, height_diff: 0 });
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
