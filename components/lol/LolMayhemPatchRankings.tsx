"use client";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { MayhemPatchRanking } from "@/lib/lol/mayhemPatchRankings";
import type { LolMayhemCatalog } from "@/lib/lol/augments/catalog";
import { AugmentIcon } from "./LolMayhemArchive";
const control="min-h-11 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus-visible:border-amber-400";
const rarityLabels={silver:"실버",gold:"골드",prismatic:"프리즘"};
// 순위 자료는 외부 ID라 공식 증강과 한글 이름(공백·"퀘스트:" 접두어 무시)으로 맞춰 아이콘을 찾는다. 도감에 없는 지난 증강은 빈 칸으로 둔다.
const nameKey=(name:string)=>name.replace(/^퀘스트:/,"").replace(/\s+/g,"");
export default function LolMayhemPatchRankings({catalog=null}:{catalog?:LolMayhemCatalog|null}){
  const icons=new Map((catalog?.augments??[]).map(augment=>[nameKey(augment.name),augment.icon]));
  const [patch,setPatch]=useState("");const [query,setQuery]=useState("");const [rarity,setRarity]=useState("");const [retry,setRetry]=useState(0);
  const [patches,setPatches]=useState<string[]>([]);
  const [response,setResponse]=useState<{key:string;ranking:MayhemPatchRanking|null;error:boolean}|null>(null);
  const key=`${patch}:${retry}`,current=response?.key===key?response:null;
  useEffect(()=>{
    const controller=new AbortController();
    fetch(`/api/lol/mayhem/patch-rankings${patch?`?patch=${encodeURIComponent(patch)}`:""}`,{cache:"no-store",signal:controller.signal})
      .then(async result=>{if(!result.ok)throw new Error("rankings_unavailable");return result.json() as Promise<{patches:string[];ranking:MayhemPatchRanking}>;})
      .then(result=>{if(!controller.signal.aborted){setPatches(result.patches);setResponse({key,ranking:result.ranking,error:false});}})
      .catch(()=>{if(!controller.signal.aborted)setResponse({key,ranking:null,error:true});});
    return()=>controller.abort();
  },[patch,key]);
  const data=current?.ranking;const term=query.trim().toLocaleLowerCase("ko");
  const rows=(data?.rows??[]).filter(row=>(!rarity||row.rarity===rarity)&&(!term||row.name.toLocaleLowerCase("ko").includes(term)));
  return <section aria-label="패치별 증강 순위" className="mt-5 min-w-0 space-y-4">
    <header className="space-y-1"><h2 className="text-lg font-semibold">패치별 전체 증강 선택률 순위</h2><p className="text-xs leading-5 text-zinc-400">모든 챔피언을 합친 통계입니다. 챔피언별 선택률과는 별개입니다.</p>
      {data&&<p className="text-xs text-zinc-400">패치 {data.patch} · 통계 기준일 {data.date}{data.estimated?" (추정)":""}</p>}
    </header>
    {!!patches.length&&<div className="grid gap-2 sm:grid-cols-[auto_auto_minmax(0,1fr)]">
        <select aria-label="증강 순위 패치" value={patch||data?.patch||patches[0]} onChange={event=>setPatch(event.target.value)} className={control}>{patches.map(value=><option key={value} value={value}>패치 {value}</option>)}</select>
        <select aria-label="증강 순위 등급" value={rarity} onChange={event=>setRarity(event.target.value)} className={control}><option value="">전체 등급</option>{Object.entries(rarityLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
        <label className="relative min-w-0"><span className="sr-only">순위 증강 검색</span><Search aria-hidden="true" size={16} className="absolute left-3 top-3.5 text-zinc-400"/><input aria-label="순위 증강 검색" type="search" value={query} onChange={event=>setQuery(event.target.value)} className={`${control} w-full pl-9`}/></label>
      </div>}
    {!current?<p role="status" className="py-10 text-center text-sm text-zinc-400">패치별 순위를 불러오는 중입니다.</p>:current.error?<div role="alert" className="space-y-3 py-10 text-center text-sm text-zinc-400"><p>패치별 증강 순위를 불러오지 못했습니다.</p><button className={control} onClick={()=>setRetry(value=>value+1)}>다시 시도</button></div>:<>
      {rows.length?<ol aria-label="패치 증강 순위 목록" className="grid grid-cols-1 gap-2">{rows.map(row=><li key={row.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <span className="w-9 shrink-0 text-center text-sm tabular-nums text-zinc-400">{row.rank??"—"}</span>{catalog&&<AugmentIcon icon={icons.get(nameKey(row.name))} patch={catalog.clientPatch} rarity={row.rarity} size={40}/>}<div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold">{row.name}</h3><p className="mt-1 text-xs text-zinc-400">{rarityLabels[row.rarity]}</p></div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-amber-300">{row.pickRate===null?"미제공":`${row.pickRate.toFixed(2)}%`}</span>
      </li>)}</ol>:<div role="status" className="space-y-3 py-10 text-center text-sm text-zinc-400"><p>조건에 맞는 증강이 없습니다.</p><button className={control} onClick={()=>{setQuery("");setRarity("");}}>필터 초기화</button></div>}
    </>}
    <p className="text-xs text-zinc-400"><a href="https://arammayhem.com/data/" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline">Data: arammayhem.com · CC BY 4.0</a></p>
  </section>;
}
