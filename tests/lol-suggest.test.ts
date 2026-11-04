import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
const guard = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/serviceRoleSupabase.server", () => ({ createServiceRoleSupabase: () => db }));
vi.mock("@/lib/lol/publicAccess.server", () => ({ guardLolPublicRequest: guard }));
import { GET } from "@/app/api/lol/suggest/route";
const request = (q: string) => new Request(`https://bgms.kr/api/lol/suggest?q=${encodeURIComponent(q)}`);

describe("LoL 저장 계정 자동완성", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guard.mockResolvedValue(null);
    db.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: [{ game_name: "Hide on bush", tag_line: "KR1", puuid: "must-not-leak" }], error: null }) });
  });
  it("공개 접근 제한을 그대로 적용한다", async () => {
    guard.mockResolvedValue(new Response(null, { status: 429 }));
    expect((await GET(request("Hi"))).status).toBe(429);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each(["", "가", "a".repeat(82), "a#b#c", "ab\u0000"])("유효하지 않은 입력에는 DB와 Riot을 호출하지 않는다: %s", async q => {
    const response = await GET(request(q));
    expect(await response.json()).toEqual({ suggestions: [] });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("서버 RPC만 호출하고 Riot ID만 응답한다", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await GET(request(" Hi "));
    expect(db.rpc).toHaveBeenCalledWith("suggest_lol_accounts", { p_query: "Hi" });
    expect(await response.json()).toEqual({ suggestions: [{ gameName: "Hide on bush", tagLine: "KR1" }] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it("DB 실패는 빈 추천으로 격리하고 계정이나 오류 원문을 노출하지 않는다", async () => {
    db.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({ data: null, error: { code: "57014", message: "private-data" } }) });
    const response = await GET(request("Hi"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ suggestions: [] });
  });
});
