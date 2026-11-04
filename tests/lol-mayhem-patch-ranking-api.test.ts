import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({guard:vi.fn(),ranking:vi.fn()}));
vi.mock("@/lib/lol/publicAccess.server",()=>({guardLolPublicRequest:mocks.guard}));
vi.mock("@/lib/lol/mayhemPatchRankings.server",()=>({getMayhemPatchRankings:mocks.ranking}));
import {GET} from "../app/api/lol/mayhem/patch-rankings/route";
const get=(query="")=>GET(new Request(`https://bgms.kr/api/lol/mayhem/patch-rankings${query}`));
beforeEach(()=>{vi.resetAllMocks();mocks.guard.mockResolvedValue(null);mocks.ranking.mockResolvedValue({patches:["26.20"],ranking:{patch:"26.20",rows:[]}});});
it("공개 read guard와 중복·알 수 없는 쿼리를 검사한다",async()=>{
  mocks.guard.mockResolvedValueOnce(new Response(null,{status:429}));expect((await get()).status).toBe(429);expect(mocks.ranking).not.toHaveBeenCalled();
  for(const q of ["?patch=../26.20","?patch=26.20&patch=26.19","?region=KR"])expect((await get(q)).status).toBe(400);
});
it("성공은 no-store, 미지원패치와 공급원 장애는 구분하고 상세는 숨긴다",async()=>{
  const response=await get("?patch=26.20");expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");expect(mocks.ranking).toHaveBeenCalledWith("26.20");
  mocks.ranking.mockRejectedValueOnce(new Error("ranking_patch_unavailable"));expect((await get("?patch=26.99")).status).toBe(404);
  mocks.ranking.mockRejectedValueOnce(new Error("upstream-private"));const fail=await get();expect(fail.status).toBe(503);expect(await fail.text()).not.toContain("upstream-private");
});
