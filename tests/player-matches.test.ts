import { describe, it, expect, vi } from "vitest";
import {
  buildCursorQueryFilter,
  fetchPlayerMatchesPaginated,
  normalizePlayerMatchesPage,
} from "../lib/pubg/playerMatches";
 
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

  it.each([
    [undefined, 1],
    [null, 1],
    ["0", 1],
    ["-2", 1],
    ["2", 2],
    [4, 4],
  ])("normalizes page %s to %s", (value, expected) => {
    expect(normalizePlayerMatchesPage(value)).toBe(expected);
  });

  it("requests the selected range and derives exact page metadata", async () => {
    const row = {
      player_id: "testuser",
      platform: "steam",
      match_id: "match-41",
      played_at: "2026-07-20T12:00:00Z",
      game_mode: "squad-fpp",
      map_name: "Baltic_Main",
      kills: 2,
      damage: 300,
      win_place: 4,
      match_type: "official",
    };
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: [row], error: null, count: 41 }),
    };
    const supabase = { from: vi.fn(() => query) } as never;

    const result = await fetchPlayerMatchesPaginated(supabase, "TestUser", "steam", 3, 20);

    expect(query.range).toHaveBeenCalledWith(40, 59);
    expect(query.select).toHaveBeenCalledWith(expect.any(String), { count: "exact" });
    expect(result).toMatchObject({ page: 3, pageSize: 20, totalCount: 41, totalPages: 3 });
    expect(result.matches).toEqual([row]);
  });
});
