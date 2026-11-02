import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_SQUAD_CACHE_VERSION, GEMINI_MODELS_TO_TRY } from "@/lib/pubg-analysis/constants";
import { COACHING_JUDGMENT_WITHHELD } from "@/lib/pubg-analysis/aiCoachingQuality";

type StreamScript =
  | { kind: "ok"; text: string; usage?: { inputTokens: number; outputTokens: number } }
  | { kind: "error"; error: Error }
  | { kind: "error-mid"; partial: string; error: Error }
  | { kind: "hang" };

const {
  mockWithAuthGuard,
  mockGetSquadAnalysisData,
  mockTrackAiUsage,
  mockTrackAiFailure,
  mockBlockPrivatePlayer,
  mockStreamText,
  streamScripts,
  streamCalls,
} = vi.hoisted(() => {
  const streamScripts: StreamScript[] = [];
  const streamCalls: Array<{ modelName: string; prompt: string; system: string; abortSignal?: AbortSignal }> = [];
  const mockStreamText = vi.fn((options: any) => {
    streamCalls.push({
      modelName: options.model.modelName,
      prompt: options.prompt,
      system: options.system,
      abortSignal: options.abortSignal,
    });
    const script: StreamScript = streamScripts.shift() ?? { kind: "error", error: new Error("no scripted model response") };
    let resolveUsage: (usage: unknown) => void = () => undefined;
    const usage = new Promise((resolve) => { resolveUsage = resolve; });
    const fullStream = (async function* () {
      if (script.kind === "error") {
        resolveUsage(undefined);
        yield { type: "error", error: script.error };
        return;
      }
      if (script.kind === "hang") {
        await new Promise(() => undefined);
        return;
      }
      yield { type: "start-step" };
      if (script.kind === "error-mid") {
        yield { type: "text-delta", text: script.partial };
        resolveUsage(undefined);
        yield { type: "error", error: script.error };
        return;
      }
      yield { type: "text-delta", text: script.text };
      resolveUsage(script.usage ?? { inputTokens: 1, outputTokens: 1 });
    })();
    return { fullStream, usage };
  });
  return {
    mockWithAuthGuard: vi.fn(),
    mockGetSquadAnalysisData: vi.fn(),
    mockTrackAiUsage: vi.fn(),
    mockTrackAiFailure: vi.fn(),
    mockBlockPrivatePlayer: vi.fn(),
    mockStreamText,
    streamScripts,
    streamCalls,
  };
});

vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamText: mockStreamText }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: () => (modelName: string) => ({ modelName }) }));
vi.mock("@/utils/supabase/guard", () => ({ withAuthGuard: mockWithAuthGuard }));
vi.mock("@/lib/pubg-analysis/squadAnalysis", () => ({ getSquadAnalysisData: mockGetSquadAnalysisData }));
vi.mock("@/lib/pubg-analysis/aiUsageTracker", () => ({ trackAiUsage: mockTrackAiUsage, trackAiFailure: mockTrackAiFailure }));
vi.mock("@/lib/pubg/privatePlayerGuard", () => ({ blockPrivatePlayer: mockBlockPrivatePlayer }));

import { POST as aiSquadPOST } from "@/app/api/pubg/ai-squad/route";

function recentIso(minutesAgo: number) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function squadFixture(overrides: Record<string, unknown> = {}) {
  return {
    groupKey: "alpha,beta",
    teamMode: "squad",
    matchCount: 3,
    latestMatchCount: 3,
    bestMatchCount: 3,
    selectedMatchIds: ["match-3", "match-2", "match-1"],
    matchesSummary: [
      { matchId: "match-3", mapName: "Baltic_Main", winPlace: 1, createdAt: recentIso(1) },
      { matchId: "match-2", mapName: "Baltic_Main", winPlace: 2, createdAt: recentIso(2) },
      { matchId: "match-1", mapName: "Baltic_Main", winPlace: 4, createdAt: recentIso(3) },
    ],
    stats: {
      avgIsolation: 1.5,
      avgTradeLatency: 8000,
      totalSmokeRescues: 2,
      totalRevives: 3,
      avgCoverRate: 0.45,
      totalTeamWipes: 1,
      totalTeammateKnocks: 2,
    },
    scores: { formation: 70, backupSpeed: 75, survivalCare: 80, focusFire: 76, teamWipe: 65 },
    squadGrade: "A",
    roleProfiles: [
      { name: "Player_A", role: "Entry", roleDesc: "진입", avgDamage: 300, avgKills: 2, avgAssists: 1, avgDbnos: 1, shares: { damage: 55, kill: 50, assist: 30, dbno: 50 } },
      { name: "Beta", role: "Support", roleDesc: "지원", avgDamage: 180, avgKills: 1, avgAssists: 2, avgDbnos: 1, shares: { damage: 45, kill: 50, assist: 70, dbno: 50 } },
    ],
    benchmarkStats: { tier: "A", avgIsolation: 1.36, avgTradeLatency: 12143, avgReviveRate: 17, avgSmokeRate: 3.58, avgTeamWipes: 5.33 },
    ...overrides,
  };
}

