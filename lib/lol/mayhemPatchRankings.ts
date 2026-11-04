export type PatchAugmentRank = { id: string; name: string; rarity: "silver"|"gold"|"prismatic"; pickRate: number|null; rank: number|null };
export type MayhemPatchRanking = { patch: string; date: string; estimated: boolean; rows: PatchAugmentRank[] };
export const validArchivePatch = (value: unknown): value is string => typeof value === "string" && /^(25|26)\.[1-9][0-9]?$/.test(value);
const invalid = () => new Error("invalid_patch_ranking");
export function parseRankingPatches(value: unknown): string[] {
  const root=value as {schemaVersion?:unknown;patches?:Array<{patch?:unknown;files?:{augments?:{json?:unknown}}}>}|null;
  if(root?.schemaVersion!==1 || !Array.isArray(root.patches) || !root.patches.length || root.patches.length>100)throw invalid();
  const patches=root.patches.map(row=>{
    if(!validArchivePatch(row?.patch) || row.files?.augments?.json!==`https://arammayhem.com/data/v1/${row.patch.replace('.','-')}/augments.json`)throw invalid();
    return row.patch;
  });
  if(new Set(patches).size!==patches.length)throw invalid();
  return patches.sort((a,b)=>{const aa=a.split('.').map(Number),bb=b.split('.').map(Number);return bb[0]-aa[0]||bb[1]-aa[1];});
}
export function parsePatchAugmentRanking(value: unknown, patch: string): MayhemPatchRanking {
  const root=value as {schemaVersion?:unknown;licenseUrl?:unknown;meta?:{patch?:unknown;statsDate?:unknown;statsDateSource?:unknown};rows?:unknown[]}|null;
  const date=root?.meta?.statsDate;
  if(!validArchivePatch(patch) || root?.schemaVersion!==1 || root.licenseUrl!=="https://creativecommons.org/licenses/by/4.0/" || root.meta?.patch!==patch
    || typeof date!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date
    || !["release","estimated"].includes(String(root.meta.statsDateSource)) || !Array.isArray(root.rows) || !root.rows.length || root.rows.length>2000)throw invalid();
  const ids=new Set<string>();
  const rows=root.rows.map(raw=>{
    const row=raw as {augmentId?:unknown;name?:Record<string,unknown>;rarity?:unknown;pickRate?:unknown;pickRateRank?:unknown}|null;
    const id=row?.augmentId, name=row?.name?.['ko-KR']??row?.name?.en;
    if(typeof id!=="string" || !/^[a-z0-9][a-z0-9_!-]{0,127}$/i.test(id) || ids.has(id) || typeof name!=="string" || !name.trim() || name.length>200
      || !["silver","gold","prismatic"].includes(String(row?.rarity))
      || (row?.pickRate!==null && (typeof row?.pickRate!=="number" || !Number.isFinite(row.pickRate) || row.pickRate<0 || row.pickRate>100))
      || (row?.pickRateRank!==null && (typeof row?.pickRateRank!=="number" || !Number.isSafeInteger(row.pickRateRank) || row.pickRateRank<1 || row.pickRateRank>2000)))throw invalid();
    ids.add(id);
    return {id,name:name.trim(),rarity:row!.rarity as PatchAugmentRank['rarity'],pickRate:row!.pickRate as number|null,rank:row!.pickRateRank as number|null};
  });
  rows.sort((a,b)=>a.pickRate===null?(b.pickRate===null?a.id.localeCompare(b.id):1):b.pickRate===null?-1:b.pickRate-a.pickRate||a.id.localeCompare(b.id));
  return {patch,date,estimated:root.meta.statsDateSource==="estimated",rows};
}
