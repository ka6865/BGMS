vi.mock("@/lib/lol/dataDragon.server", () => ({ getLolDataDragonVersion: async () => "16.21.1" }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), acquire: vi.fn(), release: vi.fn(), lookup: vi.fn(), raw: vi.fn(), persist: vi.fn(), aggregate: vi.fn(),
  processed: vi.fn(), reserve: vi.fn(), start: vi.fn(), releaseRequest: vi.fn(), recordHeaders: vi.fn(), block: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevAdmin: mocks.admin }));
vi.mock("@/lib/lol/ops.server", () => ({ recordLolOpsMetric: vi.fn() }));
vi.mock("@/lib/lol/persistence.server", async (original) => ({
  ...await original<typeof import("@/lib/lol/persistence.server")>(),
  acquireLolCollectionLease: mocks.acquire, releaseLolCollectionLease: mocks.release,
  getLolAccountByRiotId: mocks.lookup, getLolMatchRequestJson: mocks.raw, persistLolMatchDetails: mocks.persist,
  hasLolBenchmarkProcessedMatch: mocks.processed,
  aggregateLolMatchBenchmarks: mocks.aggregate, reserveLolRiotRequest: mocks.reserve, startLolRiotRequest: mocks.start,
  releaseLolRiotRequest: mocks.releaseRequest, recordLolRiotRateHeaders: mocks.recordHeaders, blockLolRiotRequests: mocks.block,
  // 실제 함수는 헤더 기록과 해제를 한 RPC로 처리한다. 기존 단정을 유지하려고 두 mock을 차례로 부른다.
  finishLolRiotRequest: async (token: string, host: string, headers: Headers) => { await mocks.recordHeaders(host, headers); await mocks.releaseRequest(token); },
}));
import { POST } from "@/app/api/admin/lol/collect/route";
import { collectLolMatches } from "@/lib/lol/riotSearch.server";

