"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { filterLolChampions, type LolChampion } from "@/lib/lol/champions";
import { LOL_AUGMENT_RARITIES, LOL_AUGMENT_RARITY_LABELS, filterLolMayhemAugments, type LolAugmentRarity, type LolMayhemCatalog } from "@/lib/lol/augments/catalog";
import { sortMayhemChampions, type MayhemChampionTiers } from "@/lib/lol/mayhemChampionTiers";
import LolMayhemItems from "./LolMayhemItems";
import LolMayhemObservationHistory from "./LolMayhemObservationHistory";
import type { PublicChampionStats } from "@/lib/lol/mayhemChampionDataset";

type Result = { dataset: PublicChampionStats | null };
const control = "min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-400 focus-visible:border-amber-400 focus-visible:ring-2 focus-visible:ring-amber-400/30";
const chip = (active: boolean) => `min-h-11 rounded-lg border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${active ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`;
const rarityColor: Record<LolAugmentRarity, string> = { prismatic: "text-fuchsia-300", gold: "text-amber-300", silver: "text-zinc-300" };

function ChampionPortrait({ champion, version, size }: { champion: LolChampion; version: string | null; size: number }) {
  return version ? <img src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champion.imageId}.png`} alt="" width={size} height={size} loading="lazy" decoding="async" className="shrink-0 rounded-lg bg-zinc-800 object-cover" style={{ width: size, height: size }} />
    : <span aria-hidden="true" className="shrink-0 rounded-lg bg-zinc-800" style={{ width: size, height: size }} />;
}

export default function LolMayhemChampionStats({ enabled = false, patch, champions, catalog, championVersion = null, itemsEnabled = false, championTiers = null }: {
  enabled?: boolean; patch: string; champions: LolChampion[]; catalog: LolMayhemCatalog; championVersion?: string | null; itemsEnabled?: boolean; championTiers?: MayhemChampionTiers|null;
}) {
  const [championId, setChampionId] = useState(String(champions.find(champion => champion.id === 29)?.id ?? champions[0]?.id ?? ""));
  const [detailView, setDetailView] = useState<"augments" | "items" | "history">(enabled ? "augments" : "items");
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerToggle = useRef<HTMLButtonElement>(null);
  const [championQuery, setChampionQuery] = useState("");
  const [query, setQuery] = useState("");
  const [rarity, setRarity] = useState<LolAugmentRarity | null>(null);
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; dataset: PublicChampionStats | null; error: boolean } | null>(null);
  const matchingChampions = sortMayhemChampions(filterLolChampions(champions, championQuery, null), championTiers);
  const tierMap = championTiers?.tiers ?? {};
  const champion = champions.find(item => String(item.id) === championId) ?? champions[0];
  const selectedId = champion ? String(champion.id) : "";
  const requestKey = `${patch}:${selectedId}:${retry}`;
  const current = response?.key === requestKey ? response : null;
  const dataset = current?.dataset;
  const loading = Boolean(selectedId && !current);
  const augments = new Map(catalog.augments.map(augment => [augment.id, augment]));
  const matchingAugments = new Set(filterLolMayhemAugments(catalog.augments, query, rarity, false).map(augment => augment.id));
  const rows = (dataset?.rows ?? []).filter(row => matchingAugments.has(row.augmentPlatformId)
    || (!rarity && (!query.trim() || `증강 ${row.augmentPlatformId}`.includes(query.trim())) && !augments.has(row.augmentPlatformId)))
    .sort((a, b) => {
      if (a.reportedPickRate === null) return b.reportedPickRate === null ? a.augmentPlatformId - b.augmentPlatformId : 1;
      if (b.reportedPickRate === null) return -1;
      return Number(b.reportedPickRate) - Number(a.reportedPickRate) || a.augmentPlatformId - b.augmentPlatformId;
    });

  useEffect(() => {
    if (!enabled || !selectedId || detailView !== "augments") return;
    const controller = new AbortController();
    fetch(`/api/lol/mayhem/champion-stats/${selectedId}?patch=${encodeURIComponent(patch)}`, { cache: "no-store", signal: controller.signal })
      .then(async result => { if (!result.ok) throw new Error("champion_stats_unavailable"); return result.json() as Promise<Result>; })
      .then(result => { if (!controller.signal.aborted) setResponse({ key: requestKey, dataset: result.dataset, error: false }); })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key: requestKey, dataset: null, error: true }); });
    return () => controller.abort();
  }, [enabled, patch, selectedId, requestKey, detailView]);

  if (!enabled && !itemsEnabled) return null;
  return <section id="champion-stats" aria-label="챔피언별 선택 통계" className="mt-5 grid items-start gap-5 lg:grid-cols-[248px_minmax(0,1fr)]">
    <h2 className="sr-only">챔피언별 증강 선택 통계</h2>
    <aside className="min-w-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/80 lg:sticky lg:top-4">
      <button ref={pickerToggle} type="button" aria-label="챔피언 선택 열기" aria-expanded={pickerOpen} aria-controls="mayhem-champion-picker" onClick={() => setPickerOpen(value => !value)}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-amber-400 lg:hidden">
        {champion && <ChampionPortrait champion={champion} version={championVersion} size={36} />}
        <span className="min-w-0 flex-1"><span className="block text-xs text-zinc-400">챔피언 선택</span><span className="block truncate text-sm font-semibold">{champion?.name ?? "챔피언 찾기"}</span></span>
        <ChevronDown aria-hidden="true" size={18} className={`text-zinc-400 transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
      </button>
      <div id="mayhem-champion-picker" className={pickerOpen ? "block" : "hidden lg:block"}>
        <div className="space-y-3 px-3 pb-3 pt-4">
          <p className="hidden text-sm font-semibold lg:block">챔피언 선택 <span className="ml-1 font-normal text-zinc-400">{champions.length}</span></p>
          {championTiers && <p className="text-xs text-zinc-400">티어순 · {championTiers.patch.replace(/^16\./,"26.")} 기준</p>}
          <label className="relative block"><span className="sr-only">챔피언 찾기</span><Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-3.5 text-zinc-400" />
            <input type="search" aria-label="통계 챔피언 검색" placeholder="챔피언 검색 · 이름, 초성" value={championQuery} onChange={event => setChampionQuery(event.target.value)} className={`${control} pl-9`} />
          </label>
        </div>
        <div role="group" aria-label="통계 챔피언 목록" className="max-h-64 overflow-y-auto overscroll-contain border-t border-zinc-800 p-1.5 [scrollbar-color:var(--color-zinc-700)_transparent] [scrollbar-width:thin] lg:max-h-[calc(100dvh-16rem)]">
          {matchingChampions.map(item => <button key={item.id} type="button" data-champion-id={item.id} aria-pressed={String(item.id) === selectedId}
            onClick={() => { setChampionId(String(item.id)); setPickerOpen(false); setRetry(0); pickerToggle.current?.focus({ preventScroll: true }); }}
            className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-400 ${String(item.id) === selectedId ? "bg-amber-400/10 font-semibold text-amber-300" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"}`}>
            <ChampionPortrait champion={item} version={championVersion} size={28} />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className={`shrink-0 rounded px-2 py-1 text-xs font-semibold ${tierMap[String(item.id)] === 1 ? "bg-amber-400/15 text-amber-300" : "bg-zinc-800 text-zinc-300"}`}>{tierMap[String(item.id)] ? `${tierMap[String(item.id)]}티어` : "미제공"}</span>
            {String(item.id) === selectedId && <Check aria-hidden="true" size={16} className="shrink-0" />}
          </button>)}
          {!matchingChampions.length && <p role="status" className="px-3 py-6 text-center text-sm leading-6 text-zinc-400">일치하는 챔피언이 없습니다. 이름이나 초성을 다시 입력해 주세요.</p>}
        </div>
      </div>
    </aside>
    <div className="min-w-0 space-y-4">
      <header className="flex items-center gap-4 rounded-xl bg-zinc-900 px-4 py-4 sm:px-5">
        {champion && <ChampionPortrait champion={champion} version={championVersion} size={56} />}
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xl font-bold"><span>{champion?.name ?? "챔피언별 증강"}</span>{dataset && detailView === "augments" && <span className="text-xs font-normal text-zinc-400">선택 기록 {dataset.rows.length}개</span>}</h3>
          <p className="mt-1 text-sm text-zinc-300">{detailView === "augments" ? "많이 선택된 증강부터 확인하세요." : detailView === "items" ? "증바람 전용 아이템 평가를 확인하세요." : "패치별 선택 관측 이력을 확인하세요."}</p>
          {dataset && detailView === "augments" && <p className="mt-1 text-xs leading-5 text-zinc-400">통계 기준일 {dataset.sourceDataDate} · 패치 {dataset.clientPatch.replace(/^16\./, "26.")}</p>}
        </div>
      </header>
      {enabled && <div role="group" aria-label="챔피언 상세 보기" className={`grid gap-2 rounded-xl bg-zinc-900 p-2 ${itemsEnabled ? "grid-cols-3" : "grid-cols-2"}`}>
        <button aria-pressed={detailView === "augments"} className={chip(detailView === "augments")} onClick={()=>setDetailView("augments")}>증강</button>
        {itemsEnabled && <button aria-pressed={detailView === "items"} className={chip(detailView === "items")} onClick={()=>setDetailView("items")}>증바람 아이템</button>}
        <button aria-pressed={detailView === "history"} className={chip(detailView === "history")} onClick={() => setDetailView("history")}>관측 이력</button>
      </div>}
      {enabled && detailView === "history" && champion ? <LolMayhemObservationHistory key={`${patch}:${selectedId}`} championId={champion.id} patch={patch} catalog={catalog}/> : itemsEnabled && detailView === "items" && champion ? <LolMayhemItems key={selectedId} championId={champion.id}/> : <>
      {!champions.length && <p role="alert" className="text-sm text-amber-300">챔피언 목록을 불러오지 못했습니다. 페이지를 새로고침해 주세요.</p>}
      {loading && <p role="status" className="py-12 text-center text-sm text-zinc-400">{champion?.name} 통계를 불러오는 중입니다.</p>}
      {current?.error && <div className="flex flex-wrap items-center gap-3 py-8 text-sm" role="alert"><span>챔피언 통계를 불러오지 못했습니다.</span><button className={chip(false)} onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
      {current && !current.error && !dataset && <p role="status" className="py-12 text-center text-sm text-zinc-400">이 챔피언의 현재 패치 선택 통계가 아직 없습니다.</p>}
      {dataset && <>
        {dataset.clientPatch !== patch && <p className="text-sm text-amber-300">이전 패치 통계 · 원천 패치 {dataset.clientPatch}</p>}
        <div className="flex flex-col gap-3 rounded-xl bg-zinc-900 p-2 sm:flex-row sm:items-center">
          <div role="group" aria-label="통계 증강 등급" className="grid grid-cols-4 gap-1 sm:flex sm:shrink-0">
            <button aria-pressed={rarity === null} className={chip(rarity === null)} onClick={() => setRarity(null)}>전체</button>
            {LOL_AUGMENT_RARITIES.map(item => <button key={item} data-rarity={item} aria-pressed={rarity === item} className={chip(rarity === item)} onClick={() => setRarity(item)}>{LOL_AUGMENT_RARITY_LABELS[item]}</button>)}
          </div>
          <label className="relative min-w-0 flex-1"><span className="sr-only">증강 검색</span><Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-3.5 text-zinc-400" />
            <input type="search" aria-label="통계 증강 검색" placeholder="증강 이름이나 효과 검색" value={query} onChange={event => setQuery(event.target.value)} className={`${control} pl-9`} />
          </label>
        </div>
        {!rows.length && <div className="py-12 text-center text-sm text-zinc-400" role="status">
          <p>{dataset.rows.length ? "조건에 맞는 증강이 없습니다." : "이 챔피언의 선택 통계가 아직 없습니다."}</p>
          {(query || rarity) && <button aria-label="통계 필터 초기화" className={`${chip(false)} mt-3`} onClick={() => { setQuery(""); setRarity(null); }}>필터 초기화</button>}
        </div>}
        {!!rows.length && <ul className="grid grid-cols-1 gap-2">{rows.map(row => {
          const augment = augments.get(row.augmentPlatformId);
          return <li key={row.augmentPlatformId} data-rarity={augment?.rarity} className="flex min-w-0 items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:gap-4">
            {augment?.icon ? <img src={`/api/lol/augment-icons/${catalog.clientPatch}/${augment.icon}`} alt="" width={48} height={48} loading="lazy" decoding="async" className="size-12 shrink-0" />
              : <span aria-hidden="true" className="size-12 shrink-0 rounded-xl bg-zinc-800" />}
            <div className="min-w-0 flex-1 space-y-1.5">
              <h4 className="break-words text-[15px] font-semibold leading-6 text-zinc-100">{augment?.name ?? `증강 ${row.augmentPlatformId}`}</h4>
              {augment && <p className={`text-xs font-semibold ${rarityColor[augment.rarity]}`}>{LOL_AUGMENT_RARITY_LABELS[augment.rarity]}</p>}
              {augment && <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-zinc-300">{augment.text}</p>}
              {augment?.notice && <p className="break-words text-xs leading-5 text-zinc-400">{augment.notice}</p>}
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-zinc-800 pt-2 sm:hidden">
                <span className="text-xs text-zinc-400">선택률</span><span className="font-semibold tabular-nums text-amber-300">{row.reportedPickRate === null ? "미제공" : `${(Number(row.reportedPickRate) * 100).toFixed(2)}%`}</span>
                {row.reportedSampleCount !== null && <span className="break-all text-xs text-zinc-400">표본 {row.reportedSampleCount.toLocaleString("ko-KR")}</span>}
              </div>
            </div>
            <div className="hidden w-28 shrink-0 space-y-1 text-right sm:block">
              <p className="text-xs text-zinc-400">선택률</p><p className="text-lg font-semibold tabular-nums text-amber-300">{row.reportedPickRate === null ? "미제공" : `${(Number(row.reportedPickRate) * 100).toFixed(2)}%`}</p>
              {row.reportedSampleCount !== null && <p className="break-all text-xs leading-5 text-zinc-400">표본 {row.reportedSampleCount.toLocaleString("ko-KR")}</p>}
            </div>
          </li>;
        })}</ul>}
        <p className="text-xs leading-5 text-zinc-400">선택률은 제공된 통계의 선택 비율입니다. 계산 분모와 증강 제시 여부는 확인되지 않았으며 등장 확률이나 승률을 뜻하지 않습니다.</p>
      </>}
      </>}
    </div>
  </section>;
}
