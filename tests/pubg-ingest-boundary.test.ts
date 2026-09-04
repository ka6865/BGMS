import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistMatchAnalysisResult } from "@/lib/pubg-analysis/persistMatchAnalysis";
import { noteDatabaseAvailable } from "@/lib/pubg/databaseCircuitBreaker";
import { buildTelemetryCacheKey, buildTelemetryPlayerKey } from "@/lib/pubg-analysis/telemetryCacheKey.server";
import { POPULATION_EVIDENCE_VERSION, RESULT_VERSION, TELEMETRY_VERSION } from "@/lib/pubg-analysis/constants";
import { BENCHMARK_FILTER_VERSION } from "@/lib/pubg-analysis/benchmarkLookup";
import { evaluateMatchEligibility } from "@/lib/pubg-analysis/matchEligibility";

const {
  mockCreateClient,
  mockDeleteObjectsFromR2,
  mockDownloadFromR2,
  mockBuildBenchmarkRow,
  mockUploadToR2,
  mockAnalysisEngine,
  mockAfter,
  mockEngineRun,
  mockFetchTierBenchmarkStats,
  mockFrom,
  mockGlobalBenchmarkMaybeSingle,
  mockPersistMatchAnalysis,
  mockProcessedTelemetryAbortSignal,
  mockProcessedTelemetryMaybeSingle,
  mockProcessedTelemetryRetry,
  mockRpc,
  mockReportPubgApiError,
  mockIsR2Configured,
  mockSupabase,
} = vi.hoisted(() => {
  const mockEngineRun = vi.fn();
  const mockDownloadFromR2 = vi.fn().mockResolvedValue(null);
  const mockUploadToR2 = vi.fn().mockResolvedValue(undefined);
  const mockDeleteObjectsFromR2 = vi.fn().mockResolvedValue({
    deletedCount: 1,
    plannedCount: 1,
    blocked: [],
    failed: [],
    dryRun: false,
  });
  const mockBuildBenchmarkRow = vi.fn((input: any) => ({
    match_id: input?.matchId ?? "match-behavior-1",
    platform: input?.platform ?? "steam",
    player_id: input?.playerNickname ?? "playerone",
    game_mode: "squad-fpp",
    match_type: "official",
    tier: "B",
    filter_version: BENCHMARK_FILTER_VERSION,
    population_evidence_version: POPULATION_EVIDENCE_VERSION,
  }));
  const mockAfter = vi.fn();
  const mockIsR2Configured = vi.fn(() => true);
  const mockAnalysisEngine = vi.fn(function MockAnalysisEngine() {
    return { run: mockEngineRun };
  });
  const mockFetchTierBenchmarkStats = vi.fn().mockResolvedValue({});
  const mockProcessedTelemetryMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const globalBenchmarkFilters: Record<string, unknown> = {};
  const mockGlobalBenchmarkMaybeSingle = vi.fn(() => Promise.resolve({
    data: {
      id: 1,
      match_id: globalBenchmarkFilters.match_id ?? "match-behavior-1",
      player_id: globalBenchmarkFilters.player_id ?? "playerone",
      platform: globalBenchmarkFilters.platform ?? "steam",
      game_mode: "squad-fpp",
      match_type: "official",
      tier: "B",
      filter_version: null,
      population_evidence_version: null,
    },
    error: null,
  }));
  const mockProcessedTelemetryAbortSignal = vi.fn();
  const mockProcessedTelemetryRetry = vi.fn();
  const mockRpc = vi.fn<(name: string) => Promise<any>>((name: string) => Promise.resolve({
    data: name === "claim_telemetry_cache_write" || name === "claim_telemetry_cache_recovery_write"
      ? true
      : name === "finalize_telemetry_cache_recovery"
        ? { ok: true, code: "finalized" }
        : null,
    error: null,
  }));
  const mockFrom = vi.fn((table: string) => {
    if (table === "global_benchmarks") {
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        retry: vi.fn(),
        abortSignal: vi.fn(),
        maybeSingle: mockGlobalBenchmarkMaybeSingle,
      };
      query.select.mockReturnValue(query);
      query.eq.mockImplementation((column: string, value: unknown) => {
        globalBenchmarkFilters[column] = value;
        return query;
      });
      query.retry.mockReturnValue(query);
      query.abortSignal.mockReturnValue(query);
      return query;
    }
    if (table === "processed_match_telemetry") {
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        retry: mockProcessedTelemetryRetry,
        abortSignal: mockProcessedTelemetryAbortSignal,
        maybeSingle: mockProcessedTelemetryMaybeSingle,
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      query.retry.mockReturnValue(query);
      query.abortSignal.mockReturnValue(query);
      return query;
    }

    return { upsert: vi.fn().mockResolvedValue({ error: null }) };
  });
  const mockSupabase = { from: mockFrom, rpc: mockRpc };

  return {
    mockCreateClient: vi.fn(() => mockSupabase),
    mockDeleteObjectsFromR2,
    mockDownloadFromR2,
    mockBuildBenchmarkRow,
    mockUploadToR2,
    mockAnalysisEngine,
    mockAfter,
    mockEngineRun,
    mockFetchTierBenchmarkStats,
    mockFrom,
    mockGlobalBenchmarkMaybeSingle,
    mockPersistMatchAnalysis: vi.fn<(...args: unknown[]) => Promise<PersistMatchAnalysisResult>>(),
    mockProcessedTelemetryAbortSignal,
    mockProcessedTelemetryMaybeSingle,
    mockProcessedTelemetryRetry,
    mockRpc,
    mockReportPubgApiError: vi.fn().mockResolvedValue(undefined),
    mockIsR2Configured,
    mockSupabase,
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (callback: (...args: unknown[]) => unknown) => callback,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mockAfter };
});

vi.mock("@/lib/pubg-analysis/AnalysisEngine", () => ({
  AnalysisEngine: mockAnalysisEngine,
}));

vi.mock("@/lib/pubg-analysis/benchmarkAdapter", () => ({
  adaptBenchmark: vi.fn(() => ({})),
}));

vi.mock("@/lib/pubg-analysis/benchmarkLookup", () => ({
  BENCHMARK_FILTER_VERSION: 8,
  fetchTierBenchmarkStats: mockFetchTierBenchmarkStats,
  isCanonicalBenchmarkTier: (tier: unknown) => typeof tier === "string"
    && ["S+", "S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-"].includes(tier),
}));

  vi.mock("@/lib/pubg-analysis/r2Service", () => ({
  deleteObjectsFromR2: mockDeleteObjectsFromR2,
  downloadFromR2: mockDownloadFromR2,
  getPresignedUrlFromR2: vi.fn().mockResolvedValue("https://r2.example/signed"),
  isR2Configured: mockIsR2Configured,
  uploadToR2: mockUploadToR2,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/pubg-analysis/pubgApiTracker", () => ({
  trackPubgRateLimit: vi.fn(),
}));

vi.mock("@/lib/pubg-analysis/persistMatchAnalysis", () => ({
  buildBenchmarkRow: mockBuildBenchmarkRow,
  persistMatchAnalysis: mockPersistMatchAnalysis,
}));

vi.mock("@/lib/pubg/apiHelper", () => ({
  reportPubgApiError: mockReportPubgApiError,
}));

import * as matchRoute from "../app/api/pubg/match/route";
import { GET as GET_TELEMETRY } from "../app/api/pubg/telemetry/route";

const { GET } = matchRoute;

const MATCH_ROUTE_PATH = resolve("app/api/pubg/match/route.ts");
const PERSIST_MODULE_PATH = resolve("lib/pubg-analysis/persistMatchAnalysis.ts");
const SCRAPER_PATH = resolve("scripts/scrape_elite.ts");
const DAILY_TASKS_WORKFLOW_PATH = resolve(".github/workflows/daily-tasks.yml");
const SOURCE_ROOTS = ["actions", "app", "components", "hooks", "lib"];
const MATCH_ID = "match-behavior-1";
const NICKNAME = "PlayerOne";
const PLAYER_ID = "account-player-one";

afterEach(() => {
  noteDatabaseAvailable();
  matchRoute.clearMatchNotFoundCache();
});

const matchAttr = {
  mapName: "Baltic_Main",
  gameMode: "squad-fpp",
  matchType: "official",
  createdAt: "2026-07-15T00:00:00Z",
  duration: 1200,
};

const participant = {
  id: "participant-1",
  type: "participant",
  attributes: {
    accountId: PLAYER_ID,
    stats: {
      playerId: PLAYER_ID,
      name: NICKNAME,
      damageDealt: 321,
      kills: 3,
      winPlace: 4,
      timeSurvived: 1000,
    },
  },
};

const roster = {
  id: "roster-1",
  type: "roster",
  relationships: { participants: { data: [{ id: participant.id }] } },
};

