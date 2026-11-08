import { expect, it } from "vitest";
import snapshot from "../lib/lol/data/mayhem-champion-tiers.json";
import { parseChampionTierSource, parseMayhemChampionTiers, sortMayhemChampions } from "../lib/lol/mayhemChampionTiers";
const champion=(id:number,name:string)=>({id,name,title:"",imageId:"Champion",tags:[]});
it("확인한173명 티어와 패치만 읽고 동일 티어는 이름순·미제공은 마지막이다",()=>{
  expect(Object.keys(parseMayhemChampionTiers(snapshot).tiers)).toHaveLength(173);
  const list=[champion(3,"다"),champion(1,"가"),champion(2,"나"),champion(4,"라")];
  const data={patch:"16.21",dataVersion:"16.21.5",date:"2026-10-30",tiers:{"1":3,"2":1,"3":1}};
  expect(sortMayhemChampions(list,data).map(c=>c.id)).toEqual([2,3,1,4]); expect(list.map(c=>c.id)).toEqual([3,1,2,4]);
  expect(sortMayhemChampions(list,null)).toBe(list);
});
it("잘못된 티어·ID·패치·날짜를 표시하지 않는다",()=>{
  for(const tiers of [{"1":0},{"1":6},{"1":1.1},{"../1":1}])expect(()=>parseMayhemChampionTiers({...snapshot,tiers})).toThrow();
  expect(()=>parseMayhemChampionTiers({...snapshot,date:"2026-02-30"})).toThrow();
  expect(()=>parseMayhemChampionTiers({...snapshot,dataVersion:"16.20.1"})).toThrow();
});
it("실제 ARAM.GG envelope의 티어와 날짜를 읽고 tier 누락은 임의로 채우지 않는다",()=>{
  const source={meta:{service:"aramgg-data-api",schemaVersion:1,apiVersion:"v1",locale:"ko",gamePatch:"16.21",apiRelease:5,dataVersion:"16.21.5",generatedAt:"2026-10-31T17:40:11.488Z",publishedAt:"2026-10-31T17:40:11.488Z",configRevision:"capture",resource:"champions",total:2},data:[
    {id:17,stats:{tier:1,gamePatch:"16.21",date:"2026-10-30"}},{id:29,stats:{gamePatch:"16.21",date:"2026-10-30"}},
  ]};
  expect(parseChampionTierSource(source)).toEqual({patch:"16.21",dataVersion:"16.21.5",date:"2026-10-30",tiers:{"17":1}});
  expect(()=>parseChampionTierSource({...source,data:[...source.data,{id:17,stats:{tier:2,gamePatch:"16.21",date:"2026-10-30"}}],meta:{...source.meta,total:3}})).toThrow();
});
