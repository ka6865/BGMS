import "server-only";
import { createSourceDownloader } from "./augments/ingest";
import { createChampionSource } from "./mayhemChampionSource";
import { parseChampionTierSource, type MayhemChampionTiers } from "./mayhemChampionTiers";
import { parseMayhemItemRatings, withMayhemItemMetadata, type MayhemItemRatings } from "./mayhemItems";
import { parsePatchAugmentRanking, parseRankingPatches, validArchivePatch, type MayhemPatchRanking } from "./mayhemPatchRankings";

const timeoutFetch:typeof fetch=(input,init)=>fetch(input,{...init,redirect:"error",cache:"no-store",signal:AbortSignal.timeout(8_000)});
const download=()=>createSourceDownloader(timeoutFetch);
let versionsCache:{expiresAt:number;promise:Promise<string[]>}|undefined;
const metadataCache=new Map<string,{expiresAt:number;promise:Promise<unknown>}>();
function versions():Promise<string[]> {
  if(versionsCache&&versionsCache.expiresAt>Date.now())return versionsCache.promise;
  const entry={expiresAt:Date.now()+3600_000,promise:(async()=>{
  const value=JSON.parse(await download()("https://ddragon.leagueoflegends.com/api/versions.json",true,128*1024));
  if(!Array.isArray(value)||value.length>1000)throw new Error("mayhem_items_version_invalid");
  const valid=value.filter((v):v is string=>typeof v==="string"&&/^\d+\.\d+\.\d+$/.test(v));
  if(!valid.length)throw new Error("mayhem_items_version_invalid");
  return valid;
  })()};
  versionsCache=entry;void entry.promise.catch(()=>{if(versionsCache===entry)versionsCache=undefined;});return entry.promise;
}
function itemMetadata(version:string):Promise<unknown> {
  const current=metadataCache.get(version);if(current&&current.expiresAt>Date.now())return current.promise;
  const entry={expiresAt:Date.now()+21600_000,promise:(async()=>JSON.parse(await download()(
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/item.json`,true,4*1024*1024,
  )))()};
  metadataCache.delete(version);metadataCache.set(version,entry);
  while(metadataCache.size>4)metadataCache.delete(metadataCache.keys().next().value!);
  void entry.promise.catch(()=>{if(metadataCache.get(version)===entry)metadataCache.delete(version);});return entry.promise;
}
const record=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new Error("mayhem_item_snapshot_invalid");
  return value as Record<string,unknown>;
};
const MAX_RAW_BYTES=2*1024*1024;
const EXCLUDED_ITEM_IDS=new Set([2052,220013]);
function itemMetadataSubset(value:unknown,parsed:NonNullable<ReturnType<typeof parseMayhemItemRatings>>):unknown {
  const data=record(record(value).data);const ids=new Set(parsed.ratings.filter(row=>row.id!==1001&&!EXCLUDED_ITEM_IDS.has(row.id)).map(row=>row.id));
  for(const id of [...ids]){
    const from=(data[String(id)] as {from?:unknown}|undefined)?.from;
    if(Array.isArray(from)&&from.length<=8)for(const component of from)if(typeof component==="string"&&/^[1-9][0-9]{0,5}$/.test(component)&&!EXCLUDED_ITEM_IDS.has(Number(component)))ids.add(Number(component));
  }
  return {data:Object.fromEntries([...ids].sort((a,b)=>a-b).flatMap(id=>{
    const row=data[String(id)];if(!row||typeof row!=="object"||Array.isArray(row))return [];
    const metadata=row as Record<string,unknown>;return [[String(id),{name:metadata.name,image:metadata.image,from:metadata.from,tags:metadata.tags}]];
  }))};
}

export async function fetchChampionTierSnapshot(options:{beforeRequest?:()=>Promise<void>}={}):Promise<{raw:string;normalized:MayhemChampionTiers}> {
  const source=createChampionSource({apiKey:process.env.LOL_MAYHEM_STATS_API_KEY,beforeRequest:options.beforeRequest});
  const version=await source.config();
  const captured=await source.championList(version);
  const normalized=parseChampionTierSource(captured.value);
  const after=await source.config();
  if(after.gamePatch!==version.gamePatch||after.dataVersion!==version.dataVersion)throw new Error("source_version_mismatch");
  return {raw:captured.body,normalized};
}

export function normalizeItemRatingSnapshot(value:unknown,championId:number):MayhemItemRatings {
  if(!Number.isSafeInteger(championId)||championId<1||championId>99999)throw new Error("invalid_champion_id");
  const root=record(value);
  if(Object.keys(root).length!==4||root.schemaVersion!==1||root.championId!==championId)throw new Error("mayhem_item_snapshot_invalid");
  const source=record(root.iesdev),official=record(root.dataDragon);
  if(Object.keys(official).length!==2||typeof official.version!=="string"||!/^\d+\.\d+\.\d+$/.test(official.version))throw new Error("mayhem_item_snapshot_invalid");
  const parsed=parseMayhemItemRatings(source,championId);
  if(!parsed)throw new Error("mayhem_item_snapshot_invalid");
  return withMayhemItemMetadata(parsed,official.version,official.metadata);
}

export async function fetchItemRatingSnapshot(championId:number):Promise<{raw:string;normalized:MayhemItemRatings}|null> {
  if(!Number.isSafeInteger(championId)||championId<1||championId>99999)throw new Error("invalid_champion_id");
  const url=`https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champion?champion_id=${championId}`;
  const source=JSON.parse(await download()(url,true,1024*1024));
  const parsed=parseMayhemItemRatings(source,championId);
  if(!parsed)return null;
  const version=(await versions()).find(candidate=>candidate.startsWith(`${parsed.patch}.`));
  if(!version)throw new Error("mayhem_items_version_unavailable");
  const fullMetadata=await itemMetadata(version);
  const snapshot={schemaVersion:1,championId,iesdev:source,dataDragon:{version,metadata:itemMetadataSubset(fullMetadata,parsed)}};
  const raw=JSON.stringify(snapshot);
  if(Buffer.byteLength(raw)>MAX_RAW_BYTES)throw new Error("mayhem_item_snapshot_too_large");
  return {raw,normalized:normalizeItemRatingSnapshot(snapshot,championId)};
}

export async function fetchRankingIndex():Promise<string[]> {
  const raw=await download()("https://arammayhem.com/data/v1/index.json",true,512*1024);
  return parseRankingPatches(JSON.parse(raw));
}

export async function fetchRankingSnapshot(patch:string):Promise<{raw:string;normalized:MayhemPatchRanking}> {
  if(!validArchivePatch(patch))throw new Error("ranking_patch_invalid");
  const raw=await download()(`https://arammayhem.com/data/v1/${patch.replace(".","-")}/augments.json`,true,2*1024*1024);
  return {raw,normalized:parsePatchAugmentRanking(JSON.parse(raw),patch)};
}
