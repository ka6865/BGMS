import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";

const database = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  selects: [] as Array<{ table: string; columns: string }>,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const query = {
        select: (columns: string) => {
          database.selects.push({ table, columns });
          return query;
        },
        eq: () => query,
        in: async () => ({ data: database.rows[table] ?? [], error: null }),
      };
      return query;
    },
  }),
}));

import { POST } from "@/app/api/pubg/matches-summary/route";

function request(matchIds = ["raw-match"]) {
  return new NextRequest("http://localhost/api/pubg/matches-summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchIds, nickname: "FixturePlayer", platform: "steam" }),
  });
}

describe("matches-summary raw timestamp fallback", () => {
  beforeEach(() => {
    database.rows = {
      processed_match_telemetry: [],
      pubg_player_matches: [],
      match_stats_raw: [{
        match_id: "raw-match",
        player_id: "fixtureplayer",
        platform: "steam",
        played_at: null,
        created_at: "2026-07-01T10:00:00.000Z",
        damage: 321,
        kills: 2,
        win_place: 4,
        game_mode: "squad-fpp",
        map_name: "Baltic_Main",
      }],
    };
    database.selects = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("helper는 played_at, created_at, request-time ultimate fallback 순서를 지킨다", () => {
    vi.setSystemTime(new Date("2026-08-10T12:34:56.000Z"));

    expect(buildBasicMatchSummary({
      match_id: "played",
      player_id: "fixtureplayer",
      platform: "steam",
      played_at: "2026-06-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
    }).createdAt).toBe("2026-06-01T00:00:00.000Z");
    expect(buildBasicMatchSummary({
      match_id: "created",
      player_id: "fixtureplayer",
      platform: "steam",
      played_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
    }).createdAt).toBe("2026-07-01T00:00:00.000Z");
    expect(buildBasicMatchSummary({
      match_id: "request-time",
      player_id: "fixtureplayer",
      platform: "steam",
      played_at: null,
      created_at: null,
    }).createdAt).toBe("2026-08-10T12:34:56.000Z");
  });

  it("서로 다른 request time에도 raw created_at을 읽어 동일한 createdAt을 반환한다", async () => {
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const firstBody = await (await POST(request())).json();

    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    const secondBody = await (await POST(request())).json();

    expect(firstBody.summaries["raw-match"].createdAt).toBe("2026-07-01T10:00:00.000Z");
    expect(secondBody.summaries["raw-match"].createdAt).toBe("2026-07-01T10:00:00.000Z");
    const rawSelects = database.selects.filter(({ table }) => table === "match_stats_raw");
    expect(rawSelects).toHaveLength(2);
    expect(rawSelects[0].columns.split(",").map((column) => column.trim())).toContain("created_at");
    expect(rawSelects[1].columns.split(",").map((column) => column.trim())).toContain("created_at");
  });

  it("요약 DB 조회에는 저장된 경기 종류를 포함한다", async () => {
    await POST(request());
    const playerMatchSelect = database.selects.find(({ table }) => table === "pubg_player_matches");
    expect(playerMatchSelect?.columns.split(",").map((column) => column.trim())).toContain("match_type");
  });

  it("ordinary history keeps a legacy processed row without embedded AI identity fields", async () => {
    database.rows.processed_match_telemetry = [{
      match_id: "legacy-match",
      data: {
        fullResult: {
          matchId: "legacy-match",
          v: 73,
          stats: {
            name: "FixturePlayer",
            kills: 2,
            damageDealt: 321,
            winPlace: 4,
          },
          gameMode: "squad-fpp",
          mapName: "Baltic_Main",
        },
      },
    }];

    const body = await (await POST(request(["legacy-match"]))).json();

    expect(body.summaries["legacy-match"]).toMatchObject({
      matchId: "legacy-match",
      summarySource: "processed_match_telemetry",
      stats: { name: "FixturePlayer", kills: 2 },
    });
    expect(body.missingMatchIds).toEqual([]);
  });
});
