import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ guard: vi.fn(), resolve: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/access.server", () => ({ requireLolDevPageAdmin: access.guard }));
vi.mock("@/lib/lol/riotSearch.server", async (original) => ({
  ...await original<typeof import("@/lib/lol/riotSearch.server")>(),
  resolveLolParticipantRef: access.resolve,
}));
import { GET } from "@/app/admin/lol/kr/by-ref/[ref]/route";
import { RiotSearchError } from "@/lib/lol/riotSearch.server";

beforeEach(() => { vi.resetAllMocks(); access.guard.mockResolvedValue(undefined); });
afterEach(() => vi.restoreAllMocks());
const request = () => GET(new Request("http://localhost:3000/admin/lol/kr/by-ref/sealed"), { params: Promise.resolve({ ref: "sealed" }) });

describe("LoL 참가자 ref 이동 HTTP", () => {
  it("현재 이름을 lolRiotIdPath로 인코딩해 캐시 없이 이동한다", async () => {
    access.resolve.mockResolvedValue("현재 이름#KR1");
    const response = await request();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`http://localhost:3000/admin/lol/kr/${encodeURIComponent("현재 이름-KR1")}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    ["invalid_request", 400, "잘못된 참가자 링크"],
    ["not_found", 404, "계정을 찾을 수 없습니다"],
    ["rate_limited", 503, "잠시 후 다시 시도"],
  ] as const)("%s를 HTTP %i 안내로 반환한다", async (kind, status, message) => {
    access.resolve.mockRejectedValue(new RiotSearchError(kind));
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(message);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("관리자 가드가 실패하면 참가자 조회를 실행하지 않는다", async () => {
    access.guard.mockRejectedValue(new Error("guard denied"));
    await expect(request()).rejects.toThrow("guard denied");
    expect(access.resolve).not.toHaveBeenCalled();
  });
});