function post(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/admin/lol/collect", {
    method: "POST", headers: { Origin: origin, Host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const request = { riotId: "Owner#FIX", count: 100, startOffset: 0, confirm: true };
let fetchMock: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;
const stored = new Map<string, unknown>();
function raw(matchId: string) {
  return { metadata: { matchId }, info: { participants: [], teams: [], gameDuration: 1800, queueId: 420 } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
  vi.stubEnv("RIOT_API_KEY", "fixture-only-no-live-request");
  const state = (globalThis as any)[Symbol.for("bgms.lol.riot-search-state")];
  state.cache.clear(); state.accounts.clear(); state.accountOps.clear(); state.inflight.clear();
  stored.clear();
  mocks.admin.mockResolvedValue({ ok: true });
  mocks.lookup.mockResolvedValue({ puuid: "private-owner", gameName: "Owner", tagLine: "FIX" });
  mocks.acquire.mockImplementation(async (key: string) => ({ key, token: "token" }));
  mocks.reserve.mockImplementation(async () => ({ token: "riot-token", permitAt: Date.now() }));
  mocks.start.mockResolvedValue({ allowed: true });
  mocks.raw.mockImplementation(async (id: string) => stored.get(id));
  mocks.persist.mockImplementation(async (value) => { stored.set(value.raw.metadata.matchId, value.raw); });
  mocks.aggregate.mockResolvedValue({ aggregated: false, skipped: false, reason: null });
  mocks.processed.mockResolvedValue(false);
  fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/ids")) {
      const start = Number(parsed.searchParams.get("start"));
      const count = Number(parsed.searchParams.get("count"));
      return Response.json(Array.from({ length: count }, (_, index) => `KR_${start + index + 1}`));
    }
    return Response.json(raw(parsed.pathname.split("/").at(-1)!));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("LoL 수집 관리자 API 경계", () => {
  it.each([null, [], {}, { ...request, confirm: undefined }, { ...request, confirm: "true" },
    { ...request, count: 0 }, { ...request, count: 101 }, { ...request, count: 1.5 },
    { ...request, startOffset: -1 }, { ...request, startOffset: 1.5 }, { ...request, startOffset: Number.MAX_SAFE_INTEGER + 1 },
    { ...request, riotId: "Owner" }, { ...request, riotId: "Owner#FIX#BAD" }, { ...request, riotId: "Owner#FIX\n" },
  ])("입력 또는 명시 확인이 없으면 저장·외부 호출을 거절한다: %j", async (body) => {
    expect((await POST(post(body))).status).toBe(400);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("관리자·동일 출처·영속 저장 가드를 유지한다", async () => {
    mocks.admin.mockResolvedValue({ ok: false, error: Response.json({}, { status: 403 }) });
    expect((await POST(post(request))).status).toBe(403);
    mocks.admin.mockResolvedValue({ ok: true });
    expect((await POST(post(request, "http://evil.test"))).status).toBe(403);
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false");
    expect((await POST(post(request))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("본문 크기를 제한하고 기본 목표 20을 사용한다", async () => {
    expect((await POST(post({ ...request, padding: "가".repeat(2048) }))).status).toBe(413);
    const response = await POST(post({ riotId: request.riotId, confirm: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ requested: 20, processed: 20, fetched: 21, nextOffset: 20 });
  });
});

describe("LoL 제한 수집", () => {
  it("100경기는 20건씩 커서를 반복하고 모든 Riot 호출은 기존 공유 가드를 경유한다", async () => {
    let offset = 0;
    for (let page = 0; page < 5; page += 1) {
      const response = await POST(post({ ...request, startOffset: offset, count: 100 - offset }));
      const result = await response.json();
      expect(result).toMatchObject({ processed: 20, fetched: 21, aggregated: 20, failed: 0 });
      offset = result.nextOffset;
    }
    expect(offset).toBe(100);
    expect(mocks.persist).toHaveBeenCalledTimes(100);
    expect(mocks.reserve).toHaveBeenCalledTimes(105);
    expect(mocks.start).toHaveBeenCalledTimes(105);
    expect(mocks.releaseRequest).toHaveBeenCalledTimes(105);
    expect(mocks.acquire).toHaveBeenCalledWith("search:v11:owner#fix", 120);
    expect(mocks.acquire).toHaveBeenCalledWith("collect:private-owner", 120);
  });
  it("저장 원문과 캐시된 경기 ID를 재사용하면 Riot 호출이 0이다", async () => {
    await collectLolMatches(request);
    fetchMock.mockClear(); mocks.persist.mockClear(); mocks.reserve.mockClear();
    const result = await collectLolMatches(request);
    expect(result).toMatchObject({ fetched: 0, reused: 20, aggregated: 0, processed: 20 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("원문 삭제 후 재수집해도 이미 처리한 경기는 신규 집계로 보고하지 않는다", async () => {
    mocks.processed.mockResolvedValue(true);
    const result = await collectLolMatches({ ...request, count: 1 });
    expect(result).toMatchObject({ processed: 1, fetched: 2, aggregated: 0, reused: 0 });
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it("429는 현재 위치에서 중단하고 Retry-After와 진행 결과를 보존한다", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/KR_3")
      ? Response.json({}, { status: 429, headers: { "Retry-After": "17" } }) : normal(url));
    const response = await POST(post(request));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(await response.json()).toMatchObject({ processed: 2, nextOffset: 2, aggregated: 2, fetched: 4, stopped: "rate_limited", retryAfter: 17 });
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledWith({ key: "collect:private-owner", token: "token" });
    expect(mocks.block).toHaveBeenCalledWith("asia", 17);
  });
  it("같은 계정 lease 충돌은 Riot을 호출하지 않는다", async () => {
    mocks.acquire.mockResolvedValue(null);
    expect((await POST(post(request))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("짧은 ID 페이지·제외 경기·개별 오류를 보고한다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/ids?")) return Response.json(["KR_1", "KR_2", "KR_3"]);
      if (url.endsWith("/KR_3")) return Response.json({}, { status: 500 });
      return Response.json(raw(url.split("/").at(-1)!));
    });
    mocks.aggregate.mockImplementation(async (id) => ({ aggregated: false, skipped: id === "KR_2" }));
    const result = await collectLolMatches(request);
    expect(result).toMatchObject({ processed: 3, nextOffset: 3, hasMore: false, aggregated: 1, skipped: 1, failed: 1, fetched: 4 });
  });
  it("커스텀 게임은 원문·참가자를 저장하거나 집계하지 않고 skipped로 센다", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/ids?")) return Response.json(["KR_1", "KR_2", "KR_3", "KR_4"]);
      const id = url.split("/").at(-1)!;
      const match = raw(id);
      if (id === "KR_1") match.info.queueId = 0;
      if (id === "KR_2") Object.assign(match.info, { gameType: "CUSTOM_GAME" });
      return Response.json(match);
    });
    // 이전 수집이 남긴 커스텀 원문도 재사용·집계하지 않는다.
    stored.set("KR_3", { ...raw("KR_3"), info: { ...raw("KR_3").info, queueId: 0 } });
    mocks.aggregate.mockResolvedValue({ aggregated: true, skipped: false });
    const result = await collectLolMatches(request);
    expect(result).toMatchObject({ processed: 4, nextOffset: 4, skipped: 3, aggregated: 1, reused: 0, failed: 0 });
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.persist.mock.calls[0][0].raw.metadata.matchId).toBe("KR_4");
    expect(mocks.aggregate.mock.calls.map(([id]) => id)).toEqual(["KR_4"]);
    expect(mocks.release).toHaveBeenCalledWith({ key: "match:KR_1", token: "token" });
    expect(mocks.release).toHaveBeenCalledWith({ key: "match:KR_2", token: "token" });
  });
  it("DB 계정이 없으면 계정 API로 확인하고 식별자를 응답에 남기지 않는다", async () => {
    mocks.lookup.mockResolvedValue(undefined);
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => url.includes("/by-riot-id/")
      ? Response.json({ puuid: "private-owner", gameName: "Owner", tagLine: "FIX" }) : normal(url));
    const result = await collectLolMatches({ ...request, count: 1 });
    expect(result.fetched).toBe(3);
    expect(JSON.stringify(result)).not.toContain("private-owner");
  });
});
