"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";

const LABELS: Record<string, string> = {
  key: "공식 ID", name: "이름", imageUrl: "이미지", description: "설명", updateDate: "갱신일", ammunition: "탄약", ammunitionImageUrl: "탄약 이미지", feature: "성능", title: "제목", specs: "제원", data: "값", playList: "영상", videoUrl: "영상 링크", addOnGroup: "부착물", categories: "분류", addOns: "부착물 목록", position: "위치", top: "상단", left: "좌측", skinGroup: "스킨", skins: "스킨 목록",
};

function Detail({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span>없음</span>;
  if (Array.isArray(value)) return value.length ? <ul className="space-y-1 pl-3">{value.map((item, i) => <li key={i}><Detail value={item} /></li>)}</ul> : <span>없음</span>;
  if (typeof value === "object") return <dl className="space-y-1 pl-3">{Object.entries(value).map(([key, item]) => <div key={key}><dt className="inline font-semibold text-gray-200">{LABELS[key] ?? key}: </dt><dd className="ml-2"><Detail value={item} /></dd></div>)}</dl>;
  const text = String(value);
  if (/^https:\/\//i.test(text)) return <a className="break-all text-amber-300 underline" href={text} target="_blank" rel="noreferrer">링크 보기</a>;
  return <span className="break-words">{text}</span>;
}

export default function OfficialCatalog({ category }: { category: "weapons" | "vehicles" }) {
  const [items, setItems] = useState<OfficialItem[] | null>(null);
  const [source, setSource] = useState("");
  const [fetchedAt, setFetchedAt] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    supabase.from("official_game_catalog").select("items,source_url,fetched_at").eq("category", category).maybeSingle().then(({ data, error }) => {
      if (!live) return;
      if (error) setError(true);
      else { setItems((data?.items ?? []) as OfficialItem[]); setSource(data?.source_url ?? ""); setFetchedAt(data?.fetched_at ?? ""); }
    });
    return () => { live = false; };
  }, [category]);
  const visible = (items ?? []).filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  return <section className="mx-auto my-8 max-w-6xl px-4 text-gray-300">
    <h2 className="text-xl font-bold text-white">공식 {category === "weapons" ? "무기" : "차량"} 정보</h2>
    <p className="mt-2 text-sm">공식 도감의 원본 정보입니다. 항목마다 갱신 시점이 다르며, 기존 BGMS 계산값과 단위가 다를 수 있습니다.</p>
    {source && <p className="mt-1 text-xs">출처: <a href={source} target="_blank" rel="noreferrer" className="text-amber-300 underline">PUBG 공식 도감</a> · 수집 {new Date(fetchedAt).toLocaleDateString("ko-KR")}</p>}
    {error ? <p className="mt-3 text-sm">공식 정보를 불러오지 못했습니다.</p> : items === null ? <p className="mt-3 text-sm">불러오는 중…</p> : items.length === 0 ? <p className="mt-3 text-sm">아직 등록된 공식 정보가 없습니다.</p> : <>
      <label className="mt-3 block text-sm">이름 검색 <input value={search} onChange={(event) => setSearch(event.target.value)} className="ml-2 max-w-full rounded border border-gray-600 bg-[#141414] px-2 py-1 text-white" /></label>
      <div className="mt-3 divide-y divide-gray-700">{visible.map((item) => <details key={item.key} className="py-3 text-sm"><summary className="cursor-pointer font-semibold text-white">{item.name} <span className="font-normal text-gray-400">{item.updated}</span></summary><div className="mt-2 leading-6"><Detail value={item.official} /></div></details>)}</div>
      {visible.length === 0 && <p className="mt-3 text-sm">일치하는 항목이 없습니다.</p>}
    </>}
  </section>;
}
