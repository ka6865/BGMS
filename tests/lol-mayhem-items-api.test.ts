import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), champions: vi.fn(), items: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/publicAccess.server", () => ({ guardLolPublicRequest: mocks.guard }));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: mocks.champions }));
vi.mock("@/lib/lol/mayhemItems.server", () => ({ getMayhemItemRatings: mocks.items }));
import { GET } from "../app/api/lol/mayhem/champion-items/[championId]/route";
const get = (id = "29", query = "") => GET(new Request(`https://bgms.kr/api/lol/mayhem/champion-items/${id}${query}`), { params: Promise.resolve({ championId: id }) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("LOL_MAYHEM_ITEMS_ENABLED", "true"); mocks.guard.mockResolvedValue(null); mocks.champions.mockResolvedValue({ champions: [{ id: 29 }] }); mocks.items.mockResolvedValue(null); });
it("로컬 기능 flag와 공개 접근 제한을 지킨다", async () => {
  vi.stubEnv("LOL_MAYHEM_ITEMS_ENABLED", "false"); expect((await get()).status).toBe(404); expect(mocks.guard).not.toHaveBeenCalled();
  vi.stubEnv("LOL_MAYHEM_ITEMS_ENABLED", "true"); mocks.guard.mockResolvedValue(new Response(null, { status: 429 })); expect((await get()).status).toBe(429); expect(mocks.items).not.toHaveBeenCalled();
});
it("등록된 챔피언과 쿼리 없는 요청만 허용한다", async () => {
  for (const id of ["0", "01", "-1", "1.5", "99999"]) expect((await get(id)).status).toBe(400);
  expect((await get("29", "?patch=16.21")).status).toBe(400); expect(mocks.items).not.toHaveBeenCalled();
});
it("자료 없음과 일시 장애를 구분하고 에러 내용을 감춘다", async () => {
  const response = await get(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.json()).toEqual({ dataset: null });
  mocks.items.mockRejectedValue(new Error("private-upstream-error")); const failed = await get(); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private-upstream-error");
  mocks.champions.mockResolvedValue(null); expect((await get()).status).toBe(503);
});