const analysisResult = {
  matchType: "official",
  gameMode: "squad-fpp",
  isValidBenchmark: true,
  stats: { ...participant.attributes.stats },
  tradeStats: { tradeKills: 1 },
  killContribution: { solo: 2 },
  isolationData: { isolationIndex: 1 },
  combatPressure: { pressureIndex: 2, utilityStats: { throwCount: 3 } },
  itemUseSummary: { smokes: 2 },
  duelStats: { duelWinRate: 50 },
  itemUseStats: { lethalThrowCount: 1 },
  benchmark: { tier: "B", score: 50, breakdown: { combat: 20, tactical: 15, survival: 15 } },
  mapData: { events: [] },
};

function collectTypeScriptFiles(path: string): string[] {
  if (!existsSync(path)) return [];

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function importedNames(file: string, moduleName: string): string[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleName) {
      return [];
    }

    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return [];
    return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
  });
}

function importsPersistModule(file: string): boolean {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  return sourceFile.statements.some((statement) => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && /(?:^|\/)persistMatchAnalysis$/.test(statement.moduleSpecifier.text));
}

function createMatchRequest({
  matchId = MATCH_ID,
  nickname = NICKNAME,
  platform = "steam",
  source = "user",
  force = false,
  host = "localhost",
  scraperToken,
  adminToken,
  recoveryToken,
  secret,
}: {
  matchId?: string;
  nickname?: string;
  platform?: "steam" | "kakao";
  source?: "user" | "scraper";
  force?: boolean;
  host?: string;
  scraperToken?: string;
  adminToken?: string;
  recoveryToken?: string;
  secret?: string;
} = {}) {
  const searchParams = new URLSearchParams({
    matchId,
    nickname,
    platform,
    source,
  });
  if (force) searchParams.set("force", "true");
  if (secret !== undefined) searchParams.set("secret", secret);

  const headers = new Headers();
  if (scraperToken !== undefined) headers.set("Authorization", `Bearer ${scraperToken}`);
  if (adminToken !== undefined) headers.set("X-BGMS-Admin-Token", adminToken);
  if (recoveryToken !== undefined) headers.set("x-benchmark-recovery-token", recoveryToken);

  return new NextRequest(
    `http://${host}/api/pubg/match?${searchParams.toString()}`,
    { headers },
  );
}

function mockPubgMatchResponse({
  upstreamId = MATCH_ID,
  includeAsset = false,
  telemetryUrl = "https://telemetry.example/match-demand.json",
}: {
  upstreamId?: string | null;
  includeAsset?: boolean;
  telemetryUrl?: string;
} = {}) {
  const data: Record<string, unknown> = { attributes: matchAttr };
  if (upstreamId !== null) data.id = upstreamId;
  const included: any[] = [participant, roster];
  if (includeAsset) {
    included.push({ id: "asset-1", type: "asset", attributes: { URL: telemetryUrl } });
  }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    data,
    included,
  }), { status: 200, headers: { "content-type": "application/json" } })));
}

function mockRecoveryMatchResponse(
  telemetryBody: unknown,
  options: {
    telemetryStatus?: number;
    telemetryUrl?: string;
    telemetryResponseUrl?: string;
    telemetryBody?: unknown;
    assetRelationshipId?: string | null;
    includedAssetId?: string;
  } = {},
) {
  const telemetryUrl = options.telemetryUrl
    ?? "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json";
  const responseBody = options.telemetryBody === undefined ? telemetryBody : options.telemetryBody;
  const telemetryResponse = new Response(
    typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    { status: options.telemetryStatus || 200, headers: { "content-type": "application/json" } },
  );
  Object.defineProperty(telemetryResponse, "url", {
    value: options.telemetryResponseUrl ?? telemetryUrl,
  });
  const includedAssetId = options.includedAssetId ?? "asset-1";
  const assetRelationshipId = options.assetRelationshipId === undefined
    ? includedAssetId
    : options.assetRelationshipId;
  const matchData: Record<string, unknown> = { id: MATCH_ID, attributes: matchAttr };
  const included = [
    participant,
    roster,
    { id: includedAssetId, type: "asset", attributes: { URL: telemetryUrl } },
  ];
  if (assetRelationshipId !== null) {
    matchData.relationships = { assets: { data: [{ type: "asset", id: assetRelationshipId }] } };
  }
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      data: matchData,
      included,
    }), { status: 200, headers: { "content-type": "application/json" } }))
    .mockResolvedValueOnce(telemetryResponse);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function validRecoveryTelemetry(platform: "steam" | "kakao" = "steam") {
  const matchDefinition = platform === "kakao"
    ? `match.bro.official.pc-2018-42.kakao.squad.kakao.2026.07.15.00.${MATCH_ID}`
    : `match.bro.competitive.pc-2018-42.steam.duo.as.2026.07.15.12.${MATCH_ID}`;
  return [
    {
      _T: "LogMatchDefinition",
      MatchId: matchDefinition,
      _D: matchAttr.createdAt,
    },
    { _T: "LogMatchStart", _D: matchAttr.createdAt },
    {
      _T: "LogPlayerAttack",
      _D: "2026-07-15T00:01:00.000Z",
      attacker: { accountId: PLAYER_ID, name: NICKNAME },
      victim: { accountId: "account-enemy", name: "Enemy" },
    },
  ];
}

function recoveryGlobalBenchmarkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    match_id: MATCH_ID,
    player_id: NICKNAME.toLowerCase(),
    platform: "steam",
    game_mode: "squad-fpp",
    match_type: "official",
    tier: "B",
    filter_version: null,
    population_evidence_version: null,
    ...overrides,
  };
}

