import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
import { getMayhemItemRatings } from "../lib/lol/mayhemItems.server";
const source = { meta: { query: "aram_mayhem_champion", game: "lol" }, data: [{ champion_id: "29", patch: "16.22", dt: "2026-11-04", data: { items: { "3089": { tier: 1 } } } }] };
afterEach(() => vi.unstubAllGlobals());
it("증바람 고정 경로와 같은 패치의 한국어 제작 재료만 가져온다", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(source)).mockResolvedValueOnce(Response.json(["16.23.1", "16.22.1", "16.21.1"])).mockResolvedValueOnce(Response.json({ data: { "3089": { name: "라바돈의 죽음모자", image: { full: "3089.png" } } } }));
  vi.stubGlobal("fetch", fetcher); const data = await getMayhemItemRatings(29);
  expect(data?.patch).toBe("16.22"); expect(data?.version).toBe("16.22.1");
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(["https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champion?champion_id=29", "https://ddragon.leagueoflegends.com/api/versions.json", "https://ddragon.leagueoflegends.com/cdn/16.22.1/data/ko_KR/item.json"]);
  for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({ cache: "no-store", redirect: "error", headers: { Accept: "application/json" } });
});
it("업스트림 실패·너무 큰 응답·잘못된 ID를 차단한다", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 })); vi.stubGlobal("fetch", fetcher);
  await expect(getMayhemItemRatings(29)).rejects.toThrow();
  fetcher.mockResolvedValue(new Response("{}", { headers: { "content-length": "2000000" } })); await expect(getMayhemItemRatings(29)).rejects.toThrow();
  fetcher.mockClear(); await expect(getMayhemItemRatings(0)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
it("일치하는 패치가 없으면 최신 패치로 대체하지 않는다", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(source)).mockResolvedValueOnce(Response.json(["16.23.1"])));
  await expect(getMayhemItemRatings(29)).rejects.toThrow("mayhem_items_version_unavailable");
});
