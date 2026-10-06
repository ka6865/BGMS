import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/pubg/telemetry/route";
import { TELEMETRY_VERSION } from "../lib/pubg-analysis/constants";
import { buildTelemetryCacheKey, buildTelemetryPlayerKey } from "../lib/pubg-analysis/telemetryCacheKey.server";
import { resolveHistoricalAccountId, selectHistoricalMapCacheCandidates } from "../lib/pubg-analysis/historicalTelemetryMap";

const mocks = vi.hoisted(() => ({
  from: vi.fn(), guard: vi.fn(), readMap: vi.fn(), downloadR2: vi.fn(), claimMap: vi.fn(), writeMap: vi.fn(),
  readShared: vi.fn(), writeShared: vi.fn(), engineRun: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/pubg/privatePlayerGuard", () => ({ blockPrivatePlayer: mocks.guard }));
vi.mock("@/lib/pubg/apiHelper", () => ({ reportPubgApiError: vi.fn() }));
vi.mock("@/lib/pubg-analysis/r2Service", () => ({
  downloadFromR2: mocks.downloadR2, getPresignedUrlFromR2: vi.fn(), isR2Configured: () => true, uploadToR2: vi.fn(),
}));
vi.mock("@/lib/pubg-analysis/telemetryMapCache", () => ({
  claimOrWaitForTelemetryMapCache: mocks.claimMap, readTelemetryMapCache: mocks.readMap,
  releaseTelemetryMapCacheRow: vi.fn(), writeTelemetryMapCache: mocks.writeMap,
}));
vi.mock("@/lib/pubg-analysis/telemetryRegistry.server", () => ({
  claimTelemetryMapCacheReservation: vi.fn(), finalizeTelemetryMapCacheLifecycle: vi.fn(), releaseTelemetryMapCacheReservation: vi.fn(),
}));
vi.mock("@/lib/pubg-analysis/sharedTelemetrySource", () => ({
  readSharedTelemetrySource: mocks.readShared, writeSharedTelemetrySource: mocks.writeShared,
}));
vi.mock("@/lib/pubg-analysis/AnalysisEngine", () => ({
  AnalysisEngine: class { run(...args: unknown[]) { return mocks.engineRun(...args); } },
}));

const MATCH = "match-history-1";
const ACCOUNT = "account.old-owner";
const NICKNAME = "oldplayer";
const identity = { matchId: MATCH, platform: "steam" as const, playerId: ACCOUNT, mode: "lite" as const };
const matchData = {
  data: {
    id: MATCH,
    attributes: { mapName: "Baltic_Main", mapId: "Baltic_Main", gameMode: "squad-fpp", createdAt: "2026-09-01T10:00:00Z" },
    relationships: { assets: { data: [{ id: "asset-old", type: "asset" }] } },
  },
  included: [
    { id: "participant-old", type: "participant", attributes: { accountId: ACCOUNT, stats: { name: "OldPlayer", playerId: ACCOUNT } } },
    { id: "roster-old", type: "roster", relationships: { participants: { data: [{ id: "participant-old" }] } } },
    { id: "asset-old", type: "asset", attributes: { URL: "https://telemetry-cdn.pubg.com/steam/asset-old-telemetry.json" } },
  ],
};
const shared = {
  sourceFormat: 1, filterVersion: 1, platform: "steam", matchId: MATCH, matchData,
  events: [
    { _T: "LogPlayerPosition", character: { accountId: ACCOUNT, name: "OldPlayer" }, location: { x: 1, y: 2, z: 0 } },
  ], checksum: "private-checksum",
};

function query(data: unknown, error: unknown = null) {
  const q: any = {};
  for (const method of ["select", "eq", "lte", "order", "limit", "abortSignal"]) q[method] = vi.fn(() => q);
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve);
  return q;
}
function request(mode = "lite", platform = "steam") {
  return new Request(`http://localhost/api/pubg/telemetry?matchId=${MATCH}&nickname=OldPlayer&platform=${platform}&mode=${mode}`);
}
function playerMatchRow(accountId = ACCOUNT, playedAt: string | null = "2026-09-01T10:00:00Z") {
  return [{ match_id: MATCH, platform: "steam", player_id: NICKNAME, account_id: accountId, played_at: playedAt }];
}
function mapRow(overrides: Record<string, unknown> = {}) {
  return {
    match_id: MATCH, platform: "steam", player_id: ACCOUNT, mode: "lite",
    telemetry_version: TELEMETRY_VERSION,
    storage_path: buildTelemetryCacheKey({ ...identity, telemetryVersion: TELEMETRY_VERSION }),
    status: "ready", ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T10:00:00Z"));
  vi.clearAllMocks();
  mocks.from.mockImplementation((table: string) => table === "pubg_player_matches" ? query(playerMatchRow())
    : table === "processed_match_telemetry" ? query([]) : table === "telemetry_map_cache_entries" ? query([])
      : (() => { throw new Error(`unexpected table ${table}`); })());
  mocks.guard.mockResolvedValue(null);
  mocks.readMap.mockResolvedValue(null);
  mocks.downloadR2.mockResolvedValue(undefined);
  mocks.claimMap.mockResolvedValue({ kind: "claimed", row: { lease_token: "lease" } });
  mocks.readShared.mockResolvedValue(null);
  mocks.writeShared.mockResolvedValue(undefined);
  mocks.engineRun.mockReturnValue({ mapName: "Baltic_Main", mapData: { teammates: [ACCOUNT], teamNames: ["OldPlayer"], events: [], zoneEvents: [] } });
  mocks.writeMap.mockImplementation(async (requestIdentity: any, payload: any) => ({
    downloadUrl: "https://r2.example/signed-map-only", payload,
    storagePath: buildTelemetryCacheKey(requestIdentity),
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("historical telemetry route", () => {
  it("blocks an expired match before reading a cached replay", async () => {
    mocks.from.mockImplementation((table: string) => table === "pubg_player_matches" ? query(playerMatchRow(ACCOUNT, "2026-08-01T10:00:00Z"))
      : table === "processed_match_telemetry" ? query([]) : table === "telemetry_map_cache_entries" ? query([mapRow()]) : query([]));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(expect.objectContaining({
      errorCode: "PUBG_MATCH_DETAIL_EXPIRED", retryable: false, retentionDays: 14,
    }));
    expect(mocks.readMap).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns retryable 503 when the scoped match date lookup fails", async () => {
    mocks.from.mockImplementation((table: string) => table === "pubg_player_matches" ? query(null, new Error("db unavailable")) : query([]));

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({
      errorCode: "PUBG_MATCH_DETAIL_RETENTION_UNAVAILABLE", retryable: true,
    }));
  });

  it("serves a saved ready map offline after account-aware privacy check", async () => {
    mocks.from.mockImplementation((table: string) => table === "telemetry_map_cache_entries" ? query([mapRow()])
      : table === "pubg_player_matches" ? query(playerMatchRow()) : query([]));
    const publicIdentity = { matchId: MATCH, platform: "steam", playerKey: buildTelemetryPlayerKey(ACCOUNT), mode: "lite", telemetryVersion: TELEMETRY_VERSION };
    mocks.readMap.mockResolvedValue({ downloadUrl: "https://r2.example/private-map", payload: { identity: publicIdentity }, storagePath: mapRow().storage_path });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ downloadUrl: "https://r2.example/private-map", identity: publicIdentity });
    expect(mocks.guard).toHaveBeenCalledWith("steam", "OldPlayer", ACCOUNT);
    expect(mocks.guard).toHaveBeenNthCalledWith(2, "steam", "OldPlayer", ACCOUNT);
    expect(mocks.readMap).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a genuinely missing ready R2 replay with the separate unavailable code", async () => {
    mocks.from.mockImplementation((table: string) => table === "telemetry_map_cache_entries" ? query([mapRow()])
      : table === "pubg_player_matches" ? query(playerMatchRow()) : query([]));
    mocks.downloadR2.mockResolvedValue(null);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(expect.objectContaining({
      errorCode: "PUBG_MATCH_DETAIL_UNAVAILABLE", retryable: false,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs from the shared source without external requests and never returns its source URL", async () => {
    mocks.from.mockImplementation(() => query([]));
    mocks.readShared.mockResolvedValue(shared);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.engineRun).toHaveBeenCalledTimes(1);
    expect(mocks.writeMap).toHaveBeenCalledTimes(1);
    expect(mocks.writeShared).not.toHaveBeenCalled();
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("telemetry-cdn.pubg.com");
    expect(body).not.toContain("private-checksum");
  });

  it("uses authoritative upstream identity when this is the account's first saved match", async () => {
    mocks.from.mockImplementation(() => query([]));
    const telemetryUrl = "https://telemetry-cdn.pubg.com/steam/asset-old-telemetry.json";
    const rawTelemetry = [
      { _T: "LogMatchDefinition", MatchId: `match.bro.official.pc-2018-01.steam.squad.kr.2026.${MATCH}` },
      { _T: "LogPlayerPosition", character: { accountId: ACCOUNT, name: "OldPlayer" }, location: { x: 1, y: 2, z: 0 } },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => matchData })
      .mockResolvedValueOnce({ ok: true, status: 200, url: telemetryUrl, json: async () => rawTelemetry });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.engineRun).toHaveBeenCalledTimes(1);
    expect(mocks.writeShared).toHaveBeenCalledTimes(1);
    expect(mocks.guard).toHaveBeenCalledWith("steam", "OldPlayer", ACCOUNT);
  });

  it("does not write shared events before requested-account telemetry evidence is confirmed", async () => {
    mocks.from.mockImplementation(() => query([]));
    const telemetryUrl = "https://telemetry-cdn.pubg.com/steam/asset-old-telemetry.json";
    const rawTelemetry = [
      { _T: "LogMatchDefinition", MatchId: `match.bro.official.pc-2018-01.steam.squad.kr.2026.${MATCH}` },
      { _T: "LogPlayerPosition", character: { accountId: "account.someone-else", name: "Other" }, location: { x: 1, y: 2, z: 0 } },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => matchData })
      .mockResolvedValueOnce({ ok: true, status: 200, url: telemetryUrl, json: async () => rawTelemetry });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());

    expect(response.status).toBe(400);
    expect(mocks.writeShared).not.toHaveBeenCalled();
    expect(mocks.writeMap).not.toHaveBeenCalled();
  });

  it("still creates the requested map when optional shared retention fails", async () => {
    mocks.from.mockImplementation(() => query([]));
    mocks.writeShared.mockRejectedValueOnce(new Error("shared upload unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const telemetryUrl = "https://telemetry-cdn.pubg.com/steam/asset-old-telemetry.json";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => matchData })
      .mockResolvedValueOnce({ ok: true, status: 200, url: telemetryUrl, json: async () => [
        { _T: "LogMatchDefinition", MatchId: `match.bro.official.pc-2018-01.steam.squad.kr.2026.${MATCH}` },
        { _T: "LogPlayerPosition", character: { accountId: ACCOUNT, name: "OldPlayer" }, location: { x: 1, y: 2, z: 0 } },
      ] }));
    try {
      const response = await GET(request());
      expect(response.status).toBe(200);
      expect(mocks.writeMap).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith("[PUBG shared source] retention failed", {
        route: "/api/pubg/telemetry", platform: "steam", matchId: MATCH,
      });
    } finally { warning.mockRestore(); }
  });

  it("blocks a private account before map reads and signing", async () => {
    mocks.from.mockImplementation((table: string) => table === "telemetry_map_cache_entries" ? query([mapRow()])
      : table === "pubg_player_matches" ? query(playerMatchRow()) : query([]));
    mocks.guard.mockResolvedValue(new Response("private", { status: 403 }));
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(mocks.readMap).not.toHaveBeenCalled();
  });

  it("falls back to upstream after a corrupt or missing map object", async () => {
    mocks.from.mockImplementation((table: string) => table === "telemetry_map_cache_entries" ? query([mapRow()])
      : table === "pubg_player_matches" ? query(playerMatchRow()) : query([]));
    const fetchMock = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.pubg.com/shards/steam/matches/");
  });

  it("fails closed on disagreement between saved account sources", async () => {
    mocks.from.mockImplementation((table: string) => table === "pubg_player_matches"
      ? query(playerMatchRow("account.other"))
      : table === "processed_match_telemetry" ? query([{
        match_id: MATCH, platform: "steam", player_id: NICKNAME,
        data: { fullResult: { player_id: NICKNAME, platform: "steam", stats: { name: "OldPlayer", playerId: ACCOUNT } } },
      }]) : query([]));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.readMap).not.toHaveBeenCalled();
  });

  it("reads a valid older map version and rejects wrong mode, path, and future rows at runtime", async () => {
    const oldVersion = TELEMETRY_VERSION - 1;
    const oldIdentity = { ...identity, telemetryVersion: oldVersion };
    const oldPath = buildTelemetryCacheKey(oldIdentity);
    const rows = [
      mapRow({ telemetry_version: oldVersion, storage_path: oldPath }),
      mapRow({ mode: "full", telemetry_version: oldVersion, storage_path: oldPath }),
      mapRow({ telemetry_version: oldVersion, storage_path: "telemetry-source/v1/steam/match.json" }),
      mapRow({ telemetry_version: TELEMETRY_VERSION + 1 }),
    ];
    mocks.from.mockImplementation((table: string) => table === "telemetry_map_cache_entries" ? query(rows)
      : table === "pubg_player_matches" ? query(playerMatchRow()) : query([]));
    mocks.readMap.mockResolvedValue({
      downloadUrl: "https://r2.example/older-map",
      payload: { identity: { matchId: MATCH, platform: "steam", playerKey: buildTelemetryPlayerKey(ACCOUNT), mode: "lite", telemetryVersion: oldVersion } },
      storagePath: oldPath,
    });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.readMap).toHaveBeenCalledTimes(1);
    expect(mocks.readMap).toHaveBeenCalledWith(oldIdentity, expect.any(Object));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("historical telemetry identity helpers", () => {
  it("resolves top-level legacy account IDs and fails closed on conflicting nested IDs", () => {
    const processed = { match_id: MATCH, platform: "steam", player_id: NICKNAME,
      data: { fullResult: { accountId: ACCOUNT, player_id: NICKNAME, platform: "steam", stats: { name: "OldPlayer" } } } };
    const input = { matchId: MATCH, platform: "steam" as const, playerId: NICKNAME, playerMatchRows: [], processedRows: [processed] };
    expect(resolveHistoricalAccountId(input)).toEqual({ status: "resolved", accountId: ACCOUNT });
    const conflicting = structuredClone(processed);
    (conflicting.data.fullResult.stats as any).playerId = "account.other";
    expect(resolveHistoricalAccountId({ ...input, processedRows: [conflicting] })).toEqual({ status: "conflict" });
  });
  it("accepts unique exact account evidence and rejects ambiguity or platform mismatch", () => {
    const resolve = (playerMatchRows: unknown, processedRows: unknown = []) => resolveHistoricalAccountId({
      matchId: MATCH, platform: "steam", playerId: NICKNAME, playerMatchRows, processedRows,
    });
    expect(resolve(playerMatchRow())).toEqual({ status: "resolved", accountId: ACCOUNT });
    expect(resolve([...playerMatchRow(), ...playerMatchRow("account.other")])).toEqual({ status: "conflict" });
    expect(resolve([{ ...playerMatchRow()[0], platform: "kakao" }])).toEqual({ status: "absent" });
  });

  it("rejects wrong account, platform, mode, path, status and future-version map rows", () => {
    const valid = mapRow();
    expect(selectHistoricalMapCacheCandidates([
      valid, mapRow({ player_id: "account.other" }), mapRow({ platform: "kakao" }),
      mapRow({ mode: "full" }), mapRow({ storage_path: "telemetry-source/v1/steam/match.json" }),
      mapRow({ status: "pending" }), mapRow({ telemetry_version: TELEMETRY_VERSION + 1 }),
    ], identity, TELEMETRY_VERSION)).toEqual([{
      identity: { ...identity, telemetryVersion: TELEMETRY_VERSION }, storagePath: valid.storage_path,
    }]);
  });
});
