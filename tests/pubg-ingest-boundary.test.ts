import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistMatchAnalysisResult } from "@/lib/pubg-analysis/persistMatchAnalysis";

const {
  mockCreateClient,
  mockAnalysisEngine,
  mockAfter,
  mockEngineRun,
  mockFrom,
  mockPersistMatchAnalysis,
  mockProcessedTelemetryMaybeSingle,
  mockRpc,
  mockReportPubgApiError,
  mockIsR2Configured,
  mockSupabase,
} = vi.hoisted(() => {
  const mockEngineRun = vi.fn();
  const mockAfter = vi.fn();
  const mockIsR2Configured = vi.fn(() => true);
  const mockAnalysisEngine = vi.fn(function MockAnalysisEngine() {
    return { run: mockEngineRun };
  });
  const mockProcessedTelemetryMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockFrom = vi.fn((table: string) => {
    if (table === "processed_match_telemetry") {
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: mockProcessedTelemetryMaybeSingle,
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      return query;
    }

    return { upsert: vi.fn().mockResolvedValue({ error: null }) };
  });
  const mockSupabase = { from: mockFrom, rpc: mockRpc };

  return {
    mockCreateClient: vi.fn(() => mockSupabase),
    mockAnalysisEngine,
    mockAfter,
    mockEngineRun,
    mockFrom,
    mockPersistMatchAnalysis: vi.fn<(...args: unknown[]) => Promise<PersistMatchAnalysisResult>>(),
    mockProcessedTelemetryMaybeSingle,
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
  fetchTierBenchmarkStats: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/pubg-analysis/r2Service", () => ({
  downloadFromR2: vi.fn().mockResolvedValue(null),
  getPresignedUrlFromR2: vi.fn().mockResolvedValue("https://r2.example/signed"),
  isR2Configured: mockIsR2Configured,
  uploadToR2: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/pubg-analysis/pubgApiTracker", () => ({
  trackPubgRateLimit: vi.fn(),
}));

vi.mock("@/lib/pubg-analysis/persistMatchAnalysis", () => ({
  persistMatchAnalysis: mockPersistMatchAnalysis,
}));

vi.mock("@/lib/pubg/apiHelper", () => ({
  reportPubgApiError: mockReportPubgApiError,
}));

import { GET } from "../app/api/pubg/match/route";
import { GET as GET_TELEMETRY } from "../app/api/pubg/telemetry/route";

const MATCH_ROUTE_PATH = resolve("app/api/pubg/match/route.ts");
const PERSIST_MODULE_PATH = resolve("lib/pubg-analysis/persistMatchAnalysis.ts");
const SCRAPER_PATH = resolve("scripts/scrape_elite.ts");
const DAILY_TASKS_WORKFLOW_PATH = resolve(".github/workflows/daily-tasks.yml");
const SOURCE_ROOTS = ["actions", "app", "components", "hooks", "lib"];
const MATCH_ID = "match-behavior-1";
const NICKNAME = "PlayerOne";
const PLAYER_ID = "account-player-one";

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
  nickname = NICKNAME,
  source = "user",
  force = false,
  scraperToken,
  adminToken,
  secret,
}: {
  nickname?: string;
  source?: "user" | "scraper";
  force?: boolean;
  scraperToken?: string;
  adminToken?: string;
  secret?: string;
} = {}) {
  const searchParams = new URLSearchParams({
    matchId: MATCH_ID,
    nickname,
    platform: "steam",
    source,
  });
  if (force) searchParams.set("force", "true");
  if (secret !== undefined) searchParams.set("secret", secret);

  const headers = new Headers();
  if (scraperToken !== undefined) headers.set("Authorization", `Bearer ${scraperToken}`);
  if (adminToken !== undefined) headers.set("X-BGMS-Admin-Token", adminToken);

  return new NextRequest(
    `http://localhost/api/pubg/match?${searchParams.toString()}`,
    { headers },
  );
}

function mockPubgMatchResponse() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    data: { attributes: matchAttr },
    included: [participant, roster],
  }), { status: 200, headers: { "content-type": "application/json" } })));
}