describe("PUBG ingest architecture boundary", () => {
  it("match route는 Vercel 실행 시간을 45초로 제한한다", () => {
    expect(matchRoute.maxDuration).toBe(45);
  });

  it("공개 ingest route를 제공하지 않는다", () => {
    expect(existsSync(resolve("app/api/pubg/ingest/route.ts"))).toBe(false);
  });

  it("제품 코드가 임시 HTTP ingest 경계와 secret/origin 설정을 참조하지 않는다", () => {
    const productFiles = SOURCE_ROOTS
      .flatMap((root) => collectTypeScriptFiles(resolve(root)))
      .map((file) => ({ file, source: readFileSync(file, "utf8") }));

    for (const forbiddenReference of [
      "/api/pubg/ingest",
      "PUBG_INGEST_INTERNAL_SECRET",
      "PUBG_INGEST_INTERNAL_ORIGIN",
      "requestUrl",
      "dispatchIngestRequest",
    ]) {
      const offenders = productFiles
        .filter(({ source }) => source.includes(forbiddenReference))
        .map(({ file }) => file);
      expect(offenders, forbiddenReference).toEqual([]);
    }
  });

  it("TypeScript import 선언 기준으로 persist 모듈 consumer를 match route 하나로 제한한다", () => {
    const consumers = SOURCE_ROOTS
      .flatMap((root) => collectTypeScriptFiles(resolve(root)))
      .filter((file) => file !== PERSIST_MODULE_PATH)
      .filter(importsPersistModule);

    expect(consumers).toEqual([MATCH_ROUTE_PATH]);
    expect(importedNames(
      MATCH_ROUTE_PATH,
      "@/lib/pubg-analysis/persistMatchAnalysis",
    )).toContain("persistMatchAnalysis");
    expect(readFileSync(MATCH_ROUTE_PATH, "utf8")).not.toMatch(/^\s*["']use client["'];?/m);
  });

  it("match·telemetry route가 서버 identity를 API identity로 직접 반환하지 않는다", () => {
    const matchSource = readFileSync(MATCH_ROUTE_PATH, "utf8");
    const telemetrySource = readFileSync(resolve("app/api/pubg/telemetry/route.ts"), "utf8");

    expect(matchSource).toContain("buildTelemetryPublicIdentity(telemetryIdentity)");
    expect(telemetrySource).toContain("identity: cacheAccess.cache.payload.identity");
    expect(telemetrySource).toContain("identity: cachedResult.payload.identity");
    expect(telemetrySource).not.toMatch(/downloadUrl:\s*(?:cached|cachedResult)\.downloadUrl,\s*identity\s*[,}]/);
  });
});

describe("PUBG match persistence behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEngineRun.mockReturnValue(analysisResult);
    mockFetchTierBenchmarkStats.mockResolvedValue({});
    mockDownloadFromR2.mockResolvedValue(null);
    mockIsR2Configured.mockReturnValue(true);
    mockPersistMatchAnalysis.mockResolvedValue({ succeeded: [], failures: [] });
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockGlobalBenchmarkMaybeSingle.mockClear();
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === "claim_telemetry_cache_write" || name === "claim_telemetry_cache_recovery_write"
        ? true
        : name === "finalize_telemetry_cache_recovery"
          ? { ok: true, code: "finalized" }
          : null,
      error: null,
    }));
    mockPubgMatchResponse();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("정상 분석 결과를 canonical 전체 입력으로 한 번 직접 저장한다", async () => {
    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ matchId: MATCH_ID }));
    expect(mockPersistMatchAnalysis).toHaveBeenCalledTimes(1);
    expect(mockPersistMatchAnalysis).toHaveBeenCalledWith(
      mockSupabase,
      {
        matchId: MATCH_ID,
        playerNickname: NICKNAME.toLowerCase(),
        platform: "steam",
        finalResult: expect.objectContaining({
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
          stats: expect.objectContaining({ name: NICKNAME }),
        }),
        matchAttr,
        rawParticipants: [participant],
        source: "user",
        forceBenchmark: false,
      },
    );
  });

  it("canonical finalResult가 match custom/event evidence를 보존하고 공통 판정기가 소비한다", async () => {
    const telemetryUrl = "https://telemetry.example/custom-event.json";
    const customMatchAttr = {
      ...matchAttr,
      isCustomMatch: true,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: MATCH_ID, attributes: customMatchAttr },
        included: [
          participant,
          roster,
          { id: "asset-1", type: "asset", attributes: { URL: telemetryUrl } },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        _T: "LogMatchStart",
        isCustomGame: true,
        isEventMode: true,
      }]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    const persistInput = mockPersistMatchAnalysis.mock.calls[0]?.[1] as {
      finalResult?: Record<string, unknown>;
      matchAttr?: Record<string, unknown>;
    };
    expect(persistInput.matchAttr).toMatchObject({ isCustomMatch: true });
    expect(persistInput.finalResult).toMatchObject({
      attributes: { isCustomMatch: true },
      telemetryFlags: { isCustomGame: true, isEventMode: true },
    });
    expect(evaluateMatchEligibility(persistInput.finalResult, "ai-summary")).toMatchObject({
      eligible: false,
      reason: "custom_match",
    });
    const telemetryOnly = {
      ...persistInput.finalResult,
      attributes: undefined,
    };
    expect(evaluateMatchEligibility(telemetryOnly, "ai-summary")).toMatchObject({
      eligible: false,
      reason: "custom_match",
    });
  });

  it("route가 분석 대상 player cache를 persist 경로 밖에서 중복 upsert하지 않는다", async () => {
    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(mockFrom).not.toHaveBeenCalledWith("pubg_player_cache");
    expect(mockPersistMatchAnalysis).toHaveBeenCalledTimes(1);
  });

  it("processed telemetry 캐시 조회에 요청 중단 신호를 건다", async () => {
    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(mockProcessedTelemetryRetry).toHaveBeenCalledWith(false);
    expect(mockProcessedTelemetryAbortSignal).toHaveBeenCalledTimes(1);
    expect(mockProcessedTelemetryAbortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("R2 hit 뒤 processed telemetry 조회 장애도 재시도 없이 회로를 연다", async () => {
    mockDownloadFromR2.mockResolvedValueOnce(JSON.stringify({
      identity: {
        matchId: MATCH_ID,
        platform: "steam",
        playerKey: buildTelemetryPlayerKey(PLAYER_ID),
        mode: "lite",
        telemetryVersion: TELEMETRY_VERSION,
      },
      startTime: matchAttr.createdAt,
      teammates: [],
      teamNames: [NICKNAME],
      events: [],
      zoneEvents: [],
      mapName: matchAttr.mapName,
    }));
    mockProcessedTelemetryMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "PGRST002", message: "schema cache unavailable" },
        status: 503,
      });

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(503);
    expect(mockProcessedTelemetryRetry).toHaveBeenCalledTimes(2);
    expect(mockProcessedTelemetryAbortSignal).toHaveBeenCalledTimes(2);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it.each([
    ["mismatch", "match-upstream-other"],
    ["missing", null],
  ])("upstream match data.id %s는 참가자·telemetry·R2·DB 처리 전에 sanitized 400으로 닫힌다", async (_label, upstreamId) => {
    mockPubgMatchResponse({ upstreamId });

    const response = await GET(createMatchRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "PUBG 응답 매치 식별자가 요청과 일치하지 않습니다.",
      errorCode: "PUBG_MATCH_UPSTREAM_IDENTITY_MISMATCH",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromR2).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("match-upstream-other");
  });

  it.each([
    ["storage mismatch", { match_id: "match-other" }],
    ["storage missing", {}],
    ["embedded missing", { match_id: MATCH_ID, data: { fullResult: { ...analysisResult, player_id: NICKNAME.toLowerCase(), platform: "steam", v: RESULT_VERSION } } }],
  ])("processed row %s는 strict match identity miss로 처리하고 새 분석을 실행한다", async (_label, row) => {
    mockProcessedTelemetryMaybeSingle.mockResolvedValueOnce({
      data: row,
      error: null,
    });

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(mockAnalysisEngine).toHaveBeenCalledTimes(1);
    expect(mockPersistMatchAnalysis).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("unmarked current v73 processed row is a cache miss and reanalyzes once", async () => {
    mockProcessedTelemetryMaybeSingle.mockResolvedValueOnce({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: {
          fullResult: {
            ...analysisResult,
            v: RESULT_VERSION,
            matchId: MATCH_ID,
            player_id: NICKNAME.toLowerCase(),
            platform: "steam",
          },
        },
      },
      error: null,
    });
    mockPubgMatchResponse();

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockAnalysisEngine).toHaveBeenCalledTimes(1);
    expect(mockPersistMatchAnalysis).toHaveBeenCalledTimes(1);
  });

  it("marked current v73 processed row is reused without needless reanalysis", async () => {
    mockProcessedTelemetryMaybeSingle.mockResolvedValueOnce({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: {
          fullResult: {
            ...analysisResult,
            v: RESULT_VERSION,
            populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
            matchId: MATCH_ID,
            player_id: NICKNAME.toLowerCase(),
            platform: "steam",
          },
        },
      },
      error: null,
    });

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("unmarked current v73 row bypasses the old analyzed R2 envelope before reanalysis", async () => {
    const telemetryUrl = "https://telemetry.example/r2-reanalysis.json";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: MATCH_ID, attributes: matchAttr },
        included: [participant, roster, { id: "asset-1", type: "asset", attributes: { URL: telemetryUrl } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: {
          fullResult: {
            ...analysisResult,
            v: RESULT_VERSION,
            matchId: MATCH_ID,
            player_id: NICKNAME.toLowerCase(),
            platform: "steam",
          },
        },
      },
      error: null,
    });
    mockDownloadFromR2.mockImplementation(async (key: string) => key.endsWith("_analyze.json")
      ? JSON.stringify({
        identity: {
          matchId: MATCH_ID,
          platform: "steam",
          playerKey: buildTelemetryPlayerKey(PLAYER_ID),
          mode: "lite",
          telemetryVersion: TELEMETRY_VERSION,
        },
        events: [{ attacker: { accountId: PLAYER_ID }, victim: { accountId: "account-enemy" } }],
      })
      : null);

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(mockAnalysisEngine).toHaveBeenCalledTimes(1);
    expect(mockPersistMatchAnalysis).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromR2.mock.calls.some(([key]) => String(key).endsWith("_analyze.json"))).toBe(false);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(telemetryUrl);
  });

  it("legacy analyze R2 cache key는 raw nickname 대신 match/platform/account hash identity를 사용한다", async () => {
    const telemetryUrl = "https://telemetry.example/analyze-identity.json";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: MATCH_ID, attributes: matchAttr },
        included: [participant, roster, { id: "asset-1", type: "asset", attributes: { URL: telemetryUrl } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    const analyzeKey = mockDownloadFromR2.mock.calls
      .map(([key]) => String(key))
      .find((key) => key.endsWith("_analyze.json"));
    expect(analyzeKey).toBe(
      `${buildTelemetryCacheKey({
        matchId: MATCH_ID,
        platform: "steam",
        playerId: PLAYER_ID,
        mode: "lite",
        telemetryVersion: TELEMETRY_VERSION,
      }).replace(/\.json$/, "_analyze.json")}`,
    );
    expect(analyzeKey).not.toContain("PlayerOne");
  });

  it("mismatched analyze R2 envelope is a miss and never reaches AnalysisEngine", async () => {
    const telemetryUrl = "https://telemetry.example/analyze-envelope.json";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: MATCH_ID, attributes: matchAttr },
        included: [participant, roster, { id: "asset-1", type: "asset", attributes: { URL: telemetryUrl } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    mockDownloadFromR2.mockImplementation(async (key: string) => key.endsWith("_analyze.json")
      ? JSON.stringify({
        identity: {
          matchId: "match-other",
          platform: "kakao",
          playerKey: buildTelemetryPlayerKey("other-account"),
          mode: "lite",
          telemetryVersion: TELEMETRY_VERSION,
        },
        events: [{ attacker: { accountId: "other-account" } }],
      })
      : null);

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockEngineRun).toHaveBeenCalledTimes(1);
    expect(mockEngineRun.mock.calls[0]?.[0]).toEqual([]);
  });

  it("malformed analyze R2 JSON is a cache miss and refetches raw telemetry", async () => {
    const telemetryUrl = "https://telemetry.example/analyze-malformed.json";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: MATCH_ID, attributes: matchAttr },
        included: [participant, roster, { id: "asset-1", type: "asset", attributes: { URL: telemetryUrl } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    mockDownloadFromR2.mockImplementation(async (key: string) => key.endsWith("_analyze.json")
      ? "{ definitely-not-json"
      : null);

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(telemetryUrl);
    expect(mockEngineRun).toHaveBeenCalledTimes(1);
  });

  it("현재 R2 map cache hit과 stale processed row가 함께 있어도 forced reanalysis가 engine·persistence를 실행한다", async () => {
    vi.stubEnv("ADMIN_REVALIDATE_TOKEN", "admin-token");
    mockDownloadFromR2.mockResolvedValueOnce(JSON.stringify({
      identity: {
        matchId: MATCH_ID,
        platform: "steam",
        playerKey: buildTelemetryPlayerKey(PLAYER_ID),
        mode: "lite",
        telemetryVersion: TELEMETRY_VERSION,
      },
      startTime: matchAttr.createdAt,
      teammates: [],
      teamNames: [NICKNAME],
      events: [],
      zoneEvents: [],
      mapName: matchAttr.mapName,
    }));
    mockProcessedTelemetryMaybeSingle.mockResolvedValueOnce({
      data: {
        data: {
          fullResult: {
            ...analysisResult,
            v: RESULT_VERSION - 1,
            matchId: MATCH_ID,
            player_id: NICKNAME.toLowerCase(),
            platform: "steam",
            mapData: undefined,
          },
        },
      },
      error: null,
    });

    const response = await GET(createMatchRequest({ force: true, adminToken: "admin-token" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.v).toBe(RESULT_VERSION);
    expect(mockAnalysisEngine).toHaveBeenCalledTimes(1);
    expect(mockPersistMatchAnalysis).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        finalResult: expect.objectContaining({ v: RESULT_VERSION }),
      }),
    );
  });

  it("신규 분석 응답은 raw mapData를 반환하지 않는다", async () => {
    const response = await GET(createMatchRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("mapData");
    expect(JSON.stringify(body)).not.toContain(PLAYER_ID);
  });

  it("PUBG telemetry asset 다운로드에 요청 중단 신호를 건다", async () => {
    const telemetryUrl = "https://telemetry.example/match-demand.json";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: MATCH_ID, attributes: matchAttr },
        included: [
          participant,
          roster,
          { id: "asset-1", type: "asset", attributes: { URL: telemetryUrl } },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(telemetryUrl);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it("분석 엔진에 요청 nickname이 아닌 PUBG canonical nickname을 전달한다", async () => {
    const response = await GET(createMatchRequest({ nickname: NICKNAME.toLowerCase() }));

    expect(response.status).toBe(200);
    expect(mockAnalysisEngine).toHaveBeenCalledWith(
      NICKNAME,
      PLAYER_ID,
      expect.any(Set),
      expect.any(Set),
      expect.any(Set),
      expect.any(Set),
      expect.any(String),
    );
  });

  it.each([
    ["returned failures", () => mockPersistMatchAnalysis.mockResolvedValue({
      succeeded: [],
      failures: [{ taskName: "match_stats_raw", message: "secret payload PlayerOne match-behavior-1 db-message" }],
    })],
    ["Promise reject", () => mockPersistMatchAnalysis.mockRejectedValue(
      new Error("secret payload PlayerOne match-behavior-1 rejected-message"),
    )],
  ])("persist %s에도 match 응답을 성공시키고 민감 정보를 로그에 남기지 않는다", async (_case, arrange) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    arrange();

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ matchId: MATCH_ID }));
    expect(mockReportPubgApiError).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const serializedLog = JSON.stringify(consoleError.mock.calls);
    for (const sensitiveValue of [
      "secret",
      "payload",
      NICKNAME,
      NICKNAME.toLowerCase(),
      PLAYER_ID,
      MATCH_ID,
      "db-message",
      "rejected-message",
    ]) {
      expect(serializedLog).not.toContain(sensitiveValue);
    }
    expect(serializedLog).toMatch(/match_stats_raw|파생 통계 저장 중 예외 발생/);
    consoleError.mockRestore();
  });

  it("processed telemetry와 cache lifecycle을 canonical identity RPC로 한 번 finalize한다", async () => {
    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ matchId: MATCH_ID }));
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenCalledWith(
      "finalize_telemetry_cache_write",
      expect.objectContaining({
        p_match_id: MATCH_ID,
        p_platform: "steam",
        p_map_name: "Baltic_Main",
        p_game_mode: "squad-fpp",
        p_processed_platform: "steam",
        p_processed_player_id: NICKNAME.toLowerCase(),
        p_processed_data: {
          fullResult: expect.objectContaining({
            matchId: MATCH_ID,
            platform: "steam",
            player_id: NICKNAME.toLowerCase(),
          }),
        },
      }),
    );
  });

  it("단일 match 분석은 telemetry registry write lease를 한 번 claim한다", async () => {
    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      "claim_telemetry_cache_write",
      expect.objectContaining({
        p_match_id: MATCH_ID,
        p_platform: "steam",
        p_player_id: PLAYER_ID,
      }),
    );
  });

  it("claim 오류가 발생하면 분석을 시작하지 않는다", async () => {
    mockRpc.mockImplementation(() => Promise.resolve({
      data: null,
      error: { code: "57014", status: 500, message: `statement timeout ${PLAYER_ID}` },
      status: 500,
    }));
    const response = await GET(createMatchRequest());

    expect(response.status).toBe(500);
    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockReportPubgApiError).toHaveBeenCalledWith(expect.objectContaining({
      route: "/api/pubg/match",
      status: 500,
      message: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_RESERVE",
      notify: true,
      context: expect.objectContaining({
        failureStage: "analysis:telemetry_cache_reserve",
        errorCode: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_RESERVE",
      }),
    }));
  });

  it("캐시 최종화 재시도 소진에도 민감정보 없이 매치 분석 결과를 반환한다", async () => {
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === "claim_telemetry_cache_write"
      ? { data: true, error: null }
      : {
          data: null,
          error: {
            code: "57014",
            status: 500,
            message: `statement timeout ${PLAYER_ID}`,
          },
          status: 500,
        }));

    const response = await GET(createMatchRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ matchId: MATCH_ID }));
    expect(mockRpc).toHaveBeenCalledTimes(7);
    expect(mockPersistMatchAnalysis).toHaveBeenCalledTimes(1);
    expect(mockReportPubgApiError).toHaveBeenCalledWith(expect.objectContaining({
      route: "/api/pubg/match",
      status: 503,
      message: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE",
      notify: true,
      context: expect.objectContaining({
        failureStage: "analysis:telemetry_cache_persistence",
        errorCode: "PUBG_MATCH_ANALYSIS_TELEMETRY_CACHE_PERSISTENCE",
      }),
    }));
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).not.toContain("statement timeout");
    expect(serializedBody).not.toContain(PLAYER_ID);
    const serializedReport = JSON.stringify(mockReportPubgApiError.mock.calls);
    expect(serializedReport).not.toContain("statement timeout");
    expect(serializedReport).not.toContain(PLAYER_ID);
    const reportInput = mockReportPubgApiError.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(reportInput?.detail))).toEqual({
      operation: "finalize",
      code: "57014",
      status: 500,
      retryCount: 2,
      elapsedMs: expect.any(Number),
    });
  });

  it("캐시 실패 관측이 reject되어도 중복 보고 없이 매치 분석 결과를 반환한다", async () => {
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === "claim_telemetry_cache_write"
      ? { data: true, error: null }
      : { data: null, error: { code: "22023", message: "invalid cache input" }, status: 400 }));
    mockReportPubgApiError.mockRejectedValueOnce(new Error("monitoring unavailable"));

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ matchId: MATCH_ID }));
    expect(mockPersistMatchAnalysis).toHaveBeenCalledTimes(1);
    expect(mockReportPubgApiError).toHaveBeenCalledTimes(1);
  });

  it("비일시적 캐시 최종화 실패는 실제 retry 횟수 0으로 관측한다", async () => {
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === "claim_telemetry_cache_write"
      ? { data: true, error: null }
      : { data: null, error: { code: "22023", message: "invalid cache input" }, status: 400 }));

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(3);
    const reportInput = mockReportPubgApiError.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(reportInput?.detail))).toEqual({
      operation: "finalize",
      code: "22023",
      status: 400,
      retryCount: 0,
      elapsedMs: expect.any(Number),
    });
  });

  it("schema cache 장애로 최종화가 실패하면 DB 보고·release·파생 저장을 연쇄 실행하지 않는다", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === "claim_telemetry_cache_write"
      ? { data: true, error: null }
      : {
          data: null,
          error: { code: "PGRST002", message: "schema cache unavailable" },
          status: 503,
        }));

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockRpc.mock.calls.filter(([name]) => name === "release_telemetry_cache_write")).toHaveLength(1);
    expect(mockReportPubgApiError).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("[MATCH] Supabase unavailable during cache persistence; database circuit opened");
    consoleError.mockRestore();
  });

  it("공개 user 요청은 내부 token 환경변수 없이 source=user로 저장한다", async () => {
    vi.stubEnv("PUBG_SCRAPER_INTERNAL_TOKEN", "");
    vi.stubEnv("ADMIN_REVALIDATE_TOKEN", "");

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    expect(mockPersistMatchAnalysis).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({ source: "user" }),
    );
  });

  it("유효한 scraper Bearer만 source=scraper로 저장한다", async () => {
    vi.stubEnv("PUBG_SCRAPER_INTERNAL_TOKEN", "scraper-token");

    const response = await GET(createMatchRequest({
      source: "scraper",
      scraperToken: "scraper-token",
    }));

    expect(response.status).toBe(200);
    expect(mockPersistMatchAnalysis).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({ source: "scraper" }),
    );
  });
});

