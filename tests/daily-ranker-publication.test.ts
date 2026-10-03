import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, any>[],
  boardPlayers: [] as { id: string; name: string; matchIds: string[] }[],
  matches: {} as Record<string, Record<string, any>>,
  requests: [] as string[],
  inserted: [] as Record<string, any>[],
  insertError: "" as string,
  raceRow: null as Record<string, any> | null,
  aiCalls: 0,
  aiError: "" as string,
  evidenceCalls: 0,
  supabaseClientCalls: 0,
  boardStatus: {} as Record<string, number>,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => { state.supabaseClientCalls++; return { from: () => {
    const filters: Record<string, unknown> = {};
    const query: any = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      gte: () => query,
      lt: () => query,
      maybeSingle: async () => ({ data: state.rows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      insert: async (payload: Record<string, any>) => {
        state.inserted.push(payload);
        if (state.insertError) {
          if (state.raceRow) state.rows.push(state.raceRow);
          return { error: { code: state.insertError } };
        }
        state.rows.push(payload);
        return { error: null };
      },
    };
    return query;
  } }; },
}));
vi.mock("@/lib/learn/dailyAi", () => ({
  DAILY_STORY_PROMPT_VERSION: "test-prompt",
  generateDailyAiStory: vi.fn(async () => {
    state.aiCalls++;
    if (state.aiError) throw new Error(state.aiError);
    return { story: { headline: "test", conclusion: "test", points: [], scenes: [
      { id: "opening", kind: "opening" }, { id: "combat", kind: "combat" }, { id: "finish", kind: "finish" },
    ], schemaVersion: 2, evidenceVersion: 5, promptVersion: "test-prompt", selection: { usedFallback: false, rejectedReasons: [] } }, model: "mock" };
  }),
}));
vi.mock("@/lib/learn/dailyEvidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/learn/dailyEvidence")>();
  return {
  DAILY_EVIDENCE_VERSION: actual.DAILY_EVIDENCE_VERSION,
  buildDailyEvidence: ({ match, candidate, dayKst }: any) => {
    state.evidenceCalls++;
    return {
      dayKst, matchId: match.data.id, accountId: candidate.accountId, nickname: candidate.nickname,
      mode: match.data.attributes.gameMode, mapName: "에란겔", leaderboardRank: candidate.rank,
      playedAt: match.data.attributes.createdAt, kills: 1, damage: 100, teamKills: 1,
      facts: [{ id: "f1", timeSeconds: 1, kind: "finish", text: "우승", sourceIndices: [5] }],
      weapons: [], killEvents: [], teamKillEvents: [], route: [], aircraft: [], zones: [], limitations: [],
    };
  },
  };
});
vi.mock("@/lib/learn/dailyScenes", () => ({
  buildDailySceneCandidates: () => [
    { id: "opening", kind: "opening", evidenceIds: ["a"] },
    { id: "combat", kind: "combat", evidenceIds: ["b"] },
    { id: "finish", kind: "finish", evidenceIds: ["c"] },
  ],
}));
vi.mock("@/lib/pubg-analysis/telemetrySource", () => ({
  relationshipBoundTelemetryAsset: () => ({ id: "asset-1", asset: { attributes: { URL: "https://telemetry.test/events" } } }),
  parseOrdinaryTelemetryUrl: () => "https://telemetry.test/events",
}));

import {
  buildStoredStory, fallbackLeaderboardMode, isRateLimited, isWinningMatch,
  formatPublicationSummary, publicationExitCode, publicationRepeatCount, publishDailyRankerStory,
  rankPublicationCandidates, recentKstStart,
} from "@/scripts/publish_daily_ranker_story";

const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "mock", PUBG_API_KEY: "pubg-mock", GOOGLE_GEMINI_API_KEY: "ai-mock",
};
const dayKst = "2026-09-23";

