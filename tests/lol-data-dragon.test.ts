import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => ({
  from: () => ({
    select: () => ({ eq: () => ({ abortSignal: () => ({ maybeSingle: db.read }) }) }),
    upsert: (value: unknown) => ({ abortSignal: () => db.write(value) }),
  }),
}) }));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
  vi.stubEnv("LOL_PERSISTENCE_ENABLED", "true");
  db.read.mockResolvedValue({ data: null, error: null }); db.write.mockResolvedValue({ error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Data Dragon 최신 버전", () => {
  it("최신 버전을 한 번 가져와 메모리와 DB에 6시간 재사용한다", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('["16.22.1","16.21.1"]'));
    vi.stubGlobal("fetch", fetcher);
    const { getLolDataDragonVersion } = await import("../lib/lol/dataDragon.server");
    expect(await Promise.all([getLolDataDragonVersion(), getLolDataDragonVersion()])).toEqual(["16.22.1", "16.22.1"]);
    expect(await getLolDataDragonVersion()).toBe("16.22.1");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("https://ddragon.leagueoflegends.com/api/versions.json", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
    expect(db.write).toHaveBeenCalledWith({ singleton: true, version: "16.22.1", fetched_at: "2026-10-24T00:00:00.000Z" });
    vi.advanceTimersByTime(6 * 60 * 60_000);
    fetcher.mockResolvedValue(new Response('["16.23.1"]'));
    expect(await getLolDataDragonVersion()).toBe("16.23.1");
  });
  it("콜드 스타트도 DB의 신선한 버전을 읽고 외부 호출을 생략한다", async () => {
    db.read.mockResolvedValue({ data: { version: "16.22.1", fetched_at: new Date().toISOString() } });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await (await import("../lib/lol/dataDragon.server")).getLolDataDragonVersion()).toBe("16.22.1");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("갱신 실패 시 만료된 마지막 성공 버전을 유지하고 1분 후 재시도한다", async () => {
    db.read.mockResolvedValue({ data: { version: "16.20.1", fetched_at: "2026-10-01T00:00:00Z" } });
    const fetcher = vi.fn().mockRejectedValue(new Error("offline")); vi.stubGlobal("fetch", fetcher);
    const { getLolDataDragonVersion } = await import("../lib/lol/dataDragon.server");
    expect(await getLolDataDragonVersion()).toBe("16.20.1");
    expect(await getLolDataDragonVersion()).toBe("16.20.1");
    expect(fetcher).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000); fetcher.mockResolvedValue(new Response('["16.22.1"]'));
    expect(await getLolDataDragonVersion()).toBe("16.22.1");
  });
  it.each(["not-json", '["https://evil.invalid"]', '[]', '"16.22.1"'])("잘못된 응답 %s는 코드 기본값으로 복구한다", async (body) => {
    db.read.mockRejectedValue(new Error("db_failed"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    expect(await (await import("../lib/lol/dataDragon.server")).getLolDataDragonVersion()).toBe("16.21.1");
    expect(db.write).not.toHaveBeenCalled();
  });
  it("길이 헤더가 없어도 64KiB에서 본문 읽기를 중단한다", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); }, cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    expect(await (await import("../lib/lol/dataDragon.server")).getLolDataDragonVersion()).toBe("16.21.1");
    expect(cancel).toHaveBeenCalledOnce(); expect(db.write).not.toHaveBeenCalled();
  });
});
