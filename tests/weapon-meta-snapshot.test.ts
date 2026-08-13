import { afterEach, describe, it, expect, vi } from "vitest";
import { buildWeaponMetaMatchSamples, persistMatchAnalysis } from "../lib/pubg-analysis/persistMatchAnalysis";

describe("persistMatchAnalysis weapon meta upsert", () => {
  it("upserts one idempotent match-level sample per weapon", async () => {
    const rpcMock = vi.fn().mockResolvedValue({ error: null });
    const fromMock = vi.fn().mockReturnValue({ upsert: vi.fn().mockResolvedValue({ error: null }) });
    const supabase = { rpc: rpcMock, from: fromMock } as any;
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");

    const result = await persistMatchAnalysis(supabase, {
      matchId: "match-test-123",
      playerNickname: "testuser",
      platform: "steam",
      finalResult: {
        matchType: "official",
        gameMode: "squad",
        stats: { kills: 2, dbnos: 1, damage: 300 },
        weaponStats: { M249: { kills: 2, dbnos: 1, damage: 300 } },
      } as any,
      matchAttr: { createdAt: "2026-08-12T10:00:00.000Z", mapName: "Erangel", gameMode: "squad" },
      rawParticipants: [],
      source: "user",
      forceBenchmark: false,
    });

    expect(result.failures).toHaveLength(0);
    expect(fromMock).toHaveBeenCalledWith("weapon_meta_match_samples");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the match timestamp to separate the 14-day baseline from the new patch", () => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const base = {
      matchId: "match-boundary",
      playerNickname: "testuser",
      platform: "steam" as const,
      finalResult: {
        matchType: "official", gameMode: "squad", isValidBenchmark: true,
        stats: {}, weaponStats: { M249: { damage: 100 } },
      },
      rawParticipants: [], source: "user" as const, forceBenchmark: false,
    };

    expect(buildWeaponMetaMatchSamples({ ...base, matchAttr: { createdAt: "2026-08-11T23:59:59.000Z" } } as any)[0].patch_version).toBe("pre_42.3");
    expect(buildWeaponMetaMatchSamples({ ...base, matchAttr: { createdAt: "2026-08-12T00:00:00.000Z" } } as any)[0].patch_version).toBe("42.3");
  });

  it("excludes vehicles and throwables from weapon-meta samples", () => {
    vi.stubEnv("PUBG_META_PATCH_VERSION", "42.3");
    vi.stubEnv("PUBG_META_PATCH_STARTED_AT", "2026-08-12T00:00:00.000Z");
    const rows = buildWeaponMetaMatchSamples({
      matchId: "match-filter", playerNickname: "testuser", platform: "steam",
      matchAttr: { createdAt: "2026-08-12T01:00:00.000Z" }, rawParticipants: [], source: "user", forceBenchmark: false,
      finalResult: {
        matchType: "official", gameMode: "squad", isValidBenchmark: true, stats: {},
        weaponStats: { M249: { damage: 100 }, ProjGrenade: { damage: 100 }, Uaz_01: { damage: 100 } },
      },
    } as any);

    expect(rows.map((row) => row.weapon_name)).toEqual(["M249"]);
    expect(rows[0].match_type).toBe("official");
  });
});