describe("PUBG ingest architecture boundary", () => {
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
    expect(telemetrySource).toContain("identity: cached.payload.identity");
    expect(telemetrySource).toContain("identity: cachedResult.payload.identity");
    expect(telemetrySource).not.toMatch(/downloadUrl:\s*(?:cached|cachedResult)\.downloadUrl,\s*identity\s*[,}]/);
  });
});

describe("PUBG match persistence behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEngineRun.mockReturnValue(analysisResult);
    mockIsR2Configured.mockReturnValue(true);
    mockPersistMatchAnalysis.mockResolvedValue({ succeeded: [], failures: [] });
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockRpc.mockResolvedValue({ data: null, error: null });
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

  it("신규 분석 응답은 raw mapData를 반환하지 않는다", async () => {
    const response = await GET(createMatchRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("mapData");
    expect(JSON.stringify(body)).not.toContain(PLAYER_ID);
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
    expect(mockRpc).toHaveBeenCalledTimes(1);
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

  it("단일 match 분석은 telemetry registry reservation을 한 번만 upsert한다", async () => {
    const response = await GET(createMatchRequest());

    expect(response.status).toBe(200);
    const registryCalls = mockFrom.mock.calls
      .filter(([table]) => table === "telemetry_map_cache_entries");
    expect(registryCalls).toHaveLength(1);
  });

  it("초기 캐시 예약 재시도 소진 후 최종 쓰기에서 다시 예약해 분석을 저장한다", async () => {
    let registryAttempts = 0;
    let response: Response | undefined;

    await mockFrom.withImplementation((table: string) => {
      if (table === "processed_match_telemetry") {
        const query = {
          select: vi.fn(),
          eq: vi.fn(),
          maybeSingle: mockProcessedTelemetryMaybeSingle,
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }

      if (table === "telemetry_map_cache_entries") {
        registryAttempts += 1;
        return {
          upsert: vi.fn().mockResolvedValue(registryAttempts <= 3
            ? {
                error: {
                  code: "57014",
                  status: 500,
                  message: `statement timeout ${PLAYER_ID}`,
                },
                status: 500,
              }
            : { error: null, status: 200 }),
        };
      }

      return { upsert: vi.fn().mockResolvedValue({ error: null, status: 200 }) };
    }, async () => {
      response = await GET(createMatchRequest());
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual(expect.objectContaining({ matchId: MATCH_ID }));
    expect(registryAttempts).toBe(4);
    expect(mockRpc).toHaveBeenCalledTimes(1);
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
  });

  it("캐시 최종화 재시도 소진에도 민감정보 없이 매치 분석 결과를 반환한다", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        code: "57014",
        status: 500,
        message: `statement timeout ${PLAYER_ID}`,
      },
      status: 500,
    });

    const response = await GET(createMatchRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ matchId: MATCH_ID }));
    expect(mockRpc).toHaveBeenCalledTimes(3);
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
    mockIsR2Configured.mockReturnValue(true);
    mockPersistMatchAnalysis.mockResolvedValue({ succeeded: [], failures: [] });
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockPubgMatchResponse();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      error: "매치 데이터를 찾을 수 없습니다. 최근 14일 내 매치인지 확인해 주세요.",
    });
    expect(mockReportPubgApiError).toHaveBeenCalledWith(expect.objectContaining({
      route: "/api/pubg/match",
      status: 404,
      message: "PUBG_MATCH_NOT_FOUND",
      notify: false,
      context: expect.objectContaining({ failureStage: "match_fetch", upstreamStatus: 404 }),
    }));
  });

  it.each([72, 71])("R2 미설정에서도 v%s 유효 분석 캐시를 외부 호출 없이 반환한다", async (version) => {
    mockIsR2Configured.mockReturnValue(false);
    mockProcessedTelemetryMaybeSingle.mockResolvedValue({
      data: {
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

    expect(response.status).toBe(200);
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

    expect(response.status).toBe(200);
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

  it("production background 분기는 Next.js after만 사용한다", () => {
    const source = readFileSync(MATCH_ROUTE_PATH, "utf8");

    expect(source).toMatch(/import\s*\{[^}]*after[^}]*\}\s*from\s*["']next\/server["']/);
    expect(source).toContain("after(async () =>");
    expect(source).not.toContain("request.waitUntil");
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
