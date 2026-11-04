import "server-only";
import { unstable_cache } from "next/cache";
import { createSourceDownloader } from "./augments/ingest";
import { parseRankingPatches, parsePatchAugmentRanking, validArchivePatch } from "./mayhemPatchRankings";
const download = () => createSourceDownloader((url,init)=>fetch(url,{...init,cache:"no-store",signal:AbortSignal.timeout(8000)}));
const patches = unstable_cache(async()=>parseRankingPatches(JSON.parse(await download()("https://arammayhem.com/data/v1/index.json",true,512*1024))),["lol-mayhem-ranking-patches-v1"],{revalidate:21600});
const ranking = unstable_cache(async(patch:string)=>parsePatchAugmentRanking(JSON.parse(await download()(`https://arammayhem.com/data/v1/${patch.replace('.','-')}/augments.json`,true,2*1024*1024)),patch),["lol-mayhem-patch-rankings-v1"],{revalidate:21600});
export async function getMayhemPatchRankings(requestedPatch?: string) {
  if(requestedPatch!==undefined && !validArchivePatch(requestedPatch))throw new Error("ranking_patch_invalid");
  const available=await patches();
  const patch=requestedPatch??available[0];
  if(!available.includes(patch))throw new Error("ranking_patch_unavailable");
  return {patches:available,ranking:await ranking(patch)};
}
