 import { describe, it, expect } from "vitest";
 import { buildCursorQueryFilter } from "../lib/pubg/playerMatches";
 
 describe("playerMatches helper", () => {
   it("builds cursor condition correctly when cursor is provided", () => {
     const filter = buildCursorQueryFilter("testuser", "steam", "2026-07-20T12:00:00Z");
     expect(filter.player_id).toBe("testuser");
     expect(filter.platform).toBe("steam");
     expect(filter.cursor).toBe("2026-07-20T12:00:00Z");
   });
 
   it("handles null cursor cleanly", () => {
     const filter = buildCursorQueryFilter("KangHeeSung_", "kakao", null);
     expect(filter.player_id).toBe("kangheesung_");
     expect(filter.platform).toBe("kakao");
     expect(filter.cursor).toBeNull();
   });
 });
