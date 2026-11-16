"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";

type AddOn = { name?: string; description?: string };
type AddOnGroup = { categories?: { name?: string; addOns?: AddOn[] }[] };

type Props = {
  category: "weapons" | "vehicles";
  onConfigureWeapon?: (item: OfficialItem) => void;
  onItemsLoaded?: (items: OfficialItem[]) => void;
  onLoadError?: () => void;
  onToggleCompare?: (item: OfficialItem) => void;
  comparedKeys?: readonly string[];
  compareFull?: boolean;
};
const UNKNOWN = "__unknown__";
// 공식 원문 updateDate에 이미 "마지막 업데이트:" 접두어가 붙어 있어 라벨 중복을 막는다.
const officialUpdated = (value: string) => value.replace(/^\s*마지막 업데이트\s*:\s*/, "").trim() || "미확인";
export const compareKey = (item: OfficialItem) => `official:${item.key}`;
const classification = (item: OfficialItem) => typeof item.category?.key === "string" && item.category.key.trim() && typeof item.category.name === "string" && item.category.name.trim() ? item.category : undefined;

export default function OfficialCatalog({ category, onConfigureWeapon, onItemsLoaded, onLoadError, onToggleCompare, comparedKeys = [], compareFull = false }: Props) {
  const [items, setItems] = useState<OfficialItem[] | null>(null);
  const [source, setSource] = useState("");
  const [fetchedAt, setFetchedAt] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [ammoFilter, setAmmoFilter] = useState("");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnPosition = useRef<{ pageY: number; listTop: number; button: HTMLButtonElement } | null>(null);
  useEffect(() => {
    if (mobileDetail) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start" });
    } else if (returnPosition.current) {
      const { pageY, listTop, button } = returnPosition.current;
      if (listRef.current) listRef.current.scrollTop = listTop;
      window.scrollTo({ top: pageY, behavior: "instant" });
      button.focus({ preventScroll: true });
      returnPosition.current = null;
    }
  }, [mobileDetail]);
  useEffect(() => {
    let live = true;
    supabase.from("official_game_catalog").select("items,source_url,fetched_at").eq("category", category).maybeSingle().then(({ data, error }) => {
      if (!live) return;
      if (error) { setError(true); onLoadError?.(); }
      else {
        const loaded = (data?.items ?? []) as OfficialItem[];
        setItems(loaded); setSource(data?.source_url ?? ""); setFetchedAt(data?.fetched_at ?? "");
        onItemsLoaded?.(loaded);
      }
    }, () => { if (live) { setError(true); onLoadError?.(); } });
    return () => { live = false; };
  }, [category, retry, onItemsLoaded, onLoadError]);
  const types = new Map((items ?? []).map((item) => {
    const type = classification(item);
    return [type?.key ?? UNKNOWN, type?.name ?? "분류 미확인"];
  }));
  const ammunition = [...new Set((items ?? []).map((item) => item.ammunition?.trim() || UNKNOWN))];
  const visible = (items ?? []).filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase())
    && (!typeFilter || (classification(item)?.key ?? UNKNOWN) === typeFilter)
    && (category !== "weapons" || !ammoFilter || (item.ammunition?.trim() || UNKNOWN) === ammoFilter));
  const collectedDate = fetchedAt && !Number.isNaN(Date.parse(fetchedAt))
    ? new Date(fetchedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "미확인";
  const active = visible.find((item) => item.key === selected) ?? visible[0];
  const imageUrl = typeof active?.official?.imageUrl === "string" && active.official.imageUrl.startsWith("https://wstatic-prod.pubg.com/") ? active.official.imageUrl : "";
  const groups = (active?.official?.addOnGroup as AddOnGroup | undefined)?.categories ?? [];
  const videos = (active?.official?.playList as { title?: string; videoUrl?: string }[] | undefined) ?? [];
  const description = typeof active?.official?.description === "string" ? active.official.description : "";
  return <section className="text-zinc-200" aria-label={category === "weapons" ? "무기 목록" : "탈것 목록"}>
    <div className={`mb-5 flex-wrap items-end justify-between gap-4 ${mobileDetail ? "hidden lg:flex" : "flex"}`}>
      <div><h2 className="mt-1 text-2xl font-black text-white sm:text-3xl">{category === "weapons" ? "무기" : "탈것"} 도감</h2><p className="mt-2 text-sm text-zinc-400">공식 도감 기준 · 항목별 업데이트 시점이 다를 수 있습니다.</p></div>
      <label className="text-xs font-bold text-zinc-400">이름 검색<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="이름을 입력하세요" className="mt-1 block min-h-11 w-56 max-w-full rounded border border-zinc-600 bg-zinc-900 px-3 text-sm text-white placeholder:text-zinc-500" /></label>
      <div className="flex w-full flex-wrap gap-3">
        <label className="min-w-0 text-xs font-bold text-zinc-400">{category === "weapons" ? "무기 종류" : "탈것 분류"}<select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="mt-1 block min-h-11 max-w-full rounded border border-zinc-600 bg-zinc-900 px-3 text-sm text-white"><option value="">전체</option>{[...types].map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        {category === "weapons" && <label className="min-w-0 text-xs font-bold text-zinc-400">탄약<select value={ammoFilter} onChange={(e) => setAmmoFilter(e.target.value)} className="mt-1 block min-h-11 max-w-full rounded border border-zinc-600 bg-zinc-900 px-3 text-sm text-white"><option value="">전체</option>{ammunition.map((ammo) => <option key={ammo} value={ammo}>{ammo === UNKNOWN ? "탄약 미표기" : ammo}</option>)}</select></label>}
      </div>
    </div>
    <p className="mb-4 text-xs text-zinc-400">공식 자료 수집일: {collectedDate}{collectedDate !== "미확인" && " (한국시간)"}</p>
    {error ? <div role="alert" className="py-12 text-center text-sm">공식 정보를 불러오지 못했습니다. <button className="min-h-11 px-2 underline" onClick={() => { setError(false); setItems(null); setRetry((n) => n + 1); }}>다시 시도</button></div> : items === null ? <p className="py-12 text-center text-sm text-zinc-400">불러오는 중…</p> : items.length === 0 ? <p className="py-12 text-center text-sm text-zinc-400">아직 등록된 공식 정보가 없습니다.</p> : visible.length === 0 ? <p className="py-12 text-center text-sm text-zinc-400">검색·필터 결과가 없습니다.</p> : <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
      <div ref={listRef} className={`max-h-[48rem] auto-rows-max content-start self-start grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 ${mobileDetail ? "hidden lg:grid" : "grid"}`} aria-label="항목 선택">
        {visible.map((item) => {
          const src = typeof item.official?.imageUrl === "string" && item.official.imageUrl.startsWith("https://wstatic-prod.pubg.com/") ? item.official.imageUrl : "";
          return <button type="button" key={item.key} onClick={(event) => {
            setSelected(item.key);
            if (window.innerWidth < 1024) {
              returnPosition.current = { pageY: window.scrollY, listTop: listRef.current?.scrollTop ?? 0, button: event.currentTarget };
              setMobileDetail(true);
            }
          }} aria-pressed={active?.key === item.key} className={`group min-w-0 border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${active?.key === item.key ? "border-amber-400 bg-zinc-800" : "border-zinc-800 bg-zinc-900 hover:border-zinc-500"}`}>
            <span className="flex h-24 items-center justify-center sm:h-28">{src && <img src={src} alt="" loading="lazy" className="max-h-full max-w-full object-contain transition-transform group-hover:scale-105" />}</span><span className="mt-2 block break-words text-sm font-bold text-white">{item.name}</span>
          </button>;
        })}
      </div>
      {active && <article ref={detailRef} tabIndex={-1} className={`min-w-0 scroll-mt-20 border border-zinc-800 bg-[#171717] p-5 sm:p-6 ${mobileDetail ? "block" : "hidden lg:block"}`} aria-label={`${active.name} 상세 정보`}>
        <button type="button" onClick={() => setMobileDetail(false)} className="mb-4 min-h-11 px-2 text-sm text-amber-400 underline lg:hidden">목록으로 돌아가기</button>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-amber-400">{classification(active)?.name ?? "분류 미확인"}</p><h3 className="mt-1 text-2xl font-black text-white">{active.name}</h3></div><span className="text-right text-xs text-zinc-400">공식 항목 수정일: {officialUpdated(active.updated)}</span></div>
        {category === "weapons" && onConfigureWeapon && <button type="button" onClick={() => onConfigureWeapon(active)} className="mt-4 min-h-11 rounded border border-amber-400 px-4 py-2 text-sm font-bold text-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400">이 무기로 파츠 설정</button>}
        {category === "weapons" && onToggleCompare && (() => {
          const compared = comparedKeys.includes(compareKey(active));
          return <button type="button" aria-pressed={compared} disabled={!compared && compareFull} onClick={() => onToggleCompare(active)} className="ml-2 mt-4 min-h-11 rounded border border-zinc-600 px-4 py-2 text-sm font-bold text-zinc-200 hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400">{compared ? "비교에서 빼기" : compareFull ? "비교 목록이 가득 찼습니다" : "비교에 추가"}</button>;
        })()}
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
