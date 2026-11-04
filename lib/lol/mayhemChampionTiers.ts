import type { LolChampion } from "./champions";
export type MayhemChampionTiers = { patch: string; dataVersion: string; date: string; tiers: Record<string, number> };
export function parseMayhemChampionTiers(value: unknown): MayhemChampionTiers {
  const v=value as MayhemChampionTiers|null;
  if(!v || !/^(15|16)\.[1-9][0-9]?$/.test(v.patch) || !/^\d+\.\d+\.\d+$/.test(v.dataVersion) || !v.dataVersion.startsWith(`${v.patch}.`)
    || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) || !Number.isFinite(Date.parse(v.date)) || new Date(v.date).toISOString().slice(0,10)!==v.date
    || !v.tiers || typeof v.tiers!=="object" || Array.isArray(v.tiers) || Object.keys(v.tiers).length>300
    || Object.entries(v.tiers).some(([id,tier])=> !/^[1-9][0-9]{0,4}$/.test(id) || !Number.isInteger(tier) || tier<1 || tier>5)) throw new Error("invalid_champion_tiers");
  return {patch:v.patch,dataVersion:v.dataVersion,date:v.date,tiers:v.tiers};
}
export function sortMayhemChampions(champions: LolChampion[], tiers: MayhemChampionTiers|null|undefined, patch: string) {
  if(!tiers || tiers.patch!==patch) return champions;
  return [...champions].sort((a,b)=>(tiers.tiers[String(a.id)]??6)-(tiers.tiers[String(b.id)]??6) || a.name.localeCompare(b.name,"ko"));
}
