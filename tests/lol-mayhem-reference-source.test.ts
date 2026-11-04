import { beforeEach, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({download:vi.fn(),source:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("next/cache",()=>({unstable_cache:(fn:unknown)=>fn}));
vi.mock("../lib/lol/augments/ingest",()=>({createSourceDownloader:()=>mocks.download}));
vi.mock("../lib/lol/mayhemChampionSource",()=>({createChampionSource:mocks.source}));
import { fetchChampionTierSnapshot, fetchItemRatingSnapshot, fetchRankingIndex, fetchRankingSnapshot, normalizeItemRatingSnapshot } from "../lib/lol/mayhemReferenceSource.server";

const version={gamePatch:"16.22",dataVersion:"16.22.1",schemaVersion:1};
const tiers={meta:{service:"aramgg-data-api",schemaVersion:1,apiVersion:"v1",locale:"ko",gamePatch:"16.22",apiRelease:5,dataVersion:"16.22.1",generatedAt:"2026-11-04T00:00:00Z",publishedAt:"2026-11-04T00:00:00Z",configRevision:"capture",resource:"champions",total:1},data:[{id:29,stats:{tier:2,gamePatch:"16.22",date:"2026-11-03"}}]};
const itemSource={meta:{query:"aram_mayhem_champion",game:"lol"},data:[{champion_id:"29",patch:"16.22",dt:"2026-11-03",data:{items:{"3089":{tier:1}}}}]};
const metadata={data:{"3089":{name:"라바돈의 죽음모자",image:{full:"3089.png"},from:["1058"]},"1058":{name:"쓸데없이 큰 지팡이",image:{full:"1058.png"}}}};
const index={schemaVersion:1,patches:[{patch:"26.20",files:{augments:{json:"https://arammayhem.com/data/v1/26-20/augments.json"}}}]};
const ranking={schemaVersion:1,licenseUrl:"https://creativecommons.org/licenses/by/4.0/",meta:{patch:"26.20",statsDate:"2026-10-20",statsDateSource:"estimated"},rows:[{augmentId:"test",name:{"ko-KR":"테스트 증강"},rarity:"gold",pickRate:null,pickRateRank:null}]};
beforeEach(()=>{
  vi.resetAllMocks();
  mocks.source.mockReturnValue({config:vi.fn(async()=>version),championList:vi.fn(async()=>({body:JSON.stringify(tiers),value:tiers,ids:[29]}))});
  mocks.download.mockImplementation(async(url:string,_json:boolean,max:number)=>{
    expect(max).toBeGreaterThan(0);
    if(url.endsWith("versions.json"))return JSON.stringify(["16.22.1"]);
    if(url.includes("/item.json"))return JSON.stringify(metadata);
    if(url.includes("index.json"))return JSON.stringify(index);
    if(url.endsWith("augments.json"))return JSON.stringify(ranking);
    if(url.includes("iesdev.com"))return JSON.stringify(itemSource);
    throw new Error("unexpected_source_url");
  });
});

it("티어 snapshot은 free config, 기존 champion GET 응답을 쓰고 캡처 후 버전을 재확인한다",async()=>{
  const result=await fetchChampionTierSnapshot();
  expect(JSON.parse(result.raw)).toEqual(tiers);expect(result.normalized).toEqual({patch:"16.22",dataVersion:"16.22.1",date:"2026-11-03",tiers:{"29":2}});
  expect(mocks.source.mock.calls[0][0].apiKey).toBe(process.env.LOL_MAYHEM_STATS_API_KEY);
  expect(mocks.source.mock.results[0].value.config).toHaveBeenCalledTimes(2);
});

it("아이템 원본은 IESDEV 원문과 사용한 Data Dragon metadata subset을 함께 보존해 재검증한다",async()=>{
  const result=await fetchItemRatingSnapshot(29);
  expect(result?.normalized.items).toMatchObject([{id:3089,tier:1,components:[{id:1058}]}]);
  const raw=JSON.parse(result!.raw);expect(raw).toEqual({schemaVersion:1,championId:29,iesdev:itemSource,dataDragon:{version:"16.22.1",metadata:{data:{"1058":{name:"쓸데없이 큰 지팡이",image:{full:"1058.png"}},"3089":{name:"라바돈의 죽음모자",image:{full:"3089.png"},from:["1058"]}}}}});
  expect(normalizeItemRatingSnapshot(raw,29)).toEqual(result?.normalized);
  expect(mocks.download.mock.calls.map(call=>call[0])).toEqual([
    "https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champion?champion_id=29",
    "https://ddragon.leagueoflegends.com/api/versions.json",
    "https://ddragon.leagueoflegends.com/cdn/16.22.1/data/ko_KR/item.json",
  ]);
  await expect(fetchItemRatingSnapshot(0)).rejects.toThrow("invalid_champion_id");
  expect(mocks.download).toHaveBeenCalledTimes(3);
});

it("정렬된 랭킹 index와 canonical patch 경로를 쓰고 날짜 추정·CC BY 자료를 유지한다",async()=>{
  expect(await fetchRankingIndex()).toEqual(["26.20"]);
  const result=await fetchRankingSnapshot("26.20");expect(JSON.parse(result.raw)).toEqual(ranking);
  expect(result.normalized).toMatchObject({patch:"26.20",estimated:true,date:"2026-10-20",rows:[{id:"test",name:"테스트 증강"}]});
  mocks.download.mockClear();await expect(fetchRankingSnapshot("../../x")).rejects.toThrow("ranking_patch_invalid");expect(mocks.download).not.toHaveBeenCalled();
  await expect(fetchRankingSnapshot("26.19")).rejects.toThrow("invalid_patch_ranking");
  expect(mocks.download.mock.calls[0][0]).toBe("https://arammayhem.com/data/v1/26-19/augments.json");
});
