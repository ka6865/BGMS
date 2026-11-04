"use client";

import { useEffect, useState } from "react";
import { filterLolChampions, type LolChampion } from "@/lib/lol/champions";
import { LOL_AUGMENT_RARITIES, LOL_AUGMENT_RARITY_LABELS, filterLolMayhemAugments, type LolAugmentRarity, type LolMayhemCatalog } from "@/lib/lol/augments/catalog";
import type { PublicChampionStats } from "@/lib/lol/mayhemChampionDataset";

type Result = { dataset: PublicChampionStats | null };
const control = "min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-400 focus-visible:border-amber-400 focus-visible:ring-2 focus-visible:ring-amber-400/30";
const chip = (active: boolean) => `min-h-11 rounded-lg border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${active ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`;
const rarityColor: Record<LolAugmentRarity, string> = { prismatic: "text-fuchsia-300", gold: "text-amber-300", silver: "text-zinc-300" };

export default function LolMayhemChampionStats({ enabled = false, patch, champions, catalog }: {
  enabled?: boolean; patch: string; champions: LolChampion[]; catalog: LolMayhemCatalog;
}) {
  const [championId, setChampionId] = useState(String(champions.find(champion => champion.id === 29)?.id ?? champions[0]?.id ?? ""));
  const [championQuery, setChampionQuery] = useState("");
  const [query, setQuery] = useState("");
  const [rarity, setRarity] = useState<LolAugmentRarity | null>(null);
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; dataset: PublicChampionStats | null; error: boolean } | null>(null);
  const matchingChampions = filterLolChampions(champions, championQuery, null);
  const champion = matchingChampions.find(item => String(item.id) === championId) ?? matchingChampions[0];
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
    if (!enabled || !selectedId) return;
    const controller = new AbortController();
    fetch(`/api/lol/mayhem/champion-stats/${selectedId}?patch=${encodeURIComponent(patch)}`, { cache: "no-store", signal: controller.signal })
      .then(async result => { if (!result.ok) throw new Error("champion_stats_unavailable"); return result.json() as Promise<Result>; })
      .then(result => { if (!controller.signal.aborted) setResponse({ key: requestKey, dataset: result.dataset, error: false }); })
      .catch(() => { if (!controller.signal.aborted) setResponse({ key: requestKey, dataset: null, error: true }); });
    return () => controller.abort();
  }, [enabled, patch, selectedId, requestKey]);

  if (!enabled) return null;
  return <section id="champion-stats" aria-label="챔피언별 선택 통계" className="mt-6 space-y-5">
    <header>
      <h2 className="text-lg font-semibold">챔피언별 증강 선택 통계</h2>
      <p className="mt-1 text-sm leading-6 text-zinc-400">내 챔피언에서 많이 선택된 증강을 확인하세요. 선택률이 높은 순서로 보여드립니다.</p>
    </header>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-2 text-sm"><span className="block text-zinc-300">챔피언 찾기</span>
        <input type="search" aria-label="통계 챔피언 검색" placeholder="챔피언 이름 · 영문 · 초성" value={championQuery} onChange={event => setChampionQuery(event.target.value)} className={control} />
      </label>
      <label className="space-y-2 text-sm"><span className="block text-zinc-300">통계를 볼 챔피언</span>
        <select aria-label="통계 챔피언 선택" className={control} value={selectedId} disabled={!matchingChampions.length} onChange={event => { setChampionId(event.target.value); setRetry(0); }}>
          {!matchingChampions.length && <option value="">검색 결과가 없습니다</option>}
          {matchingChampions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
    </div>
    {!champions.length ? <p role="alert" className="text-sm text-amber-300">챔피언 목록을 불러오지 못했습니다. 페이지를 새로고침해 주세요.</p>
      : !matchingChampions.length && <p role="status" className="text-sm text-zinc-400">일치하는 챔피언이 없습니다. 이름이나 초성을 다시 입력해 주세요.</p>}
    {loading && <p role="status" className="py-8 text-center text-sm text-zinc-400">{champion?.name} 통계를 불러오는 중입니다.</p>}
    {current?.error && <div className="flex flex-wrap items-center gap-3 text-sm" role="alert"><span>챔피언 통계를 불러오지 못했습니다.</span><button className={chip(false)} onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    {current && !current.error && !dataset && <p role="status" className="py-8 text-center text-sm text-zinc-400">이 챔피언의 현재 패치 선택 통계가 아직 없습니다.</p>}
    {dataset && <>
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-zinc-800 pb-3">
        <h3 className="text-base font-semibold">{champion?.name} <span className="ml-1 text-sm font-normal text-zinc-400">선택 기록 {dataset.rows.length}개</span></h3>
        <p className="text-xs text-zinc-400">통계 기준일 {dataset.sourceDataDate} · 패치 {dataset.clientPatch.replace(/^16\./, "26.")}</p>
      </div>
      {dataset.clientPatch !== patch && <p className="text-sm text-amber-300">이전 패치 통계 · 원천 패치 {dataset.clientPatch}</p>}
      <div className="space-y-3">
        <input type="search" aria-label="통계 증강 검색" placeholder="증강 이름이나 효과 검색" value={query} onChange={event => setQuery(event.target.value)} className={control} />
        <div role="group" aria-label="통계 증강 등급" className="flex flex-wrap gap-2">
          <button aria-pressed={rarity === null} className={chip(rarity === null)} onClick={() => setRarity(null)}>전체</button>
          {LOL_AUGMENT_RARITIES.map(item => <button key={item} data-rarity={item} aria-pressed={rarity === item} className={chip(rarity === item)} onClick={() => setRarity(item)}>{LOL_AUGMENT_RARITY_LABELS[item]}</button>)}
        </div>
      </div>
      {!rows.length && <div className="py-8 text-center text-sm text-zinc-400" role="status">
        <p>{dataset.rows.length ? "조건에 맞는 증강이 없습니다." : "이 챔피언의 선택 통계가 아직 없습니다."}</p>
        {(query || rarity) && <button aria-label="통계 필터 초기화" className={`${chip(false)} mt-3`} onClick={() => { setQuery(""); setRarity(null); }}>필터 초기화</button>}
      </div>}
      {!!rows.length && <ul className="grid gap-x-6 md:grid-cols-2">{rows.map(row => {
        const augment = augments.get(row.augmentPlatformId);
        return <li key={row.augmentPlatformId} data-rarity={augment?.rarity} className="min-w-0 border-b border-zinc-800 py-4">
          <div className="flex items-start gap-3">
            {augment?.icon ? <img src={`/api/lol/augment-icons/${catalog.clientPatch}/${augment.icon}`} alt="" width={44} height={44} loading="lazy" decoding="async" className="size-11 shrink-0 rounded-lg bg-zinc-800" />
              : <span aria-hidden="true" className="size-11 shrink-0 rounded-lg bg-zinc-800" />}
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold">{augment?.name ?? `증강 ${row.augmentPlatformId}`}</p>
              {augment && <p className={`mt-1 text-xs ${rarityColor[augment.rarity]}`}>{LOL_AUGMENT_RARITY_LABELS[augment.rarity]}</p>}
            </div>
            <div className="shrink-0 text-right"><p className="text-base font-semibold tabular-nums text-amber-300">{row.reportedPickRate === null ? "미제공" : `${(Number(row.reportedPickRate) * 100).toFixed(2)}%`}</p><p className="mt-1 text-xs text-zinc-400">선택률</p></div>
          </div>
          {augment && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">{augment.text}</p>}
          {augment?.notice && <p className="mt-1 break-words text-xs leading-5 text-zinc-400">{augment.notice}</p>}
          <p className="mt-2 break-words text-xs leading-5 text-zinc-400">선택률 출처 {row.rateSource ?? "미제공"} · 지역 {row.rateRegion ?? "미제공"}</p>
          {row.reportedSampleCount !== null && <p className="break-words text-xs leading-5 text-zinc-400">출처 제공 표본 {row.reportedSampleCount.toLocaleString("ko-KR")} · {row.countSource ?? "미제공"} · {row.countRegion ?? "지역 미제공"}</p>}
        </li>;
      })}</ul>}
      <footer className="space-y-1 text-xs leading-5 text-zinc-400">
        <p>출처: {dataset.attribution} · 데이터 버전 {dataset.upstreamVersion}</p>
        <p>출처가 제공한 선택 비율이며, 계산 분모와 증강 제시 여부는 확인되지 않았습니다. 등장 확률이나 승률을 뜻하지 않습니다.</p>
      </footer>
    </>}
  </section>;
}