function cacheChain(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: any = {};
  for (const method of ["select", "eq", "abortSignal"]) chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => result);
  chain.upsert = vi.fn(() => Promise.resolve({ error: null }));
  return chain;
}

function useSupabase(cache: ReturnType<typeof cacheChain>) {
  mockWithAuthGuard.mockResolvedValue({
    user: { id: "user-1" },
    supabaseAdmin: { from: vi.fn((table: string) => {
      if (table !== "squad_ai_coaching_cache") throw new Error(`unexpected table ${table}`);
      return cache;
    }) },
  });
}

function squadRequest(body: Record<string, unknown> = {}, signal?: AbortSignal) {
  return new Request("http://localhost/api/pubg/ai-squad", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupKey: "alpha,beta", nickname: "Player_A", platform: "steam", coachingStyle: "spicy", ...body }),
    signal,
  });
}

const modelResult = {
  squadGrade: "A",
  summary: "대열을 유지하며 교전 순서를 맞췄습니다.",
  strength: "백업 기록이 안정적입니다.",
  weakness: "간격이 벌어진 구간이 있습니다.",
  coaching: "함께 진입하는 순서를 정하세요.",
  memberFeedbacks: [{ name: "Player_A", praise: "진입을 맡았습니다.", fault: "기록이 부족해 판단을 보류합니다.", advice: "팀과 함께 움직이세요." }],
  overallOpinion: "다음 경기에서도 같은 순서를 이어가세요.",
};

async function waitForStreamCall(count: number) {
  for (let index = 0; index < 200 && streamCalls.length < count; index += 1) await Promise.resolve();
  expect(streamCalls.length).toBeGreaterThanOrEqual(count);
}

