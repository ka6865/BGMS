import { describe, it, expect, vi } from "vitest";
import { buildPlayerMatchRecordFromParticipant, fetchAndIngestBasicMatchSummary } from "../lib/pubg/playerMatchesIngest";
 
 describe("Player Match Ingestion Helper", () => {
  it("converts participant stats to PlayerMatchRecord format", () => {
     const record = buildPlayerMatchRecordFromParticipant({
       matchId: "match-123",
       nickname: "KangHeeSung",
       platform: "steam",
       createdAt: "2026-08-01T10:00:00Z",
       matchType: "competitive",
       gameMode: "squad-fpp",
       mapName: "Erangel",
       kills: 5,
       damage: 450,
       winPlace: 1
     });
     expect(record.player_id).toBe("kangheesung");
     expect(record.match_id).toBe("match-123");
     expect(record.kills).toBe(5);
     expect(record.win_place).toBe(1);
    expect(record.match_type).toBe("competitive");
  });

  it("keeps an explicit unknown mode when the source does not provide matchType", () => {
    const record = buildPlayerMatchRecordFromParticipant({
      matchId: "match-without-mode",
      nickname: "KangHeeSung",
      platform: "steam",
      createdAt: "2026-08-01T10:00:00Z",
      gameMode: "squad-fpp",
      mapName: "Erangel",
      kills: 0,
      damage: 0,
      winPlace: 42,
    });

    expect(record.match_type).toBe("unknown");
  });

  it("does not report a PUBG match as ingested when the database upsert fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        attributes: {
          createdAt: "2026-08-01T10:00:00Z",
          gameMode: "squad-fpp",
          mapName: "Erangel",
          matchType: "competitive",
        },
      },
      included: [{
        type: "participant",
        attributes: { stats: { name: "KangHeeSung", kills: 2, damageDealt: 150, winPlace: 12 } },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const supabase = {
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({ error: new Error("database unavailable") }),
      })),
    } as never;

    const record = await fetchAndIngestBasicMatchSummary(
      supabase,
      "match-db-failure",
      "KangHeeSung",
      "steam",
      "api-key",
    );

    expect(record).toBeNull();
  });
});
