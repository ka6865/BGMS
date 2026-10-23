import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ops = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/lol/ops.server", () => ({ recordLolOpsMetric: ops.record }));

const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({
  createServiceRoleSupabase: () => db,
}));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: async () => ({ ok: true }) }));

import { POST as moreMatches } from "@/app/api/admin/lol/matches/more/route";

import {
  acquireLolCollectionLease,
  getLolApiCache,
  getLolAccountByRiotId,
  getLolRankedHistory,
  getLolPlayerMatchSummaries,
  emptyLolRankedHistory,
  getLolMatchRequestJson,
  isLolPersistenceEnabled,
  lolMatchCacheKey,
  lolSearchCacheKey,
  LolPermitError,
  recordLolRiotRateHeaders,
  reserveLolRiotRequest,
} from "@/lib/lol/persistence.server";

describe("LoL persistence repository", () => {
  beforeEach(() => {
    ops.record.mockReset();
    db.rpc.mockReset();
    db.rpc.mockImplementation(() => ({
      abortSignal: () => Promise.resolve((db.rpc as any).result),
    }));
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("요약 조회는 정렬·커서 RPC만 호출하며 Riot에 접근하지 않는다", async () => {
    const rows = [{ match_id: "KR_2", played_at: "2026-10-22T12:00:00Z" }];
    (db.rpc as any).result = { data: rows, error: null };
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(getLolPlayerMatchSummaries("owner", 10, "2026-10-23T00:00:00Z")).resolves.toEqual(rows);
    expect(db.rpc).toHaveBeenCalledWith("get_lol_player_match_summaries", {
      p_puuid: "owner", p_limit: 10, p_before: "2026-10-23T00:00:00Z",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("수집은 만료 원문도 재사용하는 서비스 전용 조회를 선택한다", async () => {
    (db.rpc as any).result = { data: { metadata: { matchId: "KR_1" } }, error: null };
    await expect(getLolMatchRequestJson("KR_1", "kr", "asia", true)).resolves.toEqual({ metadata: { matchId: "KR_1" } });
    expect(db.rpc).toHaveBeenCalledWith("get_lol_benchmark_match_source", { p_match_id: "KR_1", p_platform: "kr", p_route: "asia" });
  });

  it("flags off unless explicitly enabled", () => {
    expect(isLolPersistenceEnabled()).toBe(false);
  });

  it("keeps account, platform, region, version and match cache keys distinct", () => {
    expect(lolSearchCacheKey("Name", "Tag", "kr", "asia", "16.21.1")).toBe(
      lolSearchCacheKey("name", "tag", "kr", "asia", "16.21.1"),
    );
    expect(lolSearchCacheKey("Other", "Tag", "kr", "asia", "16.21.1")).not.toBe(
      lolSearchCacheKey("Name", "Tag", "kr", "asia", "16.21.1"),
    );
    expect(
      lolSearchCacheKey("Name", "Tag", "euw1", "europe", "16.21.1"),
    ).not.toBe(lolSearchCacheKey("Name", "Tag", "kr", "asia", "16.21.1"));
    expect(lolSearchCacheKey("Name", "Tag", "kr", "asia", "16.21.2")).not.toBe(
      lolSearchCacheKey("Name", "Tag", "kr", "asia", "16.21.1"),
    );
    expect(lolMatchCacheKey("KR_1", "kr", "asia", "16.21.1")).not.toBe(
      lolMatchCacheKey("KR_1", "euw1", "europe", "16.21.1"),
    );
  });

  it("maps daily ranked history to public fields and requests a 30-day window", async () => {
    const point = { recordedAt: "2026-10-23T01:00:00Z", tier: "MASTER", rank: "I", lp: 1500 };
    const history = emptyLolRankedHistory();
    history.RANKED_SOLO_5x5 = { points: [{ ...point, date: "2026-10-23", wins: 10, losses: 8, isBaseline: false }], highest: point, trackingSince: point.recordedAt };
    (db.rpc as any).result = {
      data: { ...history, RANKED_SOLO_5x5: {
        ...history.RANKED_SOLO_5x5, points: [{ ...history.RANKED_SOLO_5x5.points[0], puuid: "private" }], highest: { ...point, id: 99 },
      }, puuid: "private" }, error: null,
    };
    await expect(getLolRankedHistory("private")).resolves.toEqual(history);
    expect(db.rpc).toHaveBeenCalledWith("get_lol_ranked_history", { p_puuid: "private", p_limit: 30 });
    expect(lolSearchCacheKey("Name", "Tag", "kr", "asia", "16.21.1")).toMatch(/^search:v9:/);
  });

  it("resolves Riot IDs to the stored account without exposing or requesting PUUID through Riot", async () => {
    const query: any = {
      eq: () => query,
      ilike: () => query,
      limit: () => query,
      abortSignal: () => Promise.resolve({ data: [{ puuid: "private", game_name: "Name", tag_line: "Tag", account_fetched_at: "2026-10-23T00:00:00Z" }], error: null }),
    };
    db.from.mockReturnValue({ select: () => query });
    await expect(getLolAccountByRiotId("name", "tag")).resolves.toEqual({ puuid: "private", gameName: "Name", tagLine: "Tag", accountFetchedAt: "2026-10-23T00:00:00Z" });
    expect(db.from).toHaveBeenCalledWith("lol_accounts");
  });

  it("reads only unexpired DTO cache through the region and version scoped RPC", async () => {
    const dto = { matches: [], matchStatus: "empty" };
    (db.rpc as any).result = { data: dto, error: null };
    await expect(
      getLolApiCache("search", "cache-key", "kr", "asia", "16.21.1"),
    ).resolves.toEqual(dto);
    expect(db.rpc).toHaveBeenCalledWith("get_lol_api_cache", {
      p_key: "cache-key",
      p_kind: "search",
      p_platform: "kr",
      p_route: "asia",
      p_version: "16.21.1",
    });
  });

  it("계정 조회 timeout은 공통 DB 제한을 사용하고 안전한 사유 로그와 503을 반환한다", async () => {
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    (db.rpc as any).result = { data: {}, error: null };
    await getLolApiCache("search", "cache-key", "kr", "asia", "16.21.1");
    const query: any = {
      eq: () => query, ilike: () => query, limit: () => query,
      abortSignal: () => Promise.reject(new DOMException("private-puuid secret-key", "TimeoutError")),
    };
    db.from.mockReturnValue({ select: () => query });
    const result = await moreMatches(new Request("http://localhost/api/admin/lol/matches/more", {
      method: "POST", headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ riotId: "Timeout#KR1", offset: 5, matchIds: ["KR_9"] }),
    }));
    expect(ops.record).toHaveBeenCalledWith("db_timeout");
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "LoL 저장소를 사용할 수 없습니다." });
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([10_000, 10_000]);
    expect(log).toHaveBeenCalledExactlyOnceWith("[lol-persistence] request_failed", JSON.stringify({
      operation: "get_lol_account_by_riot_id", stage: "database", reasonCode: "timeout",
    }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-puuid|secret-key|Timeout#KR1/);
  });

  it.each([
    { error: { message: "private-puuid secret-key" }, reasonCode: "db_error" },
    { error: { message: "TimeoutError: private-puuid secret-key" }, reasonCode: "timeout" },
  ])("공통 RPC의 $reasonCode 오류도 원문 없이 사유 코드를 기록한다", async ({ error, reasonCode }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    (db.rpc as any).result = { data: null, error };
    await expect(getLolApiCache("search", "private-cache-key", "kr", "asia", "16.21.1"))
      .rejects.toMatchObject({ kind: "persistence" });
    expect(log).toHaveBeenCalledExactlyOnceWith("[lol-persistence] request_failed", JSON.stringify({
      operation: "get_lol_api_cache", stage: "database", reasonCode,
    }));
    expect(ops.record).toHaveBeenCalledWith(reasonCode === "timeout" ? "db_timeout" : "db_error");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-puuid|secret-key|private-cache-key/);
  });

  it("검색·상세 DTO hit/miss와 저장 원문 재사용을 각각 집계한다", async () => {
    for (const kind of ["search", "match_details"] as const) {
      for (const data of [null, {}]) {
        (db.rpc as any).result = { data, error: null };
        await getLolApiCache(kind, "key", "kr", "asia", "16.21.1");
        expect(ops.record).toHaveBeenLastCalledWith(`${kind === "search" ? "search" : "detail"}_cache_${data ? "hit" : "miss"}`);
      }
    }
    (db.rpc as any).result = { data: {}, error: null };
    await getLolMatchRequestJson("KR_1", "kr", "asia");
    expect(ops.record).toHaveBeenLastCalledWith("raw_reuse");
  });

  it("reads a persisted immutable match payload through the scoped RPC", async () => {
    const raw = { metadata: { matchId: "KR_1" }, info: { participants: [] } };
    (db.rpc as any).result = { data: raw, error: null };
    await expect(getLolMatchRequestJson("KR_1", "kr", "asia")).resolves.toEqual(
      raw,
    );
    expect(db.rpc).toHaveBeenCalledWith("get_lol_match_request_json", {
      p_match_id: "KR_1",
      p_platform: "kr",
      p_route: "asia",
    });
  });

  it("fails closed when the database cannot return cache state", async () => {
    (db.rpc as any).result = {
      data: null,
      error: new Error("database unavailable"),
    };
    await expect(
      getLolApiCache("search", "cache-key", "kr", "asia", "16.21.1"),
    ).rejects.toMatchObject({ kind: "persistence" });
  });

  it("uses database leases and permits as the source of shared state", async () => {
    (db.rpc as any).result = {
      data: [
        { lease_token: "lease-token", lease_until: "2026-10-22T00:00:00Z" },
      ],
      error: null,
    };
    await expect(
      acquireLolCollectionLease("search:key", 90),
    ).resolves.toMatchObject({ token: "lease-token" });
    (db.rpc as any).result = {
      data: [
        {
          granted: true,
          lease_token: "request-token",
          permit_at: "2026-10-22T00:00:00Z",
          retry_after_seconds: 0,
          reason: "granted",
        },
      ],
      error: null,
    };
    await expect(reserveLolRiotRequest("asia")).resolves.toMatchObject({
      token: "request-token",
    });
  });

  it("shares Riot app and method limit headers through the central RPC", async () => {
    (db.rpc as any).result = { data: true, error: null };
    const headers = new Headers({
      "X-App-Rate-Limit": "20:1,100:120",
      "X-App-Rate-Limit-Count": "2:1,9:120",
      "X-Method-Rate-Limit": "10:1",
      "X-Method-Rate-Limit-Count": "1:1",
    });
    await expect(
      recordLolRiotRateHeaders("asia", headers),
    ).resolves.toBeUndefined();
    expect(db.rpc).toHaveBeenCalledWith("record_lol_riot_rate_headers", {
      p_host: "asia",
      p_app_limit: "20:1,100:120",
      p_app_count: "2:1,9:120",
      p_method_limit: "10:1",
      p_method_count: "1:1",
    });
  });

  it("fails closed when the database rejects an unrecognized Riot header", async () => {
    (db.rpc as any).result = { data: false, error: null };
    await expect(
      recordLolRiotRateHeaders("asia", new Headers()),
    ).rejects.toMatchObject({ kind: "persistence" });
  });

  it("returns a retryable busy result when the atomic permit is unavailable", async () => {
    (db.rpc as any).result = {
      data: [
        {
          granted: false,
          lease_token: null,
          permit_at: null,
          retry_after_seconds: 1,
          reason: "concurrency",
        },
      ],
      error: null,
    };
    await expect(reserveLolRiotRequest("asia")).rejects.toBeInstanceOf(
      LolPermitError,
    );
    await expect(reserveLolRiotRequest("asia")).rejects.toMatchObject({
      kind: "busy",
      retryAfterSeconds: 1,
    });
  });
});