describe("PUBG match query boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEngineRun.mockReturnValue(analysisResult);
    mockFetchTierBenchmarkStats.mockResolvedValue({});
    mockIsR2Configured.mockReturnValue(true);
    mockDownloadFromR2.mockResolvedValue(null);
    mockPersistMatchAnalysis.mockResolvedValue({ succeeded: [], failures: [] });
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === "claim_telemetry_cache_write" || name === "claim_telemetry_cache_recovery_write"
        ? true
        : name === "finalize_telemetry_cache_recovery"
          ? { ok: true, code: "finalized" }
          : null,
      error: null,
    }));
    mockPubgMatchResponse();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["shard-prefixed", "shard:match-1"],
    ["slash", "bad/id"],
    ["space", "bad id"],
    ["empty", ""],
    ["too long", "a".repeat(161)],
  ])("non-canonical matchId (%s)는 DB·PUBG·R2·mock 경계 전에 400으로 거부한다", async (_label, matchId) => {
    const response = await GET(createMatchRequest({ matchId }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "유효한 matchId 파라미터가 필요합니다.",
      errorCode: "PUBG_MATCH_INVALID_ID",
      retryable: false,
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mockDownloadFromR2).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
  });

  it.each([
    ["mismatch", "match-other-upstream"],
    ["missing", null],
  ])("telemetry upstream data.id %s는 asset fetch/R2/DB persistence 전에 sanitized 400으로 닫힌다", async (_label, upstreamId) => {
    const telemetryUrl = "https://telemetry.example/upstream-identity.json";
    const included: any[] = [participant, roster, {
      id: "asset-1",
      type: "asset",
      attributes: { URL: telemetryUrl },
    }];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: upstreamId === null
        ? { attributes: matchAttr }
        : { id: upstreamId, attributes: matchAttr },
      included,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET_TELEMETRY(new Request(
      `http://localhost/api/pubg/telemetry?matchId=${MATCH_ID}&nickname=${NICKNAME}&platform=steam&mode=lite`,
    ));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "PUBG 응답 매치 식별자가 요청과 일치하지 않습니다.",
      errorCode: "PUBG_MATCH_UPSTREAM_IDENTITY_MISMATCH",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromR2).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("match-other-upstream");
  });

  it.each([
    ["platform", "xbox"],
    ["source", "external"],
  ])("허용되지 않은 %s를 저장 처리 전 400으로 거부한다", async (key, value) => {
    const response = await GET(new NextRequest(
      `http://localhost/api/pubg/match?matchId=match-1&nickname=PlayerOne&${key}=${value}`,
    ));

    expect(response.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockReportPubgApiError).not.toHaveBeenCalled();
  });

  it.each([
    ["scraper token 환경변수 누락", undefined, undefined, 503],
    ["scraper token 환경변수 공백", "   ", undefined, 503],
    ["scraper Authorization 누락", "scraper-token", undefined, 403],
    ["scraper Authorization 불일치", "scraper-token", "wrong-token", 403],
  ])("%s 시 PUBG API·DB 진입 전 거부한다", async (_case, envToken, headerToken, status) => {
    vi.stubEnv("PUBG_SCRAPER_INTERNAL_TOKEN", envToken ?? "");

    const response = await GET(createMatchRequest({
      source: "scraper",
      scraperToken: headerToken,
    }));

    expect(response.status).toBe(status);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockReportPubgApiError).not.toHaveBeenCalled();
  });

  it.each([
    ["admin token 환경변수 누락", undefined, undefined, 503],
    ["admin token 환경변수 공백", "   ", undefined, 503],
    ["admin header 누락", "admin-token", undefined, 403],
    ["admin header 불일치", "admin-token", "wrong-token", 403],
  ])("force %s 시 캐시·PUBG API·DB 진입 전 거부한다", async (_case, envToken, headerToken, status) => {
    vi.stubEnv("ADMIN_REVALIDATE_TOKEN", envToken ?? "");

    const response = await GET(createMatchRequest({ force: true, adminToken: headerToken }));

    expect(response.status).toBe(status);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("scraper+force는 scraper와 admin scope 두 header를 모두 요구한다", async () => {
    vi.stubEnv("PUBG_SCRAPER_INTERNAL_TOKEN", "scraper-token");
    vi.stubEnv("ADMIN_REVALIDATE_TOKEN", "admin-token");

    const onlyScraper = await GET(createMatchRequest({
      source: "scraper",
      force: true,
      scraperToken: "scraper-token",
    }));
    expect(onlyScraper.status).toBe(403);

    vi.clearAllMocks();
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === "claim_telemetry_cache_write" ? true : null,
      error: null,
    }));
    mockPubgMatchResponse();
    const onlyAdmin = await GET(createMatchRequest({
      source: "scraper",
      force: true,
      adminToken: "admin-token",
    }));
    expect(onlyAdmin.status).toBe(403);

    expect(mockFrom).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("scraper+force의 두 scope가 유효하면 캐시를 우회하고 scraper로 저장한다", async () => {
    vi.stubEnv("PUBG_SCRAPER_INTERNAL_TOKEN", "scraper-token");
    vi.stubEnv("ADMIN_REVALIDATE_TOKEN", "admin-token");

    const response = await GET(createMatchRequest({
      source: "scraper",
      force: true,
      scraperToken: "scraper-token",
      adminToken: "admin-token",
    }));

    expect(response.status).toBe(200);
    expect(mockProcessedTelemetryMaybeSingle).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({ source: "scraper" }),
    );
  });

  it("유효한 admin header는 캐시를 우회하고 query secret은 권한을 부여하지 않는다", async () => {
    vi.stubEnv("ADMIN_REVALIDATE_TOKEN", "admin-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        data: {
          fullResult: {
            v: 72,
            stats: { name: NICKNAME },
            player_id: NICKNAME.toLowerCase(),
            platform: "steam",
            cached: true,
          },
        },
      },
      error: null,
    });

    const querySecretResponse = await GET(createMatchRequest({ force: true, secret: "admin-token" }));
    expect(querySecretResponse.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === "claim_telemetry_cache_write" ? true : null,
      error: null,
    }));
    mockPubgMatchResponse();
    const headerResponse = await GET(createMatchRequest({ force: true, adminToken: "admin-token" }));
    expect(headerResponse.status).toBe(200);
    expect(mockProcessedTelemetryMaybeSingle).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalled();
  });

  it("PUBG API 예외의 player·match·error 원문을 운영 보고에 남기지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new Error(`private-error ${NICKNAME} ${PLAYER_ID} ${MATCH_ID}`),
    ));

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "매치 데이터를 처리할 수 없습니다.",
      errorCode: "PUBG_MATCH_UNKNOWN",
      retryable: true,
    });
    expect(mockReportPubgApiError).toHaveBeenCalledTimes(1);
    const serializedReport = JSON.stringify(mockReportPubgApiError.mock.calls);
    for (const sensitiveValue of ["private-error", NICKNAME, PLAYER_ID, MATCH_ID]) {
      expect(serializedReport).not.toContain(sensitiveValue);
    }
  });

  it("찾을 수 없는 PUBG 매치를 404와 구조화 오류 컨텍스트로 반환한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "PUBG에서 해당 매치 데이터를 더 이상 제공하지 않습니다. 저장된 기본 전적은 계속 확인할 수 있습니다.",
      errorCode: "PUBG_MATCH_NOT_FOUND",
      retryable: false,
    });
    expect(mockReportPubgApiError).toHaveBeenCalledWith(expect.objectContaining({
      route: "/api/pubg/match",
      status: 404,
      message: "PUBG_MATCH_NOT_FOUND",
      notify: false,
      context: expect.objectContaining({ failureStage: "match_fetch", upstreamStatus: 404 }),
    }));

    const secondResponse = await GET(createMatchRequest());
    expect(secondResponse.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockReportPubgApiError).toHaveBeenCalledTimes(1);
  });

  it.each([72, 71])("R2 미설정에서 v%s stale 분석 캐시는 성공 응답으로 제공하지 않는다", async (version) => {
    mockIsR2Configured.mockReturnValue(false);
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: {
          fullResult: {
            ...analysisResult,
            mapData: undefined,
            v: version,
            matchId: MATCH_ID,
            player_id: NICKNAME.toLowerCase(),
            platform: "steam",
          },
        },
      },
      error: null,
    });

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "텔레메트리 캐시 저장소를 사용할 수 없습니다.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("R2 미설정·cache miss면 외부 호출과 engine 전에 503으로 차단한다", async () => {
    mockIsR2Configured.mockReturnValue(false);

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "텔레메트리 캐시 저장소를 사용할 수 없습니다.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
  });

  it("telemetry route도 R2 미설정을 PUBG API 호출 전 503으로 차단한다", async () => {
    mockIsR2Configured.mockReturnValue(false);

    const response = await GET_TELEMETRY(new Request(
      "http://localhost/api/pubg/telemetry?matchId=match-1&nickname=PlayerOne&platform=steam&mode=full",
    ));

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
  });

  it("백그라운드 재분석 실패를 고정된 운영 보고로 연결한다", async () => {
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: {
          fullResult: {
            ...analysisResult,
            v: 71,
            matchId: MATCH_ID,
            player_id: NICKNAME.toLowerCase(),
            platform: "steam",
          },
        },
      },
      error: null,
    });
    mockEngineRun.mockImplementation(() => {
      throw new Error(`background private ${NICKNAME} ${PLAYER_ID} ${MATCH_ID}`);
    });
    const response = await GET(createMatchRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "canonical match analysis is not ready",
      errorCode: "PUBG_AI_CANONICAL_NOT_READY",
      retryable: true,
    });
    expect(mockAfter).toHaveBeenCalledTimes(1);
    const backgroundWork = mockAfter.mock.calls[0]?.[0];
    expect(backgroundWork).toEqual(expect.any(Function));
    await backgroundWork();
    expect(mockReportPubgApiError).toHaveBeenCalledWith({
      route: "/api/pubg/match/revalidate",
      status: 500,
      message: "Background match reanalysis failed",
      detail: "Sanitized background error",
    });
    const serializedReport = JSON.stringify(mockReportPubgApiError.mock.calls);
    for (const sensitiveValue of ["background private", NICKNAME, PLAYER_ID, MATCH_ID]) {
      expect(serializedReport).not.toContain(sensitiveValue);
    }
  });

  it("stale v72은 gate가 꺼져 있으면 기존 409/background 경계를 유지한다", async () => {
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockPubgMatchResponse();

    const response = await GET(createMatchRequest());

    expect(response.status).toBe(409);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
  });

  it("loopback recovery gate enables synchronous v72 reanalysis only with exact token", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(200);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).toHaveBeenCalledTimes(1);
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockBuildBenchmarkRow).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(
      "finalize_telemetry_cache_recovery",
      expect.objectContaining({
        p_processed_guard: expect.objectContaining({
          matchId: MATCH_ID,
          playerId: NICKNAME.toLowerCase(),
          platform: "steam",
          resultVersion: RESULT_VERSION - 1,
          accountId: PLAYER_ID,
        }),
        p_benchmark_guard: expect.objectContaining({
          id: 1,
          matchId: MATCH_ID,
          playerId: NICKNAME.toLowerCase(),
          platform: "steam",
          filterVersion: null,
          populationEvidenceVersion: null,
        }),
        p_rows: expect.objectContaining({
          master: expect.objectContaining({
            match_id: MATCH_ID,
            telemetry_version: TELEMETRY_VERSION,
          }),
          processed: expect.objectContaining({
            match_id: MATCH_ID,
            player_id: NICKNAME.toLowerCase(),
            platform: "steam",
          }),
          benchmark: expect.objectContaining({
            match_id: MATCH_ID,
            filter_version: BENCHMARK_FILTER_VERSION,
            population_evidence_version: POPULATION_EVIDENCE_VERSION,
          }),
        }),
      }),
    );
    const uploadCall = mockUploadToR2.mock.invocationCallOrder[0];
    const finalizeCall = mockRpc.mock.invocationCallOrder[
      mockRpc.mock.calls.findIndex(([name]) => name === "finalize_telemetry_cache_recovery")
    ];
    expect(uploadCall).toBeLessThan(finalizeCall);
    expect((await response.json()).v).toBe(RESULT_VERSION);
  });

  it("recovery finalization failure compensates only the uploaded exact key and owned lease", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
          stats: { ...analysisResult.stats, playerId: PLAYER_ID },
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());
    mockRpc.mockImplementation((name: string, params?: Record<string, unknown>) => Promise.resolve(
      name === "finalize_telemetry_cache_recovery"
        ? { data: { ok: false, code: "processed_guard_mismatch" }, error: null }
        : {
            data: name === "claim_telemetry_cache_recovery_write" ? true : null,
            error: null,
          },
    ));

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_PERSISTENCE_FAILED",
      retryable: false,
    });
    const uploadedKey = mockUploadToR2.mock.calls[0]?.[0];
    expect(uploadedKey).toEqual(expect.stringContaining("telemetry-map/"));
    expect(mockDeleteObjectsFromR2).toHaveBeenCalledWith([uploadedKey], { dryRun: false });
    expect(mockDeleteObjectsFromR2.mock.calls[0]?.[0]).toEqual([uploadedKey]);
    expect(mockRpc).toHaveBeenCalledWith(
      "release_telemetry_cache_write",
      expect.objectContaining({
        p_match_id: MATCH_ID,
        p_player_id: PLAYER_ID,
        p_lease_token: expect.any(String),
      }),
    );
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it.each([
    ["confirmed deletion and release", "PERSISTENCE_FAILED", false, false],
    ["unconfirmed deletion", "COMPENSATION_FAILED", true, false],
    ["unconfirmed lease release", "COMPENSATION_FAILED", false, true],
  ])("recovery upload rejection runs exact-key compensation (%s)", async (
    _label,
    expectedSuffix,
    failDeletion,
    failRelease,
  ) => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
          stats: { ...analysisResult.stats, playerId: PLAYER_ID },
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());
    mockUploadToR2.mockRejectedValueOnce(new Error("upload response lost"));
    if (failDeletion) {
      mockDeleteObjectsFromR2.mockResolvedValueOnce({
        dryRun: false,
        plannedCount: 1,
        deletedCount: 0,
        blocked: [],
        failed: [{ key: "unknown", message: "delete failed" }],
      });
    }
    mockRpc.mockImplementation((name: string) => {
      if (name === "claim_telemetry_cache_recovery_write") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "release_telemetry_cache_write" && failRelease) {
        return Promise.resolve({ data: null, error: { code: "release_failed" }, status: 503 });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: `BENCHMARK_RECOVERY_${expectedSuffix}`,
      retryable: false,
    });
    const uploadedKey = mockUploadToR2.mock.calls[0]?.[0];
    expect(uploadedKey).toEqual(expect.stringContaining("telemetry-map/"));
    expect(mockDeleteObjectsFromR2).toHaveBeenCalledWith([uploadedKey], { dryRun: false });
    expect(mockRpc).toHaveBeenCalledWith("release_telemetry_cache_write", expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith("finalize_telemetry_cache_recovery", expect.anything());
  });

  it("recovery compensates a known SQLSTATE rollback without retrying the RPC", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
          stats: { ...analysisResult.stats, playerId: PLAYER_ID },
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());
    mockRpc.mockImplementation((name: string) => {
      if (name === "finalize_telemetry_cache_recovery") {
        return Promise.resolve({ data: null, error: { code: "23505" }, status: 409 });
      }
      return Promise.resolve({
        data: name === "claim_telemetry_cache_recovery_write" ? true : null,
        error: null,
      });
    });

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_PERSISTENCE_FAILED",
      retryable: false,
    });
    expect(mockRpc.mock.calls.filter(([name]) => name === "finalize_telemetry_cache_recovery")).toHaveLength(1);
    expect(mockDeleteObjectsFromR2).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("release_telemetry_cache_write", expect.anything());
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("recovery reports compensation failure when owned lease release is not confirmed", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
          stats: { ...analysisResult.stats, playerId: PLAYER_ID },
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());
    mockRpc.mockImplementation((name: string) => {
      if (name === "finalize_telemetry_cache_recovery") {
        return Promise.resolve({ data: { ok: false, code: "benchmark_guard_mismatch" }, error: null });
      }
      if (name === "claim_telemetry_cache_recovery_write") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "release_telemetry_cache_write") {
        return Promise.resolve({ data: null, error: { code: "release_failed" }, status: 503 });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_COMPENSATION_FAILED",
      retryable: false,
    });
    expect(mockDeleteObjectsFromR2).toHaveBeenCalledTimes(1);
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("recovery retries an ambiguous RPC response and does not compensate an already-committed state", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
          stats: { ...analysisResult.stats, playerId: PLAYER_ID },
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());
    let finalizeCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name === "finalize_telemetry_cache_recovery") {
        finalizeCalls += 1;
        return finalizeCalls === 1
          ? Promise.reject(new Error("response lost after commit"))
          : Promise.resolve({ data: { ok: true, code: "already_finalized" }, error: null });
      }
      return Promise.resolve({
        data: name === "claim_telemetry_cache_recovery_write" ? true : null,
        error: null,
      });
    });

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(200);
    expect(finalizeCalls).toBe(2);
    expect(mockDeleteObjectsFromR2).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith("release_telemetry_cache_write", expect.anything());
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("recovery refuses a future/current global benchmark marker before telemetry, reservation, or persistence", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockGlobalBenchmarkMaybeSingle.mockResolvedValueOnce({
      data: recoveryGlobalBenchmarkRow({
        filter_version: BENCHMARK_FILTER_VERSION,
        population_evidence_version: POPULATION_EVIDENCE_VERSION,
      }),
      error: null,
    });
    const fetchMock = mockRecoveryMatchResponse(validRecoveryTelemetry());

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_GLOBAL_BENCHMARK_CHANGED",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("recovery rebinds the global legacy marker after reservation and stops on a concurrent advance", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockGlobalBenchmarkMaybeSingle
      .mockResolvedValueOnce({ data: recoveryGlobalBenchmarkRow(), error: null })
      .mockResolvedValueOnce({
        data: recoveryGlobalBenchmarkRow({
          filter_version: BENCHMARK_FILTER_VERSION - 1,
          population_evidence_version: null,
        }),
        error: null,
      });
    const fetchMock = mockRecoveryMatchResponse(validRecoveryTelemetry());

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_GLOBAL_BENCHMARK_CHANGED",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("claim_telemetry_cache_recovery_write", expect.anything());
    expect(mockRpc).toHaveBeenCalledWith("release_telemetry_cache_write", expect.anything());
  });

  it("recovery rejects a v72 account mismatch against the upstream participant before reservation or analysis", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    const mismatchedV72 = {
      match_id: MATCH_ID,
      player_id: NICKNAME.toLowerCase(),
      platform: "steam",
      data: { fullResult: {
        ...analysisResult,
        v: RESULT_VERSION - 1,
        matchId: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        stats: { ...analysisResult.stats, playerId: "account-not-upstream" },
      } },
    };
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({ data: mismatchedV72, error: null });
    const fetchMock = mockRecoveryMatchResponse(validRecoveryTelemetry());

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_PREVIOUS_V72_REQUIRED",
      retryable: false,
    });
    // Only the upstream match request occurs; the telemetry asset fetch and
    // every reservation/engine/R2/DB persistence side effect are untouched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("recovery requires account identity evidence in telemetry even when the nickname matches", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    const telemetryWithoutAccount = [
      ...validRecoveryTelemetry().slice(0, 2),
      {
        _T: "LogPlayerAttack",
        _D: "2026-07-15T00:01:00.000Z",
        attacker: { name: NICKNAME },
        victim: { name: "Enemy" },
      },
    ];
    const fetchMock = mockRecoveryMatchResponse(telemetryWithoutAccount);

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_TELEMETRY_INVALID",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("recovery stops before claiming when the deterministic v61 target already exists", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());
    mockDownloadFromR2.mockResolvedValue("existing-v61-target");

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_TARGET_EXISTS",
      retryable: false,
    });
    expect(mockDownloadFromR2).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("claimed recovery rechecks the canonical row before engine, R2, or persistence side effects", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    const v72 = {
      match_id: MATCH_ID,
      player_id: NICKNAME.toLowerCase(),
      platform: "steam",
      data: { fullResult: {
        ...analysisResult,
        v: RESULT_VERSION - 1,
        matchId: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
      } },
    };
    const v73 = {
      ...v72,
      data: { fullResult: {
        ...v72.data.fullResult,
        v: RESULT_VERSION,
        populationEvidenceVersion: POPULATION_EVIDENCE_VERSION,
      } },
    };
    // Cached gate, GET freshness, pre-claim freshness all observe v72. The
    // post-claim read observes v73 and must release without running the
    // analysis engine or writing R2.
    mockProcessedTelemetryMaybeSingle
      .mockResolvedValueOnce({ data: v72, error: null })
      .mockResolvedValueOnce({ data: v72, error: null })
      .mockResolvedValueOnce({ data: v72, error: null })
      .mockResolvedValueOnce({ data: v73, error: null });
    const fetchMock = mockRecoveryMatchResponse(validRecoveryTelemetry());

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_PREVIOUS_V72_REQUIRED",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("claim_telemetry_cache_recovery_write", expect.anything());
    expect(mockRpc).toHaveBeenCalledWith("release_telemetry_cache_write", expect.anything());
  });

  it("recovery rechecks v72 after benchmark lookup before engine, R2, or persistence side effects", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    const sharedFullResult: Record<string, unknown> = {
      ...analysisResult,
      v: RESULT_VERSION - 1,
      matchId: MATCH_ID,
      player_id: NICKNAME.toLowerCase(),
      platform: "steam",
    };
    const sharedProcessedRow = {
      match_id: MATCH_ID,
      player_id: NICKNAME.toLowerCase(),
      platform: "steam",
      data: { fullResult: sharedFullResult },
    };
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({ data: sharedProcessedRow, error: null });
    // Model another worker finalizing v73 while the route awaits the
    // benchmark lookup. The final recovery read must reject before any
    // AnalysisEngine, R2, or persistence work begins.
    mockFetchTierBenchmarkStats.mockImplementation(async () => {
      const fullResult = sharedProcessedRow.data.fullResult;
      fullResult.v = RESULT_VERSION;
      fullResult.populationEvidenceVersion = POPULATION_EVIDENCE_VERSION;
      return {};
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_PREVIOUS_V72_REQUIRED",
      retryable: false,
    });
    expect(mockFetchTierBenchmarkStats).toHaveBeenCalledTimes(1);
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockEngineRun).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("release_telemetry_cache_write", expect.anything());
  });

  it("recovery accepts the current Kakao telemetry asset shape and binds its MatchId", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "kakao",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "kakao",
        } },
      },
      error: null,
    });
    const telemetryUrl = "https://telemetry-cdn.pubg.com/bluehole-pubg/kakao/2026/07/15/12/45/asset-1-telemetry.json";
    mockRecoveryMatchResponse(validRecoveryTelemetry("kakao"), { telemetryUrl });

    const response = await GET(createMatchRequest({
      platform: "kakao",
      recoveryToken: "canary-token",
    }));

    expect(response.status).toBe(200);
    expect(mockAnalysisEngine).toHaveBeenCalledTimes(1);
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockBuildBenchmarkRow).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(
      "finalize_telemetry_cache_recovery",
      expect.objectContaining({
        p_platform: "kakao",
        p_processed_guard: expect.objectContaining({ platform: "kakao" }),
      }),
    );
  });

  it("recovery gate ignores non-loopback origins even with flag and token", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockPubgMatchResponse();

    const response = await GET(createMatchRequest({ host: "preview.example.com", recoveryToken: "canary-token" }));

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
  });

  it("recovery gate rejects an inexact token and keeps the background boundary", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockPubgMatchResponse();

    const response = await GET(createMatchRequest({ recoveryToken: "wrong-token" }));

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled flag", "false", "canary-token"],
    ["missing server token", "true", "canary-token"],
  ])("recovery header with %s fails closed before PUBG, after, or engine work", async (_label, flag, headerToken) => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", flag);
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", _label === "missing server token" ? "" : "canary-token");
    mockPubgMatchResponse();

    const response = await GET(createMatchRequest({ recoveryToken: headerToken }));

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
  });

  it("an authorized recovery header only enables synchronous reanalysis for immediately previous v72", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 2,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockPubgMatchResponse();

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
  });

  it.each([
    ["no asset", undefined, {}],
    ["404 telemetry", [], { telemetryStatus: 404 }],
    ["empty array", [], {}],
    ["irrelevant events", [{ _T: "LogUnknown", attacker: { accountId: PLAYER_ID } }], {}],
  ])("recovery rejects %s telemetry before engine, DB, or R2 marker", async (_label, payload, options) => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    if (_label === "no asset") {
      mockPubgMatchResponse();
    } else {
      mockRecoveryMatchResponse(payload, options);
    }

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: expect.stringMatching(/^BENCHMARK_RECOVERY_/),
      retryable: false,
    });
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockEngineRun).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ["non-https", "http://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json"],
    ["untrusted host", "https://evil.example/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json"],
    ["private address", "https://127.0.0.1/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json"],
    ["explicit default port", "https://telemetry-cdn.pubg.com:443/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json"],
    ["encoded path", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset%2D1-telemetry.json"],
    ["extra path segment", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset-1/asset-1-telemetry.json"],
    ["repeated path separator", "https://telemetry-cdn.pubg.com/bluehole-pubg//steam/2026/07/15/12/45/asset-1-telemetry.json"],
    ["dot path segment", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/./asset-1-telemetry.json"],
    ["trailing path separator", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json/"],
    ["one-digit hour", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/1/45/asset-1-telemetry.json"],
    ["three-digit hour", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/123/45/asset-1-telemetry.json"],
    ["hour out of range", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/24/00/asset-1-telemetry.json"],
    ["one-digit minute", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/5/asset-1-telemetry.json"],
    ["minute out of range", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/60/asset-1-telemetry.json"],
    ["unrelated telemetry filename", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/other-telemetry.json"],
    ["query marker", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json?"],
    ["hash marker", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json#"],
    ["invalid path", "https://telemetry-cdn.pubg.com/not-telemetry.json"],
    ["empty asset URL", ""],
  ] as const)("recovery rejects %s telemetry asset URL before the telemetry fetch", async (_label, telemetryUrl) => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
    });
    const fetchMock = mockRecoveryMatchResponse(validRecoveryTelemetry(), { telemetryUrl });

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: expect.stringMatching(/^BENCHMARK_RECOVERY_TELEMETRY_(?:INVALID|REQUIRED)$/),
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["redirected host", "https://evil.example/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json"],
    ["same-host wrong path", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/other-telemetry.json"],
    ["same-host query", "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json?cache=1"],
    ["explicit default port", "https://telemetry-cdn.pubg.com:443/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json"],
  ] as const)("recovery rejects telemetry response with %s final URL", async (_label, telemetryResponseUrl) => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
    });
    const telemetryUrl = "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/asset-1-telemetry.json";
    const fetchMock = mockRecoveryMatchResponse(validRecoveryTelemetry(), { telemetryUrl, telemetryResponseUrl });

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_TELEMETRY_INVALID",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ redirect: "error" });
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
  });

  it.each([
    ["missing asset relationship", { assetRelationshipId: null }],
    ["mismatched asset relationship", { assetRelationshipId: "asset-other" }],
    ["malformed asset filename", { telemetryUrl: "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/07/15/12/45/not-telemetry.json" }],
    ["wrong MatchId prefix/platform", { telemetryBody: validRecoveryTelemetry("kakao") }],
    ["wrong telemetry match", { telemetryBody: [
      { _T: "LogMatchDefinition", MatchId: "match-other" },
      { _T: "LogMatchStart", _D: matchAttr.createdAt },
      { _T: "LogPlayerAttack", attacker: { accountId: PLAYER_ID, name: NICKNAME } },
    ] }],
  ] as const)("recovery binds %s to the requested match and canonical asset", async (_label, options) => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
    });
    const telemetryBody = "telemetryBody" in options ? options.telemetryBody : validRecoveryTelemetry();
    const fetchMock = mockRecoveryMatchResponse(telemetryBody, options);

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: expect.stringMatching(/^BENCHMARK_RECOVERY_TELEMETRY_(?:INVALID|REQUIRED)$/),
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(
      "telemetryBody" in options ? 2 : 1,
    );
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("recovery rejects an extra canonical MatchDefinition instead of accepting a valid target among mixed identities", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    const telemetryBody = [
      ...validRecoveryTelemetry(),
      {
        _T: "LogMatchDefinition",
        MatchId: "match.bro.competitive.pc-2018-42.steam.duo.as.2026.07.15.12.other-match",
      },
    ];
    const fetchMock = mockRecoveryMatchResponse(telemetryBody);

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_TELEMETRY_INVALID",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
  });

  it("recovery rejects a canonical telemetry event with no target identity evidence", async () => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse([
      { _T: "LogMatchStart", _D: matchAttr.createdAt },
      { _T: "LogPlayerAttack", attacker: { accountId: "account-other" }, victim: { accountId: "account-enemy" } },
    ]);

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    expect(mockUploadToR2).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ["returned failure", "BENCHMARK_RECOVERY_PERSISTENCE_FAILED", () => mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === "finalize_telemetry_cache_recovery"
        ? { data: { ok: false, code: "benchmark_guard_mismatch" }, error: null }
        : { data: name === "claim_telemetry_cache_recovery_write" ? true : null, error: null },
    ))],
    ["Promise reject", "BENCHMARK_RECOVERY_RECONCILIATION_FAILED", () => mockRpc.mockImplementation((name: string) => (
      name === "finalize_telemetry_cache_recovery"
        ? Promise.reject(new Error("finalize rejected"))
        : Promise.resolve({ data: name === "claim_telemetry_cache_recovery_write" ? true : null, error: null })
    ))],
  ])("authorized recovery turns atomic finalization %s into a non-2xx response", async (_label, expectedErrorCode, arrange) => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
        match_id: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
        data: { fullResult: {
          ...analysisResult,
          v: RESULT_VERSION - 1,
          matchId: MATCH_ID,
          player_id: NICKNAME.toLowerCase(),
          platform: "steam",
        } },
      },
      error: null,
    });
    mockRecoveryMatchResponse(validRecoveryTelemetry());
    arrange();

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: expectedErrorCode,
      retryable: false,
    });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockPersistMatchAnalysis).not.toHaveBeenCalled();
    if (expectedErrorCode === "BENCHMARK_RECOVERY_PERSISTENCE_FAILED") {
      expect(mockDeleteObjectsFromR2).toHaveBeenCalledTimes(1);
    } else {
      expect(mockDeleteObjectsFromR2).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalledWith("release_telemetry_cache_write", expect.anything());
    }
  });

  it.each([
    ["missing", null],
    ["current marked", { v: RESULT_VERSION, populationEvidenceVersion: POPULATION_EVIDENCE_VERSION }],
    ["current unmarked", { v: RESULT_VERSION }],
  ])("authorized recovery header rejects %s cached evidence before PUBG/background/engine work", async (_label, versionFields) => {
    vi.stubEnv("BENCHMARK_RECOVERY_SYNC_STALE", "true");
    vi.stubEnv("BENCHMARK_RECOVERY_TOKEN", "canary-token");
    const cachedData = versionFields === null ? null : {
      match_id: MATCH_ID,
      player_id: NICKNAME.toLowerCase(),
      platform: "steam",
      data: { fullResult: {
        ...analysisResult,
        ...versionFields,
        matchId: MATCH_ID,
        player_id: NICKNAME.toLowerCase(),
        platform: "steam",
      } },
    };
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({ data: cachedData, error: null });
    mockPubgMatchResponse();

    const response = await GET(createMatchRequest({ recoveryToken: "canary-token" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BENCHMARK_RECOVERY_PREVIOUS_V72_REQUIRED",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockAnalysisEngine).not.toHaveBeenCalled();
  });

  it("production background 분기는 Next.js after만 사용한다", () => {
    const source = readFileSync(MATCH_ROUTE_PATH, "utf8");

    expect(source).toMatch(/import\s*\{[^}]*after[^}]*\}\s*from\s*["']next\/server["']/);
    expect(source).toContain("after(async () =>");
    expect(source).not.toContain("request.waitUntil");
  });

  it("Supabase schema cache 장애는 DB 로깅 없이 503으로 빠르게 차단하고 잠시 회로를 연다", async () => {
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: null,
      error: { code: "PGRST002", message: "schema cache unavailable" },
      status: 503,
    });

    const firstResponse = await GET(createMatchRequest());

    expect(firstResponse.status).toBe(503);
    expect(firstResponse.headers.get("retry-after")).toBe("30");
    expect(fetch).not.toHaveBeenCalled();
    expect(mockReportPubgApiError).not.toHaveBeenCalled();
    expect(mockProcessedTelemetryMaybeSingle).toHaveBeenCalledTimes(1);

    const secondResponse = await GET(createMatchRequest());

    expect(secondResponse.status).toBe(503);
    expect(mockProcessedTelemetryMaybeSingle).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("elite scraper caller contract", () => {
  it("daily scraper job은 내부 scraper와 admin 재검증 secret을 모두 전달한다", () => {
    const workflow = readFileSync(DAILY_TASKS_WORKFLOW_PATH, "utf8");
    const scraperStep = workflow.slice(
      workflow.indexOf("- name: Run Smart Scraper"),
      workflow.indexOf("- name: Extract Bluezone Statistics"),
    );

    expect(scraperStep).toContain("PUBG_SCRAPER_INTERNAL_TOKEN: ${{ secrets.PUBG_SCRAPER_INTERNAL_TOKEN }}");
    expect(scraperStep).toContain("ADMIN_REVALIDATE_TOKEN: ${{ secrets.ADMIN_REVALIDATE_TOKEN }}");
  });

  it("query token을 사용하지 않고 주 매치와 sample을 scraper Bearer로 호출한다", () => {
    const source = readFileSync(SCRAPER_PATH, "utf8");

    expect(source).not.toContain("secret=");
    expect(source).toContain("PUBG_SCRAPER_INTERNAL_TOKEN");
    expect(source).toContain("ADMIN_REVALIDATE_TOKEN");
    expect(source).toMatch(/PUBG_SCRAPER_INTERNAL_TOKEN\?\.trim\(\)/);
    expect(source).toMatch(/ADMIN_REVALIDATE_TOKEN\?\.trim\(\)/);
    expect(source.match(/source=scraper/g)).toHaveLength(2);
    expect(source).toMatch(/Authorization:\s*`Bearer \$\{PUBG_SCRAPER_INTERNAL_TOKEN\}`/);
    expect(source).toMatch(/X-BGMS-Admin-Token/);
    expect(source).toContain("describeScraperRequestFailure");
    expect(source).toContain("스크래퍼 요청 실패");
    expect(source).toContain("스크래퍼 실행 요약");
    expect(source).toContain("throw error;");
    expect(source).not.toMatch(/console\.(?:log|error)\([^\n]*(?:nickname|matchId|sampleName|apiErr\.response|error\.message)/);
  });

  it("match route가 query secret을 읽지 않고 non-empty header token만 검증한다", () => {
    const source = readFileSync(MATCH_ROUTE_PATH, "utf8");

    expect(source).not.toMatch(/searchParams\.get\(["']secret["']\)/);
    expect(source).toContain("PUBG_SCRAPER_INTERNAL_TOKEN");
    expect(source).toContain("X-BGMS-Admin-Token");
    expect(source).toContain("timingSafeEqual");
  });
});