function installApi(
  statusForBoard: number | null = null,
  statusForMatch: number | null = null,
  telemetryResponse: number | "malformed" | null = null,
) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    state.requests.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/seasons")) return Response.json({ data: [{ id: "season-1", attributes: { isCurrentSeason: true } }] });
    if (parsed.pathname.includes("/leaderboards/")) {
      if (statusForBoard !== null) return new Response("{}", { status: statusForBoard });
      return Response.json({ data: { type: "leaderboard", attributes: { shardId: "pc-as" } }, included: state.boardPlayers.map((player, index) => ({
        type: "player", id: player.id, attributes: { name: player.name, rank: index + 1 },
      })) });
    }
    if (parsed.pathname.endsWith("/players")) {
      const ids = decodeURIComponent(parsed.searchParams.get("filter[playerIds]") ?? "").split(",");
      return Response.json({ data: state.boardPlayers.filter((player) => ids.includes(player.id)).map((player) => ({
        id: player.id,
        relationships: { matches: { data: player.matchIds.map((id) => ({ id })) } },
      })) });
    }
    if (parsed.pathname.includes("/matches/")) {
      if (statusForMatch !== null) return new Response("{}", { status: statusForMatch });
      return Response.json(state.matches[parsed.pathname.split("/").at(-1)!]);
    }
    if (parsed.hostname === "telemetry.test") {
      if (telemetryResponse === "malformed") return new Response("{", { headers: { "content-type": "application/json" } });
      if (typeof telemetryResponse === "number") return new Response("not found", { status: telemetryResponse });
      return Response.json([]);
    }
    throw new Error(`unexpected mocked URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setupWinningMatch(mode: "solo" | "duo" | "squad", winnerIds: string[], matchId = "match-1") {
  state.boardPlayers = winnerIds.map((id) => ({ id: `account.${id}`, name: id, matchIds: [matchId] }));
  state.matches[matchId] = {
    data: { id: matchId, attributes: { shardId: "steam", gameMode: mode, matchType: "competitive", isCustomMatch: false, createdAt: "2026-09-23T01:00:00Z" } },
    included: winnerIds.map((id, index) => ({ type: "participant", attributes: { stats: { playerId: `account.${id}`, name: id, winPlace: winnerIds.length === 1 || index > 0 ? 1 : 2 } } })),
  };
}

function reset() {
  state.rows = [];
  state.boardPlayers = [];
  state.matches = {};
  state.requests = [];
  state.inserted = [];
  state.insertError = "";
  state.raceRow = null;
  state.aiCalls = 0;
  state.aiError = "";
  state.evidenceCalls = 0;
  state.supabaseClientCalls = 0;
  state.boardStatus = {};
  vi.unstubAllGlobals();
}
afterEach(reset);

describe("daily ranker publication", () => {
  it("checks each mode independently and skips published rows without upstream calls", async () => {
    state.rows = ["solo", "duo", "squad"].map((mode) => ({ day_kst: dayKst, mode, match_id: `${mode}-match` }));
    const fetchMock = installApi();
    const result = await publishDailyRankerStory({ day: dayKst, apply: false, env });
    expect(result).toEqual(["duo", "squad"].map((mode) => ({ state: "already_published", dayKst, mode, matchId: `${mode}-match` })));
    expect(state.rows.find((row) => row.mode === "solo")).toEqual({ day_kst: dayKst, mode: "solo", match_id: "solo-match" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips unsupported AS Solo before DB, PUBG, or model access", async () => {
    const fetchMock = installApi();
    const result = await publishDailyRankerStory({ day: dayKst, mode: "solo", apply: true, env: { NODE_ENV: "test" } });
    expect(result).toEqual({ state: "unsupported", dayKst, mode: "solo", region: "pc-as", reason: "ranked_queue_unavailable_in_region" });
    expect(state.supabaseClientCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.aiCalls).toBe(0);
    expect(publicationExitCode(result)).toBe(0);
  });

  it("is idempotent when a mode is run again after publication", async () => {
    setupWinningMatch("duo", ["lost", "winner"]);
    const fetchMock = installApi();
    const first = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: true, env });
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: true, env });
    expect(first).toMatchObject({ state: "published", dayKst, mode: "duo", matchId: "match-1" });
    expect(second).toEqual({ state: "already_published", dayKst, mode: "duo", matchId: "match-1" });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
    expect(state.aiCalls).toBe(1);
    expect(state.inserted).toHaveLength(1);
  });

  it("continues past a ranked player who lost and deduplicates only after one account builds the match", async () => {
    setupWinningMatch("squad", ["lost", "winner", "teammate"]);
    const fetchMock = installApi();
    const result = await publishDailyRankerStory({ day: dayKst, mode: "squad", apply: false, env });
    expect(result).toMatchObject({ state: "preview", matchId: "match-1" });
    expect(state.evidenceCalls).toBe(1);
    expect(state.aiCalls).toBe(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/matches/match-1"))).toHaveLength(1);
  });

  it("reports a mode API failure and stops all further mode calls on HTTP 429", async () => {
    setupWinningMatch("duo", ["winner"]);
    const modeFailure = installApi(500);
    const failed = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: false, env });
    expect(failed).toMatchObject({ state: "failed", mode: "duo", error: expect.stringContaining("upstream_500") });
    expect(modeFailure.mock.calls.some(([url]) => String(url).includes("/leaderboards/"))).toBe(true);

    reset();
    const rateLimited = installApi(429);
    const results = await publishDailyRankerStory({ day: dayKst, apply: false, env });
    expect(results).toMatchObject([{ state: "failed", mode: "duo", error: expect.stringContaining("upstream_429") }]);
    expect(rateLimited.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/leaderboards/"))).toHaveLength(1);
    expect(rateLimited.mock.calls.some(([url]) => String(url).includes("/leaderboards/") && String(url).endsWith("/squad"))).toBe(false);
  });

  it("keeps match API outages as failures while treating an unavailable match as an ordinary skip", async () => {
    setupWinningMatch("duo", ["winner"]);
    installApi(null, 503);
    const failed = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: false, env });
    expect(failed).toMatchObject({ state: "failed", error: expect.stringContaining("upstream_503") });

    reset();
    setupWinningMatch("duo", ["winner"]);
    installApi(null, 404);
    const skipped = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: false, env });
    expect(skipped).toMatchObject({ state: "no_verified_candidate" });
    expect(publicationExitCode(skipped)).toBe(0);
  });

  it("fails the mode for telemetry HTTP and malformed JSON errors instead of reporting no candidate", async () => {
    for (const telemetryResponse of [404, "malformed"] as const) {
      reset();
      setupWinningMatch("duo", ["winner"]);
      installApi(null, null, telemetryResponse);
      const result = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: false, env });
      expect(result).toMatchObject({ state: "failed", mode: "duo" });
      expect(publicationExitCode(result)).toBe(1);
    }
  });

  it("keeps AI provider outages red but defers invalid story output without failing the workflow", async () => {
    setupWinningMatch("duo", ["winner"]);
    installApi();
    state.aiError = "model transport unavailable";
    const failed = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: false, env });
    expect(failed).toMatchObject({ state: "failed", error: "model transport unavailable" });
    expect(publicationExitCode(failed)).toBe(1);

    reset();
    setupWinningMatch("duo", ["winner"]);
    installApi();
    state.aiError = "ai_json_invalid";
    const deferred = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: false, env });
    expect(deferred).toMatchObject({ state: "no_complete_story" });
    expect(publicationExitCode(deferred)).toBe(0);
  });

  it("treats a concurrent same-mode 23505 as success, but reports a match collision from another day", async () => {
    setupWinningMatch("duo", ["winner"]);
    installApi();
    state.insertError = "23505";
    state.raceRow = { day_kst: dayKst, mode: "duo", match_id: "match-1" };
    const concurrent = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: true, env });
    expect(concurrent).toEqual({ state: "already_published", dayKst, mode: "duo", matchId: "match-1" });

    reset();
    setupWinningMatch("duo", ["winner"]);
    installApi();
    state.insertError = "23505";
    state.raceRow = { day_kst: "2026-09-22", mode: "duo", match_id: "match-1" };
    const collision = await publishDailyRankerStory({ day: dayKst, mode: "duo", apply: true, env });
    expect(collision).toMatchObject({ state: "failed", error: "daily_story_match_collision:match-1" });
  });

  it("treats no-candidate and no-story modes as normal partial publication outcomes", () => {
    expect(publicationExitCode([{ state: "published" }, { state: "no_verified_candidate" }])).toBe(0);
    expect(publicationExitCode({ state: "no_complete_story" })).toBe(0);
    expect(publicationExitCode([{ state: "published" }, { state: "already_published" }])).toBe(0);
    expect(publicationExitCode({ state: "unsupported" })).toBe(0);
  });

  it("keeps provider and persistence failures red and reports each mode outcome", () => {
    expect(publicationExitCode([{ state: "published" }, { state: "failed" }])).toBe(1);
    expect(publicationExitCode({ state: "unexpected" })).toBe(1);
    expect(formatPublicationSummary([
      { state: "published", dayKst: dayKst, mode: "squad" },
      { state: "no_verified_candidate", dayKst, mode: "duo" },
    ])).toContain("검증된 우승 후보 없음 · 미발행");
    expect(formatPublicationSummary([{ state: "failed", dayKst, mode: "duo" }]))
      .toContain("API·AI·DB 처리 실패는 Actions 실패로 표시됩니다.");
  });

  it("accepts verified competitive wins for all modes", () => {
    for (const mode of ["solo", "duo", "squad"] as const) {
      const match = { data: { attributes: { shardId: "steam", gameMode: mode, matchType: "competitive", isCustomMatch: false, createdAt: "2026-09-22T15:05:00Z" } },
        included: [{ type: "participant", attributes: { stats: { playerId: "account.a", winPlace: 1 } } }] };
      expect(isWinningMatch(match, { accountId: "account.a", nickname: "Winner", rank: 1 }, dayKst, mode)).toBe(true);
    }
  });

  it("ranks complete, diverse scenes before recurrence and deterministic match identity", () => {
    const item = (matchId: string, kinds: string[], repeatCount = 0) => ({ evidence: { matchId, playedAt: "2026-09-23T00:00:00Z" }, scenes: kinds.map((kind) => ({ kind })), repeatCount });
    expect(rankPublicationCandidates([item("z", ["opening", "combat", "finish"]), item("a", ["opening", "combat", "finish", "movement"]), item("missing", ["opening", "combat", "movement"])]).map(({ evidence }) => evidence.matchId))
      .toEqual(["a", "z"]);
    expect(recentKstStart(dayKst)).toBe("2026-09-16");
    expect(publicationRepeatCount([{ account_id: "account.a", map_name: "미라마" }, { account_id: "other", map_name: "에란겔" }], { accountId: "account.a", mapName: "에란겔" } as any)).toBe(2);
    expect(["solo", "duo", "squad"].map((mode) => fallbackLeaderboardMode(mode as "solo" | "duo" | "squad"))).toEqual(["duo", "squad", "duo"]);
    expect(isRateLimited({ response: { status: "429" } })).toBe(true);
  });

  it("retains generated metadata, indexed facts, and leaderboard provenance", () => {
    const evidence = { facts: [{ id: "f1", sourceIndices: [7] }] } as any;
    const aiStory = { schemaVersion: 2, evidenceVersion: 5, promptVersion: "scene-v1", selection: { usedFallback: false, rejectedReasons: [] }, scenes: [{ id: "1" }, { id: "2" }, { id: "3" }] } as any;
    const story = buildStoredStory(aiStory, evidence, { leaderboardObservedAt: "2026-09-23T00:00:00Z", leaderboardSeason: "s1", leaderboardSource: "board" });
    expect(story).toMatchObject({ schemaVersion: 2, evidenceVersion: 5, promptVersion: "scene-v1", sceneCount: 3, leaderboardSource: "board" });
    expect(story.facts[0].sourceIndices).toEqual([7]);
  });
});
