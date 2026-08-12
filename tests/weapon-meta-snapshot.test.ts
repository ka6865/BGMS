import { describe, it, expect, vi } from "vitest";
import { persistMatchAnalysis } from "../lib/pubg-analysis/persistMatchAnalysis";

describe("persistMatchAnalysis weapon meta upsert", () => {
  it("upserts weapon_meta_snapshots correctly without throwing", async () => {
    const rpcMock = vi.fn().mockResolvedValue({ error: null });
    const fromMock = vi.fn().mockReturnValue({ upsert: vi.fn().mockResolvedValue({ error: null }) });
    const supabase = { rpc: rpcMock, from: fromMock } as any;

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
      matchAttr: { createdAt: new Date().toISOString(), mapName: "Erangel", gameMode: "squad" },
      rawParticipants: [],
      source: "user",
      forceBenchmark: false,
    });

    expect(result.failures).toHaveLength(0);
    expect(fromMock).toHaveBeenCalledWith("weapon_meta_snapshots");
  });
});
