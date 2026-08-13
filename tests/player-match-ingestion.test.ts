 import { describe, it, expect } from "vitest";
 import { buildPlayerMatchRecordFromParticipant } from "../lib/pubg/playerMatchesIngest";
 
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
 });
