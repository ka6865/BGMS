import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({download:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("next/cache",()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock("@/lib/lol/augments/ingest",()=>({createSourceDownloader:()=>mocks.download}));
import {getMayhemPatchRankings} from "../lib/lol/mayhemPatchRankings.server";
const index={schemaVersion:1,patches:[{patch:"26.20",files:{augments:{json:"https://arammayhem.com/data/v1/26-20/augments.json"}}}]};
const source={schemaVersion:1,licenseUrl:"https://creativecommons.org/licenses/by/4.0/",meta:{patch:"26.20",statsDate:"2026-10-20",statsDateSource:"estimated"},rows:[{augmentId:"test",name:{"ko-KR":"이전 이름"},rarity:"gold",pickRate:1,pickRateRank:1}]};
beforeEach(()=>{vi.resetAllMocks();mocks.download.mockImplementation(async(url:string)=>JSON.stringify(url.endsWith("index.json")?index:source));});
it("무료 고정 도메인의 인덱스와 해당 패치만 제한된 크기로 읽는다",async()=>{
  const result=await getMayhemPatchRankings();expect(result.ranking.patch).toBe("26.20");expect(mocks.download.mock.calls).toEqual([["https://arammayhem.com/data/v1/index.json",true,512*1024],["https://arammayhem.com/data/v1/26-20/augments.json",true,2*1024*1024]]);
});
it("등록되지 않은 패치는 통계 파일을 요청하지 않는다",async()=>{
  await expect(getMayhemPatchRankings("26.19")).rejects.toThrow("ranking_patch_unavailable");expect(mocks.download).toHaveBeenCalledTimes(1);
  mocks.download.mockClear();await expect(getMayhemPatchRankings("../../x")).rejects.toThrow();expect(mocks.download).not.toHaveBeenCalled();
});
