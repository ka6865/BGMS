import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";

const database = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  selects: [] as Array<{ table: string; columns: string }>,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      let invalidColumn = false;
      const query = {
        select: (columns: string) => {
          database.selects.push({ table, columns });
          if (table === "match_stats_raw") {
            const known = new Set(["match_id", "player_id", "platform", "created_at", "damage", "kills", "win_place", "game_mode", "map_name"]);
            invalidColumn = columns.split(",").some(column => !known.has(column.trim()));
          }
          return query;
        },
        eq: () => query,
        in: async () => invalidColumn
          ? { data: null, error: { code: "42703", message: "column does not exist" } }
          : { data: database.rows[table] ?? [], error: null },
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
    vi.stubEnv("PUBG_API_KEY", "");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
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
    expect(playerMatchSelect?.columns.split(",").map((column) => column.trim())).toEqual(expect.arrayContaining(["match_type", "knocks", "survival_time"]));
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

  it("ordinary history falls back to the storage row match_id when legacy fullResult omits it", async () => {
    database.rows.processed_match_telemetry = [{
      match_id: "row-canonical-match",
      data: {
        fullResult: {
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

    const body = await (await POST(request(["row-canonical-match"]))).json();

    expect(body.summaries["row-canonical-match"]).toMatchObject({
      matchId: "row-canonical-match",
      summarySource: "processed_match_telemetry",
    });
    expect(body.missingMatchIds).toEqual([]);
  });

  it("future processed versions fall back to the current basic match summary contract", async () => {
    database.rows.processed_match_telemetry = [{
      match_id: "future-match",
      data: {
        fullResult: {
          matchId: "future-match",
          v: RESULT_VERSION + 1,
          stats: {
            name: "FixturePlayer",
            kills: 99,
            damageDealt: 9999,
            winPlace: 1,
          },
          gameMode: "squad-fpp",
          mapName: "Baltic_Main",
        },
      },
    }];
    database.rows.pubg_player_matches = [{
      match_id: "future-match",
      knocks: 0,
      survival_time: 724,
      player_id: "fixtureplayer",
      platform: "steam",
      played_at: "2026-08-10T00:00:00.000Z",
      game_mode: "squad-fpp",
      map_name: "Baltic_Main",
      kills: 2,
      damage: 321,
      win_place: 4,
      match_type: "official",
    }];

    const body = await (await POST(request(["future-match"]))).json();

    expect(body.summaries["future-match"]).toMatchObject({
      matchId: "future-match",
      v: 1,
      summarySource: "pubg_player_matches",
      stats: { kills: 2, damageDealt: 321, winPlace: 4 },
      basicStats: { DBNOs: 0, timeSurvived: 724 },
    });
    expect(body.missingMatchIds).toEqual([]);
  });

  it("canonicalizes shard aliases before the 20-match limit and returns one summary per ID", async () => {
    database.rows.match_stats_raw = [
      {
        match_id: "shard:duplicate-match",
        player_id: "fixtureplayer",
        platform: "steam",
        created_at: "2026-07-02T10:00:00.000Z",
        damage: 100,
        kills: 1,
        win_place: 5,
        game_mode: "squad-fpp",
        map_name: "Baltic_Main",
      },
      {
        match_id: "match-18",
        player_id: "fixtureplayer",
        platform: "steam",
        created_at: "2026-07-03T10:00:00.000Z",
        damage: 200,
        kills: 2,
        win_place: 4,
        game_mode: "squad-fpp",
        map_name: "Baltic_Main",
      },
    ];
    const requestedIds = [
      "shard:duplicate-match",
      "duplicate-match",
      ...Array.from({ length: 19 }, (_, index) => `match-${index}`),
    ];

    const body = await (await POST(request(requestedIds))).json();

    expect(Object.keys(body.summaries)).toEqual(["duplicate-match", "match-18"]);
    expect(body.summaries["duplicate-match"].matchId).toBe("duplicate-match");
    expect(body.missingMatchIds).toEqual(Array.from({ length: 18 }, (_, index) => `match-${index}`));
  });
});
