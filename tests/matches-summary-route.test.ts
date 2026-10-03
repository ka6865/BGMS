import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESULT_VERSION } from "@/lib/pubg-analysis/constants";
import { buildBasicMatchSummary } from "@/lib/pubg-analysis/matchSummary";

vi.mock("@/lib/pubg/privatePlayers", () => ({
  isPlayerPrivate: vi.fn().mockResolvedValue(false),
  getCachedPlayerAccountId: vi.fn(async () => database.accountId),
}));
vi.mock("@/lib/pubg/privatePlayerIdentity", () => ({
  resolvePrivatePlayerAccountId: vi.fn().mockResolvedValue(null),
}));

const database = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  errors: {} as Record<string, { message: string }>,
  selects: [] as Array<{ table: string; columns: string }>,
  writes: [] as Array<{ table: string; rows: any[]; options: Record<string, unknown> }>,
  accountId: null as string | null,
  identityFilters: [] as string[],
}));
const { ingestMatch } = vi.hoisted(() => ({ ingestMatch: vi.fn() }));
vi.mock("@/lib/pubg/playerMatchesIngest", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/pubg/playerMatchesIngest")>(),
  fetchAndIngestBasicMatchSummaryOutcome: ingestMatch,
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
        or: (filter: string) => { database.identityFilters.push(filter); return query; },
        upsert: async (rows: any[], options: Record<string, unknown>) => {
          database.writes.push({ table, rows, options });
          return { error: database.errors[`${table}:write`] ?? null };
        },
        in: async () => invalidColumn
          ? { data: null, error: { code: "42703", message: "column does not exist" } }
          : { data: database.rows[table] ?? [], error: database.errors[table] ?? null },
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
    database.writes = [];
    database.errors = {};
    database.accountId = null;
    database.identityFilters = [];
    ingestMatch.mockReset();
    ingestMatch.mockResolvedValue({ status: "not_found", record: null });
    vi.stubEnv("PUBG_API_KEY", "");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("닉네임 변경 전 경기는 캐시에서 확인한 계정 ID로 수집한다", async () => {
    database.accountId = "account.fixture1";
    database.rows.match_stats_raw = [];
    vi.stubEnv("PUBG_API_KEY", "test-key");
    await POST(request());
    expect(ingestMatch).toHaveBeenCalledWith(expect.anything(), "raw-match", "fixtureplayer", "steam", "test-key", expect.objectContaining({ expectedAccountId: "account.fixture1" }));
    expect(database.identityFilters).toEqual(['account_id.eq.account.fixture1,and(account_id.is.null,player_id.eq."fixtureplayer")']);
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

  it('repairs a raw-only basic history row without fetching PUBG or replacing concurrent records', async () => {
    const body = await (await POST(request())).json();
    expect(database.writes).toEqual([expect.objectContaining({
      table: 'pubg_player_matches',
      rows: [expect.objectContaining({ match_id: 'raw-match', played_at: '2026-07-01T10:00:00.000Z', kills: 2, match_type: 'unknown' })],
      options: expect.objectContaining({ ignoreDuplicates: true }),
    })]);
    expect(body.ingestedMatchIds).toEqual(['raw-match']);
    expect(ingestMatch).not.toHaveBeenCalled();
  });

  it('repairs a processed-only history row using observed counters and its actual match type', async () => {
    database.rows.processed_match_telemetry = [{ match_id: 'processed-only', data: { fullResult: {
      v: RESULT_VERSION, createdAt: '2026-10-03T00:00:00Z', gameMode: 'squad-fpp', matchType: 'competitive', mapName: 'Baltic_Main',
      stats: { name: 'FixturePlayer', playerId: 'account.fixture', kills: 0, damageDealt: 150, winPlace: 4, DBNOs: 0, timeSurvived: 1000 },
    } } }];
    const body = await (await POST(request(['processed-only']))).json();
    expect(database.writes[0]?.rows[0]).toMatchObject({ match_id: 'processed-only', account_id: 'account.fixture', match_type: 'competitive', kills: 0, knocks: 0, survival_time: 1000 });
    expect(body.ingestedMatchIds).toEqual(['processed-only']);
  });

  it('does not silently complete collection when repairing a basic row fails', async () => {
    database.errors['pubg_player_matches:write'] = { message: 'write unavailable' };
    const response = await POST(request());
    expect(response.status).toBe(503);
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
    expect(body.missingMatchIds).toEqual(["legacy-match"]);
    expect(database.writes).toEqual([]);
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
    expect(body.missingMatchIds).toEqual(["row-canonical-match"]);
    expect(database.writes).toEqual([]);
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

  it("attempts at most five missing matches and continues past failures without re-fetching stored matches", async () => {
    vi.stubEnv("PUBG_API_KEY", "test-key");
    const ids = Array.from({ length: 20 }, (_, index) => `new-${index}`);
    database.rows.pubg_player_matches = [{
      match_id: ids[0], player_id: "fixtureplayer", platform: "steam", kills: 1, damage: 100, win_place: 5,
    }];
    const req = request(ids);
    const body = await (await POST(req)).json();
    expect(ingestMatch).toHaveBeenCalledTimes(5);
    expect(ingestMatch.mock.calls.map((call) => call[1])).toEqual(ids.slice(1, 6));
    expect(ingestMatch.mock.calls[0][5].signal).toBe(req.signal);
    expect(body.nextMatchIds).toEqual(ids.slice(6));
    expect(body.collectionStopped).toBe(false);
    expect(body.missingMatchIds).toEqual(ids.slice(1));
    expect(body.summaries[ids[0]]).toBeDefined();
  });

  it.each([
    ["rate_limited", 429], ["upstream_error", 401], ["upstream_error", 403],
  ])("stops continuation when one match returns a request-wide error (%s, %s)", async (status, httpStatus) => {
    vi.stubEnv("PUBG_API_KEY", "test-key");
    ingestMatch.mockResolvedValueOnce({ status, httpStatus, record: null });
    const ids = Array.from({ length: 20 }, (_, index) => `new-${index}`);
    const body = await (await POST(request(ids))).json();
    expect(ingestMatch).toHaveBeenCalledTimes(5);
    expect(body.nextMatchIds).toEqual([]);
    expect(body.collectionStopped).toBe(true);
    expect(body.missingMatchIds).toEqual(ids);
  });

  it.each(["network_error", "upstream_error"])("stops continuation when the whole batch fails (%s)", async (status) => {
    vi.stubEnv("PUBG_API_KEY", "test-key");
    ingestMatch.mockResolvedValue({ status, record: null });
    const body = await (await POST(request(Array.from({ length: 20 }, (_, index) => `new-${index}`)))).json();
    expect(body.collectionStopped).toBe(true);
    expect(body.nextMatchIds).toEqual([]);
  });

  it.each(["pubg_player_matches", "match_stats_raw"])("does not mistake a storage read error for missing matches (%s)", async (table) => {
    vi.stubEnv("PUBG_API_KEY", "test-key");
    database.errors[table] = { message: "storage unavailable" };
    const response = await POST(request(["new-match"]));
    expect(response.status).toBe(503);
    expect(ingestMatch).not.toHaveBeenCalled();
  });
});
