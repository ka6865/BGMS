import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateServerClient,
  mockReadPubgCache,
  mockWritePubgCache,
  mockFetch,
} = vi.hoisted(() => ({
  mockCreateServerClient: vi.fn(),
  mockReadPubgCache: vi.fn(),
  mockWritePubgCache: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: mockCreateServerClient,
}));

vi.mock("@/lib/pubg/responseCache", () => ({
  buildPlayerCacheKey: (platform: string, nickname: string, season: string | null) =>
    `player:${platform}:${nickname.toLowerCase()}:${season || "current"}`,
  buildPlayerRefreshLockKey: (platform: string, nickname: string) =>
    `refresh:${platform.trim().toLowerCase()}:${nickname.trim().toLowerCase()}`,
  claimForceRefresh: vi.fn(),
  readPubgCache: mockReadPubgCache,
  writePubgCache: mockWritePubgCache,
}));

vi.mock("@/lib/pubg-analysis/pubgApiTracker", () => ({
  trackPubgRateLimit: vi.fn(),
}));

vi.mock("@/lib/pubg/apiHelper", () => ({
  reportPubgApiError: vi.fn(),
}));

describe("player route non-force cache boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPubgCache.mockResolvedValue(null);
    mockWritePubgCache.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", mockFetch);
  });

  it("does not call PUBG when mastery is stale and an explicit season is absent", async () => {
    const cacheRow = {
      nickname: "Fixture_Player",
      lower_nickname: "fixture_player",
      platform: "steam",
      seasons_list: [{ id: "pc-2026-02", name: "Season 2", attributes: { isCurrentSeason: true } }],
      last_season_id: "pc-2026-02",
      season_stats_data: {
        "pc-2026-02": { ranked: { roundsPlayed: 4 }, normal: null },
      },
      recent_match_ids: [],
      match_master_telemetry: [],
      clan_data: null,
      survival_mastery_data: { level: 7, xp: 12 },
      survival_mastery_updated_at: "2020-01-01T00:00:00.000Z",
      weapon_mastery_data: [],
      ban_type: "None",
      updated_at: "2026-08-18T00:00:00.000Z",
    };
    const playerQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: cacheRow, error: null }),
    };
    const telemetryQuery = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mockCreateServerClient.mockResolvedValue({
      from: vi.fn((table: string) => table === "pubg_player_cache" ? playerQuery : telemetryQuery),
    });
    mockFetch.mockImplementation(() => {
      throw new Error("PUBG must not be called for a cached non-force player");
    });

    const route = await import("../app/api/pubg/player/route");
    const response = await route.GET(new Request(
      "http://localhost/api/pubg/player?nickname=Fixture_Player&platform=steam&season=pc-2026-missing",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      nickname: "Fixture_Player",
      seasonId: "pc-2026-missing",
      stats: { ranked: null, normal: null },
      survivalMastery: { level: 7, xp: 12 },
    }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWritePubgCache).toHaveBeenCalledTimes(1);
  });
});