describe("AI squad route stability", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    streamScripts.length = 0;
    streamCalls.length = 0;
    vi.stubEnv("GOOGLE_GEMINI_API_KEY", "test-key");
    vi.stubEnv("PUBG_AI_GENERATION_DISABLED", "");
    mockBlockPrivatePlayer.mockResolvedValue(null);
    mockGetSquadAnalysisData.mockResolvedValue(squadFixture());
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("moves to the next model when the first model fails before its response starts, then persists the second model's result", async () => {
    streamScripts.push({ kind: "error", error: new Error("gemini unavailable") }, {
      kind: "ok", text: JSON.stringify(modelResult), usage: { inputTokens: 12, outputTokens: 34 },
    });
    const cache = cacheChain();
    useSupabase(cache);

    const response = await aiSquadPOST(squadRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ squadGrade: "A", summary: modelResult.summary });
    expect(streamCalls.map(call => call.modelName)).toEqual(GEMINI_MODELS_TO_TRY.slice(0, 2));
    expect(cache.upsert).toHaveBeenCalledTimes(1);
    expect(cache.upsert.mock.calls[0][0]).toMatchObject({ prompt_version: AI_SQUAD_CACHE_VERSION });
    expect(mockTrackAiUsage).toHaveBeenCalledWith("user-1", GEMINI_MODELS_TO_TRY[1], 12, 34, "squad", expect.any(Object));
  });

  it("treats a first-part timeout as a model failure and gives the next model the same first-part budget", async () => {
    vi.useFakeTimers();
    streamScripts.push({ kind: "hang" }, { kind: "ok", text: JSON.stringify(modelResult) });
    const cache = cacheChain();
    useSupabase(cache);

    const responsePromise = aiSquadPOST(squadRequest());
    await waitForStreamCall(1);
    const firstSignal = streamCalls[0].abortSignal;
    await vi.advanceTimersByTimeAsync(8_100);
    const response = await responsePromise;

    expect(firstSignal?.aborted).toBe(true);
    expect(response.status).toBe(200);
    expect(streamCalls.map(call => call.modelName)).toEqual(GEMINI_MODELS_TO_TRY.slice(0, 2));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not switch models after the response has started; a mid-stream error becomes the facts-only contract", async () => {
    streamScripts.push({ kind: "error-mid", partial: "{\"squadGrade\":\"A\",", error: new Error("stream reset") }, {
      kind: "ok", text: JSON.stringify(modelResult),
    });
    const cache = cacheChain();
    useSupabase(cache);

    const response = await aiSquadPOST(squadRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ mode: "facts_only", aiInterpretation: false, errorCode: "PUBG_AI_SQUAD_FACTS_ONLY", reason: "provider", retryable: true });
    expect(streamCalls).toHaveLength(1);
    expect(cache.upsert).not.toHaveBeenCalled();
    expect(mockTrackAiFailure).toHaveBeenCalledWith("user-1", "squad", "All Gemini models failed to respond", expect.objectContaining({ errorCode: "model" }));
  });

  it("returns facts-only with reason timeout and records a timeout code when every model misses its first part", async () => {
    vi.useFakeTimers();
    for (let index = 0; index < GEMINI_MODELS_TO_TRY.length; index += 1) streamScripts.push({ kind: "hang" });
    const cache = cacheChain();
    useSupabase(cache);

    const responsePromise = aiSquadPOST(squadRequest());
    await waitForStreamCall(1);
    await vi.advanceTimersByTimeAsync(31_000);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "facts_only", reason: "timeout", errorCode: "PUBG_AI_SQUAD_FACTS_ONLY" });
    expect(streamCalls).toHaveLength(GEMINI_MODELS_TO_TRY.length);
    expect(cache.upsert).not.toHaveBeenCalled();
    expect(mockTrackAiFailure).toHaveBeenCalledWith("user-1", "squad", "Squad Gemini models timed out", expect.objectContaining({ errorCode: "timeout" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses to call any model below three matches and never reads the cache for that case", async () => {
    mockGetSquadAnalysisData.mockResolvedValue(squadFixture({
      matchCount: 2,
      selectedMatchIds: ["match-2", "match-1"],
      matchesSummary: [
        { matchId: "match-2", mapName: "Baltic_Main", winPlace: 2, createdAt: recentIso(1) },
        { matchId: "match-1", mapName: "Baltic_Main", winPlace: 4, createdAt: recentIso(2) },
      ],
    }));
    const cache = cacheChain({ data: { ai_result: modelResult }, error: null });
    useSupabase(cache);

    const response = await aiSquadPOST(squadRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "PUBG_SQUAD_TOO_FEW_MATCHES", retryable: false, minMatchCount: 3, matchCount: 2 });
    expect(streamCalls).toHaveLength(0);
    expect(cache.maybeSingle).not.toHaveBeenCalled();
    expect(mockTrackAiFailure).toHaveBeenCalledWith("user-1", "squad", "squad matches below the AI minimum", expect.objectContaining({ errorCode: "too_few_matches" }));
  });

  it("generates with exactly three matches", async () => {
    streamScripts.push({ kind: "ok", text: JSON.stringify(modelResult) });
    useSupabase(cacheChain());

    const response = await aiSquadPOST(squadRequest());

    expect(response.status).toBe(200);
    expect(streamCalls).toHaveLength(1);
  });

  it("with the operator switch on, serves a cache hit but calls no model on a miss", async () => {
    vi.stubEnv("PUBG_AI_GENERATION_DISABLED", "true");
    const hitCache = cacheChain({ data: { ai_result: modelResult }, error: null });
    useSupabase(hitCache);
    const hit = await aiSquadPOST(squadRequest());
    expect(hit.status).toBe(200);
    expect(await hit.json()).toMatchObject({ squadGrade: "A" });
    expect(streamCalls).toHaveLength(0);

    const missCache = cacheChain();
    useSupabase(missCache);
    const miss = await aiSquadPOST(squadRequest());
    expect(miss.status).toBe(200);
    expect(await miss.json()).toMatchObject({ mode: "facts_only", reason: "disabled", errorCode: "PUBG_AI_SQUAD_FACTS_ONLY" });
    expect(streamCalls).toHaveLength(0);
    expect(missCache.upsert).not.toHaveBeenCalled();
    expect(mockTrackAiFailure).toHaveBeenCalledWith("user-1", "squad", "AI generation is disabled by operator switch", expect.objectContaining({ errorCode: "generation_disabled" }));
  });

  it("applies the squad ability guard to cached results and strips unmeasured shooting or brain claims", async () => {
    const cached = {
      ...modelResult,
      summary: "팀 기여가 큽니다. 에임이 좋습니다. 백업 반응 속도는 8초입니다.",
      memberFeedbacks: [{ name: "Player_A", praise: "뇌 빼고 배그함? 손가락 압수 마렵다.", fault: "기록이 부족해 판단을 보류합니다.", advice: "명중률을 올리세요." }],
    };
    useSupabase(cacheChain({ data: { ai_result: cached }, error: null }));

    const response = await aiSquadPOST(squadRequest());
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(text).not.toMatch(/에임|명중률|뇌|손가락/);
    expect(text).toContain("팀 기여가 큽니다.");
    expect(text).toContain("백업 반응 속도는 8초입니다.");
    expect(text).toContain(COACHING_JUDGMENT_WITHHELD);
    expect(streamCalls).toHaveLength(0);
  });

  it("applies the same ability guard to freshly generated results before they are cached", async () => {
    streamScripts.push({ kind: "ok", text: JSON.stringify({ ...modelResult, weakness: "집중력이 떨어져 실수가 많습니다. 간격이 벌어졌습니다." }) });
    const cache = cacheChain();
    useSupabase(cache);

    const response = await aiSquadPOST(squadRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.weakness).toBe("간격이 벌어졌습니다.");
    expect(cache.upsert.mock.calls[0][0].ai_result.weakness).toBe("간격이 벌어졌습니다.");
  });

  it("stops an in-flight model call when the caller aborts and returns the aborted contract without caching", async () => {
    streamScripts.push({ kind: "hang" });
    const cache = cacheChain();
    useSupabase(cache);
    const controller = new AbortController();

    const responsePromise = aiSquadPOST(squadRequest({}, controller.signal));
    await waitForStreamCall(1);
    controller.abort();
    const response = await responsePromise;

    expect(streamCalls[0].abortSignal?.aborted).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: "PUBG_AI_SQUAD_ABORTED", retryable: true });
    expect(streamCalls).toHaveLength(1);
    expect(cache.upsert).not.toHaveBeenCalled();
  });

  it("returns facts-only when the model output is not parseable JSON and does not cache it", async () => {
    streamScripts.push({ kind: "ok", text: "" , usage: { inputTokens: 5, outputTokens: 0 } });
    const cache = cacheChain();
    useSupabase(cache);

    const response = await aiSquadPOST(squadRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "facts_only", reason: "provider" });
    expect(cache.upsert).not.toHaveBeenCalled();
    expect(mockTrackAiUsage).toHaveBeenCalledWith("user-1", GEMINI_MODELS_TO_TRY[0], 5, 0, "squad", expect.any(Object));
    expect(mockTrackAiFailure).toHaveBeenCalledWith("user-1", "squad", "Squad AI response JSON invalid", expect.objectContaining({ errorCode: "parse" }));
  });

  it("emits one structured timing line with the agreed keys and no identifiers", async () => {
    streamScripts.push({ kind: "error", error: new Error("gemini unavailable") }, { kind: "ok", text: JSON.stringify(modelResult) });
    useSupabase(cacheChain());

    await aiSquadPOST(squadRequest());

    const lines = (infoSpy.mock.calls as unknown[][])
      .map(call => String(call[0]))
      .filter((line: string) => line.includes("ai-route-timing"));
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({ kind: "ai-route-timing", route: "squad", outcome: "generated" });
    expect(typeof record.requestId).toBe("string");
    expect(Object.keys(record.stages).sort()).toEqual(["auth", "cacheLookup", "dataLoad", "geminiFirstPart", "geminiTotal", "persist", "total"].sort());
    expect(record.attempts).toEqual([
      expect.objectContaining({ model: GEMINI_MODELS_TO_TRY[0], outcome: "error" }),
      expect.objectContaining({ model: GEMINI_MODELS_TO_TRY[1], outcome: "selected" }),
    ]);
    expect(lines[0]).not.toContain("Player_A");
    expect(lines[0]).not.toContain("alpha,beta");
    expect(lines[0]).not.toContain("steam");
  });
});
