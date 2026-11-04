import { NextResponse } from "next/server";
import { guardLolPublicRequest } from "@/lib/lol/publicAccess.server";
import { getMayhemPatchRankings } from "@/lib/lol/mayhemPatchRankings.server";
import { validArchivePatch } from "@/lib/lol/mayhemPatchRankings";
export const dynamic="force-dynamic";
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
export async function GET(request:Request){
  const denied=await guardLolPublicRequest(request,"read");if(denied)return denied;
  const query=new URL(request.url).searchParams;const patch=query.get("patch");
  if((patch!==null&&!validArchivePatch(patch)) || query.getAll("patch").length>1 || [...query.keys()].some(key=>key!=="patch"))return reply({error:"패치를 확인해 주세요."},400);
  try{return reply(await getMayhemPatchRankings(patch??undefined));}
  catch(error){return reply({error:"패치별 증강 순위를 불러오지 못했습니다."},error instanceof Error&&error.message==="ranking_patch_unavailable"?404:503);}
}
