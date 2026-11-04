import { expect, it } from "vitest";
import { parseRankingPatches, parsePatchAugmentRanking } from "../lib/lol/mayhemPatchRankings";
const row=(id:string,pickRate:number|null,rank:number|null)=>({augmentId:id,name:{"ko-KR":id},rarity:"gold",pickRate,pickRateRank:rank});
const source=()=>({schemaVersion:1,licenseUrl:"https://creativecommons.org/licenses/by/4.0/",meta:{patch:"26.20",statsDate:"2026-10-20",statsDateSource:"estimated"},rows:[row("zero",0,2),row("missing",null,null),row("top",10,1)]});
it("패치별 원래 한국어 이름과 등급을 유지하고 선택률0과 미제공을 구분한다",()=>{
  const data=parsePatchAugmentRanking(source(),"26.20");expect(data.estimated).toBe(true);expect(data.rows.map(r=>r.id)).toEqual(["top","zero","missing"]);expect(data.rows[1].pickRate).toBe(0);expect(data.rows[2].pickRate).toBeNull();
  expect(JSON.stringify(data)).not.toMatch(/winRate|championId/);
});
it("실제 인덱스에 있는 정상 패치 경로만 허용하고 최신순 정렬한다",()=>{
  const patches=["26.9","26.20","26.19"].map(patch=>({patch,files:{augments:{json:`https://arammayhem.com/data/v1/${patch.replace('.','-')}/augments.json`}}}));
  expect(parseRankingPatches({schemaVersion:1,patches})).toEqual(["26.20","26.19","26.9"]);
  expect(()=>parseRankingPatches({schemaVersion:1,patches:[{...patches[0],files:{augments:{json:"https://evil.invalid/a"}}}]})).toThrow();
});
it("다른 패치·라이선스·날짜·범위 밖 비율·중복 증강은 거절한다",()=>{
  expect(()=>parsePatchAugmentRanking(source(),"26.19")).toThrow();
  for(const field of [{licenseUrl:"unknown"},{meta:{...source().meta,statsDate:"2026-02-30"}},{rows:[row("bad",101,1)]},{rows:[row("bad",NaN,1)]},{rows:[row("same",1,1),row("same",2,2)]}])expect(()=>parsePatchAugmentRanking({...source(),...field},"26.20")).toThrow();
});
