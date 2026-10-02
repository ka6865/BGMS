import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    error: null as { code: string } | null,
    calls: [] as { table: string; filters: [string, unknown][]; selection: string; limit?: number }[],
    createClient: vi.fn(),
  };
  state.createClient.mockImplementation(() => ({
    from(table: string) {
      const call = { table, filters: [] as [string, unknown][], selection: "", limit: undefined as number | undefined };
      state.calls.push(call);
      const query = {
        select(selection: string) { call.selection = selection; return query; },
        eq(key: string, value: unknown) { call.filters.push([key, value]); return query; },
        order() { return query; },
        async limit(limit: number) {
          call.limit = limit;
          const rows = state.rows.filter((row) => call.filters.every(([key, value]) => row[key] === value));
          const data = call.selection.includes("headline:story")
            ? rows.map((row) => ({ ...row, ...Object.fromEntries(Object.entries(row.story as object).filter(([key]) => ["headline", "conclusion", "sceneCount", "leaderboardObservedAt", "leaderboardSeason", "leaderboardSource"].includes(key))) }))
            : rows;
          return { data, error: state.error };
        },
        async maybeSingle() {
          const row = state.rows.find((item) => call.filters.every(([key, value]) => item[key] === value)) ?? null;
          return { data: row, error: state.error };
        },
      };
      return query;
    },
  }));
  return state;
});

vi.mock("@supabase/supabase-js", () => ({ createClient: db.createClient }));

import { getDailyRankerStory, listDailyRankerStories, listDailyRankerStoriesForDay } from "@/lib/learn/dailyStories";

const envBefore = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
const storyRow = {
  day_kst: "2024-02-29", match_id: "match-1", nickname: "Winner", mode: "duo",
  map_name: "미라마", leaderboard_rank: 4, played_at: "2024-02-28T15:00:00Z",
  published_at: "2024-02-29T00:00:00Z", kills: 3, damage: 540, team_kills: 5,
  story: {
    headline: "복기", conclusion: "우승", points: [], facts: [], weapons: [], killEvents: [],
    zones: [], limitations: [], sceneCount: 2,
    leaderboardObservedAt: "2024-02-28T14:00:00Z", leaderboardSeason: "season-36", leaderboardSource: "AS",
  },
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "server-only-test-key";
  db.rows.splice(0, db.rows.length, storyRow);
  db.calls.splice(0);
  db.error = null;
  db.createClient.mockClear();
});

afterEach(() => {
  if (envBefore.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = envBefore.url;
  if (envBefore.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = envBefore.key;
});

describe("daily story store", () => {
  it("validates real calendar dates before querying and reads by date plus mode", async () => {
    expect(await getDailyRankerStory("2023-02-29", "duo")).toBeNull();
    expect(await getDailyRankerStory("2024-02-30", "solo")).toBeNull();
    expect(db.createClient).not.toHaveBeenCalled();

    db.rows[0] = {
      ...storyRow,
      story: { ...storyRow.story, dayKst: "2000-01-01", matchId: "forged", nickname: "forged", mode: "squad" },
    };
    const result = await getDailyRankerStory("2024-02-29", "duo");
    expect(result).toMatchObject({ dayKst: "2024-02-29", matchId: "match-1", nickname: "Winner", mode: "duo" });
    expect(db.calls.at(-1)?.filters).toEqual([["day_kst", "2024-02-29"], ["mode", "duo"]]);
  });

  it("lists a date's stories with the stored JSON scene count and optional leaderboard metadata", async () => {
    const result = await listDailyRankerStoriesForDay("2024-02-29");
    expect(result).toMatchObject([{
      dayKst: "2024-02-29", mode: "duo", sceneCount: 2,
      leaderboardObservedAt: "2024-02-28T14:00:00Z", leaderboardSeason: "season-36", leaderboardSource: "AS",
    }]);
    expect(db.calls[0]?.filters).toEqual([["day_kst", "2024-02-29"]]);
    expect(db.calls[0]?.selection).toContain("sceneCount:story->sceneCount");
    expect(db.calls[0]?.selection).not.toContain("scenes:story");
    db.rows.push({ ...storyRow, mode: "squad", story: { ...storyRow.story, sceneCount: "3" } });
    expect((await listDailyRankerStoriesForDay("2024-02-29"))[1]).not.toHaveProperty("sceneCount");
    const callCount = db.calls.length;
    expect(await listDailyRankerStoriesForDay("2024-02-30")).toEqual([]);
    expect(db.calls).toHaveLength(callCount);
  });

  it("keeps the existing bounded cross-date list and surfaces Supabase read errors", async () => {
    await listDailyRankerStories(1000);
    expect(db.calls[0]?.limit).toBe(100);
    db.error = { code: "42501" };
    await expect(listDailyRankerStories()).rejects.toThrow("daily-story-list:42501");
  });

  it("migrates the existing table in place and retains server-only access", () => {
    const sql = readFileSync(new URL("../supabase/migrations/20260927145237_daily_ranker_stories_by_mode.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/check \(mode in \('solo', 'duo', 'squad'\)\)/i);
    expect(sql).toMatch(/primary key \(day_kst, mode\)/i);
    expect(sql).toMatch(/revoke all on public\.daily_ranker_stories from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select, insert on public\.daily_ranker_stories to service_role/i);
    expect(sql).not.toMatch(/drop table|delete from public\.daily_ranker_stories/i);
    expect(readFileSync(new URL("../supabase/migrations/20260923222549_daily_ranker_stories.sql", import.meta.url), "utf8")).toMatch(/match_id text not null unique/i);
  });
});
