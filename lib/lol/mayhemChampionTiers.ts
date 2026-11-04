import type { LolChampion } from "./champions";
export type MayhemChampionTiers = { patch: string; dataVersion: string; date: string; tiers: Record<string, number> };
const validDate=(value:unknown):value is string=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
export function parseChampionTierSource(value:unknown):MayhemChampionTiers {
  const root=value as {meta?:Record<string,unknown>;data?:Array<{id?:unknown;stats?:{tier?:unknown;gamePatch?:unknown;date?:unknown}}>}|null;
  const meta=root?.meta;
  if(!root||meta?.service!=="aramgg-data-api"||meta.schemaVersion!==1||meta.apiVersion!=="v1"||meta.locale!=="ko"
    ||meta.resource!=="champions"||!Number.isSafeInteger(meta.apiRelease)||Number(meta.apiRelease)<1
    ||typeof meta.gamePatch!=="string"||!/^(15|16)\.[1-9][0-9]?$/.test(meta.gamePatch)
    ||typeof meta.dataVersion!=="string"||!/^\d+\.\d+\.\d+$/.test(meta.dataVersion)||!meta.dataVersion.startsWith(`${meta.gamePatch}.`)
    ||typeof meta.generatedAt!=="string"||!Number.isFinite(Date.parse(meta.generatedAt))
    ||typeof meta.publishedAt!=="string"||!Number.isFinite(Date.parse(meta.publishedAt))
    ||typeof meta.configRevision!=="string"||!meta.configRevision.trim()||!Array.isArray(root.data)||!root.data.length||root.data.length>300
    ||meta.total!==root.data.length) throw new Error("invalid_champion_tier_source");
  const tiers:Record<string,number>={};const seen=new Set<number>();let date:string|undefined;
  for(const row of root.data){
    const id=row?.id,tier=row?.stats?.tier,rowPatch=row?.stats?.gamePatch,rowDate=row?.stats?.date;
    if(typeof id!=="number"||!Number.isSafeInteger(id)||id<1||id>99999||(tier!==undefined&&tier!==null&&(typeof tier!=="number"||!Number.isInteger(tier)||tier<1||tier>5))
      ||rowPatch!==meta.gamePatch||!validDate(rowDate)||(date!==undefined&&date!==rowDate)||seen.has(id)) throw new Error("invalid_champion_tier_source");
    seen.add(id);if(tier!==undefined&&tier!==null) tiers[String(id)]=tier;date=rowDate;
  }
  return parseMayhemChampionTiers({patch:meta.gamePatch,dataVersion:meta.dataVersion,date,tiers});
}
export function parseMayhemChampionTiers(value: unknown): MayhemChampionTiers {
  const v=value as MayhemChampionTiers|null;
  if(!v || !/^(15|16)\.[1-9][0-9]?$/.test(v.patch) || !/^\d+\.\d+\.\d+$/.test(v.dataVersion) || !v.dataVersion.startsWith(`${v.patch}.`)
    || !validDate(v.date)
    || !v.tiers || typeof v.tiers!=="object" || Array.isArray(v.tiers) || Object.keys(v.tiers).length>300
    || Object.entries(v.tiers).some(([id,tier])=> !/^[1-9][0-9]{0,4}$/.test(id) || !Number.isInteger(tier) || tier<1 || tier>5)) throw new Error("invalid_champion_tiers");
  return {patch:v.patch,dataVersion:v.dataVersion,date:v.date,tiers:v.tiers};
}
export function sortMayhemChampions(champions: LolChampion[], tiers: MayhemChampionTiers|null|undefined, patch: string) {
  if(!tiers || tiers.patch!==patch) return champions;
  return [...champions].sort((a,b)=>(tiers.tiers[String(a.id)]??6)-(tiers.tiers[String(b.id)]??6) || a.name.localeCompare(b.name,"ko"));
}
