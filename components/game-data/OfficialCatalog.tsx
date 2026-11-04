"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";

type AddOn = { name?: string; description?: string };
type AddOnGroup = { categories?: { name?: string; addOns?: AddOn[] }[] };

export default function OfficialCatalog({ category }: { category: "weapons" | "vehicles" }) {
  const [items, setItems] = useState<OfficialItem[] | null>(null);
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    supabase.from("official_game_catalog").select("items,source_url").eq("category", category).maybeSingle().then(({ data, error }) => {
      if (!live) return;
      if (error) setError(true);
      else { setItems((data?.items ?? []) as OfficialItem[]); setSource(data?.source_url ?? ""); }
    });
    return () => { live = false; };
  }, [category, retry]);
  const visible = (items ?? []).filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()));
  const active = visible.find((item) => item.key === selected) ?? visible[0];
  const imageUrl = typeof active?.official?.imageUrl === "string" && active.official.imageUrl.startsWith("https://wstatic-prod.pubg.com/") ? active.official.imageUrl : "";
  const groups = (active?.official?.addOnGroup as AddOnGroup | undefined)?.categories ?? [];
  const videos = (active?.official?.playList as { title?: string; videoUrl?: string }[] | undefined) ?? [];
  const description = typeof active?.official?.description === "string" ? active.official.description : "";
  return <section className="text-zinc-200" aria-label={category === "weapons" ? "무기 목록" : "탈것 목록"}>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="mt-1 text-2xl font-black text-white sm:text-3xl">{category === "weapons" ? "무기" : "탈것"} 도감</h2><p className="mt-2 text-sm text-zinc-400">공식 도감 기준 · 항목별 업데이트 시점이 다를 수 있습니다.</p></div>
      <label className="text-xs font-bold text-zinc-400">이름 검색<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="이름을 입력하세요" className="mt-1 block min-h-11 w-56 max-w-full rounded border border-zinc-600 bg-zinc-900 px-3 text-sm text-white placeholder:text-zinc-500" /></label>
    </div>
    {error ? <div role="alert" className="py-12 text-center text-sm">공식 정보를 불러오지 못했습니다. <button className="underline" onClick={() => { setError(false); setItems(null); setRetry((n) => n + 1); }}>다시 시도</button></div> : items === null ? <p className="py-12 text-center text-sm text-zinc-400">불러오는 중…</p> : items.length === 0 ? <p className="py-12 text-center text-sm text-zinc-400">아직 등록된 공식 정보가 없습니다.</p> : visible.length === 0 ? <p className="py-12 text-center text-sm text-zinc-400">검색 결과가 없습니다.</p> : <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
      <div className="grid max-h-[48rem] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3" aria-label="항목 선택">
        {visible.map((item) => {
          const src = typeof item.official?.imageUrl === "string" && item.official.imageUrl.startsWith("https://wstatic-prod.pubg.com/") ? item.official.imageUrl : "";
          return <button type="button" key={item.key} onClick={() => { setSelected(item.key); if (window.innerWidth < 1024) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }} aria-pressed={active?.key === item.key} className={`group min-w-0 border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${active?.key === item.key ? "border-amber-400 bg-zinc-800" : "border-zinc-800 bg-zinc-900 hover:border-zinc-500"}`}>
            <span className="flex h-24 items-center justify-center sm:h-28">{src && <img src={src} alt="" loading="lazy" className="max-h-full max-w-full object-contain transition-transform group-hover:scale-105" />}</span><span className="mt-2 block break-words text-sm font-bold text-white">{item.name}</span>
          </button>;
        })}
      </div>
      {active && <article ref={detailRef} className="min-w-0 scroll-mt-20 border border-zinc-800 bg-[#171717] p-5 sm:p-6" aria-label={`${active.name} 상세 정보`}>
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs text-amber-400">{category === "weapons" ? "무기" : "탈것"}</p><h3 className="mt-1 text-2xl font-black text-white">{active.name}</h3></div><span className="text-right text-xs text-zinc-400">{active.updated}</span></div>
        <div className="my-5 flex h-44 items-center justify-center bg-[#111] sm:h-52">{imageUrl && <img src={imageUrl} alt={active.name} className="max-h-full max-w-full object-contain" />}</div>
        {description && <p className="mb-4 text-sm leading-6 text-zinc-300">{description}</p>}
        {active.ammunition && <p className="mb-3 text-sm text-zinc-300">탄약 <strong className="ml-2 text-white">{active.ammunition}</strong></p>}
        <h4 className="border-b border-zinc-700 pb-2 text-sm font-bold text-white">성능 및 제원</h4><dl className="divide-y divide-zinc-800">{Object.entries(active.specs).map(([name,value]) => <div key={name} className="flex justify-between gap-4 py-2 text-sm"><dt className="text-zinc-400">{name}</dt><dd className="min-w-0 break-words text-right text-zinc-100">{value}</dd></div>)}</dl>
        {groups.some((group) => group.addOns?.length) && <div className="mt-5"><h4 className="border-b border-zinc-700 pb-2 text-sm font-bold text-white">장착 가능한 부착물</h4>{groups.filter((group) => group.addOns?.length).map((group) => <div key={group.name} className="mt-3 text-sm"><strong className="text-zinc-300">{group.name}</strong><ul className="mt-1 space-y-1 text-zinc-400">{group.addOns?.map((item, index) => <li key={`${item.name}-${index}`}><span className="text-zinc-200">{item.name}</span>{item.description && <span> · {item.description}</span>}</li>)}</ul></div>)}</div>}
        {videos.some((video) => video.videoUrl?.startsWith("https://wstatic-prod.pubg.com/")) && <div className="mt-5 flex flex-wrap gap-3">{videos.filter((video) => video.videoUrl?.startsWith("https://wstatic-prod.pubg.com/")).map((video) => <a key={video.videoUrl} href={video.videoUrl} target="_blank" rel="noreferrer" className="text-xs text-amber-400 underline">{video.title || "영상 보기"}</a>)}</div>}
        {source && <a href={source} target="_blank" rel="noreferrer" className="mt-5 inline-block text-xs text-amber-400 underline">PUBG 공식 도감에서 보기</a>}
      </article>}
    </div>}
  </section>;
}
