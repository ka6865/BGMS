import { expect, it } from "vitest";
import snapshot from "../lib/lol/data/mayhem-champion-tiers.json";
import { parseMayhemChampionTiers, sortMayhemChampions } from "../lib/lol/mayhemChampionTiers";
const champion=(id:number,name:string)=>({id,name,title:"",imageId:"Champion",tags:[]});
it("확인한173명 티어와 패치만 읽고 동일 티어는 이름순·미제공은 마지막이다",()=>{
  expect(Object.keys(parseMayhemChampionTiers(snapshot).tiers)).toHaveLength(173);
  const list=[champion(3,"다"),champion(1,"가"),champion(2,"나"),champion(4,"라")];
  const data={patch:"16.21",dataVersion:"16.21.5",date:"2026-10-30",tiers:{"1":3,"2":1,"3":1}};
  expect(sortMayhemChampions(list,data,"16.21").map(c=>c.id)).toEqual([2,3,1,4]); expect(list.map(c=>c.id)).toEqual([3,1,2,4]);
  expect(sortMayhemChampions(list,data,"16.22")).toBe(list);
});
it("잘못된 티어·ID·패치·날짜를 표시하지 않는다",()=>{
  for(const tiers of [{"1":0},{"1":6},{"1":1.1},{"../1":1}])expect(()=>parseMayhemChampionTiers({...snapshot,tiers})).toThrow();
  expect(()=>parseMayhemChampionTiers({...snapshot,date:"2026-02-30"})).toThrow();
  expect(()=>parseMayhemChampionTiers({...snapshot,dataVersion:"16.20.1"})).toThrow();
});
