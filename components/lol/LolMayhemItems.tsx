"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { MayhemItemAsset, MayhemItemRatings } from "@/lib/lol/mayhemItems";

const control = "min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 pl-9 text-sm text-zinc-100 outline-none placeholder:text-zinc-400 focus-visible:border-amber-400";
const chip = (active: boolean) => `min-h-11 rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-amber-400 ${active
  ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`;

function ItemImage({ item, version, size }: { item: MayhemItemAsset; version: string; size: number }) {
  return item.image
    ? <img src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${item.image}`} alt="" title={item.name} width={size} height={size}
      loading="lazy" decoding="async" className="shrink-0 rounded-md bg-zinc-800" style={{ width: size, height: size }} />
    : <span aria-hidden="true" className="shrink-0 rounded-md bg-zinc-800" style={{ width: size, height: size }} />;
}

export default function LolMayhemItems({ championId }: { championId: number }) {
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; dataset: MayhemItemRatings | null; error: boolean } | null>(null);
  const key = `${championId}:${retry}`;
  const current = response?.key === key ? response : null;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/lol/mayhem/champion-items/${championId}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("items_unavailable"); return response.json() as Promise<{ dataset: MayhemItemRatings | null }>; })
      .then(result => { if (!controller.signal.aborted) setResponse({ key, dataset: result.dataset, error: false }); })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key, dataset: null, error: true }); });
    return () => controller.abort();
  }, [championId, key]);

  const data = current?.dataset;
  const term = query.trim().toLocaleLowerCase("ko");
  const visible = (data?.items ?? []).filter(item => (tier === null || item.tier === tier)
    && (!term || item.name.toLocaleLowerCase("ko").includes(term) || String(item.id) === term));

  if (!current) return <p role="status" className="py-12 text-center text-sm text-zinc-400">증바람 아이템 평가를 불러오는 중입니다.</p>;
  if (current.error) return <div role="alert" className="space-y-3 py-10 text-center text-sm text-zinc-400">
    <p>증바람 아이템 자료를 불러오지 못했습니다.</p><button className={chip(false)} onClick={() => setRetry(value => value + 1)}>다시 시도</button>
  </div>;
  if (!data || !data.items.length) return <p role="status" className="py-12 text-center text-sm text-zinc-400">이 챔피언의 증바람 아이템 평가가 아직 없습니다.</p>;

  return <section aria-label="증바람 아이템 평가" data-champion-id={data.championId} className="min-w-0 space-y-4">
    <header className="space-y-1">
      <h3 className="text-base font-semibold">증바람 아이템 평가 <span className="ml-1 text-xs font-normal text-zinc-400">{data.items.length}개</span></h3>
      <p className="text-xs leading-5 text-zinc-400">아이템 패치 {data.patch.replace(/^16\./, "26.")} · 평가 기준일 {data.date}</p>
      <p className="text-xs leading-5 text-zinc-400">등급 산정식은 확인되지 않았습니다. 선택률과 실제 구매 순서는 제공되지 않습니다.</p>
    </header>
    <div className="space-y-3 rounded-xl bg-zinc-900 p-3">
      <label className="relative block"><span className="sr-only">증바람 아이템 검색</span><Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-3.5 text-zinc-400" />
        <input type="search" aria-label="증바람 아이템 검색" placeholder="아이템 이름으로 검색" value={query} onChange={event => setQuery(event.target.value)} className={control} />
      </label>
      <div role="group" aria-label="아이템 평가 등급" className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <button aria-pressed={tier === null} className={chip(tier === null)} onClick={() => setTier(null)}>전체</button>
        {[1, 2, 3, 4, 5].map(value => <button key={value} data-tier={value} aria-pressed={tier === value} className={chip(tier === value)} onClick={() => setTier(value)}>{value}티어</button>)}
      </div>
    </div>
    {visible.length ? <ul aria-label="증바람 아이템 목록" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{visible.map(item => <li key={item.id} data-tier={item.tier} className="min-w-0 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start gap-3">
        <ItemImage item={item} version={data.version} size={44} /><h4 className="min-w-0 flex-1 break-words text-sm font-semibold leading-6">{item.name}</h4>
        <span className={`shrink-0 text-xs font-semibold ${item.tier === 1 ? "text-amber-300" : "text-zinc-300"}`}>{item.tier}티어</span>
      </div>
      <div className="border-t border-zinc-800 pt-3">
        <p className="mb-2 text-xs text-zinc-400">제작 재료</p>
        {item.components.length ? <ul className="flex flex-wrap gap-x-3 gap-y-2">{item.components.map((component, index) => <li key={`${component.id}:${index}`} className="flex w-16 min-w-0 flex-col items-center gap-1 text-center">
          <ItemImage item={component} version={data.version} size={28} /><span className="w-full break-words text-[11px] leading-4 text-zinc-300">{component.name}</span>
        </li>)}</ul> : <p className="text-xs text-zinc-400">별도 재료 정보가 없습니다.</p>}
      </div>
    </li>)}</ul> : <div role="status" className="space-y-3 py-10 text-center text-sm text-zinc-400">
      <p>조건에 맞는 아이템이 없습니다.</p><button aria-label="아이템 필터 초기화" className={chip(false)} onClick={() => { setQuery(""); setTier(null); }}>필터 초기화</button>
    </div>}
  </section>;
}
