import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), champions: vi.fn(), history: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/lol/publicAccess.server", () => ({ guardLolPublicRequest: mocks.guard }));
vi.mock("@/lib/lol/champions.server", () => ({ getLolChampions: mocks.champions }));
vi.mock("@/lib/lol/mayhemObservationHistory.server", () => ({ getMayhemObservationHistory: mocks.history }));
import { GET } from "../app/api/lol/mayhem/champion-history/[championId]/route";
const get = (id = "29", query = "?patch=16.21") => GET(new Request(`https://bgms.kr/api/lol/mayhem/champion-history/${id}${query}`), { params: Promise.resolve({ championId: id }) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("LOL_MAYHEM_CHAMPION_DATASET_ENABLED", "true");
  mocks.guard.mockResolvedValue(null); mocks.champions.mockResolvedValue({ champions: [{ id: 29 }] });
  mocks.history.mockResolvedValue({ patch: "16.21", patches: [], rows: [] });
});
it("공개 flag와 공개 read guard를 지킨다", async () => {
  vi.stubEnv("LOL_MAYHEM_CHAMPION_DATASET_ENABLED", "false"); expect((await get()).status).toBe(404); expect(mocks.guard).not.toHaveBeenCalled();
  vi.stubEnv("LOL_MAYHEM_CHAMPION_DATASET_ENABLED", "true"); mocks.guard.mockResolvedValue(new Response(null, { status: 429 })); expect((await get()).status).toBe(429); expect(mocks.history).not.toHaveBeenCalled();
});
it("등록 챔피언과 유일한 패치만 허용한다", async () => {
  for (const id of ["0", "01", "-1", "1.5", "99999"]) expect((await get(id)).status).toBe(400);
  for (const query of ["", "?patch=bad", "?patch=16.21&patch=16.20", "?patch=16.21&region=KR"]) expect((await get("29", query)).status).toBe(400);
  expect(mocks.history).not.toHaveBeenCalled();
});
it("성공 응답은 캐시하지 않고 실패 상세를 감춘다", async () => {
  const response = await get(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.history).toHaveBeenCalledWith("16.21", 29); expect(await response.json()).toHaveProperty("history");
  mocks.history.mockRejectedValue(new Error("private-secret")); const failed = await get(); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private-secret");
  mocks.champions.mockResolvedValue(null); expect((await get()).status).toBe(503);
});
