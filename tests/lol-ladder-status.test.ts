import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateLolLadder, lolKstDay, type LolLadderTier } from "@/lib/lol/ladder";
import { parseLolPlatformStatus } from "@/lib/lol/status";
import { runLolLadderSnapshot } from "../scripts/lol_ladder_snapshot";

const mocks = vi.hoisted(() => ({ request: vi.fn(), rpc: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/lol/riotSearch.server", () => ({ requestJson: mocks.request }));
vi.mock("@/lib/lol/persistence.server", () => ({ acquireLolCollectionLease: mocks.acquire, releaseLolCollectionLease: mocks.release }));

const league = (tier: LolLadderTier = "CHALLENGER", queue = "RANKED_SOLO_5x5") => ({ queue, tier,
  entries: [201, 100, 300, 200].map((leaguePoints, i) => ({ puuid: `private-${i}`, leaguePoints, freshBlood: i === 0, hotStreak: i < 2 })) });
const notice = (id: number, extra = {}) => ({ id, titles: [{ locale: "en_US", content: "English" }, { locale: "ko_KR", content: "한국 서버 점검" }],
  updates: [{ publish: true, created_at: "2026-10-25", translations: [{ locale: "ko_KR", content: "진행 중입니다." }] }], ...extra });

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
  mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: null, error: null }) }));
  mocks.acquire.mockResolvedValue({ key: "status:kr", token: "fixture" });
  mocks.request.mockResolvedValue({ maintenances: [], incidents: [] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("랭크 컷 집계·수집", () => {
  it("최저·최고·짝수 중위값과 플래그만 집계해 개인 식별자를 제외한다", () => {
    expect(aggregateLolLadder(league(), "RANKED_SOLO_5x5", "CHALLENGER")).toEqual({ queue: "RANKED_SOLO_5x5", tier: "CHALLENGER",
      player_count: 4, cutoff_lp: 100, top_lp: 300, median_lp: 200.5, fresh_blood_count: 1, hot_streak_count: 2 });
  });
  it("빈 티어는 0 LP로 오인하지 않는다", () => {
    expect(aggregateLolLadder({ ...league(), entries: [] }, "RANKED_SOLO_5x5", "CHALLENGER"))
      .toMatchObject({ player_count: 0, cutoff_lp: null, top_lp: null, median_lp: null });
  });
  it.each([null, {}, { ...league(), queue: "wrong" }, { ...league(), entries: [{ leaguePoints: -1 }] },
    { ...league(), entries: [{ leaguePoints: 1, hotStreak: true, freshBlood: "true" }] }])("잘못된 응답 %j는 저장하지 않는다", value => {
    expect(() => aggregateLolLadder(value, "RANKED_SOLO_5x5", "CHALLENGER")).toThrow();
  });
  it("KST 자정 전후 날짜를 구분한다", () => {
    expect(lolKstDay(new Date("2026-10-24T14:59:59.999Z"))).toBe("2026-10-24");
    expect(lolKstDay(new Date("2026-10-24T15:00:00Z"))).toBe("2026-10-25");
  });
  it("기본 dry-run은 정확히 6개 경로를 읽고 저장하지 않는다", async () => {
    const request = vi.fn(async (path: string) => league(path.includes("/grandmaster") ? "GRANDMASTER" : path.includes("/master") ? "MASTER" : "CHALLENGER", path.split("/").at(-1)));
    const save = vi.fn();
    const result = await runLolLadderSnapshot({ request, save }, []);
    expect(result.dryRun).toBe(true); expect(request).toHaveBeenCalledTimes(6); expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-");
    await runLolLadderSnapshot({ request, save }, ["--apply"], true);
    expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0][0]).toHaveLength(6);
  });
  it("쓰기 플래그·인자·부분 실패를 저장 전에 거절한다", async () => {
    const deps = { request: vi.fn().mockRejectedValue(new Error("upstream")), save: vi.fn() };
    await expect(runLolLadderSnapshot(deps, ["--apply"], false)).rejects.toThrow("LOL_LADDER_ENABLED");
    expect(deps.request).not.toHaveBeenCalled();
    await expect(runLolLadderSnapshot(deps, ["--apply", "--dry-run"], true)).rejects.toThrow();
    await expect(runLolLadderSnapshot(deps, ["--apply"], true)).rejects.toThrow("upstream");
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe("한국 서버 공지", () => {
  it("한국어를 우선하며 게시되지 않은 업데이트와 종료된 공지는 숨긴다", () => {
    const items = parseLolPlatformStatus({ maintenances: [notice(1), notice(2, { maintenance_status: "complete" })],
      incidents: [notice(3, { archive_at: "2026-10-25" }), notice(4, { titles: [{ locale: "en_US", content: "Fallback" }], updates: [{ publish: false }] })] });
    expect(items).toHaveLength(2); expect(items[0]).toMatchObject({ title: "한국 서버 점검", message: "진행 중입니다.", kind: "maintenance" });
    expect(items[1]).toMatchObject({ title: "Fallback", message: "", kind: "incident" });
  });
  it("형태가 바뀐 응답을 정상 상태로 표시하지 않는다", () => {
    expect(() => parseLolPlatformStatus({})).toThrow();
    expect(() => parseLolPlatformStatus({ maintenances: [{}], incidents: [] })).toThrow();
  });
  it("상태 동시 조회와 5분 내 조회는 한 번만 Riot을 호출한다", async () => {
    vi.useFakeTimers();
    const { getLolPlatformStatus } = await import("@/lib/lol/status.server");
    const [first, second] = await Promise.all([getLolPlatformStatus(), getLolPlatformStatus()]);
    expect(first).toEqual(second); expect(first).toMatchObject({ available: true, stale: false, items: [] });
    await getLolPlatformStatus(); expect(mocks.request).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(300001); await getLolPlatformStatus(); expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request).toHaveBeenCalledWith("kr", "/lol/status/v4/platform-data", 0, true);
  });
  it("다른 인스턴스의 신선한 DB 캐시는 Riot 호출 없이 재사용한다", async () => {
    mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: { payload: { items: [] }, fetchedAt: new Date().toISOString(),
      nextRefreshAt: new Date(Date.now() + 300000).toISOString() }, error: null }) }));
    const { getLolPlatformStatus } = await import("@/lib/lol/status.server");
    expect(await getLolPlatformStatus()).toMatchObject({ available: true, stale: false });
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it("만료 캐시와 upstream 실패는 기존 공지를 stale로 반환하고 재호출을 억제한다", async () => {
    const items = parseLolPlatformStatus({ maintenances: [notice(1)], incidents: [] });
    mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: { payload: { items }, fetchedAt: new Date(Date.now() - 600000).toISOString(),
      nextRefreshAt: new Date(Date.now() - 1000).toISOString() }, error: null }) }));
    mocks.request.mockRejectedValue(new Error("private-key"));
    const { getLolPlatformStatus } = await import("@/lib/lol/status.server");
    expect(await getLolPlatformStatus()).toMatchObject({ items, stale: true });
    await getLolPlatformStatus(); expect(mocks.request).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("defer_lol_platform_status", {});
  });
  it("lease 경합·DB 실패·비활성화에서는 Riot을 호출하지 않는다", async () => {
    mocks.acquire.mockResolvedValue(null);
    let statusModule = await import("@/lib/lol/status.server"); await statusModule.getLolPlatformStatus(); expect(mocks.request).not.toHaveBeenCalled();
    vi.resetModules(); mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ error: new Error("db") }) }));
    statusModule = await import("@/lib/lol/status.server"); expect(await statusModule.getLolPlatformStatus()).toMatchObject({ available: false });
    vi.stubEnv("LOL_PERSISTENCE_ENABLED", "false"); await statusModule.getLolPlatformStatus(); expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe("공개 페이지 가드", () => {
  it("공개 플래그가 꺼지면 컷·상태 조회 전에 404로 막는다", async () => {
    vi.stubEnv("LOL_PUBLIC_ENABLED", "false");
    const { default: LadderPage } = await import("@/app/lol/kr/ladder/page");
    const { default: StatusPage } = await import("@/app/lol/kr/status/page");
    await expect(LadderPage()).rejects.toThrow("404");
    await expect(StatusPage()).rejects.toThrow("404");
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
