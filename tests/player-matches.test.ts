import { describe, it, expect, vi } from "vitest";
import { readPerformanceCache, readPerformanceStates } from "../lib/pubg/performanceCache";
import {
  buildCursorQueryFilter,
  buildPlayerMatchIdentityFilter,
  fetchPlayerMatchesPaginated,
  normalizePlayerMatchesPage,
  normalizePlayerMatchHistoryFilter,
  normalizeBasicMatchStat,
  hasObservedPlayerMatchValues,
} from "../lib/pubg/playerMatches";
 
 describe("playerMatches helper", () => {
  it("uses stable account identity with an escaped legacy nickname fallback", async () => {
    const filter = buildPlayerMatchIdentityFilter('New"Name\\', 'account.same');
    expect(filter).toBe('account_id.eq.account.same,and(account_id.is.null,player_id.eq."new\\"name\\\\")');
    expect(buildPlayerMatchIdentityFilter('NewName', 'account.bad,account_id.not.is.null')).toBeNull();
    const renamed = { player_id: "oldname", account_id: "account.same", match_id: "old-match" };
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockResolvedValue({ data: [renamed], error: null, count: 1 }) };
    const result = await fetchPlayerMatchesPaginated({ from: () => query } as never, "NewName", "steam", 1, 20, "all", "account.same");
    expect(query.or).toHaveBeenCalledWith('account_id.eq.account.same,and(account_id.is.null,player_id.eq."newname")');
    expect(query.eq).not.toHaveBeenCalledWith('player_id', 'newname');
    expect(result.matches).toEqual([renamed]);
  });

  it("keeps cached scores and analysis states visible after a nickname change", async () => {
    const benchmark = { score: 72, tier: 'A' };
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockResolvedValue({ data: [{ match_id: 'old-match', benchmark, state: 'done' }], error: null }) };
    const db = { from: () => query } as never;
    expect(await readPerformanceCache(db, 'steam', 'NewName', ['old-match'], 'account.same')).toEqual({ 'old-match': benchmark });
    expect(await readPerformanceStates(db, 'steam', 'NewName', ['old-match'], 'account.same')).toEqual({ 'old-match': 'done' });
    expect(query.eq).toHaveBeenCalledWith('account_id', 'account.same');
    expect(query.eq).not.toHaveBeenCalledWith('player_id', 'newname');
  });
  it.each([undefined, null, -1, NaN, Infinity, '3', 2147483648])('does not fabricate a basic counter from %s', value => {
    expect(normalizeBasicMatchStat(value)).toBeNull();
  });
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

  it.each([
    ["ranked", "ranked"],
    ["casual", "casual"],
    ["tdm", "tdm"],
    ["normal", "normal"],
    ["unknown", "all"],
    [null, "all"],
  ])("normalizes history filter %s to %s", (value, expected) => {
    expect(normalizePlayerMatchHistoryFilter(value)).toBe(expected);
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
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("knocks, survival_time"), { count: "exact" });
    expect(result).toMatchObject({ page: 3, pageSize: 20, totalCount: 41, totalPages: 3 });
    expect(result.matches).toEqual([row]);
  });

  it("propagates database errors so the route can expose a retryable failure", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: null, error: new Error("database unavailable"), count: null }),
    };
    const supabase = { from: vi.fn(() => query) } as never;

    await expect(fetchPlayerMatchesPaginated(supabase, "TestUser", "steam", 1, 20))
      .rejects.toThrow("database unavailable");
  });

  it("applies the selected filter before range so count and pages describe the full filtered history", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data: [], error: null, count: 7 }),
    };
    const supabase = { from: vi.fn(() => query) } as never;

    const ranked = await fetchPlayerMatchesPaginated(supabase, "TestUser", "steam", 1, 20, "ranked");

    expect(query.or).toHaveBeenCalledWith(expect.stringContaining("competitive"));
    expect(ranked).toMatchObject({ totalCount: 7, totalPages: 1 });
  });

  it('reads earlier nicknames by account while limiting legacy rows to the requested name', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({data: [], error: null, count: 192}) };
    const page = await fetchPlayerMatchesPaginated({from: () => query} as never, 'NewName_', 'steam', 10, 20, 'all', 'account.target');
    expect(query.or).toHaveBeenCalledWith('account_id.eq.account.target,and(account_id.is.null,player_id.eq."newname_")');
    expect(query.eq).not.toHaveBeenCalledWith('player_id', expect.anything());
    expect(query.range).toHaveBeenCalledWith(180, 199);
    expect(page).toMatchObject({totalCount: 192, totalPages: 10, page: 10});
  });

  it('requires observed required stats but preserves an official zero', () => {
    const row = {kills: 0, damage: 0, win_place: 42, played_at: '2026-10-01T00:00:00Z', game_mode: 'duo', map_name: 'Tiger_Main'};
    expect(hasObservedPlayerMatchValues(row)).toBe(true);
    for (const key of ['kills', 'damage', 'win_place', 'played_at', 'game_mode', 'map_name']) {
      expect(hasObservedPlayerMatchValues({...row, [key]: null})).toBe(false);
    }
    expect(hasObservedPlayerMatchValues({...row, match_type: 'unavailable'})).toBe(false);
  });
});
